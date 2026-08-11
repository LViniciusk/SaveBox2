#include "storage/GarbageCollector.hpp"
#include "database/DatabasePool.hpp"
#include "storage/FileChunker.hpp"
#include <pqxx/pqxx>
#include <iostream>
#include <unordered_set>
#include <vector>
#include <optional>
#include <algorithm>
#include <limits>
#include "Services/GoogleDriveService.hpp"

GarbageCollector::GarbageCollector(DatabasePool& pool, FileChunker* chunker, GoogleDriveService* gdrive)
    : pool_(pool), chunker_(chunker), gdrive_(gdrive) {}

namespace {
constexpr auto GC_IDLE_INTERVAL = std::chrono::hours(24);

int retry_delay_seconds(int attempts) {
    const int exponent = std::min(std::max(attempts, 0), 6);
    return std::min(3600, 30 * (1 << exponent));
}

struct ExternalDeletionClaim {
    int id;
    std::string external_file_id;
    uint64_t external_storage_id;
    std::optional<uint64_t> move_job_id;
    int attempts;
};

struct ReconciliationClaim {
    uint64_t move_job_id;
    uint64_t user_id;
    uint64_t external_storage_id;
    int attempts;
};

struct ReconciliationItem {
    uint64_t item_id;
    std::string role;
    uint64_t total_bytes;
};

struct CancelledGoogleUploadClaim {
    uint64_t file_id;
    uint64_t user_id;
    uint64_t external_storage_id;
    uint64_t size_bytes;
    bool expired;
};
}

std::chrono::milliseconds GarbageCollector::next_wake_delay() {
    const auto idle_delay = std::chrono::duration_cast<std::chrono::milliseconds>(GC_IDLE_INTERVAL);
    if (!chunker_ && !gdrive_) return idle_delay;

    auto conn = pool_.acquire_connection();
    pqxx::read_transaction txn(*conn);
    const auto result = txn.exec(R"(
        WITH pending AS (
            SELECT next_retry_at AS due_at
            FROM pending_external_deletions
            WHERE $1::boolean

            UNION ALL

            SELECT next_retry_at AS due_at
            FROM pending_local_deletions
            WHERE $2::boolean

            UNION ALL

            SELECT next_attempt_at AS due_at
            FROM pending_storage_move_reconciliations
            WHERE $1::boolean
        ),
        earliest AS (
            SELECT MIN(due_at) AS due_at
            FROM pending
        )
        SELECT CASE
            WHEN due_at IS NULL THEN NULL
            ELSE CEIL(EXTRACT(EPOCH FROM GREATEST(
                due_at - CURRENT_TIMESTAMP,
                INTERVAL '0 seconds'
            )) * 1000)::BIGINT
        END
        FROM earliest
    )", pqxx::params{gdrive_ != nullptr, chunker_ != nullptr});
    txn.commit();

    if (result.empty() || result[0][0].is_null()) return idle_delay;
    const auto retry_delay = std::chrono::milliseconds(
        std::max<int64_t>(0, result[0][0].as<int64_t>()));
    return std::min(idle_delay, retry_delay);
}

