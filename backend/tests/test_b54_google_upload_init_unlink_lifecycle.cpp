#include <catch2/catch_test_macros.hpp>

#include "controllers/ApiRouter.hpp"
#include "database/DatabasePool.hpp"
#include "database/FileManager.hpp"
#include "database/FolderManager.hpp"
#include "Services/AuthService.hpp"
#include "Services/GoogleDriveService.hpp"
#include "storage/FileChunker.hpp"
#include "test_helpers.hpp"

#include <atomic>
#include <chrono>
#include <exception>
#include <pqxx/pqxx>
#include <string>
#include <thread>
#include <vector>

namespace {

bool wait_for_locking_query(const std::string& connection_string, const std::string& fragment) {
    pqxx::connection observer(connection_string);
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (std::chrono::steady_clock::now() < deadline) {
        pqxx::nontransaction txn(observer);
        if (!txn.exec(
                "SELECT 1 FROM pg_stat_activity "
                "WHERE pid <> pg_backend_pid() AND state = 'active' AND wait_event_type = 'Lock' "
                "AND query ILIKE $1 LIMIT 1",
                pqxx::params{"%" + fragment + "%"}).empty()) {
            return true;
        }
        std::this_thread::yield();
    }
    return false;
}

struct B54Fixture {
    DatabasePool pool;
    MockEmailService email;
    AuthService auth;
    FolderManager folders;
    FileManager files;
    FileChunker chunker;
    MockGoogleDriveService google;
    ApiRouter router;
    uint64_t user_id;
    uint64_t storage_id = 0;
    std::string token;

    explicit B54Fixture(uint64_t id)
        : pool(2, get_secure_conn_string()),
          auth("b54-fixture-secret", "b54-fixture-pepper", &email),
          folders(pool),
          files(pool),
          chunker("./test_storage_b54_matrix"),
          google(pool),
          router(pool, auth, folders, &files, &chunker, &google),
          user_id(id) {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE id = $1", pqxx::params{user_id});
        txn.exec(
            "INSERT INTO users (id, username, email, password_hash, max_storage_bytes, used_storage_bytes, is_email_verified) "
            "VALUES ($1, $2, $3, 'b54-hash', 104857600, 0, TRUE)",
            pqxx::params{user_id, "b54-user-" + std::to_string(user_id),
                         "b54-" + std::to_string(user_id) + "@test.com"});
        txn.commit();

        REQUIRE_NOTHROW(google.link_account(user_id, "b54-code", google.generate_test_state(user_id)));
        conn = pool.acquire_connection();
        pqxx::work storage_txn(*conn);
        storage_id = storage_txn.exec(
            "SELECT id FROM user_external_storages WHERE user_id = $1 AND provider = 'google_drive'",
            pqxx::params{user_id})[0][0].as<uint64_t>();
        storage_txn.commit();

        google.expect_refresh = true;
        REQUIRE(google.get_access_token_for_storage(storage_id) == google.mock_access_token);
        token = auth.generate_token(user_id);
    }

    ~B54Fixture() {
        try {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            txn.exec("DELETE FROM users WHERE id = $1", pqxx::params{user_id});
            txn.commit();
        } catch (...) {
        }
    }

    crow::request batch_request(const std::string& client_ref, const std::string& name_hash) const {
        crow::request request;
        request.url = "/files/batch-init";
        request.method = crow::HTTPMethod::Post;
        request.add_header("Authorization", "Bearer " + token);

        crow::json::wvalue item;
        item["client_ref"] = client_ref;
        item["encrypted_name"] = client_ref + "-name";
        item["name_hash"] = name_hash;
        item["encrypted_fdk"] = client_ref + "-fdk";
        item["size_bytes"] = 7;
        item["storage_provider"] = "google_drive";

        crow::json::wvalue body;
        std::vector<crow::json::wvalue> items;
        items.push_back(std::move(item));
        body["files"] = std::move(items);
        request.body = body.dump();
        return request;
    }
};

} // namespace

