#include "database/FileManager.hpp"
#include "database/DatabasePool.hpp"
#include "storage/FileChunker.hpp"
#include <pqxx/pqxx>
#include <random>
#include <sstream>
#include <iomanip>

namespace {
    std::string generate_uuid_v4() {
        static std::random_device rd;
        static std::mt19937 gen(rd());
        static std::uniform_int_distribution<> dis(0, 15);
        static std::uniform_int_distribution<> dis2(8, 11);

        std::stringstream ss;
        ss << std::hex;
        for (int i = 0; i < 8; i++) ss << dis(gen);
        ss << "-";
        for (int i = 0; i < 4; i++) ss << dis(gen);
        ss << "-4";
        for (int i = 0; i < 3; i++) ss << dis(gen);
        ss << "-";
        ss << dis2(gen);
        for (int i = 0; i < 3; i++) ss << dis(gen);
        ss << "-";
        for (int i = 0; i < 12; i++) ss << dis(gen);
        return ss.str();
    }
}

FileManager::FileManager(DatabasePool& pool) : pool_(pool) {}

int FileManager::init_upload(uint64_t user_id, std::optional<uint64_t> folder_id,
                              const std::string& enc_name, const std::string& name_hash,
                              uint64_t size_bytes, int total_chunks) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);

    // Verificação de duplicidade
    std::string dup_query;
    if (folder_id.has_value()) {
        dup_query = "SELECT id FROM files WHERE user_id = $1 AND name_hash = $2 AND deleted_at IS NULL AND folder_id = $3";
    } else {
        dup_query = "SELECT id FROM files WHERE user_id = $1 AND name_hash = $2 AND deleted_at IS NULL AND folder_id IS NULL";
    }

    pqxx::result dup_res;
    if (folder_id.has_value()) {
        dup_res = txn.exec(dup_query, pqxx::params{user_id, name_hash, folder_id.value()});
    } else {
        dup_res = txn.exec(dup_query, pqxx::params{user_id, name_hash});
    }

    if (!dup_res.empty()) {
        throw std::runtime_error("FILE_ALREADY_EXISTS");
    }

    auto check_quota = txn.exec(
        "SELECT used_storage_bytes, max_storage_bytes FROM users WHERE id = $1 FOR UPDATE",
        pqxx::params{user_id}
    );
    if (check_quota.empty()) throw std::runtime_error("NOT_FOUND");
    uint64_t used = check_quota[0][0].as<uint64_t>();
    uint64_t max = check_quota[0][1].as<uint64_t>();
    if (used + size_bytes > max) {
        throw std::runtime_error("QUOTA_EXCEEDED");
    }

    txn.exec("UPDATE users SET used_storage_bytes = used_storage_bytes + $1 WHERE id = $2",
             pqxx::params{size_bytes, user_id});

    auto result = txn.exec(
        "INSERT INTO files (user_id, folder_id, encrypted_name, name_hash, size_bytes, total_chunks) "
        "VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
        pqxx::params{user_id, folder_id, enc_name, name_hash, size_bytes, total_chunks}
    );

    int file_id = result[0][0].as<int>();

    std::string physical_path = std::to_string(file_id) + ".dat";
    txn.exec(
        "UPDATE files SET physical_path = $1 WHERE id = $2",
        pqxx::params{physical_path, file_id}
    );

    txn.commit();
    return file_id;
}

void FileManager::mark_upload_complete(uint64_t file_id) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);
    txn.exec(
        "UPDATE files SET is_upload_complete = true WHERE id = $1",
        pqxx::params{file_id}
    );
    txn.commit();
}

int FileManager::get_total_chunks(uint64_t file_id) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);
    auto result = txn.exec(
        "SELECT total_chunks FROM files WHERE id = $1",
        pqxx::params{file_id}
    );
    txn.commit();
    if (result.empty()) return 0;
    return result[0][0].as<int>();
}

