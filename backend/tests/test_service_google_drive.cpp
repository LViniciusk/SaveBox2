#include <catch2/catch_test_macros.hpp>
#include "database/DatabasePool.hpp"
#include "database/UsersManager.hpp"
#include "storage/GarbageCollector.hpp"
#include "test_helpers.hpp"
#include <pqxx/pqxx>
#include <stdlib.h>
#include <exception>
#include <algorithm>
#include <array>
#include <atomic>
#include <condition_variable>
#include <future>
#include <mutex>
#include <thread>
#include <vector>

#ifdef NANIKA_TESTING
struct GoogleDriveQuotaTestProbe {
    static uint64_t used_bytes(GoogleDriveService& service, uint64_t storage_id) {
        return service.get_quota_for_storage(storage_id).used_bytes;
    }

    static bool has_flight(GoogleDriveService& service, uint64_t storage_id) {
        std::lock_guard<std::mutex> lock(service.quota_cache_mutex_);
        return service.quota_flights_.find(storage_id) != service.quota_flights_.end();
    }

    static bool wait_for_followers(GoogleDriveService& service, uint64_t storage_id, std::size_t expected) {
        std::shared_ptr<GoogleDriveService::QuotaFlight> flight;
        {
            std::lock_guard<std::mutex> lock(service.quota_cache_mutex_);
            const auto it = service.quota_flights_.find(storage_id);
            if (it == service.quota_flights_.end()) return false;
            flight = it->second;
        }

        std::unique_lock<std::mutex> lock(flight->test_followers_mutex);
        return flight->test_followers_cv.wait_for(lock, std::chrono::seconds(5), [&] {
            return flight->test_followers >= expected;
        });
    }
};
#endif

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

    SECTION("Captura foto HTTPS e ignora valores inseguros") {
        gdrive.mock_account_picture = "https://lh3.googleusercontent.com/avatar";
        gdrive.link_account(9999, "valid_auth_code_123", gdrive.generate_test_state(9999));
        REQUIRE(gdrive.get_linked_accounts(9999).at(0).account_picture == "https://lh3.googleusercontent.com/avatar");

        gdrive.unlink_account(9999);
        gdrive.mock_account_picture = "javascript:alert(1)";
        gdrive.link_account(9999, "valid_auth_code_123", gdrive.generate_test_state(9999));
        REQUIRE(gdrive.get_linked_accounts(9999).at(0).account_picture.empty());
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

    SECTION("Cria sessão resumível somente na raiz da conta vinculada") {
        gdrive.link_account(9999, "valid_auth_code_123", gdrive.generate_test_state(9999));
        gdrive.expect_refresh = true;
        const auto account = gdrive.get_linked_accounts(9999).at(0);

        const auto session = gdrive.create_resumable_session(9999, account.id, 10, 42, 43, "original");

        REQUIRE(session.session_uri == "https://upload.example/session-redacted");
        REQUIRE(session.access_token == "mock_access_token_xyz");
        REQUIRE(gdrive.last_json_body.find("nanika_move_id") != std::string::npos);
        REQUIRE(gdrive.last_json_body.find("\"nanika_move_item_id\":\"43\"") != std::string::npos);
        REQUIRE(gdrive.last_json_body.find("\"nanika_role\":\"original\"") != std::string::npos);

        gdrive.create_resumable_session(9999, account.id, 10, 42, 43, "original", "http://localhost:4200");
        REQUIRE(gdrive.last_session_headers.at("Origin") == "http://localhost:4200");
        REQUIRE(gdrive.last_session_headers.count("X-Forwarded-For") == 0);
        REQUIRE(gdrive.last_session_headers.count("Cookie") == 0);
    }

    SECTION("Valida propriedades opacas do alvo Google e reconcilia determinísticamente") {
        gdrive.link_account(9999, "valid_auth_code_123", gdrive.generate_test_state(9999));
        gdrive.expect_refresh = true;
        const auto account = gdrive.get_linked_accounts(9999).at(0);

        REQUIRE(gdrive.validate_external_target(9999, account.id, "target-a", 42, 43, "original") == 10);
        gdrive.reconcile_has_match = true;
        gdrive.reconcile_paged = true;
        const auto matches = gdrive.find_external_targets(9999, account.id, 42, 43, "original", 10);
        REQUIRE(matches == std::vector<std::string>({"target-a", "target-b"}));
    }

    SECTION("Valida tamanho e pertencimento do arquivo externo ao destino") {
        gdrive.link_account(9999, "valid_auth_code_123", gdrive.generate_test_state(9999));
        gdrive.expect_refresh = true;
        const auto account = gdrive.get_linked_accounts(9999).at(0);

        REQUIRE(gdrive.get_external_file_size(9999, account.id, "target-file") == 10);
        gdrive.final_file_in_root = false;
        try {
            gdrive.get_external_file_size(9999, account.id, "target-file");
            FAIL("Deveria rejeitar arquivo fora da raiz de destino");
        } catch (const std::runtime_error& error) {
            REQUIRE(std::string(error.what()) == "STORAGE_MOVE_TARGET_INCOMPLETE");
        }
    }

    SECTION("Cacheia quota da conta por uma janela curta") {
        gdrive.link_account(9999, "valid_auth_code_123", gdrive.generate_test_state(9999));
        gdrive.expect_refresh = true;

        const auto first = gdrive.get_storage_targets(9999).at(0);
        const auto second = gdrive.get_storage_targets(9999).at(0);

        REQUIRE(first.status == "ready");
        REQUIRE(first.used_bytes.has_value());
        REQUIRE(*first.used_bytes == 500000000000);
        REQUIRE(first.max_bytes.has_value());
        REQUIRE(*first.max_bytes == 1000000000000);
        REQUIRE(first.available_bytes.has_value());
        REQUIRE(*first.available_bytes == 500000000000);
        REQUIRE(second.available_bytes == first.available_bytes);
        REQUIRE(gdrive.quota_requests == 1);
    }
}

namespace {

struct B81UserFixture {
    DatabasePool& pool;
    uint64_t user_id;

    B81UserFixture(DatabasePool& pool_ref, uint64_t id, std::string email)
        : pool(pool_ref), user_id(id) {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE id=$1", pqxx::params{user_id});
        txn.exec(
            "INSERT INTO users(id,username,email,password_hash,max_storage_bytes,is_email_verified) "
            "VALUES($1,$2,$3,'hash',104857600,TRUE)",
            pqxx::params{user_id, "b81_user_" + std::to_string(user_id), std::move(email)});
        txn.commit();
    }

    ~B81UserFixture() {
        try {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            txn.exec("DELETE FROM users WHERE id=$1", pqxx::params{user_id});
            txn.commit();
        } catch (...) {
        }
    }
};

std::string b81_claim(DatabasePool& pool, uint64_t user_id, const std::string& email) {
    auto conn = pool.acquire_connection();
    pqxx::work txn(*conn);
    const auto rows = txn.exec(
        "SELECT claim_id FROM google_link_claims WHERE user_id=$1 AND account_email=$2",
        pqxx::params{user_id, email});
    txn.commit();
    return rows.empty() ? std::string{} : rows[0][0].as<std::string>();
}

int b81_count(DatabasePool& pool, const std::string& query, uint64_t user_id, const std::string& email) {
    auto conn = pool.acquire_connection();
    pqxx::work txn(*conn);
    const auto count = txn.exec(query, pqxx::params{user_id, email})[0][0].as<int>();
    txn.commit();
    return count;
}

} // namespace

TEST_CASE("B.81 provider folder HTTP does not retain a DatabasePool slot",
          "[service][googledrive][b81]") {
    set_test_environment("GOOGLE_CLIENT_ID", "mock_client_id");
    set_test_environment("GOOGLE_CLIENT_SECRET", "mock_client_secret");

    DatabasePool pool(2, get_secure_conn_string());
    MockGoogleDriveService gdrive(pool);
    B81UserFixture user(pool, 9811, "b81-lease@test.com");

    gdrive.enable_link_gate(1);
    std::exception_ptr error;
    std::thread owner([&] {
        try {
            (void)gdrive.link_account(user.user_id, "b81-lease-code",
                                      gdrive.generate_test_state(user.user_id));
        } catch (...) {
            error = std::current_exception();
        }
    });

    const bool provider_started = gdrive.wait_for_link_waiters(1);
    REQUIRE(provider_started);
    const auto available_during_provider = pool.get_available_count();
    gdrive.release_link_gate();
    owner.join();

    CHECK_FALSE(error);
    CHECK(available_during_provider == 2);
}

