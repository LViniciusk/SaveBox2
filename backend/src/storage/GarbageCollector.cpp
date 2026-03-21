#include "storage/GarbageCollector.hpp"
#include "database/DatabasePool.hpp"
#include "storage/FileChunker.hpp"
#include <pqxx/pqxx>
#include <iostream>
#include <unordered_set>
#include <vector>

GarbageCollector::GarbageCollector(DatabasePool& pool, FileChunker* chunker)
    : pool_(pool), chunker_(chunker) {}

struct FileToDelete {
    uint64_t file_id;
    uint64_t user_id;
    uint64_t size_bytes;
};

void GarbageCollector::run_cleanup() {
    std::vector<FileToDelete> files_to_delete;
    std::unordered_set<uint64_t> valid_file_ids;

    try {
        auto conn = pool_.acquire_connection();
        pqxx::read_transaction R(*conn);

        std::string query_select = R"(
            SELECT id, user_id, size_bytes FROM files
            WHERE (is_upload_complete = FALSE AND created_at < NOW() - INTERVAL '4 hours')
               OR (deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '30 days')
        )";

        auto result = R.exec(query_select);
        for (const auto& row : result) {
            files_to_delete.push_back({
                row[0].as<uint64_t>(),
                row[1].as<uint64_t>(),
                row[2].as<uint64_t>()
            });
        }

        auto all_files = R.exec("SELECT id FROM files");
        for (const auto& row : all_files) {
            valid_file_ids.insert(row[0].as<uint64_t>());
        }

        R.commit();
    } catch (const std::exception& e) {
        std::cerr << "GC: Erro critico na Fase 1 (Leitura): " << e.what() << "\n";
        return;
    }

    for (const auto& file : files_to_delete) {
        try {
            if (chunker_) {
                chunker_->delete_file(file.file_id);
            }
        } catch (const std::exception& e) {
            std::cerr << "GC: Falha ao deletar arquivo fisico " << file.file_id << ": " << e.what() << "\n";
        }
    }
    try {
        auto conn = pool_.acquire_connection();
        pqxx::work W(*conn);

        for (const auto& file : files_to_delete) {
            if (file.size_bytes > 0) {
                W.exec("UPDATE users SET used_storage_bytes = GREATEST(0, used_storage_bytes - $1) WHERE id = $2",
                       pqxx::params{file.size_bytes, file.user_id});
            }
        }

        std::string query_delete_files = R"(
            DELETE FROM files
            WHERE (is_upload_complete = FALSE AND created_at < NOW() - INTERVAL '4 hours')
               OR (deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '30 days')
        )";
        W.exec(query_delete_files);

        std::string query_delete_folders = R"(
            DELETE FROM folders
            WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '30 days'
        )";
        W.exec(query_delete_folders);

        W.commit();

    } catch (const std::exception& e) {
        std::cerr << "GC: Erro critico na Fase 3 (Exclusao do DB): " << e.what() << "\n";
    }

    if (chunker_) {
        try {
            chunker_->delete_orphaned_files(valid_file_ids);
        } catch (const std::exception& e) {
            std::cerr << "GC: Falha ao limpar arquivos orfaos: " << e.what() << "\n";
        }
    }
}