bool FileManager::can_user_download(uint64_t file_id, uint64_t user_id) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);
    auto result = txn.exec(
        "SELECT is_upload_complete FROM files WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
        pqxx::params{file_id, user_id}
    );
    txn.commit();

    if (result.empty()) {
        throw std::runtime_error("NOT_FOUND");
    }

    if (!result[0][0].as<bool>()) {
        throw std::runtime_error("INCOMPLETE");
    }

    return true;
}

int FileManager::count_uploaded_chunks(uint64_t file_id) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);
    
    auto result = txn.exec(
        "SELECT COUNT(*) FROM file_chunks WHERE file_id = $1",
        pqxx::params{file_id}
    );
    
    txn.commit();
    
    if (result.empty()) {
        return 0;
    }
    
    return result[0][0].as<int>();
}

std::vector<crow::json::wvalue> FileManager::get_user_files_paginated(uint64_t user_id, int limit, int offset) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);

    auto result = txn.exec(
        "SELECT id, folder_id, encrypted_name, size_bytes FROM files "
        "WHERE user_id = $1 AND is_upload_complete = true AND deleted_at IS NULL "
        "ORDER BY id ASC LIMIT $2 OFFSET $3",
        pqxx::params{user_id, limit, offset}
    );

    std::vector<crow::json::wvalue> files;
    for (const auto& row : result) {
        crow::json::wvalue item;
        item["id"] = row[0].as<int>();
        
        if (row[1].is_null()) {
            item["folder_id"] = nullptr;
        } else {
            item["folder_id"] = row[1].as<int>();
        }

        item["encrypted_name"] = row[2].as<std::string>();
        item["size_bytes"] = row[3].as<int64_t>();
        files.push_back(std::move(item));
    }

    txn.commit();
    return files;
}

std::vector<int> FileManager::get_uploaded_chunks(uint64_t file_id, uint64_t user_id) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);

    auto result = txn.exec(
        "SELECT is_upload_complete FROM files WHERE id = $1 AND user_id = $2",
        pqxx::params{file_id, user_id}
    );

    if (result.empty()) {
        throw std::runtime_error("NOT_FOUND");
    }

    if (result[0][0].as<bool>()) {
        throw std::runtime_error("ALREADY_COMPLETE");
    }

    auto chunks_result = txn.exec(
        "SELECT chunk_index FROM file_chunks WHERE file_id = $1 ORDER BY chunk_index ASC",
        pqxx::params{file_id}
    );

    std::vector<int> chunks;
    for (const auto& row : chunks_result) {
        chunks.push_back(row[0].as<int>());
    }

    txn.commit();
    return chunks;
}

void FileManager::record_chunk_saved(uint64_t file_id, int chunk_index) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);
    txn.exec(
        "INSERT INTO file_chunks (file_id, chunk_index) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        pqxx::params{file_id, chunk_index}
    );
    txn.commit();
}

void FileManager::delete_file(uint64_t file_id, uint64_t user_id) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);

    auto result = txn.exec(
        "SELECT id FROM files WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
        pqxx::params{file_id, user_id}
    );

    if (result.empty()) {
        throw std::runtime_error("NOT_FOUND");
    }

    txn.exec(
        "UPDATE files SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1 AND user_id = $2",
        pqxx::params{file_id, user_id}
    );

    txn.commit();
}