TEST_CASE("B.81 live claim rejects a duplicate before provider HTTP",
          "[service][googledrive][b81]") {
    set_test_environment("GOOGLE_CLIENT_ID", "mock_client_id");
    set_test_environment("GOOGLE_CLIENT_SECRET", "mock_client_secret");

    DatabasePool pool(4, get_secure_conn_string());
    MockGoogleDriveService gdrive(pool);
    B81UserFixture user(pool, 9812, "b81-live@test.com");
    gdrive.mock_account_email = "b81-live-google@test.com";

    gdrive.enable_link_gate(1);
    std::exception_ptr first_error;
    const auto first_state = gdrive.generate_test_state(user.user_id);
    std::thread first([&] {
        try {
            (void)gdrive.link_account(user.user_id, "b81-live-a", first_state);
        } catch (...) {
            first_error = std::current_exception();
        }
    });
    REQUIRE(gdrive.wait_for_link_waiters(1));

    const auto second_state = gdrive.generate_test_state(user.user_id);
    auto second = std::async(std::launch::async, [&] {
        try {
            (void)gdrive.link_account(user.user_id, "b81-live-b", second_state);
            return std::string{};
        } catch (const std::exception& error) {
            return std::string(error.what());
        }
    });
    const bool second_finished_before_provider_release =
        second.wait_for(std::chrono::seconds(2)) == std::future_status::ready;

    gdrive.release_link_gate();
    first.join();
    const auto second_error = second.get();

    CHECK(second_finished_before_provider_release);
    CHECK_FALSE(first_error);
    CHECK(second_error == "LINK_IN_PROGRESS");
    CHECK(gdrive.folder_search_requests.load() == 1);
    CHECK(gdrive.folder_create_requests.load() == 1);
}

TEST_CASE("B.81 stale takeover fences old finalization and cleanup",
          "[service][googledrive][b81]") {
    set_test_environment("GOOGLE_CLIENT_ID", "mock_client_id");
    set_test_environment("GOOGLE_CLIENT_SECRET", "mock_client_secret");

    DatabasePool pool(4, get_secure_conn_string());
    MockGoogleDriveService gdrive(pool);
    B81UserFixture user(pool, 9813, "b81-fence@test.com");
    gdrive.mock_account_email = "b81-fence-google@test.com";
    gdrive.numbered_folder_ids = true;
    gdrive.enable_link_gate(2);

    std::exception_ptr first_error;
    const auto first_state = gdrive.generate_test_state(user.user_id);
    std::thread first([&] {
        try {
            (void)gdrive.link_account(user.user_id, "b81-fence-a", first_state);
        } catch (...) {
            first_error = std::current_exception();
        }
    });
    REQUIRE(gdrive.wait_for_link_waiters(1));

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec(
            "UPDATE google_link_claims SET expires_at=CURRENT_TIMESTAMP - INTERVAL '1 second' "
            "WHERE user_id=$1 AND account_email=$2",
            pqxx::params{user.user_id, gdrive.mock_account_email});
        txn.commit();
    }

    std::exception_ptr second_error;
    const auto second_state = gdrive.generate_test_state(user.user_id);
    std::thread second([&] {
        try {
            (void)gdrive.link_account(user.user_id, "b81-fence-b", second_state);
        } catch (...) {
            second_error = std::current_exception();
        }
    });
    const bool takeover_reached_provider = gdrive.wait_for_link_waiters(2);
    if (!takeover_reached_provider) {
        gdrive.release_link_gate();
        first.join();
        second.join();
        FAIL("stale claim takeover did not reach provider");
    }

    const auto replacement_claim = b81_claim(pool, user.user_id, gdrive.mock_account_email);
    REQUIRE_FALSE(replacement_claim.empty());
    gdrive.release_link_request(1);
    first.join();

    REQUIRE(first_error);
    try {
        std::rethrow_exception(first_error);
    } catch (const std::runtime_error& error) {
        CHECK(std::string(error.what()) == "LINK_CLAIM_LOST");
    }
    CHECK(b81_claim(pool, user.user_id, gdrive.mock_account_email) == replacement_claim);
    CHECK(b81_count(
        pool,
        "SELECT count(*) FROM user_external_storages WHERE user_id=$1 AND account_email=$2 "
        "AND is_unlinking=FALSE",
        user.user_id, gdrive.mock_account_email) == 0);

    gdrive.release_link_gate();
    second.join();
    CHECK_FALSE(second_error);
    CHECK(b81_claim(pool, user.user_id, gdrive.mock_account_email).empty());
    CHECK(b81_count(
        pool,
        "SELECT count(*) FROM user_external_storages WHERE user_id=$1 AND account_email=$2 "
        "AND is_unlinking=FALSE",
        user.user_id, gdrive.mock_account_email) == 1);
}

TEST_CASE("B.81 historical unlinking row does not block a new link",
          "[service][googledrive][b81]") {
    set_test_environment("GOOGLE_CLIENT_ID", "mock_client_id");
    set_test_environment("GOOGLE_CLIENT_SECRET", "mock_client_secret");

    DatabasePool pool(2, get_secure_conn_string());
    MockGoogleDriveService gdrive(pool);
    B81UserFixture user(pool, 9814, "b81-unlinking@test.com");
    gdrive.mock_account_email = "b81-unlinking-google@test.com";

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec(
            "INSERT INTO user_external_storages(user_id,provider,account_email,refresh_token,is_unlinking) "
            "VALUES($1,'google_drive',$2,'redacted',TRUE)",
            pqxx::params{user.user_id, gdrive.mock_account_email});
        txn.commit();
    }

    REQUIRE_NOTHROW(gdrive.link_account(
        user.user_id, "b81-unlinking-code", gdrive.generate_test_state(user.user_id)));
    CHECK(b81_count(
        pool,
        "SELECT count(*) FROM user_external_storages WHERE user_id=$1 AND account_email=$2 "
        "AND is_unlinking=FALSE",
        user.user_id, gdrive.mock_account_email) == 1);
}

TEST_CASE("B.40 expired OAuth state stops before provider and database", "[service][googledrive][b40]") {
    set_test_environment("GOOGLE_CLIENT_ID", "mock_client_id");
    set_test_environment("GOOGLE_CLIENT_SECRET", "mock_client_secret");

    DatabasePool pool(4, get_secure_conn_string());
    MockGoogleDriveService gdrive(pool);
    const uint64_t user_id = 9940;

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE id=$1", pqxx::params{user_id});
        txn.exec(
            "INSERT INTO users(id,username,email,password_hash,max_storage_bytes,is_email_verified) "
            "VALUES($1,'b40_expiry_user','b40-expiry@test.com','hash',104857600,TRUE)",
            pqxx::params{user_id});
        txn.commit();
    }

    struct Cleanup {
        DatabasePool& pool;
        uint64_t user_id;
        ~Cleanup() {
            try {
                auto conn = pool.acquire_connection();
                pqxx::work txn(*conn);
                txn.exec("DELETE FROM files WHERE user_id=$1", pqxx::params{user_id});
                txn.exec("DELETE FROM user_external_storages WHERE user_id=$1", pqxx::params{user_id});
                txn.exec("DELETE FROM folders WHERE user_id=$1", pqxx::params{user_id});
                txn.exec("DELETE FROM users WHERE id=$1", pqxx::params{user_id});
                txn.commit();
            } catch (...) {}
        }
    } cleanup{pool, user_id};

    const auto state = gdrive.generate_test_state(user_id);
    gdrive.expire_test_state(user_id);

    REQUIRE_THROWS_AS(
        gdrive.link_account(user_id, "valid_code", state),
        std::invalid_argument);
    CHECK(gdrive.token_exchange_requests.load() == 0);
    CHECK(gdrive.folder_search_requests.load() == 0);
    CHECK(gdrive.folder_create_requests.load() == 0);

    REQUIRE_THROWS_AS(
        gdrive.link_account(user_id, "valid_code", state),
        std::invalid_argument);
    CHECK(gdrive.token_exchange_requests.load() == 0);

    auto conn = pool.acquire_connection();
    pqxx::work txn(*conn);
    const auto rows = txn.exec(
        "SELECT count(*) FROM user_external_storages WHERE user_id=$1",
        pqxx::params{user_id});
    txn.commit();
    REQUIRE(rows[0][0].as<int>() == 0);

    const auto fresh_state = gdrive.generate_test_state(user_id);
    REQUIRE_NOTHROW(gdrive.link_account(user_id, "valid_code", fresh_state));
    CHECK(gdrive.token_exchange_requests.load() == 1);
    CHECK(gdrive.folder_search_requests.load() == 1);
    CHECK(gdrive.folder_create_requests.load() == 1);
}

namespace {

struct B42Fixture {
    DatabasePool pool;
    MockGoogleDriveService gdrive;
    std::vector<uint64_t> user_ids;

    B42Fixture() : pool(8, get_secure_conn_string()), gdrive(pool) {
        set_test_environment("GOOGLE_CLIENT_ID", "mock_client_id");
        set_test_environment("GOOGLE_CLIENT_SECRET", "mock_client_secret");
    }

    static void remove_user(DatabasePool& pool, uint64_t user_id) {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM files WHERE user_id=$1", pqxx::params{user_id});
        txn.exec("DELETE FROM user_external_storages WHERE user_id=$1", pqxx::params{user_id});
        txn.exec("DELETE FROM folders WHERE user_id=$1", pqxx::params{user_id});
        txn.exec("DELETE FROM users WHERE id=$1", pqxx::params{user_id});
        txn.commit();
    }

