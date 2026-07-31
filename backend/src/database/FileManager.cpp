#include "database/FileManager.hpp"
#include "database/DatabasePool.hpp"
#include "storage/FileChunker.hpp"
#include "utils/utils.hpp"
#include <pqxx/pqxx>

namespace {
crow::json::wvalue serialize_storage_move(pqxx::transaction_base& txn, uint64_t user_id, uint64_t move_id) {
    auto jobs = txn.exec(
        "SELECT id, file_id, status, source_provider, source_external_storage_id, target_provider, target_external_storage_id, "
        "total_bytes, transferred_bytes, error_code, error_detail, created_at, updated_at, completed_at "
        "FROM storage_move_jobs WHERE id = $1 AND user_id = $2",
        pqxx::params{move_id, user_id});
    if (jobs.empty()) throw std::runtime_error("STORAGE_MOVE_NOT_FOUND");
    const auto& row = jobs[0];
    crow::json::wvalue job;
    job["id"] = row[0].as<int64_t>();
    job["file_id"] = row[1].as<int64_t>();
    job["status"] = row[2].as<std::string>();
    job["source_provider"] = row[3].as<std::string>();
    job["source_external_storage_id"] = row[4].is_null() ? crow::json::wvalue(nullptr) : crow::json::wvalue(row[4].as<int64_t>());
    job["target_provider"] = row[5].as<std::string>();
    job["target_external_storage_id"] = row[6].is_null() ? crow::json::wvalue(nullptr) : crow::json::wvalue(row[6].as<int64_t>());
    job["total_bytes"] = row[7].as<int64_t>();
    job["transferred_bytes"] = row[8].as<int64_t>();
    if (!row[9].is_null()) job["error_code"] = row[9].as<std::string>();
    if (!row[10].is_null()) job["error_detail"] = row[10].as<std::string>();
    job["created_at"] = row[11].as<std::string>();
    job["updated_at"] = row[12].as<std::string>();
    if (!row[13].is_null()) job["completed_at"] = row[13].as<std::string>();

    auto rows = txn.exec(
        "SELECT id, file_id, role, source_external_file_id, target_external_file_id, total_bytes, transferred_bytes, status "
        "FROM storage_move_items WHERE move_job_id = $1 ORDER BY id",
        pqxx::params{move_id});
    std::vector<crow::json::wvalue> items;
    for (const auto& item_row : rows) {
        crow::json::wvalue item;
        item["id"] = item_row[0].as<int64_t>();
        item["file_id"] = item_row[1].as<int64_t>();
        item["role"] = item_row[2].as<std::string>();
        if (!item_row[3].is_null()) item["source_external_file_id"] = item_row[3].as<std::string>();
        if (!item_row[4].is_null()) item["target_external_file_id"] = item_row[4].as<std::string>();
        item["total_bytes"] = item_row[5].as<int64_t>();
        item["transferred_bytes"] = item_row[6].as<int64_t>();
        item["status"] = item_row[7].as<std::string>();
        items.push_back(std::move(item));
    }
    job["items"] = std::move(items);
    return job;
}

uint64_t quota_charge(const std::string& provider, uint64_t ciphertext_bytes) {
    return provider == "local" ? ciphertext_bytes : 2048;
}
}

FileManager::FileManager(DatabasePool& pool) : pool_(pool) {}

int FileManager::init_upload(uint64_t user_id, std::optional<uint64_t> folder_id,
                              const std::string& enc_name, const std::string& name_hash,
                              const std::string& encrypted_fdk,
                              uint64_t size_bytes, int total_chunks,
                              std::optional<std::string> proxy_external_file_id,
                              std::optional<uint64_t> proxy_size_bytes,
                              std::optional<std::string> proxy_encrypted_fdk,
                              bool is_hidden) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);

    if (folder_id.has_value()) {
        auto folder_check = txn.exec(
            "SELECT id FROM folders WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
            pqxx::params{folder_id.value(), user_id}
        );
        if (folder_check.empty()) {
            throw std::runtime_error("FORBIDDEN");
        }
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

    pqxx::result conflict_check;
    if (folder_id.has_value()) {
        conflict_check = txn.exec(
            "SELECT id, is_upload_complete, size_bytes FROM files WHERE user_id = $1 AND folder_id = $2 AND name_hash = $3 AND deleted_at IS NULL",
            pqxx::params{user_id, folder_id.value(), name_hash}
        );
    } else {
        conflict_check = txn.exec(
            "SELECT id, is_upload_complete, size_bytes FROM files WHERE user_id = $1 AND folder_id IS NULL AND name_hash = $2 AND deleted_at IS NULL",
            pqxx::params{user_id, name_hash}
        );
    }

    if (!conflict_check.empty()) {
        bool is_complete = conflict_check[0][1].as<bool>();
        uint64_t existing_file_id = conflict_check[0][0].as<uint64_t>();
        uint64_t existing_size = conflict_check[0][2].as<uint64_t>();

        if (!is_complete) {
            txn.exec("DELETE FROM files WHERE id = $1", pqxx::params{existing_file_id});
            txn.exec("UPDATE users SET used_storage_bytes = used_storage_bytes - $1 WHERE id = $2",
                     pqxx::params{existing_size, user_id});
        } else {
            throw std::runtime_error("FILE_ALREADY_EXISTS");
        }
    }

    std::string proxy_ext_id = proxy_external_file_id.has_value() ? txn.quote(proxy_external_file_id.value()) : "NULL";
    std::string proxy_size = proxy_size_bytes.has_value() ? std::to_string(proxy_size_bytes.value()) : "NULL";
    std::string proxy_fdk = proxy_encrypted_fdk.has_value() ? txn.quote(proxy_encrypted_fdk.value()) : "NULL";

    std::string f_id = folder_id.has_value() ? std::to_string(folder_id.value()) : "NULL";
    std::string query = "INSERT INTO files (user_id, folder_id, encrypted_name, name_hash, encrypted_fdk, size_bytes, total_chunks, "
                        "proxy_external_file_id, proxy_size_bytes, proxy_encrypted_fdk, is_hidden) VALUES (" +
                        std::to_string(user_id) + ", " +
                        f_id + ", " +
                        txn.quote(enc_name) + ", " +
                        txn.quote(name_hash) + ", " +
                        txn.quote(encrypted_fdk) + ", " +
                        std::to_string(size_bytes) + ", " +
                        std::to_string(total_chunks) + ", " +
                        proxy_ext_id + ", " +
                        proxy_size + ", " +
                        proxy_fdk + ", " +
                        (is_hidden ? "TRUE" : "FALSE") +
                        ") RETURNING id";
    auto result = txn.exec(query);

    int file_id = result[0][0].as<int>();

    std::string physical_path = std::to_string(file_id) + ".dat";
    txn.exec(
        "UPDATE files SET physical_path = $1 WHERE id = $2",
        pqxx::params{physical_path, file_id}
    );

    txn.commit();
    return file_id;
}

void FileManager::mark_upload_complete(uint64_t file_id, uint64_t user_id) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);
    txn.exec(
        "UPDATE files SET is_upload_complete = true WHERE id = $1 AND user_id = $2",
        pqxx::params{file_id, user_id}
    );
    txn.commit();
}

bool FileManager::is_upload_complete(uint64_t file_id, uint64_t user_id) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);
    auto result = txn.exec(
        "SELECT is_upload_complete FROM files WHERE id = $1 AND user_id = $2",
        pqxx::params{file_id, user_id}
    );
    txn.commit();
    
    if (result.empty()) {
        throw std::runtime_error("NOT_FOUND");
    }
    
    return result[0][0].as<bool>();
}

int FileManager::get_total_chunks(uint64_t file_id, uint64_t user_id) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);
    auto result = txn.exec(
        "SELECT total_chunks FROM files WHERE id = $1 AND user_id = $2",
        pqxx::params{file_id, user_id}
    );
    txn.commit();
    if (result.empty()) throw std::runtime_error("NOT_FOUND");
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
        "SELECT id, folder_id, encrypted_name, size_bytes, encrypted_fdk, storage_provider, "
        "proxy_external_file_id, proxy_size_bytes, proxy_encrypted_fdk, is_hidden, external_storage_id FROM files "
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
        item["encrypted_fdk"] = row[4].as<std::string>();
        item["storage_provider"] = row[5].as<std::string>();
        
        if (!row[6].is_null()) item["proxy_external_file_id"] = row[6].as<std::string>();
        if (!row[7].is_null()) item["proxy_size_bytes"] = row[7].as<int64_t>();
        if (!row[8].is_null()) item["proxy_encrypted_fdk"] = row[8].as<std::string>();
        item["is_hidden"] = row[9].as<bool>();
        item["external_storage_id"] = row[10].is_null()
            ? crow::json::wvalue(nullptr)
            : crow::json::wvalue(row[10].as<int64_t>());

        files.push_back(std::move(item));
    }

    txn.commit();
    return files;
}