TEST_CASE("B.54 Google upload init cannot commit after unlink wins the lifecycle race",
          "[b54][google][upload][unlink][race]") {
    set_test_environment("GOOGLE_CLIENT_ID", "mock_client_id");
    set_test_environment("GOOGLE_CLIENT_SECRET", "mock_client_secret");

    DatabasePool pool(2, get_secure_conn_string());
    MockEmailService email;
    AuthService auth("b54-pepper", "b54-secret", &email);
    FolderManager folders(pool);
    FileManager files(pool);
    FileChunker chunker("./test_storage_b54");
    MockGoogleDriveService google(pool);
    ApiRouter router(pool, auth, folders, &files, &chunker, &google);
    constexpr uint64_t user_id = 95401;

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE id = $1", pqxx::params{user_id});
        txn.exec(
            "INSERT INTO users (id, username, email, password_hash, max_storage_bytes, used_storage_bytes, is_email_verified) "
            "VALUES ($1, 'b54-user', 'b54-user@test.com', 'b54-hash', 104857600, 0, TRUE)",
            pqxx::params{user_id});
        txn.commit();
    }

    struct Cleanup {
        DatabasePool& pool;
        ~Cleanup() {
            try {
                auto conn = pool.acquire_connection();
                pqxx::work txn(*conn);
                txn.exec("DELETE FROM users WHERE id = $1", pqxx::params{95401});
                txn.commit();
            } catch (...) {
            }
        }
    } cleanup{pool};

    REQUIRE_NOTHROW(google.link_account(user_id, "b54-code", google.generate_test_state(user_id)));

    uint64_t storage_id = 0;
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        storage_id = txn.exec(
            "SELECT id FROM user_external_storages WHERE user_id = $1 AND provider = 'google_drive'",
            pqxx::params{user_id})[0][0].as<uint64_t>();
        txn.commit();
    }

    google.expect_refresh = true;
    REQUIRE(google.get_access_token_for_storage(storage_id) == google.mock_access_token);

    const auto token = auth.generate_token(user_id);
    crow::request request;
    request.url = "/files";
    request.add_header("Authorization", "Bearer " + token);
    request.body =
        R"({"folder_id":null,"encrypted_name":"b54-name","name_hash":"b54-name-hash",)"
        R"("encrypted_fdk":"b54-fdk","size_bytes":7,"storage_provider":"google_drive"})";

    google.enable_quota_gate();
    crow::response init_response;
    std::exception_ptr init_error;
    std::thread initializer([&] {
        try {
            init_response = router.handle_init_file_upload(request);
        } catch (...) {
            init_error = std::current_exception();
        }
    });

    const bool quota_waiter_seen = google.wait_for_quota_waiters(1);
    std::exception_ptr unlink_error;
    if (quota_waiter_seen) {
        try {
            google.unlink_account(user_id, storage_id);
        } catch (...) {
            unlink_error = std::current_exception();
        }
    }
    google.release_quota_gate();
    if (initializer.joinable()) initializer.join();

    REQUIRE(quota_waiter_seen);
    REQUIRE_FALSE(unlink_error);
    REQUIRE_FALSE(init_error);
    REQUIRE(init_response.code == 409);
    REQUIRE(init_response.body.find("EXTERNAL_UPLOAD_INIT_CONFLICT") != std::string::npos);

    auto conn = pool.acquire_connection();
    pqxx::work txn(*conn);
    REQUIRE(txn.exec(
        "SELECT is_unlinking FROM user_external_storages WHERE id = $1",
        pqxx::params{storage_id})[0][0].as<bool>());
    REQUIRE(txn.exec(
        "SELECT count(*) FROM files WHERE user_id = $1 AND name_hash = 'b54-name-hash'",
        pqxx::params{user_id})[0][0].as<int>() == 0);
    REQUIRE(txn.exec(
        "SELECT used_storage_bytes FROM users WHERE id = $1",
        pqxx::params{user_id})[0][0].as<uint64_t>() == 0);
    txn.commit();
}

