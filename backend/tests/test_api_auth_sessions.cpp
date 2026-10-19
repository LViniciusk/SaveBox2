#include <catch2/catch_test_macros.hpp>
#include "controllers/ApiRouter.hpp"
#include "database/DatabasePool.hpp"
#include "Services/AuthService.hpp"
#include "database/FolderManager.hpp"
#include "database/FileManager.hpp"
#include "storage/FileChunker.hpp"
#include "test_helpers.hpp"
#include "utils/RandomIds.hpp"
#include <crow_all.h>
#include <jwt-cpp/jwt.h>
#include <thread>
#include <chrono>
#include <exception>
#include <atomic>
#include <vector>

namespace {

int create_b35_user(DatabasePool& pool, const std::string& username, const std::string& email,
                    const std::string& password_hash = "hash_b35", bool deleted = false) {
    auto conn = pool.acquire_connection();
    pqxx::work txn(*conn);
    txn.exec("DELETE FROM users WHERE username = $1", pqxx::params{username});
    const auto result = txn.exec(
        "INSERT INTO users(username,email,password_hash,is_email_verified,deleted_at) "
        "VALUES($1,$2,$3,TRUE,$4) RETURNING id",
        pqxx::params{username, email, password_hash, deleted ? std::optional<std::string>("now") : std::nullopt});
    txn.commit();
    return result[0][0].as<int>();
}

int b35_session_count(DatabasePool& pool, int user_id) {
    auto conn = pool.acquire_connection();
    pqxx::nontransaction txn(*conn);
    return txn.exec("SELECT count(*) FROM user_sessions WHERE user_id = $1", pqxx::params{user_id})[0][0].as<int>();
}

std::string b35_signed_token(const std::string& secret, uint64_t user_id, const std::string& jti, int token_version = 1) {
    const auto issued_at = std::chrono::system_clock::now() - std::chrono::minutes(1);
    return jwt::create()
        .set_type("JWT")
        .set_issued_at(issued_at)
        .set_expires_at(issued_at + std::chrono::hours(24))
        .set_payload_claim("user_id", jwt::claim(std::to_string(user_id)))
        .set_payload_claim("tver", jwt::claim(std::to_string(token_version)))
        .set_payload_claim("jti", jwt::claim(jti))
        .sign(jwt::algorithm::hs256{secret});
}

struct B35Cleanup {
    DatabasePool& pool;
    std::vector<int> user_ids;

    ~B35Cleanup() {
        try {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            for (const int user_id : user_ids) {
                txn.exec("DELETE FROM users WHERE id = $1", pqxx::params{user_id});
            }
            txn.commit();
        } catch (...) {
        }
    }
};

struct B38LogoutFailureGuard {
    DatabasePool& pool;
    int user_id;

    ~B38LogoutFailureGuard() {
        try {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            txn.exec("DROP TRIGGER IF EXISTS b38_logout_failure_trigger ON user_sessions");
            txn.exec("DROP FUNCTION IF EXISTS b38_logout_failure_fn()");
            txn.exec("DELETE FROM users WHERE id = $1", pqxx::params{user_id});
            txn.commit();
        } catch (...) {
        }
    }

    void install() {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec(R"SQL(
            CREATE OR REPLACE FUNCTION b38_logout_failure_fn()
            RETURNS trigger
            LANGUAGE plpgsql
            AS $$
            BEGIN
                RAISE EXCEPTION 'B38_PRIVATE_DB_TRIGGER_FAILURE';
            END;
            $$
        )SQL");
        txn.exec(R"SQL(
            CREATE TRIGGER b38_logout_failure_trigger
            BEFORE DELETE ON user_sessions
            FOR EACH ROW
            WHEN (OLD.session_id = 'B38ERR1')
            EXECUTE FUNCTION b38_logout_failure_fn()
        )SQL");
        txn.commit();
    }

    void remove_trigger() {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DROP TRIGGER IF EXISTS b38_logout_failure_trigger ON user_sessions");
        txn.exec("DROP FUNCTION IF EXISTS b38_logout_failure_fn()");
        txn.commit();
    }
};

} // namespace

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