std::vector<crow::json::wvalue> FileManager::get_pending_uploads(uint64_t user_id) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);

    auto result = txn.exec(
        "SELECT id, folder_id, encrypted_name, size_bytes, total_chunks, encrypted_fdk, storage_provider, external_storage_id FROM files "
        "WHERE user_id = $1 AND is_upload_complete = false AND deleted_at IS NULL AND is_hidden = false "
        "ORDER BY id DESC",
        pqxx::params{user_id}
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
        item["total_chunks"] = row[4].as<int>();
        item["encrypted_fdk"] = row[5].as<std::string>();
        item["storage_provider"] = row[6].as<std::string>();
        item["external_storage_id"] = row[7].is_null()
            ? crow::json::wvalue(nullptr)
            : crow::json::wvalue(row[7].as<int64_t>());

        int file_id = row[0].as<int>();
        auto chunks_result = txn.exec(
            "SELECT COUNT(*) FROM file_chunks WHERE file_id = $1",
            pqxx::params{file_id}
        );
        int chunk_count = 0;
        if (!chunks_result.empty()) {
            chunk_count = chunks_result[0][0].as<int>();
        }
        item["uploaded_chunks_count"] = chunk_count;

        files.push_back(std::move(item));
    }

    txn.commit();
    return files;
}

crow::json::wvalue FileManager::get_storage_tree(uint64_t user_id,
                                                 const std::string& provider,
                                                 std::optional<uint64_t> external_storage_id,
                                                 std::optional<uint64_t> folder_id,
                                                 int limit, int offset) {
    if (provider != "local" && provider != "google_drive") throw std::invalid_argument("INVALID_PROVIDER");
    if (limit < 1 || limit > 100 || offset < 0) throw std::invalid_argument("INVALID_PAGINATION");
    if (provider == "local" && external_storage_id.has_value()) throw std::invalid_argument("LOCAL_STORAGE_ID_FORBIDDEN");
    if (provider == "google_drive" && !external_storage_id.has_value()) throw std::invalid_argument("EXTERNAL_STORAGE_ID_REQUIRED");

    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);

    if (external_storage_id.has_value()) {
        auto storage = txn.exec(
            "SELECT 1 FROM user_external_storages WHERE id = $1 AND user_id = $2 AND provider = 'google_drive'",
            pqxx::params{*external_storage_id, user_id});
        if (storage.empty()) throw std::runtime_error("STORAGE_NOT_FOUND");
    }
    if (folder_id.has_value()) {
        auto folder = txn.exec(
            "SELECT 1 FROM folders WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
            pqxx::params{*folder_id, user_id});
        if (folder.empty()) throw std::runtime_error("FOLDER_NOT_FOUND");
    }

    const std::string folder_predicate = "(($4::BIGINT = 0 AND f.parent_id IS NULL) OR ($4::BIGINT <> 0 AND f.parent_id = $4))";
    const std::string file_folder_predicate = "(($4::BIGINT = 0 AND fi.folder_id IS NULL) OR ($4::BIGINT <> 0 AND fi.folder_id = $4))";
    const int64_t storage_id = external_storage_id.has_value() ? static_cast<int64_t>(*external_storage_id) : 0;
    const int64_t current_folder = folder_id.has_value() ? static_cast<int64_t>(*folder_id) : 0;

    auto folder_rows = txn.exec(
        "WITH RECURSIVE subtree(root_id, id) AS ("
        " SELECT f.id, f.id FROM folders f WHERE f.user_id = $1 AND f.deleted_at IS NULL AND " + folder_predicate +
        " UNION ALL"
        " SELECT s.root_id, child.id FROM folders child JOIN subtree s ON child.parent_id = s.id"
        " WHERE child.user_id = $1 AND child.deleted_at IS NULL"
        ")"
        " SELECT f.id, f.parent_id, f.encrypted_name"
        " FROM folders f WHERE f.user_id = $1 AND f.deleted_at IS NULL AND " + folder_predicate +
        " AND EXISTS (SELECT 1 FROM subtree s JOIN files sf ON sf.folder_id = s.id"
        "   WHERE s.root_id = f.id AND sf.user_id = $1 AND sf.storage_provider = $2"
        "   AND (($2 = 'local' AND sf.external_storage_id IS NULL) OR ($2 = 'google_drive' AND sf.external_storage_id = $3))"
        "   AND sf.is_upload_complete = TRUE AND sf.is_hidden = FALSE AND sf.deleted_at IS NULL)"
        " ORDER BY f.id",
        pqxx::params{user_id, provider, storage_id, current_folder});

    auto count_rows = txn.exec(
        "SELECT COUNT(*) FROM files fi WHERE fi.user_id = $1 AND fi.storage_provider = $2"
        " AND (($2 = 'local' AND fi.external_storage_id IS NULL) OR ($2 = 'google_drive' AND fi.external_storage_id = $3))"
        " AND " + file_folder_predicate +
        " AND fi.is_upload_complete = TRUE AND fi.is_hidden = FALSE AND fi.deleted_at IS NULL",
        pqxx::params{user_id, provider, storage_id, current_folder});
    const int64_t total_files = count_rows[0][0].as<int64_t>();

    auto file_rows = txn.exec(
        "SELECT fi.id, fi.folder_id, fi.encrypted_name, fi.size_bytes, fi.encrypted_fdk, fi.storage_provider, fi.external_storage_id, fi.is_hidden"
        " FROM files fi WHERE fi.user_id = $1 AND fi.storage_provider = $2"
        " AND (($2 = 'local' AND fi.external_storage_id IS NULL) OR ($2 = 'google_drive' AND fi.external_storage_id = $3))"
        " AND " + file_folder_predicate +
        " AND fi.is_upload_complete = TRUE AND fi.is_hidden = FALSE AND fi.deleted_at IS NULL"
        " ORDER BY fi.id LIMIT $5 OFFSET $6",
        pqxx::params{user_id, provider, storage_id, current_folder, limit, offset});

    std::vector<crow::json::wvalue> folders;
    for (const auto& row : folder_rows) {
        crow::json::wvalue item;
        item["id"] = row[0].as<int64_t>();
        item["parent_id"] = row[1].is_null() ? crow::json::wvalue(nullptr) : crow::json::wvalue(row[1].as<int64_t>());
        item["encrypted_name"] = row[2].as<std::string>();
        folders.push_back(std::move(item));
    }

    std::vector<crow::json::wvalue> files;
    for (const auto& row : file_rows) {
        crow::json::wvalue item;
        item["id"] = row[0].as<int64_t>();
        item["folder_id"] = row[1].is_null() ? crow::json::wvalue(nullptr) : crow::json::wvalue(row[1].as<int64_t>());
        item["encrypted_name"] = row[2].as<std::string>();
        item["size_bytes"] = row[3].as<int64_t>();
        item["encrypted_fdk"] = row[4].as<std::string>();
        item["storage_provider"] = row[5].as<std::string>();
        item["external_storage_id"] = row[6].is_null() ? crow::json::wvalue(nullptr) : crow::json::wvalue(row[6].as<int64_t>());
        item["is_hidden"] = row[7].as<bool>();
        files.push_back(std::move(item));
    }

    crow::json::wvalue response;
    response["target"]["provider"] = provider;
    response["target"]["external_storage_id"] = external_storage_id.has_value()
        ? crow::json::wvalue(static_cast<int64_t>(*external_storage_id)) : crow::json::wvalue(nullptr);
    response["current_folder_id"] = folder_id.has_value()
        ? crow::json::wvalue(static_cast<int64_t>(*folder_id)) : crow::json::wvalue(nullptr);
    response["folders"] = std::move(folders);
    response["files"] = std::move(files);
    response["total_files"] = total_files;
    response["has_more"] = offset + static_cast<int>(file_rows.size()) < total_files;
    response["file_limit"] = limit;
    response["file_offset"] = offset;
    txn.commit();
    return response;
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