TEST_CASE("B.54 single Google init owns the storage lease before unlink",
          "[b54][google][upload][unlink][race]") {
    set_test_environment("GOOGLE_CLIENT_ID", "mock_client_id");
    set_test_environment("GOOGLE_CLIENT_SECRET", "mock_client_secret");
    B54Fixture fixture(95402);

    pqxx::connection blocker_connection(get_secure_conn_string());
    pqxx::work blocker(blocker_connection);
    REQUIRE_FALSE(blocker.exec(
        "SELECT id FROM users WHERE id = $1 FOR UPDATE",
        pqxx::params{fixture.user_id}).empty());

    crow::request init_request;
    init_request.url = "/files";
    init_request.add_header("Authorization", "Bearer " + fixture.token);
    init_request.body =
        R"({"folder_id":null,"encrypted_name":"b54-init-first","name_hash":"b54-init-first-hash",)"
        R"("encrypted_fdk":"b54-fdk","size_bytes":7,"storage_provider":"google_drive"})";

    crow::response init_response;
    std::exception_ptr init_error;
    std::thread initializer([&] {
        try {
            init_response = fixture.router.handle_init_file_upload(init_request);
        } catch (...) {
            init_error = std::current_exception();
        }
    });

    const bool init_waiting = wait_for_locking_query(get_secure_conn_string(), "SELECT used_storage_bytes");
    crow::response unlink_response;
    std::exception_ptr unlink_error;
    std::thread unlinker([&] {
        try {
            crow::request request;
            request.url = "/api/storage/google/accounts/" + std::to_string(fixture.storage_id);
            request.add_header("Authorization", "Bearer " + fixture.token);
            unlink_response = fixture.router.handle_unlink_google_account(
                request, static_cast<int>(fixture.storage_id));
        } catch (...) {
            unlink_error = std::current_exception();
        }
    });

    const bool unlink_waiting = wait_for_locking_query(
        get_secure_conn_string(), "SELECT id FROM user_external_storages");
    blocker.commit();
    initializer.join();
    unlinker.join();

    REQUIRE(init_waiting);
    REQUIRE(unlink_waiting);
    REQUIRE_FALSE(init_error);
    REQUIRE_FALSE(unlink_error);
    REQUIRE(init_response.code == 201);
    REQUIRE(unlink_response.code == 409);
    REQUIRE(unlink_response.body.find("ACCOUNT_HAS_PENDING_UPLOADS") != std::string::npos);

    auto conn = fixture.pool.acquire_connection();
    pqxx::work txn(*conn);
    REQUIRE(txn.exec(
        "SELECT count(*) FROM files WHERE user_id = $1 AND name_hash = 'b54-init-first-hash'",
        pqxx::params{fixture.user_id})[0][0].as<int>() == 1);
    REQUIRE(txn.exec(
        "SELECT used_storage_bytes FROM users WHERE id = $1",
        pqxx::params{fixture.user_id})[0][0].as<uint64_t>() == 2048);
    REQUIRE_FALSE(txn.exec(
        "SELECT is_unlinking FROM user_external_storages WHERE id = $1",
        pqxx::params{fixture.storage_id})[0][0].as<bool>());
    txn.commit();
}

TEST_CASE("B.54 batch Google init rejects a storage unlinked after selection",
          "[b54][google][upload][batch][unlink][race]") {
    set_test_environment("GOOGLE_CLIENT_ID", "mock_client_id");
    set_test_environment("GOOGLE_CLIENT_SECRET", "mock_client_secret");
    B54Fixture fixture(95403);
    fixture.google.enable_quota_gate();

    auto request = fixture.batch_request("b54-batch-unlink-first", "b54-batch-unlink-first-hash");
    crow::response init_response;
    std::exception_ptr init_error;
    std::thread initializer([&] {
        try {
            init_response = fixture.router.handle_batch_init_uploads(request);
        } catch (...) {
            init_error = std::current_exception();
        }
    });

    const bool quota_waiter_seen = fixture.google.wait_for_quota_waiters(1);
    std::exception_ptr unlink_error;
    if (quota_waiter_seen) {
        try {
            fixture.google.unlink_account(fixture.user_id, fixture.storage_id);
        } catch (...) {
            unlink_error = std::current_exception();
        }
    }
    fixture.google.release_quota_gate();
    if (initializer.joinable()) initializer.join();

    REQUIRE(quota_waiter_seen);
    REQUIRE_FALSE(unlink_error);
    REQUIRE_FALSE(init_error);
    REQUIRE(init_response.code == 409);
    REQUIRE(init_response.body.find("EXTERNAL_UPLOAD_INIT_CONFLICT") != std::string::npos);

    auto conn = fixture.pool.acquire_connection();
    pqxx::work txn(*conn);
    REQUIRE(txn.exec(
        "SELECT count(*) FROM files WHERE user_id = $1 AND name_hash = 'b54-batch-unlink-first-hash'",
        pqxx::params{fixture.user_id})[0][0].as<int>() == 0);
    REQUIRE(txn.exec(
        "SELECT used_storage_bytes FROM users WHERE id = $1",
        pqxx::params{fixture.user_id})[0][0].as<uint64_t>() == 0);
    txn.commit();
}

