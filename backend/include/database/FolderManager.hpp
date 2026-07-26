#pragma once

#include <crow_all.h>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

class DatabasePool;

struct BatchHardDeleteFolderResult {
        int deleted_count = 0;
        std::vector<std::string> external_files;
    };

struct BatchDeleteFolderResult {
        int deleted_count = 0;
        std::vector<std::string> external_files;
    };

struct PinnedFolder {
    uint64_t folder_id = 0;
    int position = 0;
};

struct BatchCreateFolderItem {
    std::string client_ref;
    std::optional<std::string> parent_client_ref;
    std::string encrypted_name;
    std::string name_hash;
};

struct BatchCreateFolderResult {
    std::string client_ref;
    uint64_t folder_id = 0;
    bool created = false;
};

class FolderManager {
public:
    explicit FolderManager(DatabasePool& pool);

    uint64_t create_folder(uint64_t user_id,
                           std::optional<uint64_t> parent_id,
                           const std::string& encrypted_name,
                           const std::string& name_hash);
    std::vector<BatchCreateFolderResult> batch_create_folders(
        uint64_t user_id,
        std::optional<uint64_t> root_parent_id,
        const std::vector<BatchCreateFolderItem>& folders);
    std::vector<std::string> delete_folder(uint64_t folder_id, uint64_t user_id);
    bool folder_exists(uint64_t folder_id);
    crow::json::wvalue get_folder_contents(int folder_id, int user_id);
    std::vector<crow::json::wvalue> get_all_folders(uint64_t user_id);
    crow::json::wvalue update_folder(uint64_t folder_id, uint64_t user_id, const std::optional<std::string>& enc_name, const std::optional<std::string>& name_hash, const std::optional<uint64_t>& parent_id);
    std::vector<std::string> restore_folder(uint64_t folder_id, uint64_t user_id);
    std::vector<std::string> hard_delete_folder(uint64_t folder_id, uint64_t user_id, class FileChunker* chunker);
    BatchDeleteFolderResult batch_delete_folders(uint64_t user_id, const std::vector<int>& folder_ids);
    BatchHardDeleteFolderResult batch_hard_delete_folders(uint64_t user_id, const std::vector<int>& folder_ids, class FileChunker* chunker);
    std::vector<PinnedFolder> get_pinned_folders(uint64_t user_id);
    void pin_folder(uint64_t folder_id, uint64_t user_id);
    void unpin_folder(uint64_t folder_id, uint64_t user_id);
    void reorder_pinned_folders(uint64_t user_id, const std::vector<uint64_t>& folder_ids);

private:
    DatabasePool& pool_;
};