std::optional<std::string> FileManager::delete_file(uint64_t file_id, uint64_t user_id) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);

    auto result = txn.exec(
        "SELECT id FROM files WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
        pqxx::params{file_id, user_id}
    );

    if (result.empty()) {
        throw std::runtime_error("NOT_FOUND");
    }

    auto update_res = txn.exec(
        "UPDATE files SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1 AND user_id = $2 RETURNING external_file_id",
        pqxx::params{file_id, user_id}
    );

    std::optional<std::string> external_id;
    if (!update_res.empty() && !update_res[0][0].is_null()) {
        external_id = update_res[0][0].as<std::string>();
    }

    txn.commit();
    return external_id;
}

int FileManager::batch_delete_files(uint64_t user_id, const std::vector<int>& file_ids) {
    if (file_ids.empty()) return 0;
    
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);

    std::string array_str = "{";
    for (size_t i = 0; i < file_ids.size(); ++i) {
        array_str += std::to_string(file_ids[i]);
        if (i < file_ids.size() - 1) array_str += ",";
    }
    array_str += "}";

    auto result = txn.exec(
        "UPDATE files SET deleted_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND id = ANY($2::int[]) AND deleted_at IS NULL",
        pqxx::params{user_id, array_str}
    );

    txn.commit();
    return result.affected_rows();
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

    pqxx::result res;
    if (has_folder) {
        if (folder_id.value() == 0) {
            if (has_name) {
                res = txn.exec(
                    "UPDATE files SET encrypted_name = $1, name_hash = $2, folder_id = NULL "
                    "WHERE id = $3 AND user_id = $4 "
                    "RETURNING encrypted_name, name_hash, folder_id",
                    pqxx::params{enc_name.value(), name_hash.value(), file_id, user_id}
                );
            } else {
                res = txn.exec(
                    "UPDATE files SET folder_id = NULL WHERE id = $1 AND user_id = $2 "
                    "RETURNING encrypted_name, name_hash, folder_id",
                    pqxx::params{file_id, user_id}
                );
            }
        } else {
            if (has_name) {
                res = txn.exec(
                    "UPDATE files SET encrypted_name = $1, name_hash = $2, folder_id = $3 "
                    "WHERE id = $4 AND user_id = $5 "
                    "RETURNING encrypted_name, name_hash, folder_id",
                    pqxx::params{enc_name.value(), name_hash.value(), folder_id.value(), file_id, user_id}
                );
            } else {
                res = txn.exec(
                    "UPDATE files SET folder_id = $1 WHERE id = $2 AND user_id = $3 "
                    "RETURNING encrypted_name, name_hash, folder_id",
                    pqxx::params{folder_id.value(), file_id, user_id}
                );
            }
        }
    } else {
        res = txn.exec(
            "UPDATE files SET encrypted_name = $1, name_hash = $2 WHERE id = $3 AND user_id = $4 "
            "RETURNING encrypted_name, name_hash, folder_id",
            pqxx::params{enc_name.value(), name_hash.value(), file_id, user_id}
        );
    }

    if (res.empty()) {
        throw std::runtime_error("NOT_FOUND");
    }
    
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

std::string FileManager::share_file(uint64_t file_id, uint64_t user_id, const std::string& encrypted_name_fdk) {
    auto conn = pool_.acquire_connection();

    {
        pqxx::work txn(*conn);
        auto result = txn.exec(
            "SELECT id, storage_provider FROM files WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
            pqxx::params{file_id, user_id}
        );
        if (result.empty()) {
            throw std::runtime_error("NOT_FOUND");
        }
        const std::string provider = result[0][1].as<std::string>();
        if (provider == "google_drive") {
            throw std::runtime_error("SHARING_UNSUPPORTED_PROVIDER");
        }
    }

    {
        pqxx::work txn(*conn);
        auto rl_res = txn.exec(
            "SELECT hourly_changes FROM shared_links WHERE file_id = $1 AND last_changed_at >= NOW() - INTERVAL '1 hour'",
            pqxx::params{file_id}
        );
        if (!rl_res.empty() && rl_res[0][0].as<int>() >= 10) {
            throw std::runtime_error("TOO_MANY_REQUESTS");
        }
    }

    for (int attempts = 0; attempts < 3; ++attempts) {
        std::string token = Base62Generator::generate(7);
        try {
            pqxx::work txn(*conn);
            txn.exec(
                "INSERT INTO shared_links (file_id, share_uuid, encrypted_name_fdk, hourly_changes, last_changed_at) "
                "VALUES ($1, $2, $3, 1, CURRENT_TIMESTAMP) "
                "ON CONFLICT (file_id) DO UPDATE SET "
                "    share_uuid = EXCLUDED.share_uuid, "
                "    encrypted_name_fdk = EXCLUDED.encrypted_name_fdk, "
                "    hourly_changes = CASE "
                "        WHEN shared_links.last_changed_at >= NOW() - INTERVAL '1 hour' THEN shared_links.hourly_changes + 1 "
                "        ELSE 1 "
                "    END, "
                "    last_changed_at = CURRENT_TIMESTAMP",
                pqxx::params{file_id, token, encrypted_name_fdk}
            );
            txn.commit();
            return token;
        } catch (const pqxx::unique_violation&) {
            if (attempts == 2) {
                throw std::runtime_error("ERROR_GENERATING_SHARE_LINK");
            }
        }
    }
    throw std::runtime_error("ERROR_GENERATING_SHARE_LINK");
}

FileManager::SharedFileInfo FileManager::get_shared_file_info(const std::string& uuid) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);

    auto res = txn.exec(
        "SELECT f.id, f.encrypted_name, f.size_bytes "
        "FROM shared_links s "
        "JOIN files f ON s.file_id = f.id "
        "WHERE s.share_uuid = $1 AND f.storage_provider = 'local' "
        "AND f.deleted_at IS NULL AND f.is_upload_complete = TRUE",
        pqxx::params{uuid}
    );

    if (res.empty()) {
        throw std::runtime_error("NOT_FOUND");
    }

    SharedFileInfo info;
    info.file_id = res[0][0].as<uint64_t>();
    info.encrypted_name = res[0][1].as<std::string>();
    info.size_bytes = res[0][2].as<size_t>();

    txn.commit();
    return info;
}

crow::json::wvalue FileManager::get_trash(uint64_t user_id) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);

    auto file_rows = txn.exec(
        "SELECT id, encrypted_name, size_bytes, folder_id, storage_provider, external_storage_id FROM files WHERE user_id = $1 AND deleted_at IS NOT NULL",
        pqxx::params{user_id}
    );
    std::vector<crow::json::wvalue> files;
    for (const auto& row : file_rows) {
        crow::json::wvalue f;
        f["id"] = row[0].as<int>();
        f["encrypted_name"] = row[1].as<std::string>();
        f["size_bytes"] = row[2].as<int64_t>();
        if (!row[3].is_null()) {
            f["folder_id"] = row[3].as<int>();
        } else {
            f["folder_id"] = nullptr;
        }
        f["storage_provider"] = row[4].as<std::string>();
        f["external_storage_id"] = row[5].is_null()
            ? crow::json::wvalue(nullptr)
            : crow::json::wvalue(row[5].as<int64_t>());
        files.push_back(std::move(f));
    }

    auto folder_rows = txn.exec(
        "SELECT id, encrypted_name, parent_id FROM folders WHERE user_id = $1 AND deleted_at IS NOT NULL",
        pqxx::params{user_id}
    );
    std::vector<crow::json::wvalue> folders;
    for (const auto& row : folder_rows) {
        crow::json::wvalue d;
        d["id"] = row[0].as<int>();
        d["encrypted_name"] = row[1].as<std::string>();
        if (!row[2].is_null()) {
            d["parent_id"] = row[2].as<int>();
        } else {
            d["parent_id"] = nullptr;
        }
        folders.push_back(std::move(d));
    }

    txn.commit();

    crow::json::wvalue res;
    res["files"] = std::move(files);
    res["folders"] = std::move(folders);
    return res;
}

