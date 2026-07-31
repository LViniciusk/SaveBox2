#include "storage/GarbageCollector.hpp"
#include "database/DatabasePool.hpp"
#include "storage/FileChunker.hpp"
#include <pqxx/pqxx>
#include <iostream>
#include <unordered_set>
#include <vector>
#include <optional>
#include <algorithm>
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

        auto deleted_rows = W.exec(R"(
            WITH deleted_files AS (
                DELETE FROM files
                WHERE (is_upload_complete = FALSE AND created_at < NOW() - INTERVAL '4 hours')
                   OR (deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '30 days')
                RETURNING id, storage_provider, external_file_id, external_storage_id
            )
            SELECT id, storage_provider, external_file_id, external_storage_id FROM deleted_files;
        )");

        for (const auto& row : deleted_rows) {
            std::string provider = row["storage_provider"].as<std::string>();
            if (provider == "google_drive") {
                if (!row["external_file_id"].is_null() && !row["external_storage_id"].is_null()) {
                    std::string ext_file_id = row["external_file_id"].as<std::string>();
                    uint64_t ext_storage_id = row["external_storage_id"].as<uint64_t>();
                    W.exec(
                        "INSERT INTO pending_external_deletions (external_file_id, external_storage_id) VALUES ($1, $2)",
                        pqxx::params{ext_file_id, ext_storage_id}
                    );
                }
            }
        }

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
            auto pending = W.exec(
                "SELECT id,external_file_id,external_storage_id,move_job_id,attempts FROM pending_external_deletions "
                "WHERE next_retry_at <= CURRENT_TIMESTAMP ORDER BY id LIMIT 50");
            for (const auto& row : pending) {
                const int id = row[0].as<int>();
                const std::string external_file_id = row[1].as<std::string>();
                const uint64_t storage_id = row[2].as<uint64_t>();
                const std::optional<uint64_t> move_id = row[3].is_null() ? std::nullopt : std::optional<uint64_t>(row[3].as<uint64_t>());
                try {
                    const std::string token = gdrive_->get_access_token_for_storage(storage_id);
                    cpr::Response response = cpr::Delete(
                        cpr::Url{"https://www.googleapis.com/drive/v3/files/" + external_file_id},
                        cpr::Header{{"Authorization", "Bearer " + token}}, cpr::Timeout{5000});
                    if (response.status_code == 204 || response.status_code == 404) {
                        W.exec("DELETE FROM pending_external_deletions WHERE id=$1",pqxx::params{id});
                        if (move_id.has_value()) W.exec(
                            "UPDATE storage_move_jobs SET status='completed',completed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=$1 "
                            "AND NOT EXISTS (SELECT 1 FROM pending_external_deletions WHERE move_job_id=$1)",
                            pqxx::params{*move_id});
                    } else {
                        const int delay = std::min(3600, 30 * (1 << std::min(row[4].as<int>(),6)));
                        W.exec(
                            "UPDATE pending_external_deletions SET attempts=attempts+1,next_retry_at=CURRENT_TIMESTAMP+($1 * INTERVAL '1 second'),last_error=$2 WHERE id=$3",
                            pqxx::params{delay,"HTTP_"+std::to_string(response.status_code),id});
                    }
                } catch (const std::exception& error) {
                    const int delay = std::min(3600, 30 * (1 << std::min(row[4].as<int>(),6)));
                    W.exec(
                        "UPDATE pending_external_deletions SET attempts=attempts+1,next_retry_at=CURRENT_TIMESTAMP+($1 * INTERVAL '1 second'),last_error=$2 WHERE id=$3",
                        pqxx::params{delay,std::string(error.what()).substr(0,255),id});
                }
            }
            W.exec(
                "DELETE FROM user_external_storages s WHERE s.is_unlinking=TRUE "
                "AND NOT EXISTS (SELECT 1 FROM pending_external_deletions p WHERE p.external_storage_id=s.id) "
                "AND NOT EXISTS (SELECT 1 FROM storage_move_jobs m WHERE (m.source_external_storage_id=s.id OR m.target_external_storage_id=s.id) "
                "AND m.status IN ('prepared','transferring','paused','target_uploaded','committing','cleanup_pending'))");
            W.commit();
        } catch (const std::exception& e) {
            std::cerr << "GC: Erro na Fase 3 (Delecao Externa): " << e.what() << "\n";
        }
    }

    if (chunker_) {
        try {
            auto conn = pool_.acquire_connection();
            pqxx::work W(*conn);
            auto pending = W.exec("SELECT id,move_job_id,attempts FROM pending_local_deletions WHERE next_retry_at<=CURRENT_TIMESTAMP LIMIT 50");
            for (const auto& row : pending) {
                try {
                    const uint64_t move_id = row[1].as<uint64_t>();
                    chunker_->delete_quarantined_file(move_id);
                    W.exec("DELETE FROM pending_local_deletions WHERE id=$1",pqxx::params{row[0].as<uint64_t>()});
                    W.exec("UPDATE storage_move_jobs SET status='completed',completed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=$1",pqxx::params{move_id});
                } catch (const std::exception& error) {
                    W.exec(
                        "UPDATE pending_local_deletions SET attempts=attempts+1,next_retry_at=CURRENT_TIMESTAMP+INTERVAL '1 minute',last_error=$1 WHERE id=$2",
                        pqxx::params{std::string(error.what()).substr(0,255),row[0].as<uint64_t>()});
                }
            }
            std::unordered_set<uint64_t> item_ids;
            for (const auto& row : W.exec("SELECT id FROM storage_move_items WHERE status IN ('prepared','transferring','target_uploaded')")) item_ids.insert(row[0].as<uint64_t>());
            std::unordered_set<uint64_t> cleanup_ids;
            for (const auto& row : W.exec("SELECT move_job_id FROM pending_local_deletions")) cleanup_ids.insert(row[0].as<uint64_t>());
            chunker_->delete_orphaned_move_files(item_ids,cleanup_ids);
            W.exec("DELETE FROM storage_move_jobs WHERE status IN ('completed','cancelled','failed') AND completed_at < CURRENT_TIMESTAMP-INTERVAL '7 days'");
            W.commit();
        } catch (const std::exception& error) {
            std::cerr << "GC: Erro na limpeza de storage moves: " << error.what() << "\n";
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

void GarbageCollector::cleanup_deleted_users() {
    try {
        auto conn = pool_.acquire_connection();
        pqxx::work W(*conn);

        auto users = W.exec("SELECT id FROM users WHERE deleted_at IS NOT NULL");
        for (const auto& row : users) {
            uint64_t user_id = row[0].as<uint64_t>();

            W.exec(
                "UPDATE files SET deleted_at = CURRENT_TIMESTAMP - INTERVAL '31 days' "
                "WHERE id IN ("
                "  SELECT id FROM files WHERE user_id = $1 AND deleted_at IS NULL LIMIT 50"
                ")", 
                pqxx::params{user_id}
            );

            auto count_res = W.exec("SELECT count(*) FROM files WHERE user_id = $1", pqxx::params{user_id});
            if (count_res[0][0].as<uint64_t>() == 0) {
                W.exec("DELETE FROM users WHERE id = $1", pqxx::params{user_id});
            }
        }
        W.commit();
    } catch (const std::exception& e) {
        std::cerr << "GC: Erro em cleanup_deleted_users: " << e.what() << "\n";
    }
}