TEST_CASE("B.54 batch Google init holds all storage leases before quota mutation",
          "[b54][google][upload][batch][unlink][race]") {
    set_test_environment("GOOGLE_CLIENT_ID", "mock_client_id");
    set_test_environment("GOOGLE_CLIENT_SECRET", "mock_client_secret");
    B54Fixture fixture(95404);

    pqxx::connection blocker_connection(get_secure_conn_string());
    pqxx::work blocker(blocker_connection);
    REQUIRE_FALSE(blocker.exec(
        "SELECT id FROM users WHERE id = $1 FOR UPDATE",
        pqxx::params{fixture.user_id}).empty());

    auto request = fixture.batch_request("b54-batch-init-first", "b54-batch-init-first-hash");
    crow::response init_response;
    std::exception_ptr init_error;
    std::thread initializer([&] {
        try {
            init_response = fixture.router.handle_batch_init_uploads(request);
        } catch (...) {
            init_error = std::current_exception();
        }
    });

    const bool init_waiting = wait_for_locking_query(get_secure_conn_string(), "SELECT used_storage_bytes");
    crow::response unlink_response;
    std::exception_ptr unlink_error;
    std::thread unlinker([&] {
        try {
            crow::request unlink_request;
            unlink_request.url = "/api/storage/google/accounts/" + std::to_string(fixture.storage_id);
            unlink_request.add_header("Authorization", "Bearer " + fixture.token);
            unlink_response = fixture.router.handle_unlink_google_account(
                unlink_request, static_cast<int>(fixture.storage_id));
        } catch (...) {
            unlink_error = std::current_exception();
        }
    });

    const bool unlink_waiting = wait_for_locking_query(
        get_secure_conn_string(), "SELECT id FROM user_external_storages");
    blocker.commit();
    initializer.join();
    unlinker.join();

    REQUIRE(init_waiting);
    REQUIRE(unlink_waiting);
    REQUIRE_FALSE(init_error);
    REQUIRE_FALSE(unlink_error);
    REQUIRE(init_response.code == 201);
    REQUIRE(unlink_response.code == 409);
    REQUIRE(unlink_response.body.find("ACCOUNT_HAS_PENDING_UPLOADS") != std::string::npos);

    auto conn = fixture.pool.acquire_connection();
    pqxx::work txn(*conn);
    REQUIRE(txn.exec(
        "SELECT count(*) FROM files WHERE user_id = $1 AND name_hash = 'b54-batch-init-first-hash'",
        pqxx::params{fixture.user_id})[0][0].as<int>() == 1);
    REQUIRE(txn.exec(
        "SELECT used_storage_bytes FROM users WHERE id = $1",
        pqxx::params{fixture.user_id})[0][0].as<uint64_t>() == 2048);
    txn.commit();
}