std::optional<std::string> FileManager::restore_file(uint64_t file_id, uint64_t user_id) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);

    try {
        auto res = txn.exec(
            "UPDATE files "
            "SET deleted_at = NULL, "
            "    folder_id = ("
            "        SELECT CASE WHEN deleted_at IS NOT NULL THEN NULL ELSE id END "
            "        FROM folders WHERE id = files.folder_id"
            "    ) "
            "WHERE id = $1 AND user_id = $2 AND deleted_at IS NOT NULL "
            "RETURNING external_file_id",
            pqxx::params{file_id, user_id}
        );

        if (res.empty()) {
            throw std::runtime_error("NOT_FOUND");
        }

        std::optional<std::string> external_id;
        if (!res[0][0].is_null()) {
            external_id = res[0][0].as<std::string>();
        }

        txn.commit();
        return external_id;
    } catch (const pqxx::unique_violation&) {
        throw std::runtime_error("FILE_ALREADY_EXISTS");
    }
}

std::optional<std::string> FileManager::hard_delete_file(uint64_t file_id, uint64_t user_id, FileChunker* chunker) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);

    auto deleted_files_res = txn.exec(
        "WITH deleted_file AS ("
        "  DELETE FROM files WHERE id = $1 AND user_id = $2 AND deleted_at IS NOT NULL "
        "  RETURNING id, storage_provider, size_bytes, external_file_id, external_storage_id"
        ") "
        "SELECT id, storage_provider, size_bytes, external_file_id, external_storage_id FROM deleted_file",
        pqxx::params{file_id, user_id}
    );

    if (deleted_files_res.empty()) {
        throw std::runtime_error("NOT_FOUND");
    }

    auto row = deleted_files_res[0];
    auto fid = row[0].as<uint64_t>();
    std::string provider = row[1].as<std::string>();
    uint64_t size = row[2].as<uint64_t>();
    
    uint64_t freed_bytes = (provider == "local") ? size : 2048;
    
    std::optional<std::string> ext_file_id_opt;

    if (provider == "google_drive") {
        if (!row[3].is_null() && !row[4].is_null()) {
            std::string ext_file_id = row[3].as<std::string>();
            ext_file_id_opt = ext_file_id;
            txn.exec("INSERT INTO pending_external_deletions (external_file_id, external_storage_id) VALUES ($1, $2)",
                     pqxx::params{ext_file_id, row[4].as<uint64_t>()});
        }
    } else {
        if (chunker) chunker->delete_file(fid);
    }

    if (freed_bytes > 0) {
        txn.exec("UPDATE users SET used_storage_bytes = GREATEST(0, used_storage_bytes - $1) WHERE id = $2",
                 pqxx::params{freed_bytes, user_id});
    }

    txn.commit();
    return ext_file_id_opt;
}

BatchHardDeleteResult FileManager::batch_hard_delete_files(uint64_t user_id, const std::vector<int>& file_ids, FileChunker* chunker) {
    if (file_ids.empty()) return {};

    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);

    std::string arr_str = "{";
    for (size_t i = 0; i < file_ids.size(); ++i) {
        arr_str += std::to_string(file_ids[i]);
        if (i < file_ids.size() - 1) arr_str += ",";
    }
    arr_str += "}";

    auto deleted_files_res = txn.exec(
        "WITH deleted_files AS ("
        "  DELETE FROM files WHERE id = ANY($1::int[]) AND user_id = $2 AND deleted_at IS NOT NULL "
        "  RETURNING id, storage_provider, size_bytes, external_file_id, external_storage_id"
        ") "
        "SELECT id, storage_provider, size_bytes, external_file_id, external_storage_id FROM deleted_files",
        pqxx::params{arr_str, user_id}
    );

    BatchHardDeleteResult result;
    uint64_t total_freed_bytes = 0;

    for (auto row : deleted_files_res) {
        auto fid = row[0].as<uint64_t>();
        std::string provider = row[1].as<std::string>();
        uint64_t size = row[2].as<uint64_t>();
        
        uint64_t freed_bytes = (provider == "local") ? size : 2048;
        total_freed_bytes += freed_bytes;

        if (provider == "google_drive") {
            if (!row[3].is_null() && !row[4].is_null()) {
                std::string ext_file_id = row[3].as<std::string>();
                result.external_files.push_back(ext_file_id);
                txn.exec("INSERT INTO pending_external_deletions (external_file_id, external_storage_id) VALUES ($1, $2)",
                         pqxx::params{ext_file_id, row[4].as<uint64_t>()});
            }
        } else {
            if (chunker) chunker->delete_file(fid);
        }
        result.deleted_count++;
    }

    if (total_freed_bytes > 0) {
        txn.exec("UPDATE users SET used_storage_bytes = GREATEST(0, used_storage_bytes - $1) WHERE id = $2",
                 pqxx::params{total_freed_bytes, user_id});
    }

    txn.commit();
    return result;
}

std::vector<std::string> FileManager::empty_trash(uint64_t user_id, FileChunker* chunker) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);

    auto deleted_files_res = txn.exec(
        "WITH deleted_files AS ("
        "  DELETE FROM files WHERE user_id = $1 AND deleted_at IS NOT NULL "
        "  RETURNING id, storage_provider, size_bytes, external_file_id, external_storage_id"
        ") "
        "SELECT id, storage_provider, size_bytes, external_file_id, external_storage_id FROM deleted_files",
        pqxx::params{user_id}
    );

    uint64_t freed_bytes = 0;
    std::vector<std::string> external_files;

    for (const auto& row : deleted_files_res) {
        auto fid = row[0].as<uint64_t>();
        std::string provider = row[1].as<std::string>();
        uint64_t size = row[2].as<uint64_t>();
        
        freed_bytes += (provider == "local") ? size : 2048;
        
        if (provider == "google_drive") {
            if (!row[3].is_null() && !row[4].is_null()) {
                std::string ext_file_id = row[3].as<std::string>();
                external_files.push_back(ext_file_id);
                txn.exec("INSERT INTO pending_external_deletions (external_file_id, external_storage_id) VALUES ($1, $2)",
                         pqxx::params{ext_file_id, row[4].as<uint64_t>()});
            }
        } else {
            if (chunker) chunker->delete_file(fid);
        }
    }

    if (freed_bytes > 0) {
        txn.exec("UPDATE users SET used_storage_bytes = GREATEST(0, used_storage_bytes - $1) WHERE id = $2",
                 pqxx::params{freed_bytes, user_id});
    }

    txn.exec("DELETE FROM folders WHERE user_id = $1 AND deleted_at IS NOT NULL", pqxx::params{user_id});

    txn.commit();
    return external_files;
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