TEST_CASE("B.38 logout local nao reporta sucesso sem revogacao persistida", "[api][auth][b38]") {
    DatabasePool pool(2, get_secure_conn_string());
    MockEmailService email;
    AuthService auth("B38_logout_pepper", "B38_logout_secret", &email);
    FolderManager folder_mgr(pool);
    auth.set_database_pool(pool);
    ApiRouter router(pool, auth, folder_mgr);

    int user_id = 0;
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username = 'auth_b38_logout_user'");
        const auto result = txn.exec(
            "INSERT INTO users(username,email,password_hash,is_email_verified) "
            "VALUES('auth_b38_logout_user','auth_b38_logout_user@test.com','hash_b38',TRUE) "
            "RETURNING id");
        user_id = result[0][0].as<int>();
        txn.commit();
    }
    B38LogoutFailureGuard cleanup{pool, user_id};

    Base62Generator::test_next_token() = "B38ERR1";
    const std::string token_a = auth.generate_token(user_id);
    Base62Generator::test_next_token() = "B38OTH1";
    const std::string token_b = auth.generate_token(user_id);
    REQUIRE(auth.verify_token(token_a) == std::optional<uint64_t>(user_id));
    REQUIRE(auth.verify_token(token_b) == std::optional<uint64_t>(user_id));

    cleanup.install();

    crow::request logout_request;
    logout_request.method = crow::HTTPMethod::Post;
    logout_request.add_header("Authorization", "Bearer " + token_a);
    auto failed = router.handle_logout(logout_request);

    CHECK(failed.code == 500);
    CHECK(failed.body.find("Erro interno") != std::string::npos);
    CHECK(failed.body.find("B38_PRIVATE_DB_TRIGGER_FAILURE") == std::string::npos);
    CHECK(failed.body.find("user_sessions") == std::string::npos);
    CHECK(failed.body.find("DELETE") == std::string::npos);
    CHECK(failed.body.find("pqxx") == std::string::npos);
    CHECK(failed.body.find("postgres") == std::string::npos);
    CHECK(failed.body.find("session_id") == std::string::npos);
    CHECK(failed.body.find("B38ERR1") == std::string::npos);
    CHECK(failed.get_header_value("Set-Cookie").empty());

    {
        auto conn = pool.acquire_connection();
        pqxx::nontransaction txn(*conn);
        const auto row = txn.exec(
            "SELECT count(*) FROM user_sessions WHERE user_id = $1 AND session_id = $2",
            pqxx::params{user_id, "B38ERR1"});
        CHECK(row[0][0].as<int>() == 1);
    }
    CHECK(auth.verify_token(token_a) == std::optional<uint64_t>(user_id));
    CHECK(auth.verify_token(token_b) == std::optional<uint64_t>(user_id));

    cleanup.remove_trigger();
    auto retry = router.handle_logout(logout_request);
    REQUIRE(retry.code == 200);
    REQUIRE(retry.body.find("Logout local realizado com sucesso") != std::string::npos);
    REQUIRE(retry.get_header_value("Set-Cookie").find("jwt=; HttpOnly; Path=/; Max-Age=0") != std::string::npos);
    REQUIRE(auth.verify_token(token_a) == std::nullopt);
    REQUIRE(auth.verify_token(token_b) == std::optional<uint64_t>(user_id));
}

TEST_CASE("B.35 issuer fails closed on cross-user JTI collision", "[auth][b35]") {
    DatabasePool pool(4, get_secure_conn_string());
    MockEmailService email;
    AuthService auth("B35_collision_pepper", "B35_collision_secret", &email);
    auth.set_database_pool(pool);
    B35Cleanup cleanup{pool, {}};

    const int owner_id = create_b35_user(pool, "b35_collision_owner", "b35-owner@test.com");
    const int collider_id = create_b35_user(pool, "b35_collision_collider", "b35-collider@test.com");
    cleanup.user_ids = {owner_id, collider_id};

    Base62Generator::test_next_token() = "COLLIDE";
    const std::string owner_token = auth.generate_token(owner_id);

    Base62Generator::test_next_token() = "COLLIDE";
    std::string collider_token;
    std::exception_ptr collider_error;
    try {
        collider_token = auth.generate_token(collider_id);
    } catch (...) {
        collider_error = std::current_exception();
    }

    CHECK_FALSE(owner_token.empty());
    CHECK(collider_error != nullptr);
    CHECK(collider_token.empty());
    CHECK(b35_session_count(pool, owner_id) == 1);
    CHECK(b35_session_count(pool, collider_id) == 0);
    CHECK(auth.verify_token(owner_token) == std::optional<uint64_t>(owner_id));
    CHECK((collider_token.empty() || auth.verify_token(collider_token) == std::nullopt));
}

