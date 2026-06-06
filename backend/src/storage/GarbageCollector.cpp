#include "storage/GarbageCollector.hpp"
#include "database/DatabasePool.hpp"
#include "storage/FileChunker.hpp"
#include <pqxx/pqxx>
#include <iostream>
#include <unordered_set>
#include <vector>
#include "Services/GoogleDriveService.hpp"
#include <cpr/cpr.h>

GarbageCollector::GarbageCollector(DatabasePool& pool, FileChunker* chunker, GoogleDriveService* gdrive)
    : pool_(pool), chunker_(chunker), gdrive_(gdrive) {}

struct FileToDelete {
    uint64_t file_id;
    uint64_t user_id;
    uint64_t size_bytes;
    std::string storage_provider;
};

void GarbageCollector::run_cleanup() {
    std::vector<FileToDelete> files_to_delete;
    std::unordered_set<uint64_t> valid_file_ids;

    try {
        auto conn = pool_.acquire_connection();
        pqxx::read_transaction R(*conn);

        std::string query_select = R"(
            SELECT id, user_id, size_bytes, storage_provider FROM files
            WHERE (is_upload_complete = FALSE AND created_at < NOW() - INTERVAL '4 hours')
               OR (deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '30 days')
        )";

        auto result = R.exec(query_select);
        for (const auto& row : result) {
            files_to_delete.push_back({
                row[0].as<uint64_t>(),
                row[1].as<uint64_t>(),
                row[2].as<uint64_t>(),
                row[3].as<std::string>()
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
            uint64_t refund_bytes = (file.storage_provider == "local") ? file.size_bytes : 2048;
            if (refund_bytes > 0) {
                W.exec("UPDATE users SET used_storage_bytes = GREATEST(0, used_storage_bytes - $1) WHERE id = $2",
                       pqxx::params{refund_bytes, file.user_id});
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

        std::string query_delete_banned_ips = R"(
            DELETE FROM banned_ips
            WHERE expires_at < NOW()
        )";
        W.exec(query_delete_banned_ips);

        W.commit();
    } catch (const std::exception& e) {
        std::cerr << "GC: Erro critico na Fase 2 (Atualizacao e Delecao DB): " << e.what() << "\n";
    }

    if (gdrive_) {
        try {
            auto conn = pool_.acquire_connection();
            pqxx::work W(*conn);
            
            auto pending = W.exec("SELECT id, external_file_id, external_storage_id FROM pending_external_deletions LIMIT 50");
            
            for (const auto& row : pending) {
                int id = row[0].as<int>();
                std::string external_file_id = row[1].as<std::string>();
                uint64_t external_storage_id = row[2].as<uint64_t>();
                
                try {
                    std::string access_token = gdrive_->get_access_token_for_storage(external_storage_id);
                    cpr::Response r = cpr::Delete(
                        cpr::Url{"https://www.googleapis.com/drive/v3/files/" + external_file_id},
                        cpr::Header{{"Authorization", "Bearer " + access_token}}
                    );
                    
                    if (r.status_code == 204 || r.status_code == 404) {
                        W.exec("DELETE FROM pending_external_deletions WHERE id = $1", pqxx::params{id});
                    } else {
                        std::cerr << "GC: Falha ao deletar arquivo no GDrive. Status: " << r.status_code << "\n";
                    }
                } catch (const std::exception& e) {
                    std::cerr << "GC: Erro ao processar delecao externa " << id << ": " << e.what() << "\n";
                    W.exec("DELETE FROM pending_external_deletions WHERE id = $1", pqxx::params{id});
                }
            }
            
            W.exec(
                "DELETE FROM user_external_storages "
                "WHERE is_unlinking = TRUE AND id NOT IN ("
                "  SELECT DISTINCT external_storage_id FROM pending_external_deletions"
                ")"
            );

            W.commit();
        } catch (const std::exception& e) {
            std::cerr << "GC: Erro na Fase 3 (Delecao Externa): " << e.what() << "\n";
        }
    }

    if (chunker_) {
        try {
            chunker_->delete_orphaned_files(valid_file_ids);
        } catch (const std::exception& e) {
            std::cerr << "GC: Falha ao limpar arquivos orfaos: " << e.what() << "\n";
        }
    }
}