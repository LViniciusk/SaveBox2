#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>
#include <utility>
#include <crow_all.h>

class DatabasePool;

struct BatchInitItem {
    std::optional<uint64_t> folder_id;
    std::string enc_name;
    std::string name_hash;
    std::string encrypted_fdk;
    uint64_t size_bytes;
    int total_chunks;
    std::string storage_provider;
    std::optional<uint64_t> external_storage_id;
    std::optional<std::string> proxy_external_file_id;
    std::optional<uint64_t> proxy_size_bytes;
    std::optional<std::string> proxy_encrypted_fdk;
};

struct BatchInitResult {
    uint64_t file_id;
    std::string enc_name;
    std::string name_hash;
    std::string storage_provider;
    std::string external_file_id; 
    std::string access_token;     
    std::string root_folder_id;   
};

struct ExternalSyncFile {
    uint64_t id;
    std::string external_file_id;
};

struct BatchHardDeleteResult {
    int deleted_count = 0;
    std::vector<std::string> external_files;
};

class FileManager {
public:
    explicit FileManager(DatabasePool& pool);
    int init_upload(uint64_t user_id, std::optional<uint64_t> folder_id,
                    const std::string& enc_name, const std::string& name_hash,
                    const std::string& encrypted_fdk,
                    uint64_t size_bytes, int total_chunks,
                    std::optional<std::string> proxy_external_file_id = std::nullopt,
                    std::optional<uint64_t> proxy_size_bytes = std::nullopt,
                    std::optional<std::string> proxy_encrypted_fdk = std::nullopt);
    std::vector<BatchInitResult> batch_init_uploads(uint64_t user_id, const std::vector<BatchInitItem>& files);
    crow::json::wvalue get_user_quota(uint64_t user_id);
    void mark_upload_complete(uint64_t file_id, uint64_t user_id);
    bool is_upload_complete(uint64_t file_id, uint64_t user_id);
    int get_total_chunks(uint64_t file_id, uint64_t user_id);
    bool can_user_download(uint64_t file_id, uint64_t user_id);
    std::string get_file_name(uint64_t file_id, uint64_t user_id);
    std::vector<crow::json::wvalue> get_user_files_paginated(uint64_t user_id, int limit, int offset);
    std::vector<crow::json::wvalue> get_pending_uploads(uint64_t user_id);
    std::vector<int> get_uploaded_chunks(uint64_t file_id, uint64_t user_id);
    void record_chunk_saved(uint64_t file_id, int chunk_index);
    int count_uploaded_chunks(uint64_t file_id);
    std::optional<std::string> delete_file(uint64_t file_id, uint64_t user_id);
    std::optional<std::string> hard_delete_file(uint64_t file_id, uint64_t user_id, class FileChunker* chunker);
    BatchHardDeleteResult batch_hard_delete_files(uint64_t user_id, const std::vector<int>& file_ids, class FileChunker* chunker);
    int batch_delete_files(uint64_t user_id, const std::vector<int>& file_ids);
    crow::json::wvalue update_file(uint64_t file_id, uint64_t user_id, const std::optional<std::string>& enc_name, const std::optional<std::string>& name_hash, const std::optional<uint64_t>& folder_id);
    std::string share_file(uint64_t file_id, uint64_t user_id);
    std::pair<uint64_t, std::string> get_shared_file_info(const std::string& uuid);
    crow::json::wvalue get_trash(uint64_t user_id);
    std::optional<std::string> restore_file(uint64_t file_id, uint64_t user_id);
    std::vector<std::string> empty_trash(uint64_t user_id, class FileChunker* chunker);
    int init_external_upload(uint64_t user_id, std::optional<uint64_t> folder_id,
                             const std::string& enc_name, const std::string& name_hash,
                             const std::string& encrypted_fdk,
                             uint64_t size_bytes, const std::string& storage_provider,
                             std::optional<uint64_t> external_storage_id = std::nullopt,
                             std::optional<std::string> proxy_external_file_id = std::nullopt,
                             std::optional<uint64_t> proxy_size_bytes = std::nullopt,
                             std::optional<std::string> proxy_encrypted_fdk = std::nullopt);
    void finalize_external_upload(uint64_t file_id, uint64_t user_id,
                                  const std::string& external_file_id);
    std::string get_storage_provider(uint64_t file_id, uint64_t user_id);
    std::vector<ExternalSyncFile> get_external_sync_map(uint64_t user_id, uint64_t external_storage_id);
    void cleanup_external_sync(uint64_t user_id, uint64_t external_storage_id, const std::vector<std::string>& missing_external_ids);

private:
    DatabasePool& pool_;
};
