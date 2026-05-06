#include <catch2/catch_test_macros.hpp>
#include "controllers/ApiRouter.hpp"
#include "database/DatabasePool.hpp"
#include "Services/AuthService.hpp"
#include "database/FolderManager.hpp"
#include "middlewares/RateLimitMiddleware.hpp"
#include "test_helpers.hpp"
#include <crow_all.h>




TEST_CASE("API de Autenticação - Registro e Login", "[api][auth]") {
    std::string conn_str = get_secure_conn_string();
    DatabasePool pool(2, conn_str);
    MockEmailService mock_email_service;
    AuthService auth("Lords_do_Underground", "A_flor", &mock_email_service);
    FolderManager folder_mgr(pool);
    ApiRouter router(pool, auth, folder_mgr);

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username = 'api_test_user'");
        txn.commit();
    }

    SECTION("Registro de Usuário - handle_register") {
        crow::request req;
        req.body = R"({"username": "api_test_user", "email": "api_test_user@test.com", "password": "super_senha"})";

        crow::response res = router.handle_register(req);

        REQUIRE(res.code == 201);
        REQUIRE(res.body.find("Verifique seu e-mail") != std::string::npos);
    }

    SECTION("Tratamento de Conflito - Usuário Duplicado") {
        crow::request req;
        req.body = R"({"username": "api_test_user", "email": "api_test_user@test.com", "password": "super_senha"})";

        router.handle_register(req);

        crow::response res = router.handle_register(req);

        REQUIRE(res.code == 409);
    }

    SECTION("Login bloqueado ate verificar e-mail, depois liberado") {
        crow::request req_register;
        req_register.body = R"({"username": "api_test_user", "email": "api_test_user@test.com", "password": "super_senha"})";

        crow::response register_res = router.handle_register(req_register);
        REQUIRE(register_res.code == 201);

        crow::request req_login;
        req_login.body = R"({"username": "api_test_user", "password": "super_senha"})";
        crow::response login_before_verify = router.handle_login(req_login);
        REQUIRE(login_before_verify.code == 403);

        std::string verification_token;
        {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            auto token_res = txn.exec("SELECT verification_token FROM users WHERE username = 'api_test_user'");
            REQUIRE_FALSE(token_res.empty());
            REQUIRE_FALSE(token_res[0][0].is_null());
            verification_token = token_res[0][0].as<std::string>();
            txn.commit();
        }

        crow::request req_verify;
        req_verify.url = "/verify?token=" + verification_token;
        req_verify.url_params = crow::query_string(req_verify.url.substr(req_verify.url.find('?')));
        crow::response verify_res = router.handle_verify_email(req_verify);
        REQUIRE(verify_res.code == 200);

        crow::response login_after_verify = router.handle_login(req_login);
        REQUIRE(login_after_verify.code == 200);
        REQUIRE(login_after_verify.body.find("token") != std::string::npos);
    }

    SECTION("Login com Senha Errada") {
        crow::request req;
        req.body = R"({"username": "api_test_user", "email": "api_test_user@test.com", "password": "super_senha"})";

        router.handle_register(req);

        req.body = R"({"username": "api_test_user", "password": "senha_errada"})";
        crow::response res = router.handle_login(req);

        REQUIRE(res.code == 401);
    }

    SECTION("Segurança: Tratamento de Tipagem JSON (Register/Login)") {
        crow::request req_bad_reg;
        req_bad_reg.body = R"({"username": 123, "email": "api_test_user@test.com", "password": true})";
        crow::response res_bad_reg = router.handle_register(req_bad_reg);
        REQUIRE(res_bad_reg.code == 400);
        REQUIRE(res_bad_reg.body.find("Tipos de dados invalidos no JSON") != std::string::npos);

        crow::request req_bad_log;
        req_bad_log.body = R"({"username": 123, "password": true})";
        crow::response res_bad_log = router.handle_login(req_bad_log);
        REQUIRE(res_bad_log.code == 400);
        REQUIRE(res_bad_log.body.find("Tipos de dados invalidos no JSON") != std::string::npos);
    }

    SECTION("Rate Limit nao permite bypass via query string") {
        {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            txn.exec("DELETE FROM banned_ips WHERE ip = '10.10.10.10'");
            txn.commit();
        }

        RateLimitMiddleware limiter;
        limiter.init(pool);
        RateLimitMiddleware::context ctx;

        for (int i = 1; i <= 20; ++i) {
            crow::request req;
            req.url = "/login?bypass=1";
            req.method = crow::HTTPMethod::Post;
            req.remote_ip_address = "10.10.10.10";

            crow::response res;
            limiter.before_handle(req, res, ctx);

            if (i >= 16) {
                REQUIRE((res.code == 429 || res.code == 403));
            }
        }
    }

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username = 'api_test_user'");
        txn.commit();
    }
}
