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

void FileManager::mark_upload_complete(uint64_t file_id, uint64_t user_id) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);
    txn.exec(
        "UPDATE files SET is_upload_complete = true WHERE id = $1 AND user_id = $2",
        pqxx::params{file_id, user_id}
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
