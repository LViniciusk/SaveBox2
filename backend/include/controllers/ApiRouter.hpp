#pragma once

#include "crow_all.h"
#include "database/DatabasePool.hpp"
#include "services/AuthService.hpp"
#include "database/FolderManager.hpp"
#include "services/CryptoService.hpp"
#include <string>

class ApiRouter {
public:
    ApiRouter() = default;
    ApiRouter(DatabasePool& pool, AuthService& auth, FolderManager& folder_mgr, CryptoService& crypto);

    std::string handle_healthcheck() const;
    crow::response handle_register(const crow::request& req);
    crow::response handle_login(const crow::request& req);
    crow::response handle_create_folder(const crow::request& req);

    void setup_routes(crow::SimpleApp& app);

private:
    DatabasePool* pool_ = nullptr;
    AuthService* auth_ = nullptr;
    FolderManager* folder_mgr_ = nullptr;
    CryptoService* crypto_ = nullptr;
};