void GarbageCollector::process_pending_storage_move_reconciliations() {
    if (!gdrive_) return;

    std::vector<ReconciliationClaim> claims;
    try {
        auto conn = pool_.acquire_connection();
        pqxx::work claim_txn(*conn);
        const auto rows = claim_txn.exec(R"(
            SELECT r.move_job_id, j.user_id, r.external_storage_id, r.attempts
            FROM pending_storage_move_reconciliations r
            JOIN storage_move_jobs j ON j.id = r.move_job_id
            WHERE r.next_attempt_at <= CURRENT_TIMESTAMP
            ORDER BY r.next_attempt_at
            FOR UPDATE OF r SKIP LOCKED
            LIMIT 25
        )");
        for (const auto& row : rows) {
            claims.push_back({row[0].as<uint64_t>(), row[1].as<uint64_t>(), row[2].as<uint64_t>(), row[3].as<int>()});
            claim_txn.exec(
                "UPDATE pending_storage_move_reconciliations SET next_attempt_at=CURRENT_TIMESTAMP+INTERVAL '5 minutes' WHERE move_job_id=$1",
                pqxx::params{row[0].as<uint64_t>()});
        }
        claim_txn.commit();
    } catch (const std::exception&) {
        std::cerr << "GC: falha ao reivindicar reconciliacoes Google\n";
        return;
    }

    for (const auto& claim : claims) {
        std::vector<ReconciliationItem> items;
        try {
            auto conn = pool_.acquire_connection();
            pqxx::read_transaction read_txn(*conn);
            for (const auto& row : read_txn.exec(
                "SELECT id,role,total_bytes FROM storage_move_items WHERE move_job_id=$1 ORDER BY id",
                pqxx::params{claim.move_job_id})) {
                items.push_back({row[0].as<uint64_t>(), row[1].as<std::string>(), row[2].as<uint64_t>()});
            }
            read_txn.commit();
        } catch (const std::exception&) {
            std::cerr << "GC: falha ao ler itens de reconciliacao\n";
            continue;
        }

        bool scan_completed = true;
        std::vector<std::string> targets;
        for (const auto& item : items) {
            try {
                const auto matches = gdrive_->find_external_targets(
                    claim.user_id, claim.external_storage_id, claim.move_job_id,
                    item.item_id, item.role, item.total_bytes);
                targets.insert(targets.end(), matches.begin(), matches.end());
            } catch (const std::exception&) {
                scan_completed = false;
                break;
            }
        }

        try {
            auto conn = pool_.acquire_connection();
            pqxx::work result_txn(*conn);
            for (const auto& external_id : targets) {
                result_txn.exec(
                    "INSERT INTO pending_external_deletions(external_file_id,external_storage_id,move_job_id) "
                    "VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
                    pqxx::params{external_id, claim.external_storage_id, claim.move_job_id});
            }

            const int delay = retry_delay_seconds(claim.attempts + 1);
            const bool expired = !result_txn.exec(
                "SELECT 1 FROM pending_storage_move_reconciliations "
                "WHERE move_job_id=$1 AND expires_at <= CURRENT_TIMESTAMP",
                pqxx::params{claim.move_job_id}).empty();
            if (!scan_completed) {
                result_txn.exec(
                    "UPDATE pending_storage_move_reconciliations SET attempts=attempts+1, "
                    "next_attempt_at=CURRENT_TIMESTAMP+($1 * INTERVAL '1 second'), last_error=$2 WHERE move_job_id=$3",
                    pqxx::params{delay, std::optional<std::string>("GOOGLE_RECONCILE_FAILED"), claim.move_job_id});
            } else if (expired) {
                // A final attempt was made. Pending deletion rows, if any, retain cleanup ownership.
                result_txn.exec("DELETE FROM pending_storage_move_reconciliations WHERE move_job_id=$1",
                                pqxx::params{claim.move_job_id});
            } else {
                result_txn.exec(
                    "UPDATE pending_storage_move_reconciliations SET attempts=attempts+1, "
                    "next_attempt_at=CURRENT_TIMESTAMP+($1 * INTERVAL '1 second'), last_error=NULL WHERE move_job_id=$2",
                    pqxx::params{delay, claim.move_job_id});
            }
            result_txn.commit();
        } catch (const std::exception&) {
            std::cerr << "GC: falha ao persistir reconciliacao Google\n";
        }
    }
}

