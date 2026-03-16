#include "storage/GarbageCollector.hpp"

#include <pqxx/pqxx>
#include <iostream>
#include <vector>

GarbageCollector::GarbageCollector(DatabasePool& pool, const std::string& temp_vault_path)
    : pool_(pool), temp_vault_path_(temp_vault_path) {}

size_t GarbageCollector::cleanup_abandoned_uploads(int hours_old) {
    size_t total_freed = 0;

    try {
        auto conn = pool_.acquire_connection();
        pqxx::work W(*conn);

        std::string interval_str = std::to_string(hours_old) + " hours";

        pqxx::result rows = W.exec(
            "SELECT id, physical_path, size_bytes FROM files "
            "WHERE is_upload_complete = FALSE "
            "AND created_at < NOW() - CAST($1 AS INTERVAL);",
            pqxx::params{interval_str}
        );

        for (const auto& row : rows) {
            int64_t file_id = row["id"].as<int64_t>();
            std::string physical_path = row["physical_path"].as<std::string>();
            size_t size_bytes = row["size_bytes"].as<size_t>();

            try {
                if (std::filesystem::exists(physical_path)) {
                    if (std::filesystem::remove(physical_path)) {
                        total_freed += size_bytes;
                    }
                }
            } catch (const std::filesystem::filesystem_error& e) {
                std::cerr << "GC: falha ao deletar arquivo físico '"
                          << physical_path << "': " << e.what() << std::endl;
            }

            W.exec(
                "DELETE FROM files WHERE id = $1;",
                pqxx::params{file_id}
            );
        }

        W.commit();
    } catch (const std::exception& e) {
        std::cerr << "GC: erro durante limpeza: " << e.what() << std::endl;
    }

    return total_freed;
}
