#include <catch2/catch_test_macros.hpp>
#include "controllers/ApiRouter.hpp"
#include "database/DatabasePool.hpp"
#include "Services/AuthService.hpp"
#include "database/FolderManager.hpp"
#include "middlewares/RateLimitMiddleware.hpp"
#include "test_helpers.hpp"
#include "database/UsersManager.hpp"
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

    SECTION("Criacao de Usuario via OAuth2 - Sucesso") {
        UsersManager users_mgr(pool);
        
        int new_user_id = users_mgr.create_oauth_user("oauth_user@test.com", "google", "google_123", "OAuth User");
        REQUIRE(new_user_id > 0);

        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        auto result = txn.exec(
            "SELECT email, auth_provider, provider_id, password_hash, is_email_verified FROM users WHERE id = $1",
            pqxx::params{new_user_id}
        );

        REQUIRE(result.size() == 1);
        REQUIRE(result[0][0].as<std::string>() == "oauth_user@test.com");
        REQUIRE(result[0][1].as<std::string>() == "google");
        REQUIRE(result[0][2].as<std::string>() == "google_123");
        REQUIRE(result[0][3].is_null());
        REQUIRE(result[0][4].as<bool>() == true);
    }

    SECTION("Falha ao criar Usuario OAuth2 - Email local ja existe") {
        crow::request req_register;
        req_register.body = R"({"username": "local_user", "email": "local_user@test.com", "password": "super_senha"})";
        router.handle_register(req_register);

        // Attempt to create OAuth user with same email
        UsersManager users_mgr(pool);
        REQUIRE_THROWS_AS(
            users_mgr.create_oauth_user("local_user@test.com", "google", "google_456"),
            std::runtime_error
        );
    }
    
    SECTION("Falha ao criar Usuario OAuth2 - provider_id invalido (vazio)") {
        UsersManager users_mgr(pool);
        REQUIRE_THROWS_AS(
            users_mgr.create_oauth_user("another_oauth_user@test.com", "google", ""),
            std::invalid_argument
        );
    }

    SECTION("Rejeita token Google com email_verified=false") {
        std::string payload = R"({
            "iss": "accounts.google.com",
            "sub": "999888777",
            "email": "unverified@evil.com",
            "email_verified": false,
            "aud": "test-client-id"
        })";

        REQUIRE_THROWS_AS(
            AuthService::validate_google_claims(payload, "test-client-id"),
            std::invalid_argument
        );

        // Verificar que a mensagem é EMAIL_NOT_VERIFIED_BY_PROVIDER
        try {
            AuthService::validate_google_claims(payload, "test-client-id");
            FAIL("Deveria ter lancado excecao");
        } catch (const std::invalid_argument& e) {
            REQUIRE(std::string(e.what()) == "EMAIL_NOT_VERIFIED_BY_PROVIDER");
        }

        // Garantir que nenhum usuario foi persistido
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        auto result = txn.exec("SELECT count(*) FROM users WHERE email = 'unverified@evil.com'");
        REQUIRE(result[0][0].as<int>() == 0);
    }

    SECTION("Rejeita token Google com email_verified ausente") {
        std::string payload = R"({
            "iss": "accounts.google.com",
            "sub": "111222333",
            "email": "no_verified_field@test.com",
            "aud": "test-client-id"
        })";

        REQUIRE_THROWS_AS(
            AuthService::validate_google_claims(payload, "test-client-id"),
            std::invalid_argument
        );

        try {
            AuthService::validate_google_claims(payload, "test-client-id");
            FAIL("Deveria ter lancado excecao");
        } catch (const std::invalid_argument& e) {
            REQUIRE(std::string(e.what()) == "EMAIL_NOT_VERIFIED_BY_PROVIDER");
        }
    }

    SECTION("Aceita token Google com email_verified como string 'true'") {
        std::string payload = R"({
            "iss": "accounts.google.com",
            "sub": "444555666",
            "email": "string_verified@test.com",
            "email_verified": "true",
            "aud": "test-client-id",
            "name": "String User",
            "picture": "https://example.com/photo.jpg"
        })";

        AuthService::GoogleClaims claims;
        REQUIRE_NOTHROW(claims = AuthService::validate_google_claims(payload, "test-client-id"));

        REQUIRE(claims.sub == "444555666");
        REQUIRE(claims.email == "string_verified@test.com");
        REQUIRE(claims.name == "String User");
        REQUIRE(claims.picture == "https://example.com/photo.jpg");
    }

    SECTION("Rejeita token Google com email_verified como string 'false'") {
        std::string payload = R"({
            "iss": "accounts.google.com",
            "sub": "777888999",
            "email": "string_false@test.com",
            "email_verified": "false",
            "aud": "test-client-id"
        })";

        REQUIRE_THROWS_AS(
            AuthService::validate_google_claims(payload, "test-client-id"),
            std::invalid_argument
        );
    }

    SECTION("Rejeita token Google com issuer invalido") {
        std::string payload = R"({
            "iss": "evil-issuer.com",
            "sub": "123456",
            "email": "evil@test.com",
            "email_verified": true,
            "aud": "test-client-id"
        })";

        REQUIRE_THROWS_AS(
            AuthService::validate_google_claims(payload, "test-client-id"),
            std::invalid_argument
        );
    }

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username = 'api_test_user'");
        txn.exec("DELETE FROM users WHERE email = 'oauth_user@test.com'");
        txn.exec("DELETE FROM users WHERE email = 'local_user@test.com'");
        txn.commit();
    }
}

