#include "controllers/ApiRouter.hpp"
#include <optional>

ApiRouter::ApiRouter(DatabasePool& pool, AuthService& auth, FolderManager& folder_mgr)
    : pool_(&pool), auth_(&auth), folder_mgr_(&folder_mgr) {}

std::string ApiRouter::handle_healthcheck() const {
    return R"({"status":"online"})";
}

crow::response ApiRouter::handle_register(const crow::request& req) {
    try {
        auto body = crow::json::load(req.body);
        if (!body) {
            return crow::response(400, R"({"error":"JSON invalido"})");
        }

        std::string username = body["username"].s();
        std::string password = body["password"].s();

        auto conn = pool_->acquire_connection();
        pqxx::work txn(*conn);

        auto check = txn.exec(
            "SELECT count(*) FROM users WHERE username = $1",
            pqxx::params{username}
        );

        if (check[0][0].as<int>() > 0) {
            return crow::response(409, R"({"error":"Usuario ja existe"})");
        }

        std::string hash = auth_->hash_password(password);

        auto result = txn.exec(
            "INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id",
            pqxx::params{username, hash}
        );

        txn.commit();

        int user_id = result[0][0].as<int>();
        return crow::response(201,
            R"({"message":"Usuario Criado", "token":")" + auth_->generate_token(user_id) + R"("})");

    } catch (const std::exception& e) {
        return crow::response(500, R"({"error":"Erro interno"})");
    }
}

crow::response ApiRouter::handle_login(const crow::request& req) {
    try {
        auto body = crow::json::load(req.body);
        if (!body) {
            return crow::response(400, R"({"error":"JSON invalido"})");
        }

        std::string username = body["username"].s();
        std::string password = body["password"].s();

        auto conn = pool_->acquire_connection();
        pqxx::work txn(*conn);

        auto result = txn.exec(
            "SELECT id, password_hash FROM users WHERE username = $1",
            pqxx::params{username}
        );

        txn.commit();

        if (result.empty()) {
            return crow::response(401, R"({"error":"Credenciais invalidas"})");
        }

        int user_id = result[0][0].as<int>();
        std::string hash_do_banco = result[0][1].as<std::string>();

        if (!auth_->verify_password(password, hash_do_banco)) {
            return crow::response(401, R"({"error":"Credenciais invalidas"})");
        }

        return crow::response(200,
            R"({"message":"Login efetuado", "token":")" + auth_->generate_token(user_id) + R"("})");

    } catch (const std::exception& e) {
        return crow::response(500, R"({"error":"Erro interno"})");
    }
}

crow::response ApiRouter::handle_create_folder(const crow::request& req) {
    try {
        auto user_id_opt = authenticate_request(req);
        if (!user_id_opt) {
            return crow::response(401, R"({"error":"Token ausente ou invalido"})");
        }
        uint64_t user_id = *user_id_opt;

        auto body = crow::json::load(req.body);
        if (!body || !body.has("encrypted_name") || !body.has("name_hash")) {
            return crow::response(400, R"({"error":"JSON invalido"})");
        }

        std::string encrypted_name = body["encrypted_name"].s();
        std::string name_hash = body["name_hash"].s();

        std::optional<uint64_t> parent_id_opt;
        if (body.has("parent_id") && body["parent_id"].t() != crow::json::type::Null) {
            parent_id_opt = static_cast<uint64_t>(body["parent_id"].i());
        }

        uint64_t folder_id = folder_mgr_->create_folder(user_id, parent_id_opt, encrypted_name, name_hash);

        return crow::response(201,
            R"({"message":"Pasta criada", "folder_id":)" + std::to_string(folder_id) + "}");

    } catch (const pqxx::unique_violation& e) {
        return crow::response(409, R"({"error":"Pasta ja existe"})");
    } catch (const std::exception& e) {
        return crow::response(500, R"({"error":"Erro interno"})");
    }
}

std::optional<uint64_t> ApiRouter::authenticate_request(const crow::request& req) const {
    auto auth_header = req.get_header_value("Authorization");
    if (auth_header.empty() || auth_header.rfind("Bearer ", 0) != 0) {
        return std::nullopt;
    }
    std::string token = auth_header.substr(7); // skip "Bearer "
    return auth_->verify_token(token);
}

void ApiRouter::setup_routes(crow::SimpleApp& app) {
    CROW_ROUTE(app, "/health")
    ([this]() {
        crow::response res(handle_healthcheck());
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/register").methods(crow::HTTPMethod::Post)
    ([this](const crow::request& req) {
        auto res = handle_register(req);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/login").methods(crow::HTTPMethod::Post)
    ([this](const crow::request& req) {
        auto res = handle_login(req);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/folders").methods(crow::HTTPMethod::Post)
    ([this](const crow::request& req) {
        auto res = handle_create_folder(req);
        res.set_header("Content-Type", "application/json");
        return res;
    });
}
