#pragma once

#include <crow_all.h>
#include <cstdint>
#include <optional>
#include <string>

class DatabasePool;

class FolderManager {
public:
    explicit FolderManager(DatabasePool& pool);

    uint64_t create_folder(uint64_t user_id,
                           std::optional<uint64_t> parent_id,
                           const std::string& encrypted_name,
                           const std::string& name_hash);

    std::vector<uint64_t> delete_folder(uint64_t folder_id, uint64_t user_id);
    bool folder_exists(uint64_t folder_id);

    crow::json::wvalue get_folder_contents(int folder_id, int user_id);
    std::vector<crow::json::wvalue> get_all_folders(uint64_t user_id);
    
    crow::json::wvalue update_folder(uint64_t folder_id, uint64_t user_id, const std::optional<std::string>& enc_name, const std::optional<std::string>& name_hash, const std::optional<uint64_t>& parent_id);

private:
    DatabasePool& pool_;
};
