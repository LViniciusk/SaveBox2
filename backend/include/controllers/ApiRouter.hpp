#pragma once

#include "crow_all.h"
#include "database/DatabasePool.hpp"
#include "services/AuthService.hpp"

class FileManager;
class FolderManager;
class FileChunker;

#include <optional>
#include <cstdint>
#include <string>

class ApiRouter {
public:
    ApiRouter() = default;
    ApiRouter(DatabasePool& pool, AuthService& auth, FolderManager& folder_mgr,
              FileManager* file_mgr = nullptr, FileChunker* chunker = nullptr);

    std::string handle_healthcheck() const;
    crow::response handle_register(const crow::request& req);
    crow::response handle_login(const crow::request& req);
    crow::response handle_create_folder(const crow::request& req);
    crow::response handle_init_file_upload(const crow::request& req);
    crow::response handle_upload_chunk(const crow::request& req, int file_id);
    crow::response handle_download_file(const crow::request& req, int file_id);
    crow::response handle_list_folder_contents(const crow::request& req, int folder_id);
    crow::response handle_get_tree(const crow::request& req);
    crow::response handle_get_uploaded_chunks(const crow::request& req, int file_id);
    crow::response handle_delete_file(const crow::request& req, int file_id);
    crow::response handle_delete_folder(const crow::request& req, int folder_id);
    crow::response handle_update_file(const crow::request& req, int file_id);
    crow::response handle_update_folder(const crow::request& req, int folder_id);
    crow::response handle_share_file(const crow::request& req, int file_id);
    crow::response handle_get_shared_file(const crow::request& req, const std::string& uuid);

    void setup_routes(crow::App<crow::CORSHandler>& app);

private:
    DatabasePool* pool_ = nullptr;
    AuthService* auth_ = nullptr;
    FolderManager* folder_mgr_ = nullptr;
    FileManager* file_mgr_ = nullptr;
    FileChunker* chunker_ = nullptr;

    std::optional<uint64_t> authenticate_request(const crow::request& req) const;
};