TEST_CASE("B.35 issuer fails closed on same-user JTI collision", "[auth][b35]") {
    DatabasePool pool(4, get_secure_conn_string());
    MockEmailService email;
    AuthService auth("B35_same_collision_pepper", "B35_same_collision_secret", &email);
    auth.set_database_pool(pool);
    B35Cleanup cleanup{pool, {}};

    const int user_id = create_b35_user(pool, "b35_same_collision", "b35-same-collision@test.com");
    cleanup.user_ids = {user_id};

    Base62Generator::test_next_token() = "SAME001";
    const std::string owner_token = auth.generate_token(user_id);

    Base62Generator::test_next_token() = "SAME001";
    std::string duplicate_token;
    std::exception_ptr duplicate_error;
    try {
        duplicate_token = auth.generate_token(user_id);
    } catch (...) {
        duplicate_error = std::current_exception();
    }

    CHECK(duplicate_error != nullptr);
    CHECK(duplicate_token.empty());
    CHECK(b35_session_count(pool, user_id) == 1);
    CHECK(auth.verify_token(owner_token) == std::optional<uint64_t>(user_id));
}

TEST_CASE("B.35 verifier binds JTI ownership to the JWT user", "[auth][b35]") {
    DatabasePool pool(4, get_secure_conn_string());
    MockEmailService email;
    AuthService auth("B35_verify_pepper", "B35_verify_secret", &email);
    auth.set_database_pool(pool);
    FolderManager folders(pool);
    ApiRouter router(pool, auth, folders);
    B35Cleanup cleanup{pool, {}};

    const int owner_id = create_b35_user(pool, "b35_verify_owner", "b35-verify-owner@test.com");
    const int forged_id = create_b35_user(pool, "b35_verify_forged", "b35-verify-forged@test.com");
    cleanup.user_ids = {owner_id, forged_id};

    Base62Generator::test_next_token() = "OWNED01";
    const std::string owner_token = auth.generate_token(owner_id);
    const std::string forged_token = b35_signed_token("B35_verify_secret", forged_id, "OWNED01");

    CHECK(auth.verify_token(owner_token) == std::optional<uint64_t>(owner_id));
    CHECK(auth.verify_token(forged_token) == std::nullopt);
    CHECK(b35_session_count(pool, owner_id) == 1);

    crow::request forged_logout;
    forged_logout.add_header("Authorization", "Bearer " + forged_token);
    CHECK(router.handle_logout(forged_logout).code == 401);
    CHECK(auth.verify_token(owner_token) == std::optional<uint64_t>(owner_id));
}

TEST_CASE("B.35 issuance fails closed for missing, deleted and unconfigured users", "[auth][b35]") {
    DatabasePool pool(4, get_secure_conn_string());
    MockEmailService email;
    AuthService auth("B35_issuer_pepper", "B35_issuer_secret", &email);
    auth.set_database_pool(pool);
    B35Cleanup cleanup{pool, {}};

    const int deleted_id = create_b35_user(pool, "b35_deleted", "b35-deleted@test.com", "hash_b35", true);
    cleanup.user_ids = {deleted_id};

    CHECK_THROWS(auth.generate_token(999999999));
    CHECK_THROWS(auth.generate_token(deleted_id));
    CHECK(b35_session_count(pool, deleted_id) == 0);

    AuthService no_pool("B35_issuer_pepper", "B35_no_pool_secret", &email);
    CHECK_THROWS(no_pool.generate_token(deleted_id));
    const std::string signed_without_session = b35_signed_token(
        "B35_no_pool_secret", deleted_id, "NOPOOL1");
    CHECK(no_pool.verify_token(signed_without_session) == std::nullopt);
}

