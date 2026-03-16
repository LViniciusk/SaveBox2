#include "ApiRouter.hpp"

ApiRouter::ApiRouter(DatabasePool& pool, AuthService& auth)
    : pool_(&pool), auth_(&auth) {}

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
            R"({"message":"Usuario criado", "user_id":)" + std::to_string(user_id) + "}");

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
            R"({"message":"Login efetuado", "user_id":)" + std::to_string(user_id) + "}");

    } catch (const std::exception& e) {
        return crow::response(500, R"({"error":"Erro interno"})");
    }
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
}