    uint64_t link_storage(uint64_t user_id) {
        remove_user(pool, user_id);
        {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            txn.exec(
                "INSERT INTO users(id,username,email,password_hash,max_storage_bytes,is_email_verified) "
                "VALUES($1,$2,$3,'hash',104857600,TRUE)",
                pqxx::params{user_id, "b42_user_" + std::to_string(user_id),
                             "b42_" + std::to_string(user_id) + "@test.com"});
            txn.commit();
        }
        user_ids.push_back(user_id);
        gdrive.expect_refresh = false;
        gdrive.link_account(user_id, "valid_code", gdrive.generate_test_state(user_id));
        return gdrive.get_linked_accounts(user_id).at(0).id;
    }

    void warm_tokens() {
        gdrive.expect_refresh = true;
        for (const auto user_id : user_ids) {
            const auto account = gdrive.get_linked_accounts(user_id).at(0);
            REQUIRE(gdrive.get_access_token_for_storage(account.id) == gdrive.mock_access_token);
        }
    }

    ~B42Fixture() {
        for (const auto user_id : user_ids) {
            try {
                remove_user(pool, user_id);
            } catch (...) {
            }
        }
    }
};

struct QuotaCall {
    uint64_t used_bytes = 0;
    std::exception_ptr error;
};

void call_quota(MockGoogleDriveService& gdrive, uint64_t storage_id, QuotaCall& result) {
    try {
        result.used_bytes = GoogleDriveQuotaTestProbe::used_bytes(gdrive, storage_id);
    } catch (...) {
        result.error = std::current_exception();
    }
}

const std::string quota_body(uint64_t used_bytes) {
    return R"({"storageQuota":{"limit":"1000000000000","usage":")" +
        std::to_string(used_bytes) + R"("}})";
}

} // namespace

TEST_CASE("B.42 cross-storage quota requests are independently admitted",
          "[b42][service][googledrive]") {
    B42Fixture fixture;
    const auto storage_a = fixture.link_storage(104210);
    const auto storage_b = fixture.link_storage(104211);
    fixture.warm_tokens();

    fixture.gdrive.enable_quota_gate(2);
    QuotaCall result_a;
    QuotaCall result_b;
    std::thread worker_a([&] { call_quota(fixture.gdrive, storage_a, result_a); });
    const bool first_reached = fixture.gdrive.wait_for_quota_waiters(1);
    std::thread worker_b([&] { call_quota(fixture.gdrive, storage_b, result_b); });
    const bool second_reached = fixture.gdrive.wait_for_quota_waiters(2);
    fixture.gdrive.release_quota_gate();
    worker_a.join();
    worker_b.join();

    REQUIRE(first_reached);
    CHECK(second_reached);
    CHECK_FALSE(result_a.error);
    CHECK_FALSE(result_b.error);
    CHECK(fixture.gdrive.quota_requests.load() == 2);
}

TEST_CASE("B.42 same-storage successful cold cohort remains single-flight",
          "[b42][service][googledrive]") {
    B42Fixture fixture;
    const auto storage_id = fixture.link_storage(104220);
    fixture.warm_tokens();

    fixture.gdrive.enable_quota_gate();
    QuotaCall owner_result;
    std::thread owner([&] { call_quota(fixture.gdrive, storage_id, owner_result); });
    const bool owner_reached = fixture.gdrive.wait_for_quota_waiters(1);

    constexpr size_t follower_count = 3;
    std::array<QuotaCall, follower_count> follower_results;
    std::vector<std::thread> followers;
    bool followers_joined = false;
    if (owner_reached) {
        for (auto& result : follower_results) {
            followers.emplace_back([&] { call_quota(fixture.gdrive, storage_id, result); });
        }
        followers_joined = GoogleDriveQuotaTestProbe::wait_for_followers(
            fixture.gdrive, storage_id, follower_count);
    }
    fixture.gdrive.release_quota_gate();
    owner.join();
    for (auto& follower : followers) follower.join();

    REQUIRE(owner_reached);
    REQUIRE(followers_joined);
    REQUIRE_FALSE(owner_result.error);
    CHECK(owner_result.used_bytes == 500000000000ULL);
    for (const auto& result : follower_results) {
        CHECK_FALSE(result.error);
        CHECK(result.used_bytes == owner_result.used_bytes);
    }
    CHECK(fixture.gdrive.quota_requests.load() == 1);
}

TEST_CASE("B.42 same-storage failure cohort shares failure and permits later retry",
          "[b42][service][googledrive]") {
    B42Fixture fixture;
    const auto storage_id = fixture.link_storage(104230);
    fixture.warm_tokens();
    fixture.gdrive.set_quota_response(503, R"({"error":"unavailable"})");
    fixture.gdrive.enable_quota_gate();

    constexpr size_t follower_count = 3;
    std::array<QuotaCall, follower_count> follower_results;
    std::vector<std::thread> workers;
    QuotaCall owner_result;
    std::thread owner([&] { call_quota(fixture.gdrive, storage_id, owner_result); });
    const bool owner_reached = fixture.gdrive.wait_for_quota_waiters(1);
    bool followers_joined = false;
    if (owner_reached) {
        for (auto& result : follower_results) {
            workers.emplace_back([&] { call_quota(fixture.gdrive, storage_id, result); });
        }
        followers_joined = GoogleDriveQuotaTestProbe::wait_for_followers(
            fixture.gdrive, storage_id, follower_count);
    }
    fixture.gdrive.release_quota_gate();
    owner.join();
    for (auto& worker : workers) worker.join();

    REQUIRE(owner_reached);
    REQUIRE(followers_joined);
    CHECK(owner_result.error);
    for (const auto& result : follower_results) CHECK(result.error);
    CHECK(fixture.gdrive.quota_requests.load() == 1);

    fixture.gdrive.set_quota_response(200, quota_body(500000000000ULL));
    QuotaCall retry;
    call_quota(fixture.gdrive, storage_id, retry);
    CHECK_FALSE(retry.error);
    CHECK(retry.used_bytes == 500000000000ULL);
    CHECK(fixture.gdrive.quota_requests.load() == 2);
}

TEST_CASE("B.42 invalidation returns while quota provider is blocked",
          "[b42][service][googledrive]") {
    B42Fixture fixture;
    const auto storage_id = fixture.link_storage(104240);
    fixture.warm_tokens();
    fixture.gdrive.enable_quota_gate();

    QuotaCall result;
    std::thread quota_worker([&] { call_quota(fixture.gdrive, storage_id, result); });
    const bool quota_reached = fixture.gdrive.wait_for_quota_waiters(1);

    std::mutex invalidation_mutex;
    std::condition_variable invalidation_cv;
    bool invalidation_started = false;
    bool invalidation_finished = false;
    std::thread invalidator([&] {
        {
            std::lock_guard lock(invalidation_mutex);
            invalidation_started = true;
            invalidation_cv.notify_all();
        }
        fixture.gdrive.invalidate_storage_caches({storage_id});
        {
            std::lock_guard lock(invalidation_mutex);
            invalidation_finished = true;
            invalidation_cv.notify_all();
        }
    });
    {
        std::unique_lock lock(invalidation_mutex);
        const bool invalidation_started_observed = invalidation_cv.wait_for(lock, std::chrono::seconds(5), [&] {
            return invalidation_started;
        });
        if (!invalidation_started_observed) {
            fixture.gdrive.release_quota_gate();
            quota_worker.join();
            invalidator.join();
            REQUIRE(invalidation_started_observed);
            return;
        }
    }
    bool finished_before_provider_release;
    {
        std::unique_lock lock(invalidation_mutex);
        finished_before_provider_release = invalidation_cv.wait_for(lock, std::chrono::seconds(5), [&] {
            return invalidation_finished;
        });
    }
    fixture.gdrive.release_quota_gate();
    quota_worker.join();
    invalidator.join();

    CHECK(finished_before_provider_release);
    REQUIRE(quota_reached);
    CHECK_FALSE(result.error);
}

TEST_CASE("B.42 invalidation remains selective by storage",
          "[b42][service][googledrive]") {
    B42Fixture fixture;
    const auto storage_a = fixture.link_storage(104250);
    const auto storage_b = fixture.link_storage(104251);
    fixture.warm_tokens();

    CHECK_NOTHROW(GoogleDriveQuotaTestProbe::used_bytes(fixture.gdrive, storage_a));
    CHECK_NOTHROW(GoogleDriveQuotaTestProbe::used_bytes(fixture.gdrive, storage_b));
    REQUIRE(fixture.gdrive.quota_requests.load() == 2);

    fixture.gdrive.invalidate_storage_caches({storage_a});
    CHECK_NOTHROW(GoogleDriveQuotaTestProbe::used_bytes(fixture.gdrive, storage_b));
    CHECK(fixture.gdrive.quota_requests.load() == 2);
    CHECK_NOTHROW(GoogleDriveQuotaTestProbe::used_bytes(fixture.gdrive, storage_a));
    CHECK(fixture.gdrive.quota_requests.load() == 3);
}