TEST_CASE("B.35 local login does not emit a token after session collision", "[api][auth][b35]") {
    DatabasePool pool(4, get_secure_conn_string());
    MockEmailService email;
    AuthService auth("B35_api_pepper", "B35_api_secret", &email);
    auth.set_database_pool(pool);
    FolderManager folders(pool);
    ApiRouter router(pool, auth, folders);
    B35Cleanup cleanup{pool, {}};

    const int owner_id = create_b35_user(pool, "b35_api_owner", "b35-api-owner@test.com");
    const std::string password_hash = auth.hash_password("b35-password");
    const int login_id = create_b35_user(
        pool, "b35_api_login", "b35-api-login@test.com", password_hash);
    cleanup.user_ids = {owner_id, login_id};

    Base62Generator::test_next_token() = "APIJTI1";
    const std::string owner_token = auth.generate_token(owner_id);
    Base62Generator::test_next_token() = "APIJTI1";

    crow::request request;
    request.body = R"({"username":"b35_api_login","password":"b35-password"})";
    crow::response response = router.handle_login(request);

    CHECK(response.code == 500);
    CHECK(response.body.find("token") == std::string::npos);
    CHECK(response.get_header_value("Set-Cookie").empty());
    CHECK(auth.verify_token(owner_token) == std::optional<uint64_t>(owner_id));
    CHECK(b35_session_count(pool, login_id) == 0);
}

TEST_CASE("B.35 same-user issuance keeps ten sessions under a deterministic lock race", "[auth][b35]") {
    DatabasePool pool(8, get_secure_conn_string());
    MockEmailService email;
    AuthService auth("B35_race_pepper", "B35_race_secret", &email);
    auth.set_database_pool(pool);
    B35Cleanup cleanup{pool, {}};
    const int user_id = create_b35_user(pool, "b35_race_user", "b35-race@test.com");
    cleanup.user_ids = {user_id};

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM user_sessions WHERE user_id = $1", pqxx::params{user_id});
        for (int index = 1; index <= 10; ++index) {
            const std::string session_id = std::string("OLD") + (index < 10 ? "000" : "00") + std::to_string(index);
            txn.exec(
                "INSERT INTO user_sessions(session_id,user_id,created_at) "
                "VALUES($1,$2,CURRENT_TIMESTAMP - ($3 * INTERVAL '1 second'))",
                pqxx::params{session_id, user_id, 100 - index});
        }
        txn.commit();
    }

    auto blocker_connection = pool.acquire_connection();
    pqxx::work blocker(*blocker_connection);
    blocker.exec(
        "SELECT session_id FROM user_sessions WHERE session_id = 'OLD0001' FOR UPDATE");

    std::string token_a;
    std::string token_b;
    std::exception_ptr error_a;
    std::exception_ptr error_b;
    std::thread first([&] {
        Base62Generator::test_next_token() = "RACEA01";
        try {
            token_a = auth.generate_token(user_id);
        } catch (...) {
            error_a = std::current_exception();
        }
    });
    std::thread second([&] {
        Base62Generator::test_next_token() = "RACEB01";
        try {
            token_b = auth.generate_token(user_id);
        } catch (...) {
            error_b = std::current_exception();
        }
    });

    bool observed_waiters = false;
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (!observed_waiters && std::chrono::steady_clock::now() < deadline) {
        auto observer_connection = pool.acquire_connection();
        pqxx::nontransaction observer(*observer_connection);
        const auto result = observer.exec(
            "SELECT count(*) FROM pg_stat_activity "
            "WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock' "
            "AND (query ILIKE '%user_sessions%' OR query ILIKE '%FROM users%')");
        observed_waiters = result[0][0].as<int>() >= 2;
        if (!observed_waiters) std::this_thread::yield();
    }

    blocker.commit();
    first.join();
    second.join();

    CHECK(observed_waiters);
    CHECK_FALSE(error_a);
    CHECK_FALSE(error_b);
    CHECK_FALSE(token_a.empty());
    CHECK_FALSE(token_b.empty());
    CHECK(b35_session_count(pool, user_id) == 10);
    CHECK(auth.verify_token(token_a) == std::optional<uint64_t>(user_id));
    CHECK(auth.verify_token(token_b) == std::optional<uint64_t>(user_id));
}