int FileManager::init_external_upload(uint64_t user_id, std::optional<uint64_t> folder_id,
                                       const std::string& enc_name, const std::string& name_hash,
                                       const std::string& encrypted_fdk,
                                       uint64_t size_bytes, const std::string& storage_provider,
                                       std::optional<uint64_t> external_storage_id,
                                       std::optional<std::string> proxy_external_file_id,
                                       std::optional<uint64_t> proxy_size_bytes,
                                       std::optional<std::string> proxy_encrypted_fdk,
                                       bool is_hidden) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);

    if (folder_id.has_value()) {
        auto folder_check = txn.exec(
            "SELECT id FROM folders WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
            pqxx::params{folder_id.value(), user_id}
        );
        if (folder_check.empty()) {
            throw std::runtime_error("FORBIDDEN");
        }
    }

    auto check_quota = txn.exec(
        "SELECT used_storage_bytes, max_storage_bytes FROM users WHERE id = $1 FOR UPDATE",
        pqxx::params{user_id}
    );
    if (check_quota.empty()) throw std::runtime_error("NOT_FOUND");
    uint64_t used = check_quota[0][0].as<uint64_t>();
    uint64_t max = check_quota[0][1].as<uint64_t>();
    uint64_t metadata_cost = 2048; 
    if (used + metadata_cost > max) {
        throw std::runtime_error("QUOTA_EXCEEDED");
    }

    txn.exec("UPDATE users SET used_storage_bytes = used_storage_bytes + $1 WHERE id = $2",
             pqxx::params{metadata_cost, user_id});

    pqxx::result conflict_check;
    if (folder_id.has_value()) {
        conflict_check = txn.exec(
            "SELECT id, is_upload_complete, size_bytes FROM files WHERE user_id = $1 AND folder_id = $2 AND name_hash = $3 AND deleted_at IS NULL",
            pqxx::params{user_id, folder_id.value(), name_hash}
        );
    } else {
        conflict_check = txn.exec(
            "SELECT id, is_upload_complete, size_bytes FROM files WHERE user_id = $1 AND folder_id IS NULL AND name_hash = $2 AND deleted_at IS NULL",
            pqxx::params{user_id, name_hash}
        );
    }

    if (!conflict_check.empty()) {
        bool is_complete = conflict_check[0][1].as<bool>();
        uint64_t existing_file_id = conflict_check[0][0].as<uint64_t>();

        if (!is_complete) {
            txn.exec("DELETE FROM files WHERE id = $1", pqxx::params{existing_file_id});
            txn.exec("UPDATE users SET used_storage_bytes = used_storage_bytes - $1 WHERE id = $2",
                     pqxx::params{metadata_cost, user_id});
        } else {
            throw std::runtime_error("FILE_ALREADY_EXISTS");
        }
    }

    std::string proxy_ext_id = proxy_external_file_id.has_value() ? txn.quote(proxy_external_file_id.value()) : "NULL";
    std::string proxy_size = proxy_size_bytes.has_value() ? std::to_string(proxy_size_bytes.value()) : "NULL";
    std::string proxy_fdk = proxy_encrypted_fdk.has_value() ? txn.quote(proxy_encrypted_fdk.value()) : "NULL";

    std::string f_id = folder_id.has_value() ? std::to_string(folder_id.value()) : "NULL";
    std::string ext_id = external_storage_id.has_value() ? std::to_string(external_storage_id.value()) : "NULL";

    std::string query = "INSERT INTO files (user_id, folder_id, encrypted_name, name_hash, encrypted_fdk, size_bytes, total_chunks, "
                        "is_upload_complete, storage_provider, external_storage_id, proxy_external_file_id, proxy_size_bytes, "
                        "proxy_encrypted_fdk, is_hidden) VALUES (" +
                        std::to_string(user_id) + ", " +
                        f_id + ", " +
                        txn.quote(enc_name) + ", " +
                        txn.quote(name_hash) + ", " +
                        txn.quote(encrypted_fdk) + ", " +
                        std::to_string(size_bytes) + ", " +
                        "0, FALSE, " +
                        txn.quote(storage_provider) + ", " +
                        ext_id + ", " +
                        proxy_ext_id + ", " +
                        proxy_size + ", " +
                        proxy_fdk + ", " +
                        (is_hidden ? "TRUE" : "FALSE") +
                        ") RETURNING id";
    auto result = txn.exec(query);

    int file_id = result[0][0].as<int>();
    txn.commit();
    return file_id;
}

std::vector<BatchInitResult> FileManager::batch_init_uploads(uint64_t user_id, const std::vector<BatchInitItem>& files) {
    if (files.empty()) return {};

    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);

    uint64_t total_local_bytes = 0;
    uint64_t total_metadata_cost = 0;
    const uint64_t metadata_cost = 2048;

    for (const auto& file : files) {
        if (file.folder_id.has_value()) {
            auto folder_check = txn.exec(
                "SELECT id FROM folders WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
                pqxx::params{file.folder_id.value(), user_id}
            );
            if (folder_check.empty()) {
                throw std::runtime_error("FORBIDDEN_FOLDER");
            }
        }
        if (file.storage_provider == "local") {
            total_local_bytes += file.size_bytes;
        } else {
            total_metadata_cost += metadata_cost;
        }
    }

    uint64_t total_cost = total_local_bytes + total_metadata_cost;

    auto check_quota = txn.exec(
        "SELECT used_storage_bytes, max_storage_bytes FROM users WHERE id = $1 FOR UPDATE",
        pqxx::params{user_id}
    );
    if (check_quota.empty()) throw std::runtime_error("NOT_FOUND");
    
    uint64_t used = check_quota[0][0].as<uint64_t>();
    uint64_t max = check_quota[0][1].as<uint64_t>();
    
    if (used + total_cost > max) {
        throw std::runtime_error("QUOTA_EXCEEDED");
    }

    txn.exec("UPDATE users SET used_storage_bytes = used_storage_bytes + $1 WHERE id = $2",
             pqxx::params{total_cost, user_id});

    std::string query = "INSERT INTO files (user_id, folder_id, encrypted_name, name_hash, encrypted_fdk, "
                        "size_bytes, total_chunks, is_upload_complete, storage_provider, external_storage_id, "
                        "proxy_external_file_id, proxy_size_bytes, proxy_encrypted_fdk, is_hidden) VALUES ";

    for (size_t i = 0; i < files.size(); ++i) {
        if (i > 0) query += ", ";
        
        std::string f_id = files[i].folder_id.has_value() ? std::to_string(files[i].folder_id.value()) : "NULL";
        std::string ext_id = files[i].external_storage_id.has_value() ? std::to_string(files[i].external_storage_id.value()) : "NULL";
        int chunks = files[i].storage_provider == "local" ? files[i].total_chunks : 0;
        // External uploads become complete only after finalize_external_upload stores the provider ID.
        bool is_complete = false;
        
        std::string proxy_ext_id = files[i].proxy_external_file_id.has_value() ? txn.quote(files[i].proxy_external_file_id.value()) : "NULL";
        std::string proxy_size = files[i].proxy_size_bytes.has_value() ? std::to_string(files[i].proxy_size_bytes.value()) : "NULL";
        std::string proxy_fdk = files[i].proxy_encrypted_fdk.has_value() ? txn.quote(files[i].proxy_encrypted_fdk.value()) : "NULL";
        std::string is_hidden = files[i].is_hidden ? "TRUE" : "FALSE";
        
        query += "(" + std::to_string(user_id) + ", " + 
                 f_id + ", " + 
                 txn.quote(files[i].enc_name) + ", " + 
                 txn.quote(files[i].name_hash) + ", " + 
                 txn.quote(files[i].encrypted_fdk) + ", " + 
                 std::to_string(files[i].size_bytes) + ", " + 
                 std::to_string(chunks) + ", " + 
                 (is_complete ? "TRUE" : "FALSE") + ", " +
                 txn.quote(files[i].storage_provider) + ", " + 
                 ext_id + ", " + 
                 proxy_ext_id + ", " + 
                 proxy_size + ", " + 
                 proxy_fdk + ", " +
                 is_hidden + ")";
    }

    query += " RETURNING id, name_hash, storage_provider";

    std::vector<BatchInitResult> results;
    std::vector<int> local_ids;

    try {
        auto result = txn.exec(query);
        for (auto row : result) {
            BatchInitResult res;
            res.file_id = row[0].as<int>();
            res.name_hash = row[1].as<std::string>();
            res.storage_provider = row[2].as<std::string>();
            
            if (res.storage_provider == "local") {
                local_ids.push_back(static_cast<int>(res.file_id));
            }
            results.push_back(res);
        }

        if (!local_ids.empty()) {
            std::string update_query = "UPDATE files SET physical_path = id || '.dat' WHERE id = ANY($1::int[]) AND physical_path IS NULL";
            std::string ids_array = "{";
            for (size_t i = 0; i < local_ids.size(); ++i) {
                if (i > 0) ids_array += ",";
                ids_array += std::to_string(local_ids[i]);
            }
            ids_array += "}";
            txn.exec(update_query, pqxx::params{ids_array});
        }

        txn.commit();
        return results;
    } catch (const pqxx::unique_violation& e) {
        throw std::runtime_error("FILE_ALREADY_EXISTS");
    }
}

void FileManager::finalize_external_upload(uint64_t file_id, uint64_t user_id,
                                            const std::string& external_file_id) {
    if (external_file_id.empty()) {
        throw std::invalid_argument("EXTERNAL_FILE_ID_REQUIRED");
    }

    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);

    auto result = txn.exec(
        "SELECT storage_provider, is_upload_complete FROM files "
        "WHERE id = $1 AND deleted_at IS NULL",
        pqxx::params{file_id}
    );

    if (result.empty()) {
        throw std::runtime_error("NOT_FOUND");
    }

    auto owner_check = txn.exec(
        "SELECT id FROM files WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
        pqxx::params{file_id, user_id}
    );
    if (owner_check.empty()) {
        throw std::runtime_error("FORBIDDEN");
    }

    std::string provider = result[0][0].as<std::string>();
    bool already_complete = result[0][1].as<bool>();

    if (provider == "local") {
        throw std::runtime_error("INVALID_STORAGE_PROVIDER");
    }

    if (already_complete) {
        throw std::runtime_error("ALREADY_COMPLETE");
    }

    txn.exec(
        "UPDATE files SET external_file_id = $1, is_upload_complete = true "
        "WHERE id = $2 AND user_id = $3",
        pqxx::params{external_file_id, file_id, user_id}
    );

    txn.commit();
}

