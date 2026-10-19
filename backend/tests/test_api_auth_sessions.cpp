#include <catch2/catch_test_macros.hpp>
#include "controllers/ApiRouter.hpp"
#include "database/DatabasePool.hpp"
#include "Services/AuthService.hpp"
#include "database/FolderManager.hpp"
#include "database/FileManager.hpp"
#include "storage/FileChunker.hpp"
#include "test_helpers.hpp"
#include <crow_all.h>
#include <thread>
#include <chrono>

TEST_CASE("API Auth - Gestao de Sessoes Locais", "[api][auth][sessions]") {
    std::string conn_str = get_secure_conn_string();
    DatabasePool pool(2, conn_str);
    MockEmailService mock_email;
    AuthService auth("SessoesSecret", "sessoes_salt", &mock_email);
    FolderManager folder_mgr(pool);
    FileManager file_mgr(pool);
    FileChunker chunker("test_sessions_dir");
    
    auth.set_database_pool(pool);
    ApiRouter router(pool, auth, folder_mgr, &file_mgr, &chunker);

    int user_id = 0;

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);

        txn.exec("CREATE TABLE IF NOT EXISTS user_sessions (session_id VARCHAR(7) PRIMARY KEY, user_id BIGINT REFERENCES users(id) ON DELETE CASCADE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)");
        txn.exec("DELETE FROM users WHERE username = 'session_user'");
        
        auto res = txn.exec("INSERT INTO users (username, email, password_hash, is_email_verified) VALUES ('session_user', 'sess@test.com', 'hash_s', true) RETURNING id");
        user_id = res[0][0].as<int>();
        txn.commit();
    }

    SECTION("Teste do 11º Dispositivo - Expulsao da Sessao Mais Antiga") {
        std::vector<std::string> tokens;
        
        // Simular 10 logins
        for (int i = 0; i < 10; ++i) {
            std::string t = auth.generate_token(user_id);
            tokens.push_back(t);
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
        }

        {
            auto conn = pool.acquire_connection();
            pqxx::nontransaction txn(*conn);
            auto count = txn.exec("SELECT COUNT(*) FROM user_sessions WHERE user_id = " + std::to_string(user_id));
            REQUIRE(count[0][0].as<int>() == 10);
        }

        // Simular 11º login
        std::string token_11 = auth.generate_token(user_id);

        {
            auto conn = pool.acquire_connection();
            pqxx::nontransaction txn(*conn);
            auto count = txn.exec("SELECT COUNT(*) FROM user_sessions WHERE user_id = " + std::to_string(user_id));
            REQUIRE(count[0][0].as<int>() == 10); // Still 10!
        }

        // Verify the first token is no longer valid
        auto decoded_opt = auth.verify_token(tokens[0]);
        REQUIRE(decoded_opt == std::nullopt); // Should fail because JTI is gone

        // Verify the 11th token is valid
        auto decoded_11 = auth.verify_token(token_11);
        REQUIRE(decoded_11 != std::nullopt);
    }

    SECTION("Teste de Logout Local") {
        std::string token_a = auth.generate_token(user_id);
        std::string token_b = auth.generate_token(user_id);

        // Verify both are valid initially
        REQUIRE(auth.verify_token(token_a) != std::nullopt);
        REQUIRE(auth.verify_token(token_b) != std::nullopt);

        // Logout Local for token A
        crow::request req;
        req.url = "/logout/local";
        req.method = crow::HTTPMethod::Post;
        req.add_header("Authorization", "Bearer " + token_a);
        
        crow::response res = router.handle_logout(req); // handle_logout should be local logout
        REQUIRE(res.code == 200);

        // Verify token A is invalid, token B is valid
        REQUIRE(auth.verify_token(token_a) == std::nullopt);
        REQUIRE(auth.verify_token(token_b) != std::nullopt);
    }

    SECTION("Teste de Middleware (Token Revogado)") {
        std::string token = auth.generate_token(user_id);
        
        // Manual deletion of JTI from DB
        {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            txn.exec("DELETE FROM user_sessions WHERE user_id = " + std::to_string(user_id));
            txn.commit();
        }

        // Test middleware effectively returning 401 using a protected route like /files
        crow::request req;
        req.url = "/api/users/me/quota";
        req.method = crow::HTTPMethod::Get;
        req.add_header("Authorization", "Bearer " + token);

        crow::response res = router.handle_get_quota(req);
        REQUIRE(res.code == 401);
    }

    SECTION("Teste de Logout Global - Invalida Todos") {
        std::string token_x = auth.generate_token(user_id);
        std::string token_y = auth.generate_token(user_id);
        std::string token_z = auth.generate_token(user_id);

        REQUIRE(auth.verify_token(token_x) != std::nullopt);
        REQUIRE(auth.verify_token(token_y) != std::nullopt);

        // Logout Global
        crow::request req;
        req.url = "/logout/global";
        req.method = crow::HTTPMethod::Post;
        req.add_header("Authorization", "Bearer " + token_x);
        
        crow::response res = router.handle_logout_global(req);
        REQUIRE(res.code == 200);

        // Verify ALL are invalid due to token_version increment
        REQUIRE(auth.verify_token(token_x) == std::nullopt);
        REQUIRE(auth.verify_token(token_y) == std::nullopt);
        REQUIRE(auth.verify_token(token_z) == std::nullopt);
    }

    SECTION("Teste de Double Logout e Token Malformado") {
        std::string token_a = auth.generate_token(user_id);

        crow::request req;
        req.url = "/logout";
        req.method = crow::HTTPMethod::Post;
        req.add_header("Authorization", "Bearer " + token_a);
        
        // Primeiro Logout
        crow::response res1 = router.handle_logout(req);
        REQUIRE(res1.code == 200);

        // Segundo Logout com o mesmo token (Ja revogado)
        crow::response res2 = router.handle_logout(req);
        REQUIRE(res2.code == 401);

        // Token Malformado
        req.headers.clear();
        req.add_header("Authorization", "Bearer invalid.token.struct");
        crow::response res3 = router.handle_logout(req);
        REQUIRE(res3.code == 401);
        
        // Sem Token
        req.headers.clear();
        crow::response res4 = router.handle_logout(req);
        REQUIRE(res4.code == 401);
    }

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username = 'session_user'");
        txn.commit();
    }
}
