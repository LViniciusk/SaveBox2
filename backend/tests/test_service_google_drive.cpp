#include <catch2/catch_test_macros.hpp>
#include "database/DatabasePool.hpp"
#include "test_helpers.hpp"
#include <pqxx/pqxx>
#include <stdlib.h>

TEST_CASE("Service Google Drive - Vinculação e Lógica de Token", "[service][googledrive]") {
    set_test_environment("GOOGLE_CLIENT_ID", "mock_client_id");
    set_test_environment("GOOGLE_CLIENT_SECRET", "mock_client_secret");
    
    std::string conn_str = get_secure_conn_string();
    DatabasePool pool(2, conn_str);
    MockGoogleDriveService gdrive(pool);

    // Limpar estado
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username = 'gd_service_user'");
        txn.exec("INSERT INTO users (id, username, email, password_hash, max_storage_bytes, is_email_verified) "
                 "VALUES (9999, 'gd_service_user', 'gd@test.com', 'hash', 104857600, true) "
                 "ON CONFLICT (id) DO NOTHING");
        txn.exec("DELETE FROM user_external_storages WHERE user_id = 9999");
        txn.commit();
    }

    struct DbCleanup {
        DatabasePool& p;
        uint64_t uid;
        ~DbCleanup() {
            try {
                auto c = p.acquire_connection();
                pqxx::work t(*c);
                t.exec("DELETE FROM files WHERE user_id = " + std::to_string(uid));
                t.exec("DELETE FROM user_external_storages WHERE user_id = " + std::to_string(uid));
                t.exec("DELETE FROM folders WHERE user_id = " + std::to_string(uid));
                t.exec("DELETE FROM users WHERE id = " + std::to_string(uid));
                t.commit();
            } catch(...) {}
        }
    } cleanup{pool, 9999};

    SECTION("Vincular conta com sucesso (mock)") {
        REQUIRE_FALSE(gdrive.is_linked(9999));
        
        std::string state = gdrive.generate_test_state(9999);
        auto result = gdrive.link_account(9999, "valid_auth_code_123", state);
        
        REQUIRE(result.root_folder_id == "mock_folder_123");
        REQUIRE(gdrive.is_linked(9999));
        
        gdrive.expect_refresh = true;
        auto accounts = gdrive.get_linked_accounts(9999);
        REQUIRE(accounts.size() == 1);
        std::string token = gdrive.get_access_token_for_storage(accounts[0].id);
        REQUIRE(token == "mock_access_token_xyz");
    }

    SECTION("Falha na API do Google ao vincular - Token Exchange Falha") {
        gdrive.token_exchange_ok = false;
        std::string state = gdrive.generate_test_state(9999);

        REQUIRE_THROWS_AS(gdrive.link_account(9999, "invalid_code", state), std::runtime_error);
        REQUIRE_FALSE(gdrive.is_linked(9999));
    }

    SECTION("Falha na API do Google ao criar pasta") {
        gdrive.create_folder_ok = false;
        std::string state = gdrive.generate_test_state(9999);

        REQUIRE_THROWS_AS(gdrive.link_account(9999, "valid_code", state), std::runtime_error);
        REQUIRE_FALSE(gdrive.is_linked(9999));
    }

    SECTION("Obter token valido (Refresh Token Success)") {
        std::string state = gdrive.generate_test_state(9999);
        gdrive.link_account(9999, "valid_auth_code_123", state);

        gdrive.expect_refresh = true;
        auto accounts = gdrive.get_linked_accounts(9999);
        REQUIRE(accounts.size() == 1);
        std::string token = gdrive.get_access_token_for_storage(accounts[0].id);
        REQUIRE(token == "mock_access_token_xyz");
        
        REQUIRE(accounts[0].root_folder_id == "mock_folder_123");
    }

    SECTION("Obter token falha (Refresh Token Expired/Revoked)") {
        std::string state = gdrive.generate_test_state(9999);
        gdrive.link_account(9999, "valid_auth_code_123", state);
        gdrive.refresh_token_ok = false;
        gdrive.expect_refresh = true;

        auto accounts = gdrive.get_linked_accounts(9999);
        REQUIRE(accounts.size() == 1);
        REQUIRE_THROWS_AS(gdrive.get_access_token_for_storage(accounts[0].id), std::runtime_error);
    }

    SECTION("Desvincular conta Google Drive") {
        std::string state = gdrive.generate_test_state(9999);
        gdrive.link_account(9999, "valid_auth_code_123", state);
        REQUIRE(gdrive.is_linked(9999));

        gdrive.unlink_account(9999);
        REQUIRE_FALSE(gdrive.is_linked(9999));
        
        gdrive.expect_refresh = true;
        auto accounts = gdrive.get_linked_accounts(9999);
        REQUIRE(accounts.empty());
        REQUIRE_THROWS_AS(gdrive.unlink_account(9999), std::runtime_error);
    }
}