crow::json::wvalue FileManager::update_file(uint64_t file_id, uint64_t user_id, const std::optional<std::string>& enc_name, const std::optional<std::string>& name_hash, const std::optional<uint64_t>& folder_id) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);

    auto result = txn.exec(
        "SELECT id FROM files WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
        pqxx::params{file_id, user_id}
    );
    if (result.empty()) {
        throw std::runtime_error("NOT_FOUND");
    }


    if (folder_id.has_value() && folder_id.value() != 0) {
        auto folder_res = txn.exec(
            "SELECT id FROM folders WHERE id = $1 AND user_id = $2",
            pqxx::params{folder_id.value(), user_id}
        );
        if (folder_res.empty()) {
            throw std::runtime_error("FORBIDDEN");
        }
    }

    bool has_name = enc_name.has_value() && name_hash.has_value();
    bool has_folder = folder_id.has_value();

    if (!has_name && !has_folder) {
        throw std::runtime_error("BAD_REQUEST");
    }


    if (has_name || has_folder) {
        if (has_folder) {
            if (folder_id.value() == 0) {
                if (has_name) {
                    txn.exec("UPDATE files SET encrypted_name = $1, name_hash = $2, folder_id = NULL WHERE id = $3 AND user_id = $4",
                             pqxx::params{enc_name.value(), name_hash.value(), file_id, user_id});
                } else {
                    txn.exec("UPDATE files SET folder_id = NULL WHERE id = $1 AND user_id = $2",
                             pqxx::params{file_id, user_id});
                }
            } else {
                if (has_name) {
                    txn.exec("UPDATE files SET encrypted_name = $1, name_hash = $2, folder_id = $3 WHERE id = $4 AND user_id = $5",
                             pqxx::params{enc_name.value(), name_hash.value(), folder_id.value(), file_id, user_id});
                } else {
                    txn.exec("UPDATE files SET folder_id = $1 WHERE id = $2 AND user_id = $3",
                             pqxx::params{folder_id.value(), file_id, user_id});
                }
            }
        } else {
            if (has_name) {
                txn.exec("UPDATE files SET encrypted_name = $1, name_hash = $2 WHERE id = $3 AND user_id = $4",
                         pqxx::params{enc_name.value(), name_hash.value(), file_id, user_id});
            }
        }
    }

    auto res = txn.exec(
        "SELECT encrypted_name, name_hash, folder_id FROM files WHERE id = $1", 
        pqxx::params{file_id}
    );
    
    crow::json::wvalue ret;
    ret["encrypted_name"] = res[0][0].as<std::string>();
    ret["name_hash"] = res[0][1].as<std::string>();
    
    if (res[0][2].is_null()) {
        ret["folder_id"] = nullptr;
    } else {
        ret["folder_id"] = res[0][2].as<int>();
    }

    txn.commit();
    return ret; 
}

std::string FileManager::share_file(uint64_t file_id, uint64_t user_id) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);

    auto result = txn.exec(
        "SELECT id FROM files WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
        pqxx::params{file_id, user_id}
    );
    if (result.empty()) {
        throw std::runtime_error("NOT_FOUND");
    }

    std::string uuid = generate_uuid_v4();

    txn.exec(
        "INSERT INTO shared_links (file_id, share_uuid) VALUES ($1, $2)",
        pqxx::params{file_id, uuid}
    );

    txn.commit();
    return uuid;
}

std::pair<uint64_t, std::string> FileManager::get_shared_file_info(const std::string& uuid) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);

    auto res = txn.exec(
        "SELECT f.id, f.encrypted_name "
        "FROM shared_links s "
        "JOIN files f ON s.file_id = f.id "
        "WHERE s.share_uuid = $1",
        pqxx::params{uuid}
    );

    if (res.empty()) {
        throw std::runtime_error("NOT_FOUND");
    }

    uint64_t file_id = res[0][0].as<uint64_t>();
    std::string enc_name = res[0][1].as<std::string>();

    txn.commit();
    
    return {file_id, enc_name}; 
}

crow::json::wvalue FileManager::get_trash(uint64_t user_id) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);

    auto file_rows = txn.exec(
        "SELECT id, encrypted_name, size_bytes FROM files WHERE user_id = $1 AND deleted_at IS NOT NULL",
        pqxx::params{user_id}
    );
    std::vector<crow::json::wvalue> files;
    for (const auto& row : file_rows) {
        crow::json::wvalue f;
        f["id"] = row[0].as<int>();
        f["encrypted_name"] = row[1].as<std::string>();
        f["size_bytes"] = row[2].as<int64_t>();
        files.push_back(std::move(f));
    }

    auto folder_rows = txn.exec(
        "SELECT id, encrypted_name FROM folders WHERE user_id = $1 AND deleted_at IS NOT NULL",
        pqxx::params{user_id}
    );
    std::vector<crow::json::wvalue> folders;
    for (const auto& row : folder_rows) {
        crow::json::wvalue d;
        d["id"] = row[0].as<int>();
        d["encrypted_name"] = row[1].as<std::string>();
        folders.push_back(std::move(d));
    }

    txn.commit();

    crow::json::wvalue res;
    res["files"] = std::move(files);
    res["folders"] = std::move(folders);
    return res;
}