TEST_CASE("B.42 invalidated owner cannot republish stale quota",
          "[b42][service][googledrive]") {
    B42Fixture fixture;
    const auto storage_id = fixture.link_storage(104260);
    fixture.warm_tokens();
    fixture.gdrive.set_quota_response(200, quota_body(777));
    fixture.gdrive.enable_quota_gate();

    QuotaCall old_result;
    std::thread old_owner([&] { call_quota(fixture.gdrive, storage_id, old_result); });
    const bool old_reached = fixture.gdrive.wait_for_quota_waiters(1);

    if (!old_reached) {
        fixture.gdrive.release_quota_gate();
        old_owner.join();
        REQUIRE(old_reached);
        return;
    }

    fixture.gdrive.invalidate_storage_caches({storage_id});
    fixture.gdrive.set_quota_response(200, quota_body(111));
    QuotaCall new_result;
    call_quota(fixture.gdrive, storage_id, new_result);

    fixture.gdrive.set_quota_response(200, quota_body(777));
    fixture.gdrive.release_quota_gate();
    old_owner.join();

    QuotaCall cached_new_result;
    call_quota(fixture.gdrive, storage_id, cached_new_result);

    REQUIRE_FALSE(old_result.error);
    REQUIRE_FALSE(new_result.error);
    REQUIRE_FALSE(cached_new_result.error);
    CHECK(old_result.used_bytes == 777);
    CHECK(new_result.used_bytes == 111);
    CHECK(cached_new_result.used_bytes == 111);
    CHECK(fixture.gdrive.quota_requests.load() == 2);
}

TEST_CASE("B.42 old finalizer cannot erase a newer flight",
          "[b42][service][googledrive]") {
    B42Fixture fixture;
    const auto storage_id = fixture.link_storage(104270);
    fixture.warm_tokens();
    fixture.gdrive.enable_quota_gate(2);

    QuotaCall old_result;
    std::thread old_owner([&] { call_quota(fixture.gdrive, storage_id, old_result); });
    const bool old_reached = fixture.gdrive.wait_for_quota_waiters(1);
    if (!old_reached) {
        fixture.gdrive.release_quota_gate();
        old_owner.join();
        REQUIRE(old_reached);
        return;
    }
    fixture.gdrive.invalidate_storage_caches({storage_id});

    QuotaCall new_result;
    std::thread new_owner([&] { call_quota(fixture.gdrive, storage_id, new_result); });
    const bool new_reached = fixture.gdrive.wait_for_quota_waiters(2);
    if (!new_reached) {
        fixture.gdrive.release_quota_gate();
        old_owner.join();
        new_owner.join();
        REQUIRE(new_reached);
        return;
    }
    const bool newer_flight_before_old_release = GoogleDriveQuotaTestProbe::has_flight(
        fixture.gdrive, storage_id);

    fixture.gdrive.release_quota_request(1);
    old_owner.join();
    const bool newer_flight_after_old_release = GoogleDriveQuotaTestProbe::has_flight(
        fixture.gdrive, storage_id);

    fixture.gdrive.release_quota_gate();
    new_owner.join();
    REQUIRE(newer_flight_before_old_release);
    CHECK(newer_flight_after_old_release);
    REQUIRE(old_reached);
    REQUIRE(new_reached);
    CHECK_FALSE(old_result.error);
    CHECK_FALSE(new_result.error);
    CHECK(fixture.gdrive.quota_requests.load() == 2);
}

TEST_CASE("B.43 terminal deletion invalidates token and quota caches",
          "[b43][gc][service][googledrive]") {
    B42Fixture fixture;
    const uint64_t user_id = 43121;
    const auto storage_id = fixture.link_storage(user_id);

    fixture.gdrive.expect_refresh = true;
    REQUIRE(fixture.gdrive.get_access_token_for_storage(storage_id) == fixture.gdrive.mock_access_token);
    REQUIRE(GoogleDriveQuotaTestProbe::used_bytes(fixture.gdrive, storage_id) == 500000000000ULL);
    REQUIRE(fixture.gdrive.refresh_requests.load() == 1);
    REQUIRE(fixture.gdrive.quota_requests.load() == 1);

    UsersManager users(fixture.pool);
    users.delete_user(user_id);
    GarbageCollector gc(fixture.pool, nullptr, &fixture.gdrive);
    gc.run_cleanup();

    CHECK_THROWS(fixture.gdrive.get_access_token_for_storage(storage_id));
    CHECK_THROWS(GoogleDriveQuotaTestProbe::used_bytes(fixture.gdrive, storage_id));
}

TEST_CASE("B.40 OAuth state keeps mismatch replacement and owner semantics", "[service][googledrive][b40]") {
    set_test_environment("GOOGLE_CLIENT_ID", "mock_client_id");
    set_test_environment("GOOGLE_CLIENT_SECRET", "mock_client_secret");

    DatabasePool pool(4, get_secure_conn_string());
    MockGoogleDriveService gdrive(pool);
    const uint64_t first_user_id = 9942;
    const uint64_t second_user_id = 9943;

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE id=$1 OR id=$2", pqxx::params{first_user_id, second_user_id});
        txn.exec(
            "INSERT INTO users(id,username,email,password_hash,max_storage_bytes,is_email_verified) "
            "VALUES($1,'b40_state_owner','b40-owner@test.com','hash',104857600,TRUE), "
            "($2,'b40_state_other','b40-other@test.com','hash',104857600,TRUE)",
            pqxx::params{first_user_id, second_user_id});
        txn.commit();
    }

    struct Cleanup {
        DatabasePool& pool;
        uint64_t first_user_id;
        uint64_t second_user_id;
        ~Cleanup() {
            try {
                auto conn = pool.acquire_connection();
                pqxx::work txn(*conn);
                for (const auto user_id : {first_user_id, second_user_id}) {
                    txn.exec("DELETE FROM files WHERE user_id=$1", pqxx::params{user_id});
                    txn.exec("DELETE FROM user_external_storages WHERE user_id=$1", pqxx::params{user_id});
                    txn.exec("DELETE FROM folders WHERE user_id=$1", pqxx::params{user_id});
                    txn.exec("DELETE FROM users WHERE id=$1", pqxx::params{user_id});
                }
                txn.commit();
            } catch (...) {}
        }
    } cleanup{pool, first_user_id, second_user_id};

    SECTION("mismatch does not consume the current state") {
        const auto current = gdrive.generate_test_state(first_user_id);
        REQUIRE_THROWS_AS(
            gdrive.link_account(first_user_id, "valid_code", "wrong_state"),
            std::invalid_argument);
        CHECK(gdrive.token_exchange_requests.load() == 0);
        REQUIRE_NOTHROW(gdrive.link_account(first_user_id, "valid_code", current));
        CHECK(gdrive.token_exchange_requests.load() == 1);
    }

    SECTION("new generation replaces the old state") {
        const auto old_state = gdrive.generate_test_state(first_user_id);
        const auto current = gdrive.generate_test_state(first_user_id);
        REQUIRE_THROWS_AS(
            gdrive.link_account(first_user_id, "valid_code", old_state),
            std::invalid_argument);
        CHECK(gdrive.token_exchange_requests.load() == 0);
        REQUIRE_NOTHROW(gdrive.link_account(first_user_id, "valid_code", current));
        CHECK(gdrive.token_exchange_requests.load() == 1);
    }

    SECTION("wrong owner cannot consume the current state") {
        const auto owner_state = gdrive.generate_test_state(first_user_id);
        REQUIRE_THROWS_AS(
            gdrive.link_account(second_user_id, "valid_code", owner_state),
            std::invalid_argument);
        CHECK(gdrive.token_exchange_requests.load() == 0);
        REQUIRE_NOTHROW(gdrive.link_account(first_user_id, "valid_code", owner_state));
        CHECK(gdrive.token_exchange_requests.load() == 1);
    }
}

