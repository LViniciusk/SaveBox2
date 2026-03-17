#pragma once

#include "database/DatabasePool.hpp"
#include <cstdint>
#include <string>
#include <vector>
#include <crow_all.h>

class FileManager {
public:
    explicit FileManager(DatabasePool& pool);

    int init_upload(uint64_t user_id, uint64_t folder_id,
                    const std::string& enc_name, const std::string& name_hash,
                    uint64_t size_bytes, int total_chunks);

    void mark_upload_complete(uint64_t file_id);

    int get_total_chunks(uint64_t file_id);
    bool can_user_download(uint64_t file_id, uint64_t user_id);
    std::vector<crow::json::wvalue> get_user_files_paginated(uint64_t user_id, int limit, int offset);
    std::vector<int> get_uploaded_chunks(uint64_t file_id, uint64_t user_id);
    void record_chunk_saved(uint64_t file_id, int chunk_index);
    int count_uploaded_chunks(uint64_t file_id);

private:
    DatabasePool& pool_;
};