std::string FileManager::get_storage_provider(uint64_t file_id, uint64_t user_id) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);

    auto result = txn.exec(
        "SELECT storage_provider FROM files WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
        pqxx::params{file_id, user_id}
    );

    txn.commit();

    if (result.empty()) {
        throw std::runtime_error("NOT_FOUND");
    }

    return result[0][0].is_null() ? "local" : result[0][0].as<std::string>();
}

std::string FileManager::get_file_name(uint64_t file_id, uint64_t user_id) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);
    auto result = txn.exec(
        "SELECT encrypted_name FROM files WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
        pqxx::params{file_id, user_id}
    );
    txn.commit();
    if (result.empty()) {
        throw std::runtime_error("NOT_FOUND");
    }
    return result[0][0].as<std::string>();
}

std::vector<ExternalSyncFile> FileManager::get_external_sync_map(uint64_t user_id, uint64_t external_storage_id) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);

    auto result = txn.exec(
        "SELECT id, external_file_id FROM files "
        "WHERE user_id = $1 AND external_storage_id = $2 AND deleted_at IS NULL AND external_file_id IS NOT NULL",
        pqxx::params{user_id, external_storage_id}
    );
    txn.commit();

    std::vector<ExternalSyncFile> map;
    for (const auto& row : result) {
        map.push_back({
            row[0].as<uint64_t>(),
            row[1].as<std::string>()
        });
    }
    return map;
}

void FileManager::cleanup_external_sync(uint64_t user_id, uint64_t external_storage_id, const std::vector<std::string>& missing_external_ids) {
    if (missing_external_ids.empty()) return;

    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);

    std::string array_literal = "{";
    for (size_t i = 0; i < missing_external_ids.size(); ++i) {
        if (i > 0) array_literal += ",";
        array_literal += "\"" + txn.esc(missing_external_ids[i]) + "\"";
    }
    array_literal += "}";


    txn.exec(
        "UPDATE files SET deleted_at = CURRENT_TIMESTAMP "
        "WHERE user_id = $1 AND external_storage_id = $2 AND external_file_id = ANY($3::text[]) AND deleted_at IS NULL",
        pqxx::params{user_id, external_storage_id, array_literal}
    );

    txn.commit();
}

std::vector<crow::json::wvalue> FileManager::list_shares(uint64_t file_id, uint64_t user_id) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);

    auto owner_check = txn.exec(
        "SELECT id FROM files WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
        pqxx::params{file_id, user_id}
    );
    if (owner_check.empty()) {
        throw std::runtime_error("NOT_FOUND");
    }

    auto res = txn.exec(
        "SELECT id, share_uuid, to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') FROM shared_links WHERE file_id = $1",
        pqxx::params{file_id}
    );

    std::vector<crow::json::wvalue> shares;
    for (const auto& row : res) {
        crow::json::wvalue share;
        share["id"] = row[0].as<int>();
        share["share_id"] = row[1].as<std::string>();
        share["created_at"] = row[2].as<std::string>();
        shares.push_back(std::move(share));
    }

    txn.commit();
    return shares;
}

void FileManager::revoke_share(const std::string& share_uuid, uint64_t user_id) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);

    auto res = txn.exec(
        "SELECT f.id FROM shared_links s "
        "JOIN files f ON s.file_id = f.id "
        "WHERE s.share_uuid = $1 AND f.user_id = $2",
        pqxx::params{share_uuid, user_id}
    );

    if (res.empty()) {
        throw std::runtime_error("NOT_FOUND");
    }

    txn.exec(
        "DELETE FROM shared_links WHERE share_uuid = $1",
        pqxx::params{share_uuid}
    );

    txn.commit();
}

crow::json::wvalue FileManager::get_shared_file_metadata(const std::string& uuid) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);

    auto res = txn.exec(
        "SELECT s.encrypted_name_fdk, f.size_bytes "
        "FROM shared_links s "
        "JOIN files f ON s.file_id = f.id "
        "WHERE s.share_uuid = $1 AND f.storage_provider = 'local' "
        "AND f.deleted_at IS NULL AND f.is_upload_complete = TRUE",
        pqxx::params{uuid}
    );

    if (res.empty()) {
        throw std::runtime_error("NOT_FOUND");
    }

    crow::json::wvalue meta;
    meta["encrypted_name"] = res[0][0].as<std::string>();
    meta["size_bytes"] = res[0][1].as<uint64_t>();
    meta["storage_provider"] = "local";

    txn.commit();
    return meta;
}

crow::json::wvalue FileManager::start_storage_move(uint64_t user_id, uint64_t file_id,
                                                   const std::string& target_provider,
                                                   std::optional<uint64_t> target_external_storage_id,
                                                   std::optional<uint64_t> target_available_bytes) {
    if (target_provider != "local" && target_provider != "google_drive") throw std::invalid_argument("STORAGE_TARGET_NOT_FOUND");
    if (target_provider == "local" && target_external_storage_id.has_value()) throw std::invalid_argument("STORAGE_TARGET_NOT_FOUND");
    if (target_provider == "google_drive" && !target_external_storage_id.has_value()) throw std::invalid_argument("STORAGE_TARGET_NOT_FOUND");

    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);
    auto user = txn.exec("SELECT used_storage_bytes, max_storage_bytes FROM users WHERE id = $1 FOR UPDATE", pqxx::params{user_id});
    if (user.empty()) throw std::runtime_error("NOT_FOUND");
    auto files = txn.exec(
        "SELECT storage_provider, external_storage_id, size_bytes, proxy_external_file_id, proxy_physical_path, proxy_size_bytes, "
        "external_file_id, is_upload_complete, is_hidden, deleted_at IS NOT NULL FROM files WHERE id = $1 AND user_id = $2 FOR UPDATE",
        pqxx::params{file_id, user_id});
    if (files.empty()) throw std::runtime_error("NOT_FOUND");
    const auto& file = files[0];
    if (!file[7].as<bool>() || file[8].as<bool>() || file[9].as<bool>()) throw std::runtime_error("STORAGE_MOVE_INVALID_STATE");
    const std::string source_provider = file[0].as<std::string>();
    const std::optional<uint64_t> source_storage = file[1].is_null()
        ? std::nullopt : std::optional<uint64_t>(file[1].as<uint64_t>());
    if (source_provider == target_provider && source_storage == target_external_storage_id) throw std::runtime_error("SAME_STORAGE_TARGET");

    if (target_external_storage_id.has_value()) {
        auto target = txn.exec(
            "SELECT is_unlinking FROM user_external_storages WHERE id = $1 AND user_id = $2 AND provider = 'google_drive' FOR UPDATE",
            pqxx::params{*target_external_storage_id, user_id});
        if (target.empty()) throw std::runtime_error("STORAGE_TARGET_NOT_FOUND");
        if (target[0][0].as<bool>()) throw std::runtime_error("STORAGE_TARGET_UNAVAILABLE");
    }
    if (source_provider == "local" && target_provider == "google_drive") {
        auto shares = txn.exec("SELECT 1 FROM shared_links WHERE file_id = $1", pqxx::params{file_id});
        if (!shares.empty()) throw std::runtime_error("ACTIVE_PUBLIC_SHARE");
    }

    const uint64_t original_size = file[2].as<uint64_t>();
    const bool has_proxy = !file[5].is_null() &&
        ((source_provider == "google_drive" && !file[3].is_null()) || (source_provider == "local" && !file[4].is_null()));
    const uint64_t proxy_size = has_proxy ? file[5].as<uint64_t>() : 0;
    const uint64_t total_bytes = original_size + proxy_size;
    auto reserved = txn.exec(
        "SELECT COALESCE(SUM(reserved_bytes), 0) FROM storage_move_jobs WHERE user_id = $1 "
        "AND target_provider = $2 AND (($2 = 'local' AND target_external_storage_id IS NULL) OR target_external_storage_id = $3) "
        "AND status IN ('prepared','transferring','paused','target_uploaded','committing','cleanup_pending')",
        pqxx::params{user_id, target_provider, target_external_storage_id.value_or(0)});
    const uint64_t already_reserved = reserved[0][0].as<uint64_t>();
    if (target_provider == "local") {
        const uint64_t used = user[0][0].as<uint64_t>();
        const uint64_t max = user[0][1].as<uint64_t>();
        if (total_bytes > max || used > max - total_bytes || already_reserved > max - used - total_bytes) {
            throw std::runtime_error("INSUFFICIENT_STORAGE");
        }
    } else if (target_available_bytes.has_value() &&
               (total_bytes > *target_available_bytes || already_reserved > *target_available_bytes - total_bytes)) {
        throw std::runtime_error("INSUFFICIENT_STORAGE");
    }

    auto inserted = txn.exec(
        "INSERT INTO storage_move_jobs (user_id, file_id, source_provider, source_external_storage_id, target_provider, target_external_storage_id, total_bytes, reserved_bytes) "
        "VALUES ($1,$2,$3,$4,$5,$6,$7,$7) RETURNING id",
        pqxx::params{user_id, file_id, source_provider, source_storage, target_provider, target_external_storage_id, total_bytes});
    const uint64_t move_id = inserted[0][0].as<uint64_t>();
    txn.exec(
        "INSERT INTO storage_move_items (move_job_id, file_id, role, source_external_file_id, total_bytes) VALUES ($1,$2,'original',$3,$4)",
        pqxx::params{move_id, file_id,
            source_provider == "google_drive" && !file[6].is_null() ? std::optional<std::string>(file[6].as<std::string>()) : std::nullopt,
            original_size});
    if (has_proxy) {
        txn.exec(
            "INSERT INTO storage_move_items (move_job_id, file_id, role, source_external_file_id, total_bytes) VALUES ($1,$2,'proxy',$3,$4)",
            pqxx::params{move_id, file_id,
                source_provider == "google_drive" ? std::optional<std::string>(file[3].as<std::string>()) : std::nullopt,
                proxy_size});
    }
    auto response = serialize_storage_move(txn, user_id, move_id);
    txn.commit();
    return response;
}

