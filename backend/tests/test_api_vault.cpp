#include <catch2/catch_test_macros.hpp>
#include "controllers/ApiRouter.hpp"
#include "database/DatabasePool.hpp"
#include "Services/AuthService.hpp"
#include "database/FolderManager.hpp"
#include "test_helpers.hpp"
#include <pqxx/pqxx>

TEST_CASE("API Vault - init exige verification criptografada", "[api][vault]") {
    constexpr uint64_t user_id = 9987;
    DatabasePool pool(2, get_secure_conn_string());
    MockEmailService email;
    AuthService auth("pepper", "secret", &email);
    FolderManager folders(pool);
    ApiRouter router(pool, auth, folders);

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE id = $1", pqxx::params{user_id});
        txn.exec("INSERT INTO users (id, username, email, password_hash, is_email_verified) "
                 "VALUES ($1, 'vault_api_user', 'vault-api@test.com', 'hash', TRUE)",
                 pqxx::params{user_id});
        txn.commit();
    }
    struct Cleanup {
        DatabasePool& pool;
        ~Cleanup() {
            try {
                auto conn = pool.acquire_connection();
                pqxx::work txn(*conn);
                txn.exec("DELETE FROM users WHERE id = 9987");
                txn.commit();
            } catch (...) {}
        }
    } cleanup{pool};

    const auto token = auth.generate_token(user_id);

    SECTION("sem auth retorna 401") {
        crow::request req;
        req.body = R"({"vault_verification":"ciphertext"})";
        REQUIRE(router.handle_init_vault(req).code == 401);
    }

    SECTION("payload inválido retorna 400 e não inicializa") {
        crow::request req;
        req.add_header("Authorization", "Bearer " + token);
        req.body = R"({})";
        const auto response = router.handle_init_vault(req);
        REQUIRE(response.code == 400);
        REQUIRE(response.body.find("VAULT_VERIFICATION_INVALID") != std::string::npos);

        auto conn = pool.acquire_connection();
        pqxx::nontransaction query(*conn);
        const auto row = query.exec("SELECT is_vault_initialized, vault_verification FROM users WHERE id = $1",
                                    pqxx::params{user_id})[0];
        REQUIRE(row[0].as<bool>() == false);
        REQUIRE(row[1].is_null());
    }

    SECTION("tipos e tamanho inválidos retornam 400") {
        for (const auto& payload : {
            std::string(R"({"vault_verification":null})"),
            std::string(R"({"vault_verification":123})"),
            std::string(R"({"vault_verification":""})"),
            std::string(R"({"vault_verification":" )")
        }) {
            crow::request req;
            req.add_header("Authorization", "Bearer " + token);
            req.body = payload;
            REQUIRE(router.handle_init_vault(req).code == 400);
        }

        crow::request oversized;
        oversized.add_header("Authorization", "Bearer " + token);
        oversized.body = R"({"vault_verification":")" + std::string(16 * 1024 + 1, 'x') + R"("})";
        REQUIRE(router.handle_init_vault(oversized).code == 400);
    }

    SECTION("GET sem auth e GET sem verificação retornam estados seguros") {
        crow::request unauthenticated;
        REQUIRE(router.handle_get_vault_verification(unauthenticated).code == 401);

        crow::request get;
        get.add_header("Authorization", "Bearer " + token);
        auto response = router.handle_get_vault_verification(get);
        REQUIRE(response.code == 404);
        REQUIRE(response.get_header_value("Cache-Control") == "no-store");
        REQUIRE(response.get_header_value("Pragma") == "no-cache");
    }

    SECTION("valor válido persiste somente ciphertext e GET usa no-store") {
        crow::request init;
        init.add_header("Authorization", "Bearer " + token);
        init.body = R"({"vault_verification":"ciphertext-only"})";
        REQUIRE(router.handle_init_vault(init).code == 204);

        auto conn = pool.acquire_connection();
        pqxx::nontransaction query(*conn);
        const auto row = query.exec("SELECT is_vault_initialized, vault_verification FROM users WHERE id = $1",
                                    pqxx::params{user_id})[0];
        REQUIRE(row[0].as<bool>() == true);
        REQUIRE(row[1].as<std::string>() == "ciphertext-only");

        crow::request get;
        get.add_header("Authorization", "Bearer " + token);
        auto response = router.handle_get_vault_verification(get);
        REQUIRE(response.code == 200);
        REQUIRE(response.get_header_value("Cache-Control") == "no-store");
        REQUIRE(response.get_header_value("Pragma") == "no-cache");
        REQUIRE(response.body.find("ciphertext-only") != std::string::npos);
        REQUIRE(response.body.find("vaultKey") == std::string::npos);
    }
}