TEST_CASE("B.35 refresh preserves the logical session slot", "[api][auth][b35]") {
    DatabasePool pool(6, get_secure_conn_string());
    MockEmailService email;
    AuthService auth("B35_refresh_pepper", "B35_refresh_secret", &email);
    auth.set_database_pool(pool);
    FolderManager folders(pool);
    ApiRouter router(pool, auth, folders);
    B35Cleanup cleanup{pool, {}};
    const int user_id = create_b35_user(pool, "b35_refresh_user", "b35-refresh@test.com");
    cleanup.user_ids = {user_id};

    const std::string token_1 = auth.generate_token(user_id);
    REQUIRE(b35_session_count(pool, user_id) == 1);

    const auto refresh = [&](const std::string& token) {
        crow::request request;
        request.add_header("Cookie", "jwt=" + token);
        return router.handle_refresh(request);
    };

    crow::response response_2 = refresh(token_1);
    std::string token_2;
    if (response_2.code == 200) token_2 = crow::json::load(response_2.body)["token"].s();
    crow::response response_3 = refresh(token_2.empty() ? token_1 : token_2);
    std::string token_3;
    if (response_3.code == 200) token_3 = crow::json::load(response_3.body)["token"].s();

    CHECK(response_2.code == 200);
    CHECK(response_3.code == 200);
    CHECK(b35_session_count(pool, user_id) == 1);
    CHECK_FALSE(token_2.empty());
    CHECK_FALSE(token_3.empty());
    CHECK(auth.extract_jti(token_1) == auth.extract_jti(token_2));
    CHECK(auth.extract_jti(token_2) == auth.extract_jti(token_3));
    CHECK(auth.verify_token(token_1) == std::optional<uint64_t>(user_id));
    CHECK(auth.verify_token(token_3) == std::optional<uint64_t>(user_id));

    crow::request logout_request;
    logout_request.add_header("Authorization", "Bearer " + token_3);
    CHECK(router.handle_logout(logout_request).code == 200);
    CHECK(auth.verify_token(token_1) == std::nullopt);
    CHECK(auth.verify_token(token_3) == std::nullopt);
}

TEST_CASE("B.35 refresh does not evict unrelated logical devices", "[api][auth][b35]") {
    DatabasePool pool(6, get_secure_conn_string());
    MockEmailService email;
    AuthService auth("B35_devices_pepper", "B35_devices_secret", &email);
    auth.set_database_pool(pool);
    FolderManager folders(pool);
    ApiRouter router(pool, auth, folders);
    B35Cleanup cleanup{pool, {}};
    const int user_id = create_b35_user(pool, "b35_devices_user", "b35-devices@test.com");
    cleanup.user_ids = {user_id};

    std::vector<std::string> tokens;
    for (int index = 0; index < 10; ++index) tokens.push_back(auth.generate_token(user_id));
    REQUIRE(b35_session_count(pool, user_id) == 10);

    crow::request request;
    request.add_header("Cookie", "jwt=" + tokens.front());
    crow::response response = router.handle_refresh(request);
    std::string refreshed;
    if (response.code == 200) refreshed = crow::json::load(response.body)["token"].s();

    CHECK(response.code == 200);
    CHECK_FALSE(refreshed.empty());
    CHECK(b35_session_count(pool, user_id) == 10);
    CHECK(auth.extract_jti(refreshed) == auth.extract_jti(tokens.front()));
    CHECK(auth.verify_token(tokens.front()) == std::optional<uint64_t>(user_id));
    for (std::size_t index = 1; index < tokens.size(); ++index) {
        CHECK(auth.verify_token(tokens[index]) == std::optional<uint64_t>(user_id));
    }
}