crow::json::wvalue FileManager::get_storage_move(uint64_t user_id, uint64_t move_id) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);
    auto result = serialize_storage_move(txn, user_id, move_id);
    txn.commit();
    return result;
}

crow::json::wvalue FileManager::get_active_storage_moves(uint64_t user_id) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);
    auto rows = txn.exec(
        "SELECT id FROM storage_move_jobs WHERE user_id = $1 AND status IN ('prepared','transferring','paused','target_uploaded','committing','cleanup_pending') ORDER BY created_at",
        pqxx::params{user_id});
    std::vector<crow::json::wvalue> jobs;
    for (const auto& row : rows) jobs.push_back(serialize_storage_move(txn, user_id, row[0].as<uint64_t>()));
    crow::json::wvalue response;
    response["moves"] = std::move(jobs);
    txn.commit();
    return response;
}

void FileManager::set_storage_move_status(uint64_t user_id, uint64_t move_id, const std::string& status) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);
    pqxx::result result;
    if (status == "paused") {
        result = txn.exec(
            "UPDATE storage_move_jobs SET status = 'paused', updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND user_id = $2 AND status IN ('prepared','transferring') RETURNING id",
            pqxx::params{move_id, user_id});
    } else if (status == "transferring") {
        result = txn.exec(
            "UPDATE storage_move_jobs SET status = 'transferring', updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND user_id = $2 AND status IN ('prepared','paused','transferring') RETURNING id",
            pqxx::params{move_id, user_id});
    } else {
        throw std::invalid_argument("STORAGE_MOVE_INVALID_STATE");
    }
    if (result.empty()) throw std::runtime_error("STORAGE_MOVE_INVALID_STATE");
    txn.commit();
}

uint64_t FileManager::record_storage_move_chunk(uint64_t user_id, uint64_t move_id, uint64_t item_id,
                                                int chunk_index, uint64_t size_bytes) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);
    auto item = txn.exec(
        "SELECT i.total_bytes, j.target_provider, j.status FROM storage_move_items i JOIN storage_move_jobs j ON j.id = i.move_job_id "
        "WHERE i.id = $1 AND i.move_job_id = $2 AND j.user_id = $3 FOR UPDATE",
        pqxx::params{item_id, move_id, user_id});
    if (item.empty()) throw std::runtime_error("STORAGE_MOVE_NOT_FOUND");
    if (item[0][1].as<std::string>() != "local" || item[0][2].as<std::string>() == "paused") throw std::runtime_error("STORAGE_MOVE_INVALID_STATE");
    const uint64_t total = item[0][0].as<uint64_t>();
    const uint64_t offset = static_cast<uint64_t>(chunk_index) * FileChunker::MAX_CHUNK_SIZE;
    if (size_bytes > FileChunker::MAX_CHUNK_SIZE || offset > total || size_bytes > total - offset) throw std::invalid_argument("INVALID_CHUNK");
    txn.exec(
        "INSERT INTO storage_move_chunks (move_item_id, chunk_index, size_bytes) VALUES ($1,$2,$3) "
        "ON CONFLICT (move_item_id, chunk_index) DO UPDATE SET size_bytes = EXCLUDED.size_bytes",
        pqxx::params{item_id, chunk_index, size_bytes});
    auto bytes = txn.exec("SELECT COALESCE(SUM(size_bytes),0) FROM storage_move_chunks WHERE move_item_id = $1", pqxx::params{item_id});
    const uint64_t transferred = bytes[0][0].as<uint64_t>();
    txn.exec("UPDATE storage_move_items SET transferred_bytes = $1, status = 'transferring' WHERE id = $2", pqxx::params{transferred, item_id});
    txn.exec(
        "UPDATE storage_move_jobs SET transferred_bytes = (SELECT COALESCE(SUM(transferred_bytes),0) FROM storage_move_items WHERE move_job_id = $1), status = 'transferring', updated_at = CURRENT_TIMESTAMP WHERE id = $1",
        pqxx::params{move_id});
    txn.commit();
    return transferred;
}

void FileManager::update_storage_move_progress(uint64_t user_id, uint64_t move_id, uint64_t item_id,
                                               uint64_t transferred_bytes) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);
    auto item = txn.exec(
        "SELECT i.total_bytes,j.status FROM storage_move_items i JOIN storage_move_jobs j ON j.id=i.move_job_id "
        "WHERE i.id=$1 AND i.move_job_id=$2 AND j.user_id=$3 FOR UPDATE",
        pqxx::params{item_id,move_id,user_id});
    if (item.empty()) throw std::runtime_error("STORAGE_MOVE_NOT_FOUND");
    if (item[0][1].as<std::string>() == "paused" || transferred_bytes > item[0][0].as<uint64_t>()) throw std::runtime_error("STORAGE_MOVE_INVALID_STATE");
    txn.exec("UPDATE storage_move_items SET transferred_bytes=GREATEST(transferred_bytes,$1),status='transferring' WHERE id=$2",pqxx::params{transferred_bytes,item_id});
    txn.exec(
        "UPDATE storage_move_jobs SET transferred_bytes=(SELECT COALESCE(SUM(transferred_bytes),0) FROM storage_move_items WHERE move_job_id=$1),status='transferring',updated_at=CURRENT_TIMESTAMP WHERE id=$1",
        pqxx::params{move_id});
    txn.commit();
}

void FileManager::mark_storage_move_item_uploaded(uint64_t user_id, uint64_t move_id, uint64_t item_id,
                                                  std::optional<std::string> target_external_file_id) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);
    auto item = txn.exec(
        "SELECT i.total_bytes, i.transferred_bytes, j.target_provider, j.status FROM storage_move_items i JOIN storage_move_jobs j ON j.id=i.move_job_id "
        "WHERE i.id=$1 AND i.move_job_id=$2 AND j.user_id=$3 FOR UPDATE",
        pqxx::params{item_id, move_id, user_id});
    if (item.empty()) throw std::runtime_error("STORAGE_MOVE_NOT_FOUND");
    const std::string provider = item[0][2].as<std::string>();
    if ((provider == "google_drive") != target_external_file_id.has_value()) throw std::runtime_error("STORAGE_MOVE_TARGET_INCOMPLETE");
    if (item[0][0].as<uint64_t>() != item[0][1].as<uint64_t>()) throw std::runtime_error("STORAGE_MOVE_TARGET_INCOMPLETE");
    txn.exec(
        "UPDATE storage_move_items SET status='target_uploaded', target_external_file_id=$1 WHERE id=$2",
        pqxx::params{target_external_file_id, item_id});
    auto remaining = txn.exec("SELECT COUNT(*) FROM storage_move_items WHERE move_job_id=$1 AND status <> 'target_uploaded'", pqxx::params{move_id});
    if (remaining[0][0].as<int>() == 0) txn.exec("UPDATE storage_move_jobs SET status='target_uploaded', updated_at=CURRENT_TIMESTAMP WHERE id=$1", pqxx::params{move_id});
    txn.commit();
}

