#pragma once

#include <cstdint>
#include <string>
#include <vector>
#include <utility>
#include <crow_all.h>

class DatabasePool;

class FileManager {
public:
    explicit FileManager(DatabasePool& pool);

    int init_upload(uint64_t user_id, std::optional<uint64_t> folder_id,
                    const std::string& enc_name, const std::string& name_hash,
                    uint64_t size_bytes, int total_chunks);

    crow::json::wvalue get_user_quota(uint64_t user_id);

    void mark_upload_complete(uint64_t file_id);

    int get_total_chunks(uint64_t file_id);
    bool can_user_download(uint64_t file_id, uint64_t user_id);
    std::vector<crow::json::wvalue> get_user_files_paginated(uint64_t user_id, int limit, int offset);
    std::vector<int> get_uploaded_chunks(uint64_t file_id, uint64_t user_id);
    void record_chunk_saved(uint64_t file_id, int chunk_index);
    int count_uploaded_chunks(uint64_t file_id);
    void delete_file(uint64_t file_id, uint64_t user_id);
    crow::json::wvalue update_file(uint64_t file_id, uint64_t user_id, const std::optional<std::string>& enc_name, const std::optional<std::string>& name_hash, const std::optional<uint64_t>& folder_id);
    
    std::string share_file(uint64_t file_id, uint64_t user_id);
    std::pair<uint64_t, std::string> get_shared_file_info(const std::string& uuid);

    crow::json::wvalue get_trash(uint64_t user_id);
    void restore_file(uint64_t file_id, uint64_t user_id);
    void empty_trash(uint64_t user_id, class FileChunker* chunker);

private:
    DatabasePool& pool_;
};