void GarbageCollector::process_pending_external_deletions() {
    if (!gdrive_) return;

    std::vector<ExternalDeletionClaim> claims;
    try {
        auto conn = pool_.acquire_connection();
        pqxx::work claim_txn(*conn);
        const auto rows = claim_txn.exec(R"(
            SELECT id,external_file_id,external_storage_id,move_job_id,attempts
            FROM pending_external_deletions
            WHERE next_retry_at <= CURRENT_TIMESTAMP
            ORDER BY next_retry_at
            FOR UPDATE SKIP LOCKED
            LIMIT 50
        )");
        for (const auto& row : rows) {
            claims.push_back({row[0].as<int>(), row[1].as<std::string>(), row[2].as<uint64_t>(),
                              row[3].is_null() ? std::nullopt : std::optional<uint64_t>(row[3].as<uint64_t>()), row[4].as<int>()});
            claim_txn.exec(
                "UPDATE pending_external_deletions SET next_retry_at=CURRENT_TIMESTAMP+INTERVAL '5 minutes' WHERE id=$1",
                pqxx::params{row[0].as<int>()});
        }
        claim_txn.commit();
    } catch (const std::exception&) {
        std::cerr << "GC: falha ao reivindicar delecoes externas\n";
        return;
    }

    for (const auto& claim : claims) {
        bool deleted = false;
        std::string error_code;
        try {
            const int status = gdrive_->delete_external_file(claim.external_storage_id, claim.external_file_id);
            deleted = status == 204 || status == 404;
            if (!deleted) error_code = "HTTP_" + std::to_string(status);
        } catch (const std::exception&) {
            error_code = "GOOGLE_DELETE_FAILED";
        }

        try {
            auto conn = pool_.acquire_connection();
            pqxx::work result_txn(*conn);
            if (deleted) {
                result_txn.exec("DELETE FROM pending_external_deletions WHERE id=$1", pqxx::params{claim.id});
                if (claim.move_job_id.has_value()) {
                    result_txn.exec(
                        "UPDATE storage_move_jobs SET status=CASE WHEN status='cleanup_pending' THEN 'completed' ELSE status END, "
                        "completed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=$1 "
                        "AND NOT EXISTS (SELECT 1 FROM pending_external_deletions WHERE move_job_id=$1) "
                        "AND NOT EXISTS (SELECT 1 FROM pending_local_deletions WHERE move_job_id=$1) "
                        "AND NOT EXISTS (SELECT 1 FROM pending_storage_move_reconciliations WHERE move_job_id=$1)",
                        pqxx::params{*claim.move_job_id});
                }
            } else {
                const int delay = retry_delay_seconds(claim.attempts + 1);
                result_txn.exec(
                    "UPDATE pending_external_deletions SET attempts=attempts+1, "
                    "next_retry_at=CURRENT_TIMESTAMP+($1 * INTERVAL '1 second'),last_error=$2 WHERE id=$3",
                    pqxx::params{delay, error_code, claim.id});
            }
            result_txn.commit();
        } catch (const std::exception&) {
            std::cerr << "GC: falha ao persistir delecao externa\n";
        }
    }
}

void GarbageCollector::process_cancelled_google_uploads() {
    if (!gdrive_) return;

    std::vector<CancelledGoogleUploadClaim> claims;
    try {
        auto conn = pool_.acquire_connection();
        pqxx::work claim_txn(*conn);
        const auto rows = claim_txn.exec(R"(
            SELECT id,user_id,external_storage_id,size_bytes,
                   deleted_at < CURRENT_TIMESTAMP - INTERVAL '8 days'
            FROM files
            WHERE is_external_cleanup_pending=TRUE
              AND storage_provider='google_drive'
              AND is_upload_complete=FALSE
              AND deleted_at IS NOT NULL
              AND external_file_id IS NULL
              AND external_storage_id IS NOT NULL
            ORDER BY deleted_at,id
            FOR UPDATE SKIP LOCKED
            LIMIT 50
        )");
        claims.reserve(rows.size());
        for (const auto& row : rows) {
            claims.push_back({row[0].as<uint64_t>(), row[1].as<uint64_t>(), row[2].as<uint64_t>(),
                              row[3].as<uint64_t>(), row[4].as<bool>()});
        }
        claim_txn.commit();
    } catch (const std::exception&) {
        std::cerr << "GC: falha ao reivindicar uploads Google cancelados\n";
        return;
    }

    for (const auto& claim : claims) {
        std::vector<std::string> matches;
        try {
            matches = gdrive_->find_external_upload_targets(
                claim.user_id, claim.external_storage_id, claim.file_id, claim.size_bytes);
        } catch (const std::exception&) {
            std::cerr << "GC: falha ao reconciliar upload Google cancelado\n";
            continue;
        }

        if (matches.size() > 1 || (matches.empty() && !claim.expired)) continue;

        try {
            auto conn = pool_.acquire_connection();
            pqxx::work result_txn(*conn);
            const auto deleted = result_txn.exec(
                "DELETE FROM files WHERE id=$1 AND user_id=$2 "
                "AND is_external_cleanup_pending=TRUE "
                "AND storage_provider='google_drive' AND is_upload_complete=FALSE "
                "AND deleted_at IS NOT NULL AND external_file_id IS NULL "
                "AND external_storage_id=$3 RETURNING user_id",
                pqxx::params{claim.file_id, claim.user_id, claim.external_storage_id});
            if (deleted.empty()) {
                result_txn.commit();
                continue;
            }

            if (matches.size() == 1) {
                result_txn.exec(
                    "INSERT INTO pending_external_deletions(external_file_id,external_storage_id) "
                    "VALUES($1,$2) ON CONFLICT DO NOTHING",
                    pqxx::params{matches.front(), claim.external_storage_id});
            }
            result_txn.exec(
                "UPDATE users SET used_storage_bytes=GREATEST(0,used_storage_bytes-2048) WHERE id=$1",
                pqxx::params{claim.user_id});
            result_txn.commit();
        } catch (const std::exception&) {
            std::cerr << "GC: falha ao concluir cleanup de upload Google cancelado\n";
        }
    }
}