TEST_CASE("B.41 total quota returns the DB lease before quota HTTP", "[service][googledrive][b41]") {
    set_test_environment("GOOGLE_CLIENT_ID", "mock_client_id");
    set_test_environment("GOOGLE_CLIENT_SECRET", "mock_client_secret");

    DatabasePool pool(2, get_secure_conn_string());
    MockGoogleDriveService gdrive(pool);
    const uint64_t user_id = 9945;
    uint64_t storage_id = 0;

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE id=$1", pqxx::params{user_id});
        txn.exec(
            "INSERT INTO users(id,username,email,password_hash,max_storage_bytes,is_email_verified) "
            "VALUES($1,'b41_quota_user','b41-quota@test.com','hash',104857600,TRUE)",
            pqxx::params{user_id});
        txn.commit();
    }

    REQUIRE_NOTHROW(gdrive.link_account(user_id, "valid_code", gdrive.generate_test_state(user_id)));
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        storage_id = txn.exec(
            "SELECT id FROM user_external_storages WHERE user_id=$1 AND provider='google_drive'",
            pqxx::params{user_id})[0][0].as<uint64_t>();
        txn.exec(
            "INSERT INTO files(user_id,encrypted_name,name_hash,encrypted_fdk,size_bytes,is_upload_complete,storage_provider,external_storage_id) "
            "VALUES($1,'active','b41-active','fdk',100,TRUE,'google_drive',$2), "
            "($1,'deleted','b41-deleted','fdk',40,TRUE,'google_drive',$2), "
            "($1,'incomplete','b41-incomplete','fdk',70,FALSE,'google_drive',$2)",
            pqxx::params{user_id, storage_id});
        txn.exec(
            "UPDATE files SET deleted_at = CURRENT_TIMESTAMP "
            "WHERE user_id = $1 AND name_hash = 'b41-deleted'",
            pqxx::params{user_id});
        const auto deleted_fixture = txn.exec(
            "SELECT size_bytes, is_upload_complete, deleted_at IS NOT NULL "
            "FROM files WHERE user_id = $1 AND name_hash = 'b41-deleted'",
            pqxx::params{user_id});
        REQUIRE(deleted_fixture.size() == 1);
        CHECK(deleted_fixture[0][0].as<uint64_t>() == 40);
        CHECK(deleted_fixture[0][1].as<bool>());
        CHECK(deleted_fixture[0][2].as<bool>());
        txn.commit();
    }

    struct Cleanup {
        DatabasePool& pool;
        uint64_t user_id;
        ~Cleanup() {
            try {
                auto conn = pool.acquire_connection();
                pqxx::work txn(*conn);
                txn.exec("DELETE FROM users WHERE id=$1", pqxx::params{user_id});
                txn.commit();
            } catch (...) {}
        }
    } cleanup{pool, user_id};

    gdrive.expect_refresh = true;
    REQUIRE(gdrive.get_access_token_for_storage(storage_id) == gdrive.mock_access_token);
    REQUIRE(gdrive.refresh_requests.load() == 1);

    gdrive.enable_quota_gate();
    std::pair<uint64_t, uint64_t> result{0, 0};
    std::exception_ptr error;
    std::thread worker([&] {
        try {
            result = gdrive.get_total_quota(user_id);
        } catch (...) {
            error = std::current_exception();
        }
    });

    const bool quota_blocked = gdrive.wait_for_quota_waiters(1);
    const size_t available_at_quota_gate = quota_blocked ? pool.get_available_count() : 0;
    gdrive.release_quota_gate();
    worker.join();

    REQUIRE(quota_blocked);
    REQUIRE_FALSE(error);
    CHECK(available_at_quota_gate == 2);
    CHECK(result.first == 140);
    CHECK(result.second == 500000000140ULL);
    CHECK(gdrive.quota_requests == 1);
}

TEST_CASE("B.37 caracteriza ownership concorrente de vinculo Google", "[service][googledrive][b37]") {
    set_test_environment("GOOGLE_CLIENT_ID", "mock_client_id");
    set_test_environment("GOOGLE_CLIENT_SECRET", "mock_client_secret");

    DatabasePool pool(8, get_secure_conn_string());
    MockGoogleDriveService gdrive(pool);
    const uint64_t first_user_id = 9937;
    const uint64_t second_user_id = 9938;
    gdrive.mock_account_email = "b37-same-account@test.com";

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE id IN ($1,$2) OR username IN ('gd_b37_first','gd_b37_second')",
                 pqxx::params{first_user_id, second_user_id});
        txn.exec(
            "INSERT INTO users(id,username,email,password_hash,max_storage_bytes,is_email_verified) VALUES "
            "($1,'gd_b37_first','gd_b37_first@test.com','hash',104857600,TRUE),"
            "($2,'gd_b37_second','gd_b37_second@test.com','hash',104857600,TRUE)",
            pqxx::params{first_user_id, second_user_id});
        txn.commit();
    }

    struct Cleanup {
        DatabasePool& pool;
        uint64_t first;
        uint64_t second;
        ~Cleanup() {
            try {
                auto conn = pool.acquire_connection();
                pqxx::work txn(*conn);
                txn.exec("DELETE FROM users WHERE id IN ($1,$2)", pqxx::params{first, second});
                txn.commit();
            } catch (...) {}
        }
    } cleanup{pool, first_user_id, second_user_id};

    const auto active_count = [&](uint64_t user_id) {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        const auto count = txn.exec(
            "SELECT count(*) FROM user_external_storages WHERE user_id=$1 AND provider='google_drive' "
            "AND account_email=$2 AND is_unlinking=FALSE",
            pqxx::params{user_id, gdrive.mock_account_email})[0][0].as<int>();
        txn.commit();
        return count;
    };

    SECTION("duplicata sequencial para antes do provider") {
        gdrive.link_account(first_user_id, "b37_code_a", gdrive.generate_test_state(first_user_id));
        const int searches = gdrive.folder_search_requests.load();
        const int creates = gdrive.folder_create_requests.load();

        std::string error;
        try {
            (void)gdrive.link_account(first_user_id, "b37_code_b", gdrive.generate_test_state(first_user_id));
        } catch (const std::runtime_error& exception) {
            error = exception.what();
        }

        CHECK(error == "ALREADY_LINKED");
        CHECK(gdrive.folder_search_requests.load() == searches);
        CHECK(gdrive.folder_create_requests.load() == creates);
        CHECK(active_count(first_user_id) == 1);
    }

    SECTION("dois states legitimos disputam uma unica authority") {
        gdrive.numbered_folder_ids = true;
        gdrive.enable_link_gate(2);
        std::array<std::exception_ptr, 2> errors{};
        std::array<GoogleDriveService::LinkResult, 2> results{};

        const auto state_a = gdrive.generate_test_state(first_user_id);
        std::thread first([&] {
            try { results[0] = gdrive.link_account(first_user_id, "b37_code_a", state_a); }
            catch (...) { errors[0] = std::current_exception(); }
        });
        const bool first_reached_provider = gdrive.wait_for_link_waiters(1);
        if (!first_reached_provider) {
            gdrive.release_link_gate();
            first.join();
            REQUIRE(first_reached_provider);
        }

        const auto state_b = gdrive.generate_test_state(first_user_id);
        std::thread second([&] {
            try { results[1] = gdrive.link_account(first_user_id, "b37_code_b", state_b); }
            catch (...) { errors[1] = std::current_exception(); }
        });
        const bool both_reached_provider = gdrive.wait_for_link_waiters(2);
        gdrive.release_link_gate();
        first.join();
        second.join();

        int successes = 0;
        int duplicates = 0;
        for (const auto& error : errors) {
            if (!error) {
                ++successes;
                continue;
            }
            try { std::rethrow_exception(error); }
            catch (const std::runtime_error& exception) {
                if (std::string(exception.what()) == "ALREADY_LINKED" ||
                    std::string(exception.what()) == "LINK_IN_PROGRESS") ++duplicates;
            }
        }
        const int active_rows = active_count(first_user_id);
        std::string winner_root;
        for (size_t i = 0; i < errors.size(); ++i) {
            if (!errors[i]) winner_root = results[i].root_folder_id;
        }
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        const auto stored_root = txn.exec(
            "SELECT root_folder_id FROM user_external_storages WHERE user_id=$1 AND provider='google_drive' "
            "AND account_email=$2 AND is_unlinking=FALSE",
            pqxx::params{first_user_id, gdrive.mock_account_email});
        txn.commit();
        INFO("both_provider=" << both_reached_provider << " successes=" << successes
             << " duplicates=" << duplicates << " searches=" << gdrive.folder_search_requests.load()
             << " creates=" << gdrive.folder_create_requests.load() << " active_rows=" << active_rows);

        CHECK_FALSE(both_reached_provider);
        CHECK(successes == 1);
        CHECK(duplicates == 1);
        CHECK(gdrive.folder_search_requests.load() == 1);
        CHECK(gdrive.folder_create_requests.load() == 1);
        CHECK(active_rows == 1);
        REQUIRE(stored_root.size() == 1);
        CHECK(stored_root[0][0].as<std::string>() == winner_root);
    }

    SECTION("usuarios diferentes permanecem independentes") {
        gdrive.enable_link_gate(1);
        std::exception_ptr first_error;
        const auto first_state = gdrive.generate_test_state(first_user_id);
        std::thread first([&] {
            try { (void)gdrive.link_account(first_user_id, "b37_code_a", first_state); }
            catch (...) { first_error = std::current_exception(); }
        });
        const bool first_reached_provider = gdrive.wait_for_link_waiters(1);
        if (!first_reached_provider) {
            gdrive.release_link_gate();
            first.join();
            REQUIRE(first_reached_provider);
        }

        const auto second_state = gdrive.generate_test_state(second_user_id);
        auto second = std::async(std::launch::async, [&] {
            return gdrive.link_account(second_user_id, "b37_code_b", second_state);
        });
        const bool second_reached_provider = gdrive.wait_for_folder_searches(2);
        const bool second_finished_before_release =
            second.wait_for(std::chrono::seconds(5)) == std::future_status::ready;
        gdrive.release_link_gate();
        first.join();
        const auto second_result = second.get();

        CHECK(second_reached_provider);
        CHECK(second_finished_before_release);
        CHECK_FALSE(first_error);
        CHECK_FALSE(second_result.root_folder_id.empty());
        CHECK(active_count(first_user_id) == 1);
        CHECK(active_count(second_user_id) == 1);
    }

    SECTION("row antiga em unlink permite novo vinculo ativo") {
        {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            txn.exec(
                "INSERT INTO user_external_storages(user_id,provider,account_email,refresh_token,root_folder_id,is_unlinking) "
                "VALUES($1,'google_drive',$2,'old-token','old-folder',TRUE)",
                pqxx::params{first_user_id, gdrive.mock_account_email});
            txn.commit();
        }

        const auto result = gdrive.link_account(
            first_user_id, "b37_code_a", gdrive.generate_test_state(first_user_id));
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        const auto counts = txn.exec(
            "SELECT count(*) FILTER (WHERE is_unlinking=TRUE), count(*) FILTER (WHERE is_unlinking=FALSE) "
            "FROM user_external_storages WHERE user_id=$1 AND provider='google_drive' AND account_email=$2",
            pqxx::params{first_user_id, gdrive.mock_account_email});
        txn.commit();

        CHECK_FALSE(result.root_folder_id.empty());
        CHECK(counts[0][0].as<int>() == 1);
        CHECK(counts[0][1].as<int>() == 1);
    }

    SECTION("falha do owner libera ownership transacional") {
        gdrive.create_folder_ok = false;
        std::string first_error;
        try {
            (void)gdrive.link_account(first_user_id, "b37_code_a", gdrive.generate_test_state(first_user_id));
        } catch (const std::runtime_error& exception) {
            first_error = exception.what();
        }
        CHECK(first_error == "GOOGLE_FOLDER_CREATION_FAILED");
        CHECK(active_count(first_user_id) == 0);

        gdrive.create_folder_ok = true;
        CHECK_NOTHROW(gdrive.link_account(
            first_user_id, "b37_code_b", gdrive.generate_test_state(first_user_id)));
        CHECK(active_count(first_user_id) == 1);
    }
}