crow::json::wvalue FileManager::cancel_storage_move(uint64_t user_id, uint64_t move_id) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);
    auto job = txn.exec(
        "SELECT status,target_provider,target_external_storage_id FROM storage_move_jobs WHERE id=$1 AND user_id=$2 FOR UPDATE",
        pqxx::params{move_id,user_id});
    if (job.empty()) throw std::runtime_error("STORAGE_MOVE_NOT_FOUND");
    const std::string status = job[0][0].as<std::string>();
    if (status == "completed" || status == "cleanup_pending" || status == "committing") throw std::runtime_error("STORAGE_MOVE_INVALID_STATE");
    if (status != "cancelled") {
        if (job[0][1].as<std::string>() == "google_drive" && !job[0][2].is_null()) {
            txn.exec(
                "INSERT INTO pending_external_deletions(external_file_id,external_storage_id) "
                "SELECT target_external_file_id,$1 FROM storage_move_items "
                "WHERE move_job_id=$2 AND target_external_file_id IS NOT NULL ON CONFLICT DO NOTHING",
                pqxx::params{job[0][2].as<uint64_t>(),move_id});
        }
        txn.exec("UPDATE storage_move_jobs SET status='cancelled', reserved_bytes=0, updated_at=CURRENT_TIMESTAMP, completed_at=CURRENT_TIMESTAMP WHERE id=$1", pqxx::params{move_id});
        txn.exec("UPDATE storage_move_items SET status='cancelled' WHERE move_job_id=$1 AND status <> 'completed'", pqxx::params{move_id});
    }
    auto result = serialize_storage_move(txn, user_id, move_id);
    txn.commit();
    return result;
}

crow::json::wvalue FileManager::complete_storage_move(uint64_t user_id, uint64_t move_id, FileChunker& chunker) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);
    auto jobs = txn.exec(
        "SELECT file_id,status,source_provider,source_external_storage_id,target_provider,target_external_storage_id,total_bytes "
        "FROM storage_move_jobs WHERE id=$1 AND user_id=$2 FOR UPDATE",
        pqxx::params{move_id,user_id});
    if (jobs.empty()) throw std::runtime_error("STORAGE_MOVE_NOT_FOUND");
    const auto& job = jobs[0];
    const std::string status = job[1].as<std::string>();
    if (status == "completed" || status == "cleanup_pending") {
        auto result = serialize_storage_move(txn,user_id,move_id);
        txn.commit();
        return result;
    }
    if (status != "target_uploaded") throw std::runtime_error("STORAGE_MOVE_TARGET_INCOMPLETE");
    const uint64_t file_id = job[0].as<uint64_t>();
    const std::string source_provider = job[2].as<std::string>();
    const std::string target_provider = job[4].as<std::string>();
    auto items = txn.exec("SELECT id,role,total_bytes,target_external_file_id FROM storage_move_items WHERE move_job_id=$1 AND status='target_uploaded' ORDER BY id FOR UPDATE", pqxx::params{move_id});
    if (items.empty()) throw std::runtime_error("STORAGE_MOVE_TARGET_INCOMPLETE");
    txn.exec("UPDATE storage_move_jobs SET status='committing',updated_at=CURRENT_TIMESTAMP WHERE id=$1",pqxx::params{move_id});

    std::vector<std::pair<uint64_t, std::string>> promoted;
    bool source_quarantined = false;
    try {
        if (target_provider == "local") {
            for (const auto& item : items) {
                const uint64_t item_id = item[0].as<uint64_t>();
                const std::string role = item[1].as<std::string>();
                if (chunker.get_move_file_size(item_id) != item[2].as<uint64_t>()) throw std::runtime_error("STORAGE_MOVE_TARGET_INCOMPLETE");
                if (role == "original") chunker.promote_move_file(item_id,file_id);
                else chunker.promote_move_proxy(item_id,file_id);
                promoted.emplace_back(item_id, role);
            }
        }
        if (source_provider == "local") {
            chunker.quarantine_file(file_id, move_id);
            source_quarantined = true;
            chunker.quarantine_proxy(file_id, move_id);
        }

    auto file = txn.exec("SELECT size_bytes,proxy_size_bytes,external_file_id,proxy_external_file_id FROM files WHERE id=$1 AND user_id=$2 FOR UPDATE",pqxx::params{file_id,user_id});
    const uint64_t ciphertext_size = job[6].as<uint64_t>();
    const uint64_t source_charge = quota_charge(source_provider, ciphertext_size);
    const uint64_t target_charge = quota_charge(target_provider, ciphertext_size);
    const auto original = items[0];
    std::optional<std::string> target_external_file_id = original[3].is_null() ? std::nullopt : std::optional<std::string>(original[3].as<std::string>());
    std::optional<std::string> proxy_external_file_id;
    if (items.size() > 1 && !items[1][3].is_null()) proxy_external_file_id = items[1][3].as<std::string>();
    txn.exec(
        "UPDATE files SET storage_provider=$1, external_storage_id=$2, external_file_id=$3, physical_path=$4, "
        "proxy_external_file_id=$5, proxy_physical_path=$6 WHERE id=$7",
        pqxx::params{target_provider,
            target_provider == "google_drive" ? std::optional<uint64_t>(job[5].as<uint64_t>()) : std::nullopt,
            target_external_file_id,
            target_provider == "local" ? std::optional<std::string>(std::to_string(file_id)+".dat") : std::nullopt,
            proxy_external_file_id,
            target_provider == "local" && items.size() > 1 ? std::optional<std::string>(std::to_string(file_id)+".proxy.dat") : std::nullopt,
            file_id});
    if (target_charge >= source_charge) {
        txn.exec("UPDATE users SET used_storage_bytes=used_storage_bytes+$1 WHERE id=$2",pqxx::params{target_charge-source_charge,user_id});
    } else {
        txn.exec("UPDATE users SET used_storage_bytes=GREATEST(0,used_storage_bytes-$1) WHERE id=$2",pqxx::params{source_charge-target_charge,user_id});
    }
    if (source_provider == "google_drive") {
        if (!file[0][2].is_null() && !job[3].is_null()) txn.exec(
            "INSERT INTO pending_external_deletions(external_file_id,external_storage_id,move_job_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
            pqxx::params{file[0][2].as<std::string>(),job[3].as<uint64_t>(),move_id});
        if (!file[0][3].is_null() && !job[3].is_null()) txn.exec(
            "INSERT INTO pending_external_deletions(external_file_id,external_storage_id,move_job_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
            pqxx::params{file[0][3].as<std::string>(),job[3].as<uint64_t>(),move_id});
    } else {
        txn.exec("INSERT INTO pending_local_deletions(move_job_id) VALUES($1) ON CONFLICT DO NOTHING",pqxx::params{move_id});
    }
    txn.exec("UPDATE storage_move_items SET status='completed' WHERE move_job_id=$1",pqxx::params{move_id});
    txn.exec("UPDATE storage_move_jobs SET status='cleanup_pending',reserved_bytes=0,transferred_bytes=total_bytes,updated_at=CURRENT_TIMESTAMP WHERE id=$1",pqxx::params{move_id});
    if (source_provider == "google_drive") {
        txn.exec(
            "UPDATE storage_move_jobs SET status='completed',completed_at=CURRENT_TIMESTAMP WHERE id=$1 "
            "AND NOT EXISTS (SELECT 1 FROM pending_external_deletions WHERE move_job_id=$1)",
            pqxx::params{move_id});
    }
        auto result = serialize_storage_move(txn,user_id,move_id);
        txn.commit();
        return result;
    } catch (...) {
        if (source_quarantined) {
            chunker.restore_quarantined_proxy(file_id, move_id);
            chunker.restore_quarantined_file(file_id, move_id);
        }
        for (auto it = promoted.rbegin(); it != promoted.rend(); ++it) {
            if (it->second == "original") chunker.demote_move_file(it->first, file_id);
            else chunker.demote_move_proxy(it->first, file_id);
        }
        throw;
    }
}

