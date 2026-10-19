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
    bool is_hidden = false;
};

struct BatchInitResult {
    uint64_t file_id;
    std::optional<uint64_t> folder_id;
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

struct PendingGoogleRecoveryFile {
    uint64_t external_storage_id;
    std::string name_hash;
    uint64_t size_bytes;
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
                    std::optional<std::string> proxy_encrypted_fdk = std::nullopt,
                    bool is_hidden = false);
    std::vector<BatchInitResult> batch_init_uploads(uint64_t user_id, const std::vector<BatchInitItem>& files);
    crow::json::wvalue get_user_quota(uint64_t user_id);
    bool store_local_chunk(uint64_t file_id, uint64_t user_id, int chunk_index,
                           const std::string& binary_data, class FileChunker& chunker);
    bool can_user_download(uint64_t file_id, uint64_t user_id);
    std::string get_file_name(uint64_t file_id, uint64_t user_id);
    std::vector<crow::json::wvalue> get_user_files_paginated(uint64_t user_id, int limit, int offset);
    std::vector<crow::json::wvalue> get_pending_uploads(uint64_t user_id);
    PendingGoogleRecoveryFile get_pending_google_recovery_file(uint64_t file_id, uint64_t user_id);
    PendingGoogleRecoveryFile mark_pending_google_upload_cancelled(uint64_t file_id, uint64_t user_id);
    void require_pending_local_recovery_file(uint64_t file_id, uint64_t user_id);
    crow::json::wvalue get_storage_tree(uint64_t user_id,
                                        const std::string& provider,
                                        std::optional<uint64_t> external_storage_id,
                                        std::optional<uint64_t> folder_id,
                                        int limit, int offset);
    std::vector<int> get_uploaded_chunks(uint64_t file_id, uint64_t user_id);
    std::optional<std::string> delete_file(uint64_t file_id, uint64_t user_id);
    std::optional<std::string> hard_delete_file(uint64_t file_id, uint64_t user_id, class FileChunker* chunker);
    BatchHardDeleteResult batch_hard_delete_files(uint64_t user_id, const std::vector<int>& file_ids, class FileChunker* chunker);
    int batch_delete_files(uint64_t user_id, const std::vector<int>& file_ids);
    crow::json::wvalue update_file(uint64_t file_id, uint64_t user_id, const std::optional<std::string>& enc_name, const std::optional<std::string>& name_hash, const std::optional<uint64_t>& folder_id);
    std::string share_file(uint64_t file_id, uint64_t user_id, const std::string& encrypted_name_fdk);
    struct SharedFileInfo {
        uint64_t file_id;
        std::string encrypted_name;
        size_t size_bytes;
    };
    SharedFileInfo get_shared_file_info(const std::string& uuid);
    std::vector<crow::json::wvalue> list_shares(uint64_t file_id, uint64_t user_id);
    void revoke_share(const std::string& share_uuid, uint64_t user_id);
    crow::json::wvalue get_shared_file_metadata(const std::string& uuid);
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
                             std::optional<std::string> proxy_encrypted_fdk = std::nullopt,
                             bool is_hidden = false);
    void finalize_external_upload(uint64_t file_id, uint64_t user_id,
                                  const std::string& external_file_id);
    std::string get_storage_provider(uint64_t file_id, uint64_t user_id);
    std::vector<ExternalSyncFile> get_external_sync_map(uint64_t user_id, uint64_t external_storage_id);
    void cleanup_external_sync(uint64_t user_id, uint64_t external_storage_id, const std::vector<std::string>& missing_external_ids);
    crow::json::wvalue start_storage_move(uint64_t user_id, uint64_t file_id,
                                          const std::string& target_provider,
                                          std::optional<uint64_t> target_external_storage_id,
                                          std::optional<uint64_t> target_available_bytes);
    crow::json::wvalue get_storage_move(uint64_t user_id, uint64_t move_id);
    crow::json::wvalue get_active_storage_moves(uint64_t user_id);
    void set_storage_move_status(uint64_t user_id, uint64_t move_id, const std::string& status);
    uint64_t record_storage_move_chunk(uint64_t user_id, uint64_t move_id, uint64_t item_id,
                                       int chunk_index, uint64_t size_bytes);
    void update_storage_move_progress(uint64_t user_id, uint64_t move_id, uint64_t item_id, uint64_t transferred_bytes);
    void mark_storage_move_item_uploaded(uint64_t user_id, uint64_t move_id, uint64_t item_id,
                                         std::optional<std::string> target_external_file_id);
    void record_storage_move_failure(uint64_t user_id, uint64_t move_id,
                                    const std::string& error_code, const std::string& failure_stage,
                                    bool retryable,
                                    const std::vector<std::string>& additional_external_file_ids = {},
                                    class FileChunker* chunker = nullptr);
    void clear_storage_move(uint64_t user_id, uint64_t move_id);
    crow::json::wvalue cancel_storage_move(uint64_t user_id, uint64_t move_id,
                                           const std::vector<std::string>& additional_external_file_ids = {},
                                           class FileChunker* chunker = nullptr);
    crow::json::wvalue complete_storage_move(uint64_t user_id, uint64_t move_id, class FileChunker& chunker);

private:
    DatabasePool& pool_;
};