TEST_CASE("B.33 Google Drive deduplica refresh concorrente por storage", "[service][googledrive][b33]") {
    set_test_environment("GOOGLE_CLIENT_ID", "mock_client_id");
    set_test_environment("GOOGLE_CLIENT_SECRET", "mock_client_secret");

    DatabasePool pool(12, get_secure_conn_string());
    MockGoogleDriveService gdrive(pool);
    const uint64_t user_id = 9998;
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE id=$1 OR username='gd_b33_user'", pqxx::params{user_id});
        txn.exec(
            "INSERT INTO users(id,username,email,password_hash,max_storage_bytes,is_email_verified) "
            "VALUES($1,'gd_b33_user','gd_b33@test.com','hash',104857600,TRUE)",
            pqxx::params{user_id});
        txn.commit();
    }

    struct Cleanup {
        DatabasePool& pool;
        uint64_t user_id;
        ~Cleanup() {
            try {
                auto conn = pool.acquire_connection();
                pqxx::work txn(*conn);
                txn.exec("DELETE FROM users WHERE id=$1", pqxx::params{user_id});
                txn.commit();
            } catch (...) {}
        }
    } cleanup{pool, user_id};

    const auto link_storage = [&]() {
        gdrive.expect_refresh = false;
        gdrive.link_account(user_id, "valid_auth_code_123", gdrive.generate_test_state(user_id));
        return gdrive.get_linked_accounts(user_id).at(0).id;
    };

    const auto run_success_cohort = [&](uint64_t storage_id, int count) {
        std::vector<std::string> tokens(static_cast<size_t>(count));
        std::vector<std::exception_ptr> errors(static_cast<size_t>(count));
        std::vector<std::thread> callers;
        callers.reserve(static_cast<size_t>(count));
        callers.emplace_back([&] {
            try {
                tokens[0] = gdrive.get_access_token_for_storage(storage_id);
            } catch (...) {
                errors[0] = std::current_exception();
            }
        });
        const bool gate_opened = gdrive.wait_for_refresh_waiters(1);

        std::mutex ready_mutex;
        std::condition_variable ready_cv;
        std::atomic<int> ready{0};
        std::atomic<int> calling{0};
        std::promise<void> start_promise;
        const auto start = start_promise.get_future().share();
        for (int i = 1; i < count; ++i) {
            callers.emplace_back([&, i, start] {
                ready.fetch_add(1);
                ready_cv.notify_one();
                start.wait();
                calling.fetch_add(1);
                ready_cv.notify_one();
                try {
                    tokens[static_cast<size_t>(i)] = gdrive.get_access_token_for_storage(storage_id);
                } catch (...) {
                    errors[static_cast<size_t>(i)] = std::current_exception();
                }
            });
        }
        bool all_ready;
        {
            std::unique_lock<std::mutex> lock(ready_mutex);
            all_ready = ready_cv.wait_for(lock, std::chrono::seconds(5), [&] {
                return ready.load() == count - 1;
            });
        }
        start_promise.set_value();
        bool all_calling;
        {
            std::unique_lock<std::mutex> lock(ready_mutex);
            all_calling = ready_cv.wait_for(lock, std::chrono::seconds(5), [&] {
                return calling.load() == count - 1;
            });
        }
        gdrive.release_refresh_gate();
        for (auto& caller : callers) caller.join();
        REQUIRE(all_ready);
        REQUIRE(all_calling);
        REQUIRE(gate_opened);
        REQUIRE(std::all_of(tokens.begin(), tokens.end(), [&](const auto& token) {
            return token == gdrive.mock_access_token;
        }));
        REQUIRE(std::all_of(errors.begin(), errors.end(), [](const auto& error) { return !error; }));
    };

    SECTION("cache quente nao repete refresh") {
        const auto storage_id = link_storage();
        gdrive.expect_refresh = true;
        REQUIRE(gdrive.get_access_token_for_storage(storage_id) == gdrive.mock_access_token);
        REQUIRE(gdrive.get_access_token_for_storage(storage_id) == gdrive.mock_access_token);
        REQUIRE(gdrive.refresh_requests.load() == 1);
    }

    SECTION("cold miss do mesmo storage compartilha uma tentativa") {
        const auto storage_id = link_storage();
        gdrive.expect_refresh = true;
        gdrive.enable_refresh_gate();
        run_success_cohort(storage_id, 8);
        REQUIRE(gdrive.refresh_requests.load() == 1);
    }

    SECTION("falha concorrente e retry posterior compartilham somente o cohort") {
        const auto storage_id = link_storage();
        gdrive.expect_refresh = true;
        gdrive.refresh_token_ok = false;
        gdrive.enable_refresh_gate();

        std::vector<std::exception_ptr> errors(8);
        std::vector<std::thread> callers;
        std::mutex ready_mutex;
        std::condition_variable ready_cv;
        std::atomic<size_t> ready{0};
        std::atomic<size_t> calling{0};
        std::promise<void> start_promise;
        const auto start = start_promise.get_future().share();
        callers.emplace_back([&] {
            try {
                (void)gdrive.get_access_token_for_storage(storage_id);
            } catch (...) {
                errors[0] = std::current_exception();
            }
        });
        const bool gate_opened = gdrive.wait_for_refresh_waiters(1);

        for (size_t i = 1; i < errors.size(); ++i) {
            callers.emplace_back([&, i, start] {
                ready.fetch_add(1);
                ready_cv.notify_one();
                start.wait();
                calling.fetch_add(1);
                ready_cv.notify_one();
                try {
                    (void)gdrive.get_access_token_for_storage(storage_id);
                } catch (...) {
                    errors[i] = std::current_exception();
                }
            });
        }
        bool all_ready;
        {
            std::unique_lock<std::mutex> lock(ready_mutex);
            all_ready = ready_cv.wait_for(lock, std::chrono::seconds(5), [&] {
                return ready.load() == errors.size() - 1;
            });
        }
        start_promise.set_value();
        bool all_calling;
        {
            std::unique_lock<std::mutex> lock(ready_mutex);
            all_calling = ready_cv.wait_for(lock, std::chrono::seconds(5), [&] {
                return calling.load() == errors.size() - 1;
            });
        }
        gdrive.release_refresh_gate();
        for (auto& caller : callers) caller.join();

        REQUIRE(all_ready);
        REQUIRE(all_calling);
        REQUIRE(gate_opened);
        REQUIRE(gdrive.refresh_requests.load() == 1);
        REQUIRE(std::all_of(errors.begin(), errors.end(), [](const auto& error) { return error != nullptr; }));

        gdrive.refresh_token_ok = true;
        REQUIRE(gdrive.get_access_token_for_storage(storage_id) == gdrive.mock_access_token);
        REQUIRE(gdrive.refresh_requests.load() == 2);
    }

    SECTION("storages diferentes nao compartilham ownership de refresh") {
        const auto first_storage_id = link_storage();
        uint64_t second_storage_id;
        {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            second_storage_id = txn.exec(
                "INSERT INTO user_external_storages(user_id,provider,account_email,refresh_token,root_folder_id) "
                "SELECT user_id,provider,'gd_b33_second@test.com',refresh_token,'root-second' "
                "FROM user_external_storages WHERE id=$1 RETURNING id",
                pqxx::params{first_storage_id})[0][0].as<uint64_t>();
            txn.commit();
        }

        gdrive.expect_refresh = true;
        gdrive.enable_refresh_gate();
        std::exception_ptr first_error;
        std::exception_ptr second_error;
        std::thread first([&] {
            try { (void)gdrive.get_access_token_for_storage(first_storage_id); }
            catch (...) { first_error = std::current_exception(); }
        });
        std::thread second([&] {
            try { (void)gdrive.get_access_token_for_storage(second_storage_id); }
            catch (...) { second_error = std::current_exception(); }
        });
        const bool both_refreshes_opened = gdrive.wait_for_refresh_waiters(2);
        gdrive.release_refresh_gate();
        first.join();
        second.join();

        REQUIRE(both_refreshes_opened);
        REQUIRE_FALSE(first_error);
        REQUIRE_FALSE(second_error);
        REQUIRE(gdrive.refresh_requests.load() == 2);
    }

    SECTION("B.33 unlink-all invalidates only storages owned by that user") {
        const auto first_owned_storage_id = link_storage();
        const uint64_t other_user_id = 9997;
        uint64_t second_owned_storage_id;
        uint64_t other_storage_id;
        {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            txn.exec("DELETE FROM users WHERE id=$1 OR username='gd_b33_other_user'",
                     pqxx::params{other_user_id});
            txn.exec(
                "INSERT INTO users(id,username,email,password_hash,max_storage_bytes,is_email_verified) "
                "VALUES($1,'gd_b33_other_user','gd_b33_other@test.com','hash',104857600,TRUE)",
                pqxx::params{other_user_id});
            second_owned_storage_id = txn.exec(
                "INSERT INTO user_external_storages(user_id,provider,account_email,refresh_token,root_folder_id) "
                "SELECT user_id,provider,'gd_b33_second_owned@test.com',refresh_token,'root-second-owned' "
                "FROM user_external_storages WHERE id=$1 RETURNING id",
                pqxx::params{first_owned_storage_id})[0][0].as<uint64_t>();
            other_storage_id = txn.exec(
                "INSERT INTO user_external_storages(user_id,provider,account_email,refresh_token,root_folder_id) "
                "SELECT $1,provider,'gd_b33_other@test.com',refresh_token,'root-other' "
                "FROM user_external_storages WHERE id=$2 RETURNING id",
                pqxx::params{other_user_id, first_owned_storage_id})[0][0].as<uint64_t>();
            txn.commit();
        }

        struct OtherUserCleanup {
            DatabasePool& pool;
            uint64_t user_id;
            ~OtherUserCleanup() {
                try {
                    auto conn = pool.acquire_connection();
                    pqxx::work txn(*conn);
                    txn.exec("DELETE FROM users WHERE id=$1", pqxx::params{user_id});
                    txn.commit();
                } catch (...) {}
            }
        } other_cleanup{pool, other_user_id};

        gdrive.expect_refresh = true;
        REQUIRE(gdrive.get_access_token_for_storage(first_owned_storage_id) == gdrive.mock_access_token);
        REQUIRE(gdrive.get_access_token_for_storage(second_owned_storage_id) == gdrive.mock_access_token);
        REQUIRE(gdrive.get_access_token_for_storage(other_storage_id) == gdrive.mock_access_token);
        REQUIRE(gdrive.refresh_requests.load() == 3);
        REQUIRE(gdrive.get_storage_targets(user_id).size() == 2);
        REQUIRE(gdrive.get_storage_targets(other_user_id).at(0).status == "ready");
        REQUIRE(gdrive.quota_requests == 3);

        gdrive.unlink_account(user_id);

        {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            REQUIRE(txn.exec(
                "SELECT COUNT(*) FROM user_external_storages WHERE id IN ($1,$2) AND is_unlinking=TRUE",
                pqxx::params{first_owned_storage_id, second_owned_storage_id})[0][0].as<int>() == 2);
            REQUIRE_FALSE(txn.exec(
                "SELECT is_unlinking FROM user_external_storages WHERE id=$1 AND user_id=$2",
                pqxx::params{other_storage_id, other_user_id})[0][0].as<bool>());
            txn.commit();
        }

        CHECK(gdrive.get_access_token_for_storage(other_storage_id) == gdrive.mock_access_token);
        CHECK(gdrive.refresh_requests.load() == 3);
        CHECK(gdrive.get_storage_targets(other_user_id).at(0).status == "ready");
        CHECK(gdrive.quota_requests == 3);
    }

    SECTION("B.33 specific unlink invalidates only the owned storage") {
        const auto unlinked_storage_id = link_storage();
        uint64_t retained_storage_id;
        {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            retained_storage_id = txn.exec(
                "INSERT INTO user_external_storages(user_id,provider,account_email,refresh_token,root_folder_id) "
                "SELECT user_id,provider,'gd_b33_retained@test.com',refresh_token,'root-retained' "
                "FROM user_external_storages WHERE id=$1 RETURNING id",
                pqxx::params{unlinked_storage_id})[0][0].as<uint64_t>();
            txn.commit();
        }

        gdrive.expect_refresh = true;
        REQUIRE(gdrive.get_access_token_for_storage(unlinked_storage_id) == gdrive.mock_access_token);
        REQUIRE(gdrive.get_access_token_for_storage(retained_storage_id) == gdrive.mock_access_token);
        REQUIRE(gdrive.refresh_requests.load() == 2);

        gdrive.unlink_account(user_id, unlinked_storage_id);

        CHECK(gdrive.get_access_token_for_storage(retained_storage_id) == gdrive.mock_access_token);
        CHECK(gdrive.refresh_requests.load() == 2);
        CHECK(gdrive.get_access_token_for_storage(
            unlinked_storage_id, GoogleDriveService::TokenAccess::UnlinkCleanup) == gdrive.mock_access_token);
        CHECK(gdrive.refresh_requests.load() == 3);
    }

    SECTION("B.33 unlink prevents an older in-flight refresh from publishing") {
        const auto storage_id = link_storage();
        gdrive.expect_refresh = true;
        gdrive.enable_refresh_gate();

        std::string stale_token;
        std::exception_ptr stale_error;
        std::thread refresh([&] {
            try {
                stale_token = gdrive.get_access_token_for_storage(storage_id);
            } catch (...) {
                stale_error = std::current_exception();
            }
        });

        const bool refresh_blocked = gdrive.wait_for_refresh_waiters(1);
        if (refresh_blocked) {
            gdrive.unlink_account(user_id, storage_id);
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            CHECK(txn.exec(
                "SELECT is_unlinking FROM user_external_storages WHERE id=$1 AND user_id=$2",
                pqxx::params{storage_id, user_id})[0][0].as<bool>());
            txn.commit();
        }

        gdrive.release_refresh_gate();
        refresh.join();
        REQUIRE(refresh_blocked);

        CHECK(stale_token.empty());
        CHECK(stale_error != nullptr);
        if (stale_error) {
            try {
                std::rethrow_exception(stale_error);
            } catch (const std::runtime_error& error) {
                CHECK(std::string(error.what()) == "STORAGE_NOT_FOUND");
            }
        }

        CHECK(gdrive.get_access_token_for_storage(
            storage_id, GoogleDriveService::TokenAccess::UnlinkCleanup) == gdrive.mock_access_token);
        CHECK(gdrive.refresh_requests.load() == 2);
    }

    SECTION("B.33 completed unlink cannot retain an older refresh in cache") {
        const auto storage_id = link_storage();
        gdrive.expect_refresh = true;
        gdrive.enable_refresh_gate();

        std::exception_ptr stale_error;
        std::thread refresh([&] {
            try {
                (void)gdrive.get_access_token_for_storage(storage_id);
            } catch (...) {
                stale_error = std::current_exception();
            }
        });

        const bool refresh_blocked = gdrive.wait_for_refresh_waiters(1);
        if (refresh_blocked) gdrive.unlink_account(user_id, storage_id);
        gdrive.release_refresh_gate();
        refresh.join();
        REQUIRE(refresh_blocked);

        GarbageCollector gc(pool, nullptr, &gdrive);
        gc.run_cleanup();
        {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            REQUIRE(txn.exec("SELECT COUNT(*) FROM user_external_storages WHERE id=$1",
                             pqxx::params{storage_id})[0][0].as<int>() == 0);
            txn.commit();
        }

        CHECK(stale_error != nullptr);
        std::string post_gc_error;
        try {
            (void)gdrive.get_access_token_for_storage(storage_id);
        } catch (const std::runtime_error& error) {
            post_gc_error = error.what();
        }
        CHECK(post_gc_error == "STORAGE_NOT_FOUND");
        CHECK(gdrive.refresh_requests.load() == 1);
    }

    SECTION("B.33 cleanup can refresh after unlink begins") {
        const auto storage_id = link_storage();
        gdrive.unlink_account(user_id, storage_id);
        gdrive.expect_refresh = true;

        REQUIRE(gdrive.get_access_token_for_storage(
            storage_id, GoogleDriveService::TokenAccess::UnlinkCleanup) == gdrive.mock_access_token);
        REQUIRE(gdrive.refresh_requests.load() == 1);
    }

    SECTION("B.33 terminal unlink releases token cached by cleanup refresh") {
        const auto storage_id = link_storage();
        gdrive.unlink_account(user_id, storage_id);
        {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            REQUIRE(txn.exec("SELECT is_unlinking FROM user_external_storages WHERE id=$1",
                             pqxx::params{storage_id})[0][0].as<bool>());
            txn.commit();
        }

        gdrive.expect_refresh = true;
        REQUIRE(gdrive.get_access_token_for_storage(
            storage_id, GoogleDriveService::TokenAccess::UnlinkCleanup) == gdrive.mock_access_token);
        REQUIRE(gdrive.refresh_requests.load() == 1);
        REQUIRE(gdrive.get_access_token_for_storage(
            storage_id, GoogleDriveService::TokenAccess::UnlinkCleanup) == gdrive.mock_access_token);
        REQUIRE(gdrive.refresh_requests.load() == 1);

        GarbageCollector gc(pool, nullptr, &gdrive);
        gc.run_cleanup();
        {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            REQUIRE(txn.exec("SELECT COUNT(*) FROM user_external_storages WHERE id=$1",
                             pqxx::params{storage_id})[0][0].as<int>() == 0);
            txn.commit();
        }

        std::string terminal_error;
        try {
            (void)gdrive.get_access_token_for_storage(storage_id);
        } catch (const std::runtime_error& error) {
            terminal_error = error.what();
        }
        CHECK(terminal_error == "STORAGE_NOT_FOUND");
        CHECK(gdrive.refresh_requests.load() == 1);
    }

    SECTION("B.33 terminal GC deletion beats an in-flight cleanup refresh") {
        const auto storage_id = link_storage();
        gdrive.unlink_account(user_id, storage_id);
        gdrive.expect_refresh = true;
        gdrive.enable_refresh_gate();

        std::string token;
        std::exception_ptr refresh_error;
        std::thread refresh([&] {
            try {
                token = gdrive.get_access_token_for_storage(
                    storage_id, GoogleDriveService::TokenAccess::UnlinkCleanup);
            } catch (...) {
                refresh_error = std::current_exception();
            }
        });

        const bool refresh_blocked = gdrive.wait_for_refresh_waiters(1);
        if (refresh_blocked) {
            GarbageCollector gc(pool, nullptr, &gdrive);
            gc.run_cleanup();
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            CHECK(txn.exec("SELECT COUNT(*) FROM user_external_storages WHERE id=$1",
                           pqxx::params{storage_id})[0][0].as<int>() == 0);
            txn.commit();
        }
        gdrive.release_refresh_gate();
        refresh.join();

        REQUIRE(refresh_blocked);
        CHECK(token.empty());
        CHECK(refresh_error != nullptr);
        if (refresh_error) {
            try {
                std::rethrow_exception(refresh_error);
            } catch (const std::runtime_error& error) {
                CHECK(std::string(error.what()) == "STORAGE_NOT_FOUND");
            }
        }
        CHECK(gdrive.refresh_requests.load() == 1);
    }
}