void GarbageCollector::run_cleanup() {
    std::vector<std::string> orphan_candidates;
    std::vector<std::string> move_orphan_candidates;
    if (chunker_) {
        try {
            orphan_candidates = chunker_->snapshot_canonical_files();
        } catch (const std::exception&) {
            std::cerr << "GC: Falha ao capturar candidatos de arquivos orfaos\n";
        }
        // New move artifacts belong to the next cycle, not this cycle's DB owner view.
        try {
            move_orphan_candidates = chunker_->snapshot_move_artifacts();
        } catch (const std::exception&) {
            std::cerr << "GC: Falha ao capturar candidatos de artefatos de move\n";
        }
    }

    std::vector<uint64_t> deleted_file_ids;
    try {
        auto conn = pool_.acquire_connection();
        pqxx::work W(*conn);

        W.exec(R"(
            WITH ranked AS (
                SELECT f.id,
                       ROW_NUMBER() OVER (PARTITION BY f.user_id ORDER BY f.id) AS row_number
                FROM files f
                JOIN users u ON u.id = f.user_id
                WHERE u.deleted_at IS NOT NULL
                  AND f.deleted_at IS NULL
                  AND NOT EXISTS (
                      SELECT 1
                      FROM storage_move_jobs m
                      WHERE m.file_id = f.id
                        AND (
                            m.status IN ('prepared','transferring','paused','target_uploaded','committing','cleanup_pending')
                            OR EXISTS (SELECT 1 FROM pending_local_deletions p WHERE p.move_job_id = m.id)
                            OR EXISTS (SELECT 1 FROM pending_external_deletions p WHERE p.move_job_id = m.id)
                            OR EXISTS (SELECT 1 FROM pending_storage_move_reconciliations r WHERE r.move_job_id = m.id)
                        )
                  )
            )
            UPDATE files f
            SET deleted_at = CURRENT_TIMESTAMP - INTERVAL '31 days'
            FROM ranked
            WHERE f.id = ranked.id
              AND ranked.row_number <= 50
        )");

        auto deleted_rows = W.exec(R"(
            DELETE FROM files
            WHERE is_external_cleanup_pending=FALSE
              AND ((is_upload_complete = FALSE AND created_at < NOW() - INTERVAL '4 hours')
               OR (deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '30 days')
              )
            RETURNING id, user_id, size_bytes, storage_provider, external_file_id, external_storage_id
        )");

        for (const auto& row : deleted_rows) {
            const auto file_id = row["id"].as<uint64_t>();
            const auto user_id = row["user_id"].as<uint64_t>();
            const auto provider = row["storage_provider"].as<std::string>();
            deleted_file_ids.push_back(file_id);

            const uint64_t refund_bytes = (provider == "local")
                ? row["size_bytes"].as<uint64_t>()
                : 2048;
            if (refund_bytes > 0) {
                W.exec("UPDATE users SET used_storage_bytes = GREATEST(0, used_storage_bytes - $1) WHERE id = $2",
                       pqxx::params{refund_bytes, user_id});
            }

            if (provider == "google_drive"
                && !row["external_file_id"].is_null()
                && !row["external_storage_id"].is_null()) {
                    const std::string ext_file_id = row["external_file_id"].as<std::string>();
                    const uint64_t ext_storage_id = row["external_storage_id"].as<uint64_t>();
                    W.exec(
                        "INSERT INTO pending_external_deletions (external_file_id, external_storage_id) VALUES ($1, $2)",
                        pqxx::params{ext_file_id, ext_storage_id}
                    );
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
        deleted_file_ids.clear();
        std::cerr << "GC: Erro critico na Fase 2 (Atualizacao e Delecao DB): " << e.what() << "\n";
    }

    if (chunker_) {
        for (const auto file_id : deleted_file_ids) {
            try {
                chunker_->delete_file(file_id);
            } catch (const std::exception& e) {
                std::cerr << "GC: Falha ao deletar arquivo fisico " << file_id << ": " << e.what() << "\n";
            }
        }
    }

    if (gdrive_) {
        process_pending_storage_move_reconciliations();
        process_cancelled_google_uploads();
        process_pending_external_deletions();
        std::vector<uint64_t> finalized_storage_ids;
        try {
            auto conn = pool_.acquire_connection();
            pqxx::work W(*conn);
            const auto deleted_storages = W.exec(
                "DELETE FROM user_external_storages s WHERE s.is_unlinking=TRUE "
                "AND NOT EXISTS (SELECT 1 FROM pending_external_deletions p WHERE p.external_storage_id=s.id) "
                "AND NOT EXISTS (SELECT 1 FROM pending_storage_move_reconciliations r WHERE r.external_storage_id=s.id) "
                "AND NOT EXISTS (SELECT 1 FROM storage_move_jobs m WHERE (m.source_external_storage_id=s.id OR m.target_external_storage_id=s.id) "
                "AND m.status IN ('prepared','transferring','paused','target_uploaded','committing','cleanup_pending')) "
                "RETURNING s.id");
            finalized_storage_ids.reserve(deleted_storages.size());
            for (const auto& row : deleted_storages) {
                finalized_storage_ids.push_back(row[0].as<uint64_t>());
            }
            W.commit();
        } catch (const std::exception&) {
            finalized_storage_ids.clear();
            std::cerr << "GC: falha ao concluir delecao de contas Google\n";
        }
        gdrive_->invalidate_storage_caches(finalized_storage_ids);
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
                    W.exec("UPDATE storage_move_jobs SET status=CASE WHEN status='cleanup_pending' THEN 'completed' ELSE status END,completed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=$1",pqxx::params{move_id});
                } catch (const std::exception& error) {
                    W.exec(
                        "UPDATE pending_local_deletions SET attempts=attempts+1,next_retry_at=CURRENT_TIMESTAMP+INTERVAL '1 minute',last_error=$1 WHERE id=$2",
                        pqxx::params{std::string(error.what()).substr(0,255),row[0].as<uint64_t>()});
                }
            }
            std::unordered_set<uint64_t> item_ids;
            for (const auto& row : W.exec("SELECT id FROM storage_move_items WHERE status IN ('prepared','transferring','target_uploaded')")) item_ids.insert(row[0].as<uint64_t>());
            std::unordered_set<uint64_t> protected_cleanup_job_ids;
            for (const auto& row : W.exec(
                "SELECT move_job_id FROM pending_local_deletions "
                "UNION "
                "SELECT id FROM storage_move_jobs "
                "WHERE source_provider='local' "
                "AND status IN ('prepared','transferring','paused','target_uploaded','committing','cleanup_pending')")) {
                protected_cleanup_job_ids.insert(row[0].as<uint64_t>());
            }
            chunker_->delete_orphaned_move_files(move_orphan_candidates, item_ids, protected_cleanup_job_ids);
            W.exec(
                "DELETE FROM storage_move_jobs AS m WHERE m.status IN ('completed','cancelled','failed') "
                "AND m.completed_at < CURRENT_TIMESTAMP-INTERVAL '7 days' "
                "AND NOT EXISTS (SELECT 1 FROM pending_external_deletions p WHERE p.move_job_id=m.id) "
                "AND NOT EXISTS (SELECT 1 FROM pending_local_deletions p WHERE p.move_job_id=m.id) "
                "AND NOT EXISTS (SELECT 1 FROM pending_storage_move_reconciliations r WHERE r.move_job_id=m.id)");
            W.commit();
        } catch (const std::exception& error) {
            std::cerr << "GC: Erro na limpeza de storage moves: " << error.what() << "\n";
        }
    }

    if (chunker_) {
        try {
            std::unordered_set<uint64_t> valid_file_ids;
            auto conn = pool_.acquire_connection();
            pqxx::read_transaction read_txn(*conn);
            for (const auto& row : read_txn.exec("SELECT id FROM files")) {
                valid_file_ids.insert(row[0].as<uint64_t>());
            }
            read_txn.commit();
            chunker_->delete_orphaned_files(orphan_candidates, valid_file_ids);
        } catch (const std::exception& e) {
            std::cerr << "GC: Falha ao limpar arquivos orfaos: " << e.what() << "\n";
        }
    }

    std::vector<uint64_t> terminalized_storage_ids;
    try {
        auto conn = pool_.acquire_connection();
        pqxx::work W(*conn);
        const auto candidates = W.exec(R"(
            SELECT u.id
            FROM users u
            WHERE u.deleted_at IS NOT NULL
              AND NOT EXISTS (
                  SELECT 1 FROM files f WHERE f.user_id = u.id
              )
              AND NOT EXISTS (
                  SELECT 1
                  FROM pending_external_deletions p
                  JOIN user_external_storages s ON s.id = p.external_storage_id
                  WHERE s.user_id = u.id
              )
              AND NOT EXISTS (
                  SELECT 1
                  FROM pending_storage_move_reconciliations r
                  JOIN user_external_storages s ON s.id = r.external_storage_id
                  WHERE s.user_id = u.id
              )
              AND NOT EXISTS (
                  SELECT 1
                  FROM pending_local_deletions p
                  JOIN storage_move_jobs m ON m.id = p.move_job_id
                  WHERE m.user_id = u.id
              )
              AND NOT EXISTS (
                  SELECT 1
                  FROM storage_move_jobs m
                  WHERE m.user_id = u.id
                    AND m.status IN ('prepared','transferring','paused','target_uploaded','committing','cleanup_pending')
              )
            ORDER BY u.id
            LIMIT 50
            FOR UPDATE OF u SKIP LOCKED
        )");

        for (const auto& candidate : candidates) {
            const auto user_id = candidate[0].as<uint64_t>();
            std::vector<uint64_t> user_storage_ids;
            for (const auto& storage : W.exec(
                "SELECT id FROM user_external_storages WHERE user_id=$1",
                pqxx::params{user_id})) {
                user_storage_ids.push_back(storage[0].as<uint64_t>());
            }

            const auto deleted = W.exec(R"(
                DELETE FROM users u
                WHERE u.id = $1
                  AND u.deleted_at IS NOT NULL
                  AND NOT EXISTS (
                      SELECT 1 FROM files f WHERE f.user_id = u.id
                  )
                  AND NOT EXISTS (
                      SELECT 1
                      FROM pending_external_deletions p
                      JOIN user_external_storages s ON s.id = p.external_storage_id
                      WHERE s.user_id = u.id
                  )
                  AND NOT EXISTS (
                      SELECT 1
                      FROM pending_storage_move_reconciliations r
                      JOIN user_external_storages s ON s.id = r.external_storage_id
                      WHERE s.user_id = u.id
                  )
                  AND NOT EXISTS (
                      SELECT 1
                      FROM pending_local_deletions p
                      JOIN storage_move_jobs m ON m.id = p.move_job_id
                      WHERE m.user_id = u.id
                  )
                  AND NOT EXISTS (
                      SELECT 1
                      FROM storage_move_jobs m
                      WHERE m.user_id = u.id
                        AND m.status IN ('prepared','transferring','paused','target_uploaded','committing','cleanup_pending')
                  )
                RETURNING u.id
            )", pqxx::params{user_id});
            if (!deleted.empty()) {
                terminalized_storage_ids.insert(terminalized_storage_ids.end(),
                                                user_storage_ids.begin(), user_storage_ids.end());
            }
        }
        W.commit();
    } catch (const std::exception& e) {
        terminalized_storage_ids.clear();
        std::cerr << "GC: falha ao concluir contas apagadas: " << e.what() << "\n";
    }

    if (gdrive_ && !terminalized_storage_ids.empty()) {
        gdrive_->invalidate_storage_caches(terminalized_storage_ids);
    }
}
