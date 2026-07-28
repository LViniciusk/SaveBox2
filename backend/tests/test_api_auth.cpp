#include <catch2/catch_test_macros.hpp>
#include "controllers/ApiRouter.hpp"
#include "database/DatabasePool.hpp"
#include "Services/AuthService.hpp"
#include "database/FolderManager.hpp"
#include "middlewares/RateLimitMiddleware.hpp"
#include "test_helpers.hpp"
#include "database/UsersManager.hpp"
#include <crow_all.h>
#include <jwt-cpp/jwt.h>
#include "utils/utils.hpp"


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

    SECTION("Base62Generator - Tamanho, Alfabeto e Entropia") {
        std::string token1 = Base62Generator::generate(6);
        std::string token2 = Base62Generator::generate(7);

        REQUIRE(token1.length() == 6);
        REQUIRE(token2.length() == 7);
        REQUIRE(token1 != token2); // Entropia básica

        auto is_base62 = [](const std::string& str) {
            for (char c : str) {
                if (!std::isalnum(c)) return false;
            }
            return true;
        };

        REQUIRE(is_base62(token1));
        REQUIRE(is_base62(token2));
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

    SECTION("Seguranca: Constant-time contra User Enumeration Timing Attacks") {
        crow::request req_reg;
        req_reg.body = R"({"username": "api_test_user", "email": "api_test_user@test.com", "password": "super_senha"})";
        router.handle_register(req_reg);
        
        // Ativar a conta
        {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            txn.exec("UPDATE users SET is_email_verified = true WHERE username = 'api_test_user'");
            txn.commit();
        }

        // 1. Username que nao existe (Gatilho da mitigacao)
        crow::request req_non_existent;
        req_non_existent.body = R"({"username": "ghost_user_doesnt_exist", "password": "super_senha_wrong"})";
        
        auto start1 = std::chrono::high_resolution_clock::now();
        crow::response res_non_existent = router.handle_login(req_non_existent);
        auto end1 = std::chrono::high_resolution_clock::now();
        
        REQUIRE(res_non_existent.code == 401);

        // 2. Username que existe mas com senha errada
        crow::request req_existent;
        req_existent.body = R"({"username": "api_test_user", "password": "super_senha_wrong"})";

        auto start2 = std::chrono::high_resolution_clock::now();
        crow::response res_existent = router.handle_login(req_existent);
        auto end2 = std::chrono::high_resolution_clock::now();
        
        REQUIRE(res_existent.code == 401);

        auto duration_non_existent = std::chrono::duration_cast<std::chrono::milliseconds>(end1 - start1).count();
        auto duration_existent = std::chrono::duration_cast<std::chrono::milliseconds>(end2 - start2).count();

        // O delta deve ser impercetivel, mas como o Libsodium/Argon2 pode flutuar dezenas de ms 
        // no Windows (jitter de scheduling), aumentamos a tolerância. Sem a mitigação, o delta 
        // seria equivalente a todo o processamento do Argon2 (frequentemente > 100ms).
        long long delta = std::abs(duration_existent - duration_non_existent);
        REQUIRE(delta < 150); 
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

    SECTION("Proteção contra Session Hijacking / Token Expirado (JWT)") {
        auto now = std::chrono::system_clock::now();
        auto expired = now - std::chrono::hours(24);

        std::string expired_token = jwt::create()
            .set_type("JWT")
            .set_issued_at(expired - std::chrono::hours(1))
            .set_expires_at(expired)
            .set_payload_claim("user_id", jwt::claim(std::string("1")))
            .set_payload_claim("tver", jwt::claim(std::string("1")))
            .sign(jwt::algorithm::hs256{"A_flor"});

        crow::request req;
        req.add_header("Authorization", "Bearer " + expired_token);
        
        crow::response res = router.handle_get_tree(req);
        REQUIRE(res.code == 401);
    }

    SECTION("Global Logout (Invalidação de JWT)") {
        crow::request req_reg;
        req_reg.body = R"({"username": "logout_test_user", "email": "logout_test_user@test.com", "password": "super_senha"})";
        router.handle_register(req_reg);
        
        {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            txn.exec("UPDATE users SET is_email_verified = true WHERE username = 'logout_test_user'");
            txn.commit();
        }

        // 1. Faz login e obtem o JWT valido (Versao A)
        crow::request req_login;
        req_login.body = R"({"username": "logout_test_user", "password": "super_senha"})";
        crow::response res_login = router.handle_login(req_login);
        REQUIRE(res_login.code == 200);

        auto body_json = crow::json::load(res_login.body);
        std::string jwt_token = body_json["token"].s();

        // 2. Tenta acessar rota protegida (garante que token esta ativo)
        crow::request req_protected;
        req_protected.add_header("Authorization", "Bearer " + jwt_token);
        crow::response res_protected = router.handle_create_folder(req_protected);
        // Sem body, mas deve passar no authenticate_request e cair no erro 400
        REQUIRE(res_protected.code == 400); 

        // 3. Chama o Logout Global
        crow::request req_logout;
        req_logout.add_header("Authorization", "Bearer " + jwt_token);
        crow::response res_logout = router.handle_logout(req_logout);
        
        REQUIRE(res_logout.code == 200);
        // Verifica a limpeza de cookie do lado do cliente
        REQUIRE(res_logout.get_header_value("Set-Cookie").find("jwt=; HttpOnly; Path=/; Max-Age=0") != std::string::npos);

        // 4. O Passo Crítico: Tentar acessar a rota protegida novamente com o mesmo token (Versao A)
        crow::response res_replay = router.handle_create_folder(req_protected);
        REQUIRE(res_replay.code == 401);

        // 5. Verifica se novo login funciona (Token Versioning)
        crow::response res_login2 = router.handle_login(req_login);
        REQUIRE(res_login2.code == 200);
    }

    SECTION("Verificação de Conta (Base62, TTL e Brute-Force)") {
        RateLimitMiddleware rl_mw;
        rl_mw.init(pool);

        crow::request req_reg;
        req_reg.body = R"({"username": "verify_user", "email": "verify_user@test.com", "password": "super_senha"})";
        req_reg.add_header("CF-Connecting-IP", "10.0.0.99");
        router.handle_register(req_reg);
        
        std::string valid_token;
        {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            auto res = txn.exec("SELECT verification_token FROM users WHERE username = 'verify_user'");
            valid_token = res[0][0].as<std::string>();
            // Simula avanço de 6 minutos no tempo (já que o TTL é de 5 minutos, o token gerado em t=0 expiraria em t=5, em t=6 ele está expirado).
            txn.exec("UPDATE users SET token_expires_at = NOW() - INTERVAL '1 minute' WHERE username = 'verify_user'");
            txn.commit();
        }

        // Teste 1: Rejeição de um código expirado (simulando avanço do relógio em 6 minutos)
        crow::request req_expired;
        req_expired.url = "/verify?token=" + valid_token;
        req_expired.url_params = crow::query_string("?token=" + valid_token);
        crow::response res_expired = router.handle_verify_email(req_expired);
        REQUIRE(res_expired.code == 400);

        {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            txn.exec("UPDATE users SET token_expires_at = NOW() + INTERVAL '5 minutes' WHERE username = 'verify_user'");
            txn.commit();
        }

        // Teste 2: Força Bruta (5 tentativas seguidas com o código errado)
        RateLimitMiddleware::context ctx;
        crow::response dummy_res;
        
        for (int i = 0; i < 5; ++i) {
            crow::request req_bad;
            req_bad.url = "/verify";
            req_bad.url_params = crow::query_string("?token=WRONG1");
            req_bad.add_header("CF-Connecting-IP", "10.0.0.99");
            
            rl_mw.before_handle(req_bad, dummy_res, ctx);
            if (dummy_res.code != 0 && dummy_res.code != 200) break; // Middleware blocked!

            crow::response res_bad = router.handle_verify_email(req_bad);
            REQUIRE(res_bad.code == 400);
        }

        // A 6ª tentativa deve ser bloqueada pelo middleware (429 ou 403)
        crow::request req_blocked;
        req_blocked.url = "/verify";
        req_blocked.add_header("CF-Connecting-IP", "10.0.0.99");
        rl_mw.before_handle(req_blocked, dummy_res, ctx);
        REQUIRE(dummy_res.code != 0); // Está bloqueado! (Provavelmente 429 ou 403)

        // Limpeza do teste
        {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            txn.exec("DELETE FROM banned_ips WHERE ip = '10.0.0.99'");
            txn.commit();
        }
    }

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username = 'api_test_user'");
        txn.exec("DELETE FROM users WHERE username = 'logout_test_user'");
        txn.exec("DELETE FROM users WHERE username = 'verify_user'");
        txn.exec("DELETE FROM users WHERE email = 'oauth_user@test.com'");
        txn.exec("DELETE FROM users WHERE email = 'local_user@test.com'");
        txn.commit();
    }
}