TEST_CASE("B.34 caracteriza autoridade de capability durante unlink", "[service][googledrive][b34]") {
    set_test_environment("GOOGLE_CLIENT_ID", "mock_client_id");
    set_test_environment("GOOGLE_CLIENT_SECRET", "mock_client_secret");

    DatabasePool pool(12, get_secure_conn_string());
    MockGoogleDriveService gdrive(pool);
    const uint64_t user_id = 9996;
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE id=$1 OR username='gd_b34_user'", pqxx::params{user_id});
        txn.exec(
            "INSERT INTO users(id,username,email,password_hash,max_storage_bytes,is_email_verified) "
            "VALUES($1,'gd_b34_user','gd_b34@test.com','hash',104857600,TRUE)",
            pqxx::params{user_id});
        txn.commit();
    }

    struct Cleanup {
        DatabasePool& pool;
        uint64_t user_id;
        ~Cleanup() {
            try {
                auto conn = pool.acquire_connection();
                pqxx::work txn(*conn);
                txn.exec("DELETE FROM users WHERE id=$1", pqxx::params{user_id});
                txn.commit();
            } catch (...) {}
        }
    } cleanup{pool, user_id};

    const auto link_storage = [&]() {
        gdrive.link_account(user_id, "valid_auth_code_123", gdrive.generate_test_state(user_id));
        return gdrive.get_linked_accounts(user_id).at(0).id;
    };

    SECTION("normal cold access rejects an unlinking storage before refresh") {
        const auto storage_id = link_storage();
        gdrive.unlink_account(user_id, storage_id);
        gdrive.expect_refresh = true;

        std::string token;
        std::string error;
        try {
            token = gdrive.get_access_token_for_storage(storage_id);
        } catch (const std::runtime_error& exception) {
            error = exception.what();
        }

        CHECK(token.empty());
        CHECK(error == "STORAGE_NOT_FOUND");
        CHECK(gdrive.refresh_requests.load() == 0);
    }

    SECTION("normal access cannot consume a cleanup-warm token") {
        const auto storage_id = link_storage();
        gdrive.unlink_account(user_id, storage_id);
        gdrive.expect_refresh = true;

        const auto cleanup_token = gdrive.get_access_token_for_storage(
            storage_id, GoogleDriveService::TokenAccess::UnlinkCleanup);
        CHECK(cleanup_token == gdrive.mock_access_token);
        CHECK(gdrive.refresh_requests.load() == 1);

        std::string token;
        std::string error;
        try {
            token = gdrive.get_access_token_for_storage(storage_id);
        } catch (const std::runtime_error& exception) {
            error = exception.what();
        }

        CHECK(token.empty());
        CHECK(error == "STORAGE_NOT_FOUND");
        CHECK(gdrive.refresh_requests.load() == 1);
    }

    SECTION("normal follower cannot inherit an in-flight cleanup refresh") {
        const auto storage_id = link_storage();
        gdrive.unlink_account(user_id, storage_id);
        gdrive.expect_refresh = true;
        gdrive.enable_refresh_gate();

        std::string cleanup_token;
        std::exception_ptr cleanup_error;
        std::thread cleanup_owner([&] {
            try {
                cleanup_token = gdrive.get_access_token_for_storage(
                    storage_id, GoogleDriveService::TokenAccess::UnlinkCleanup);
            } catch (...) {
                cleanup_error = std::current_exception();
            }
        });
        const bool owner_started = gdrive.wait_for_refresh_waiters(1);

        std::string normal_token;
        std::exception_ptr normal_error;
        std::thread normal_follower([&] {
            try {
                normal_token = gdrive.get_access_token_for_storage(storage_id);
            } catch (...) {
                normal_error = std::current_exception();
            }
        });

        gdrive.release_refresh_gate();
        cleanup_owner.join();
        normal_follower.join();

        REQUIRE(owner_started);
        CHECK_FALSE(cleanup_error);
        CHECK(cleanup_token == gdrive.mock_access_token);
        CHECK(normal_token.empty());
        CHECK(normal_error != nullptr);
        CHECK(gdrive.refresh_requests.load() == 1);
    }

    SECTION("normal owner cannot poison cleanup authority") {
        const auto storage_id = link_storage();
        gdrive.unlink_account(user_id, storage_id);
        gdrive.expect_refresh = true;
        gdrive.enable_refresh_gate();

        std::string normal_token;
        std::exception_ptr normal_error;
        std::thread normal_owner([&] {
            try {
                normal_token = gdrive.get_access_token_for_storage(storage_id);
            } catch (...) {
                normal_error = std::current_exception();
            }
        });
        normal_owner.join();
        CHECK(normal_token.empty());
        CHECK(normal_error != nullptr);

        std::string cleanup_token;
        std::exception_ptr cleanup_error;
        std::thread cleanup_owner([&] {
            try {
                cleanup_token = gdrive.get_access_token_for_storage(
                    storage_id, GoogleDriveService::TokenAccess::UnlinkCleanup);
            } catch (...) {
                cleanup_error = std::current_exception();
            }
        });

        const bool cleanup_started = gdrive.wait_for_refresh_waiters(1);
        gdrive.release_refresh_gate();
        cleanup_owner.join();

        REQUIRE(cleanup_started);
        CHECK_FALSE(cleanup_error);
        CHECK(cleanup_token == gdrive.mock_access_token);
        CHECK(gdrive.refresh_requests.load() == 1);
    }

    SECTION("new resumable session remains denied after unlink") {
        const auto storage_id = link_storage();
        gdrive.unlink_account(user_id, storage_id);
        gdrive.expect_refresh = true;

        std::string error;
        try {
            (void)gdrive.create_resumable_session(user_id, storage_id, 10, 42, 43, "original");
        } catch (const std::runtime_error& exception) {
            error = exception.what();
        }
        CHECK(error == "STORAGE_TARGET_UNAVAILABLE");
        CHECK(gdrive.refresh_requests.load() == 0);
    }

    SECTION("storage selection ignores an unlinking account") {
        const auto storage_id = link_storage();
        gdrive.unlink_account(user_id, storage_id);
        gdrive.expect_refresh = true;
        std::string access_token;
        std::string root_folder_id;

        CHECK(gdrive.select_best_storage(user_id, 10, access_token, root_folder_id) == 0);
        CHECK(access_token.empty());
        CHECK(root_folder_id.empty());
        CHECK(gdrive.refresh_requests.load() == 0);
    }
}
