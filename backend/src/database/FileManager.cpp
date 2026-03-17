#include "database/FileManager.hpp"
#include <pqxx/pqxx>

FileManager::FileManager(DatabasePool& pool) : pool_(pool) {}

int FileManager::init_upload(uint64_t user_id, uint64_t folder_id,
                              const std::string& enc_name, const std::string& name_hash,
                              uint64_t size_bytes, int total_chunks) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);

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
        "SELECT is_upload_complete FROM files WHERE id = $1 AND user_id = $2",
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
        "WHERE user_id = $1 AND is_upload_complete = true "
        "ORDER BY id ASC LIMIT $2 OFFSET $3",
        pqxx::params{user_id, limit, offset}
    );

    std::vector<crow::json::wvalue> files;
    for (const auto& row : result) {
        crow::json::wvalue item;
        item["id"] = row[0].as<int>();
        item["folder_id"] = row[1].as<int>();
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