TEST_CASE("B.35 refreshed JWT remains subject to global logout", "[api][auth][b35]") {
    DatabasePool pool(4, get_secure_conn_string());
    MockEmailService email;
    AuthService auth("B35_global_refresh_pepper", "B35_global_refresh_secret", &email);
    auth.set_database_pool(pool);
    FolderManager folders(pool);
    ApiRouter router(pool, auth, folders);
    B35Cleanup cleanup{pool, {}};
    const int user_id = create_b35_user(pool, "b35_global_refresh", "b35-global-refresh@test.com");
    cleanup.user_ids = {user_id};

    const std::string original = auth.generate_token(user_id);
    crow::request refresh_request;
    refresh_request.add_header("Cookie", "jwt=" + original);
    crow::response refresh_response = router.handle_refresh(refresh_request);
    REQUIRE(refresh_response.code == 200);
    const std::string refreshed = crow::json::load(refresh_response.body)["token"].s();

    crow::request logout_request;
    logout_request.add_header("Authorization", "Bearer " + refreshed);
    REQUIRE(router.handle_logout_global(logout_request).code == 200);
    CHECK(auth.verify_token(original) == std::nullopt);
    CHECK(auth.verify_token(refreshed) == std::nullopt);

    crow::request stale_refresh;
    stale_refresh.add_header("Cookie", "jwt=" + original);
    CHECK(router.handle_refresh(stale_refresh).code == 401);
}

TEST_CASE("B.35 concurrent refresh keeps one logical session", "[api][auth][b35]") {
    DatabasePool pool(8, get_secure_conn_string());
    MockEmailService email;
    AuthService auth("B35_concurrent_refresh_pepper", "B35_concurrent_refresh_secret", &email);
    auth.set_database_pool(pool);
    FolderManager folders(pool);
    ApiRouter router(pool, auth, folders);
    B35Cleanup cleanup{pool, {}};
    const int user_id = create_b35_user(pool, "b35_concurrent_refresh", "b35-concurrent-refresh@test.com");
    cleanup.user_ids = {user_id};
    const std::string original = auth.generate_token(user_id);

    crow::response response_a;
    crow::response response_b;
    std::thread first([&] {
        crow::request request;
        request.add_header("Cookie", "jwt=" + original);
        response_a = router.handle_refresh(request);
    });
    std::thread second([&] {
        crow::request request;
        request.add_header("Cookie", "jwt=" + original);
        response_b = router.handle_refresh(request);
    });
    first.join();
    second.join();

    CHECK(response_a.code == 200);
    CHECK(response_b.code == 200);
    CHECK(b35_session_count(pool, user_id) == 1);
    if (response_a.code == 200 && response_b.code == 200) {
        const std::string token_a = crow::json::load(response_a.body)["token"].s();
        const std::string token_b = crow::json::load(response_b.body)["token"].s();
        CHECK(auth.extract_jti(token_a) == auth.extract_jti(original));
        CHECK(auth.extract_jti(token_b) == auth.extract_jti(original));
    }
}