void FileManager::restore_file(uint64_t file_id, uint64_t user_id) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);

    auto check = txn.exec(
        "SELECT folder_id, name_hash FROM files WHERE id = $1 AND user_id = $2 AND deleted_at IS NOT NULL",
        pqxx::params{file_id, user_id}
    );
    if (check.empty()) throw std::runtime_error("NOT_FOUND");

    std::string name_hash = check[0][1].as<std::string>();

    std::optional<uint64_t> folder_id;
    if (!check[0][0].is_null()) {
        folder_id = check[0][0].as<uint64_t>();
        auto parent_check = txn.exec(
            "SELECT deleted_at FROM folders WHERE id = $1 AND user_id = $2",
            pqxx::params{*folder_id, user_id}
        );
        if (!parent_check.empty() && !parent_check[0][0].is_null()) {
            folder_id.reset();
        }
    }

    std::string dup_query;
    pqxx::result dup_res;
    if (folder_id.has_value()) {
        dup_query = "SELECT id FROM files WHERE user_id = $1 AND name_hash = $2 AND deleted_at IS NULL AND folder_id = $3";
        dup_res = txn.exec(dup_query, pqxx::params{user_id, name_hash, *folder_id});
    } else {
        dup_query = "SELECT id FROM files WHERE user_id = $1 AND name_hash = $2 AND deleted_at IS NULL AND folder_id IS NULL";
        dup_res = txn.exec(dup_query, pqxx::params{user_id, name_hash});
    }

    if (!dup_res.empty()) {
        throw std::runtime_error("FILE_ALREADY_EXISTS");
    }

    if (folder_id.has_value()) {
        txn.exec(
            "UPDATE files SET deleted_at = NULL, folder_id = $1 WHERE id = $2 AND user_id = $3",
            pqxx::params{*folder_id, file_id, user_id}
        );
    } else {
        txn.exec(
            "UPDATE files SET deleted_at = NULL, folder_id = NULL WHERE id = $1 AND user_id = $2",
            pqxx::params{file_id, user_id}
        );
    }

    txn.commit();
}

void FileManager::empty_trash(uint64_t user_id, FileChunker* chunker) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);

    auto quota_release = txn.exec(
        "SELECT COALESCE(SUM(size_bytes), 0) FROM files WHERE user_id = $1 AND deleted_at IS NOT NULL",
        pqxx::params{user_id}
    );
    uint64_t freed_bytes = quota_release[0][0].as<uint64_t>();
    if (freed_bytes > 0) {
        txn.exec("UPDATE users SET used_storage_bytes = used_storage_bytes - $1 WHERE id = $2",
                 pqxx::params{freed_bytes, user_id});
    }

    auto files_to_delete = txn.exec(
        "SELECT id FROM files WHERE user_id = $1 AND deleted_at IS NOT NULL",
        pqxx::params{user_id}
    );

    for (const auto& row : files_to_delete) {
        auto fid = row[0].as<uint64_t>();
        if (chunker) chunker->delete_file(fid);
    }

    txn.exec("DELETE FROM files WHERE user_id = $1 AND deleted_at IS NOT NULL", pqxx::params{user_id});
    txn.exec("DELETE FROM folders WHERE user_id = $1 AND deleted_at IS NOT NULL", pqxx::params{user_id});

    txn.commit();
}

crow::json::wvalue FileManager::get_user_quota(uint64_t user_id) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);
    auto res = txn.exec("SELECT used_storage_bytes, max_storage_bytes FROM users WHERE id = $1", pqxx::params{user_id});
    if (res.empty()) throw std::runtime_error("NOT_FOUND");
    crow::json::wvalue json;
    json["used_bytes"] = res[0][0].as<uint64_t>();
    json["max_bytes"] = res[0][1].as<uint64_t>();
    txn.commit();
    return json;
}