TEST_CASE("B.54 mixed Local and Google batch fails before any mutation",
          "[b54][google][upload][batch][atomicity]") {
    set_test_environment("GOOGLE_CLIENT_ID", "mock_client_id");
    set_test_environment("GOOGLE_CLIENT_SECRET", "mock_client_secret");
    B54Fixture fixture(95405);

    {
        auto conn = fixture.pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("UPDATE user_external_storages SET is_unlinking = TRUE WHERE id = $1",
                 pqxx::params{fixture.storage_id});
        txn.commit();
    }

    BatchInitItem local;
    local.enc_name = "b54-local-name";
    local.name_hash = "b54-local-hash";
    local.encrypted_fdk = "b54-local-fdk";
    local.size_bytes = 7;
    local.total_chunks = 1;
    local.storage_provider = "local";

    BatchInitItem google;
    google.enc_name = "b54-google-name";
    google.name_hash = "b54-google-hash";
    google.encrypted_fdk = "b54-google-fdk";
    google.size_bytes = 7;
    google.total_chunks = 0;
    google.storage_provider = "google_drive";
    google.external_storage_id = fixture.storage_id;

    std::string error;
    try {
        fixture.files.batch_init_uploads(fixture.user_id, {local, google});
    } catch (const std::exception& exception) {
        error = exception.what();
    }

    REQUIRE(error == "EXTERNAL_UPLOAD_INIT_CONFLICT");
    auto conn = fixture.pool.acquire_connection();
    pqxx::work txn(*conn);
    REQUIRE(txn.exec(
        "SELECT count(*) FROM files WHERE user_id = $1",
        pqxx::params{fixture.user_id})[0][0].as<int>() == 0);
    REQUIRE(txn.exec(
        "SELECT used_storage_bytes FROM users WHERE id = $1",
        pqxx::params{fixture.user_id})[0][0].as<uint64_t>() == 0);
    txn.commit();
}

TEST_CASE("B.54 unlink-all validates only its captured active storage set",
          "[b54][google][upload][unlink][atomicity]") {
    set_test_environment("GOOGLE_CLIENT_ID", "mock_client_id");
    set_test_environment("GOOGLE_CLIENT_SECRET", "mock_client_secret");
    B54Fixture fixture(95406);
    uint64_t second_storage_id = 0;

    {
        auto conn = fixture.pool.acquire_connection();
        pqxx::work txn(*conn);
        second_storage_id = txn.exec(
            "INSERT INTO user_external_storages "
            "(user_id, provider, account_email, refresh_token, root_folder_id) "
            "VALUES ($1, 'google_drive', 'b54-second@test.com', 'b54-refresh-2', 'b54-root-2') "
            "RETURNING id",
            pqxx::params{fixture.user_id})[0][0].as<uint64_t>();
        txn.exec(
            "INSERT INTO files (user_id, encrypted_name, name_hash, encrypted_fdk, size_bytes, total_chunks, "
            "is_upload_complete, storage_provider, external_storage_id) "
            "VALUES ($1, 'b54-pending', 'b54-pending-hash', 'b54-fdk', 7, 0, FALSE, 'google_drive', $2)",
            pqxx::params{fixture.user_id, fixture.storage_id});
        txn.exec("UPDATE users SET used_storage_bytes = 2048 WHERE id = $1", pqxx::params{fixture.user_id});
        txn.commit();
    }

    std::string error;
    try {
        fixture.google.unlink_account(fixture.user_id);
    } catch (const std::exception& exception) {
        error = exception.what();
    }

    REQUIRE(error == "ACCOUNT_HAS_PENDING_UPLOADS");
    auto conn = fixture.pool.acquire_connection();
    pqxx::work txn(*conn);
    REQUIRE_FALSE(txn.exec(
        "SELECT is_unlinking FROM user_external_storages WHERE id = $1",
        pqxx::params{fixture.storage_id})[0][0].as<bool>());
    REQUIRE_FALSE(txn.exec(
        "SELECT is_unlinking FROM user_external_storages WHERE id = $1",
        pqxx::params{second_storage_id})[0][0].as<bool>());
    REQUIRE(txn.exec(
        "SELECT count(*) FROM files WHERE user_id = $1 AND name_hash = 'b54-pending-hash'",
        pqxx::params{fixture.user_id})[0][0].as<int>() == 1);
    REQUIRE(txn.exec(
        "SELECT used_storage_bytes FROM users WHERE id = $1",
        pqxx::params{fixture.user_id})[0][0].as<uint64_t>() == 2048);
    txn.commit();
}