TEST_CASE("B.35 refresh versus session pruning has a linearizable lock order", "[auth][b35][microfreeze]") {
    DatabasePool pool(8, get_secure_conn_string());
    MockEmailService email;
    AuthService auth("B35_microfreeze_pepper", "B35_microfreeze_secret", &email);
    auth.set_database_pool(pool);
    B35Cleanup cleanup{pool, {}};
    const int user_id = create_b35_user(pool, "b35_microfreeze_user", "b35-microfreeze@test.com");
    cleanup.user_ids = {user_id};

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM user_sessions WHERE user_id = $1", pqxx::params{user_id});
        for (int index = 1; index <= 10; ++index) {
            const std::string session_id = std::string("OLD") + (index < 10 ? "000" : "00") + std::to_string(index);
            txn.exec(
                "INSERT INTO user_sessions(session_id,user_id,created_at) "
                "VALUES($1,$2,CURRENT_TIMESTAMP - ($3 * INTERVAL '1 second'))",
                pqxx::params{session_id, user_id, 100 - index});
        }
        txn.commit();
    }

    const std::string oldest_token = b35_signed_token(
        "B35_microfreeze_secret", user_id, "OLD0001");
    std::vector<std::string> unaffected_tokens;
    for (int index = 2; index <= 10; ++index) {
        const std::string session_id = std::string("OLD") + (index < 10 ? "000" : "00") + std::to_string(index);
        unaffected_tokens.push_back(b35_signed_token(
            "B35_microfreeze_secret", user_id, session_id));
    }

    auto setup_connection = pool.acquire_connection();
    pqxx::nontransaction setup(*setup_connection);
    const auto setup_count = setup.exec(
        "SELECT count(*) FROM user_sessions WHERE user_id = $1", pqxx::params{user_id});
    const auto oldest = setup.exec(
        "SELECT session_id FROM user_sessions WHERE user_id = $1 "
        "ORDER BY created_at DESC, session_id DESC OFFSET 9 LIMIT 1",
        pqxx::params{user_id});
    REQUIRE(setup_count[0][0].as<int>() == 10);
    REQUIRE(oldest[0][0].as<std::string>() == "OLD0001");

    auto blocker_connection = pool.acquire_connection();
    pqxx::work blocker(*blocker_connection);
    blocker.exec(
        "SELECT session_id FROM user_sessions WHERE session_id = 'OLD0001' FOR UPDATE");

    std::string issued_token;
    std::optional<std::string> refreshed_token;
    std::exception_ptr issue_error;
    std::exception_ptr refresh_error;
    std::atomic<bool> refresh_started{false};

    std::thread issuer([&] {
        Base62Generator::test_next_token() = "RACE110";
        try {
            issued_token = auth.generate_token(user_id);
        } catch (...) {
            issue_error = std::current_exception();
        }
    });

    bool issuer_waiting = false;
    const auto issuer_deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (!issuer_waiting && std::chrono::steady_clock::now() < issuer_deadline) {
        auto observer_connection = pool.acquire_connection();
        pqxx::nontransaction observer(*observer_connection);
        const auto result = observer.exec(
            "SELECT count(*) FROM pg_stat_activity "
            "WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock' "
            "AND query ILIKE '%user_sessions%'");
        issuer_waiting = result[0][0].as<int>() >= 1;
        if (!issuer_waiting) std::this_thread::yield();
    }

    std::thread refresher([&] {
        refresh_started.store(true);
        try {
            refreshed_token = auth.refresh_token(oldest_token);
        } catch (...) {
            refresh_error = std::current_exception();
        }
    });

    bool overlap_observed = false;
    const auto overlap_deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (!overlap_observed && std::chrono::steady_clock::now() < overlap_deadline) {
        auto observer_connection = pool.acquire_connection();
        pqxx::nontransaction observer(*observer_connection);
        const auto result = observer.exec(
            "SELECT count(*) FROM pg_stat_activity "
            "WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock' "
            "AND query ILIKE '%user_sessions%'");
        overlap_observed = refresh_started.load() && result[0][0].as<int>() >= 2;
        if (!overlap_observed) std::this_thread::yield();
    }

    blocker.commit();
    issuer.join();
    refresher.join();

    CHECK(issuer_waiting);
    CHECK(overlap_observed);
    CHECK_FALSE(issue_error);
    CHECK_FALSE(refresh_error);
    CHECK_FALSE(issued_token.empty());
    CHECK(b35_session_count(pool, user_id) == 10);
    CHECK(auth.verify_token(issued_token) == std::optional<uint64_t>(user_id));
    CHECK(auth.verify_token(oldest_token) == std::nullopt);
    for (const auto& token : unaffected_tokens) {
        CHECK(auth.verify_token(token) == std::optional<uint64_t>(user_id));
    }
    const bool refreshed_still_valid = refreshed_token.has_value()
        && auth.verify_token(*refreshed_token) == std::optional<uint64_t>(user_id);
    CHECK_FALSE(refreshed_still_valid);
}
