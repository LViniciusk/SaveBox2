#include <catch2/catch_test_macros.hpp>

#include "controllers/ApiRouter.hpp"
#include "database/DatabasePool.hpp"
#include "database/FolderManager.hpp"
#include "database/UsersManager.hpp"
#include "Services/AuthService.hpp"
#include "storage/FileChunker.hpp"
#include "storage/GarbageCollector.hpp"
#include "test_helpers.hpp"

#include <crow_all.h>
#include <filesystem>
#include <string>

namespace {

struct B43Fixture {
    DatabasePool pool;
    std::filesystem::path vault;
    FileChunker chunker;
    MockGoogleDriveService gdrive;
    GarbageCollector gc;
    std::string suffix;
    uint64_t user_id;

    explicit B43Fixture(std::string test_suffix)
        : pool(4, get_secure_conn_string()),
          vault("./vault_b43_" + test_suffix),
          chunker(vault.string()),
          gdrive(pool),
          gc(pool, &chunker, &gdrive),
          suffix(std::move(test_suffix)),
          user_id(0) {
        std::filesystem::remove_all(vault);
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        const auto username = "b43_" + suffix;
        txn.exec("DELETE FROM users WHERE username=$1", pqxx::params{username});
        user_id = txn.exec(
            "INSERT INTO users(username,email,password_hash,is_email_verified,max_storage_bytes,used_storage_bytes) "
            "VALUES($1,$2,'hash',TRUE,1000000,0) RETURNING id",
            pqxx::params{username, username + "@test.com"})[0][0].as<uint64_t>();
        txn.commit();
    }

    ~B43Fixture() {
        try {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            txn.exec("DELETE FROM pending_external_deletions WHERE external_file_id LIKE $1",
                     pqxx::params{"b43-" + suffix + "-%"});
            txn.exec("DELETE FROM users WHERE id=$1", pqxx::params{user_id});
            txn.commit();
        } catch (...) {
        }
        std::filesystem::remove_all(vault);
    }

    int count(const std::string& query) {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        const int result = txn.exec(query)[0][0].as<int>();
        txn.commit();
        return result;
    }

    uint64_t create_local_file(const std::string& name, uint64_t size = 8) {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        const auto file_id = txn.exec(
            "INSERT INTO files(user_id,encrypted_name,name_hash,encrypted_fdk,size_bytes,"
            "is_upload_complete,storage_provider) VALUES($1,$2,$3,'fdk',$4,TRUE,'local') RETURNING id",
            pqxx::params{user_id, "cipher-" + name, "b43-" + suffix + "-" + name, size})[0][0].as<uint64_t>();
        txn.commit();
        REQUIRE(chunker.write_chunk(file_id, 0, std::string(size, 'x')));
        return file_id;
    }

    uint64_t create_google_storage() {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        const auto storage_id = txn.exec(
            "INSERT INTO user_external_storages(user_id,provider,account_email,refresh_token,root_folder_id) "
            "VALUES($1,'google_drive',$2,'refresh','root') RETURNING id",
            pqxx::params{user_id, "b43-" + suffix + "@test.com"})[0][0].as<uint64_t>();
        txn.commit();
        return storage_id;
    }

    uint64_t create_google_file(uint64_t storage_id) {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        const auto file_id = txn.exec(
            "INSERT INTO files(user_id,encrypted_name,name_hash,encrypted_fdk,size_bytes,"
            "is_upload_complete,storage_provider,external_file_id,external_storage_id) "
            "VALUES($1,'cipher-google',$2,'fdk',2048,TRUE,'google_drive',$3,$4) RETURNING id",
            pqxx::params{user_id, "b43-" + suffix + "-google-hash", "b43-" + suffix + "-external", storage_id})[0][0].as<uint64_t>();
        txn.commit();
        return file_id;
    }

    void soft_delete() {
        UsersManager users(pool);
        users.delete_user(user_id);
    }

};

} // namespace

TEST_CASE("B.43 deleted local account enters the existing file GC lifecycle", "[b43][gc]") {
    B43Fixture fixture("local");
    const auto file_id = fixture.create_local_file("single");
    fixture.soft_delete();

    CHECK(fixture.count("SELECT COUNT(*) FROM users WHERE id=" + std::to_string(fixture.user_id) + " AND deleted_at IS NOT NULL") == 1);

    fixture.gc.run_cleanup();

    CHECK(fixture.count("SELECT COUNT(*) FROM files WHERE id=" + std::to_string(file_id)) == 0);
    CHECK(fixture.count("SELECT COUNT(*) FROM users WHERE id=" + std::to_string(fixture.user_id)) == 0);
    CHECK_FALSE(std::filesystem::exists(fixture.vault / (std::to_string(file_id) + ".dat")));
}

TEST_CASE("B.43 deleted-user preparation preserves the 50-file batch bound", "[b43][gc]") {
    B43Fixture fixture("batch");
    for (int index = 0; index < 51; ++index) {
        fixture.create_local_file("batch-" + std::to_string(index));
    }
    fixture.soft_delete();

    fixture.gc.run_cleanup();

    CHECK(fixture.count("SELECT COUNT(*) FROM files WHERE user_id=" + std::to_string(fixture.user_id)) == 1);
    CHECK(fixture.count("SELECT COUNT(*) FROM users WHERE id=" + std::to_string(fixture.user_id)) == 1);

    fixture.gc.run_cleanup();

    CHECK(fixture.count("SELECT COUNT(*) FROM files WHERE user_id=" + std::to_string(fixture.user_id)) == 0);
    CHECK(fixture.count("SELECT COUNT(*) FROM users WHERE id=" + std::to_string(fixture.user_id)) == 0);
}

TEST_CASE("B.43 provider failure preserves deleted-user cleanup authority", "[b43][gc]") {
    B43Fixture fixture("provider-failure");
    const auto storage_id = fixture.create_google_storage();
    fixture.create_google_file(storage_id);
    fixture.gdrive.deletion_status = 503;
    fixture.soft_delete();

    const int requests_before_failure_run = fixture.gdrive.deletion_requests;
    fixture.gc.run_cleanup();

    CHECK(fixture.gdrive.deletion_requests > requests_before_failure_run);
    CHECK(fixture.count("SELECT COUNT(*) FROM users WHERE id=" + std::to_string(fixture.user_id)) == 1);
    CHECK(fixture.count("SELECT COUNT(*) FROM user_external_storages WHERE id=" + std::to_string(storage_id)) == 1);
    CHECK(fixture.count("SELECT COUNT(*) FROM pending_external_deletions WHERE external_storage_id=" + std::to_string(storage_id)) == 1);

    fixture.gdrive.deletion_status = 204;
    {
        auto conn = fixture.pool.acquire_connection();
        pqxx::work retry_txn(*conn);
        retry_txn.exec(
            "UPDATE pending_external_deletions "
            "SET next_retry_at=CURRENT_TIMESTAMP-INTERVAL '1000 years' "
            "WHERE external_storage_id=$1",
            pqxx::params{storage_id});
        retry_txn.commit();
    }
    const int requests_before_retry = fixture.gdrive.deletion_requests;
    fixture.gc.run_cleanup();

    CHECK(fixture.gdrive.deletion_requests > requests_before_retry);
    CHECK(fixture.count("SELECT COUNT(*) FROM pending_external_deletions WHERE external_storage_id=" + std::to_string(storage_id)) == 0);
    CHECK(fixture.count("SELECT COUNT(*) FROM users WHERE id=" + std::to_string(fixture.user_id)) == 0);
}

TEST_CASE("B.43 repeated cleanup does not repeat file accounting", "[b43][gc]") {
    B43Fixture fixture("idempotency");
    const auto storage_id = fixture.create_google_storage();
    const auto file_id = fixture.create_local_file("accounted", 8);
    {
        auto conn = fixture.pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec(
            "UPDATE users SET used_storage_bytes=8 WHERE id=$1",
            pqxx::params{fixture.user_id});
        txn.exec(
            "INSERT INTO pending_external_deletions(external_file_id,external_storage_id) VALUES($1,$2)",
            pqxx::params{"b43-idempotency-blocker", storage_id});
        txn.commit();
    }
    fixture.gdrive.deletion_status = 503;
    fixture.soft_delete();

    fixture.gc.run_cleanup();
    CHECK(fixture.count("SELECT COUNT(*) FROM files WHERE id=" + std::to_string(file_id)) == 0);
    CHECK(fixture.count("SELECT used_storage_bytes FROM users WHERE id=" + std::to_string(fixture.user_id)) == 0);
    CHECK(fixture.count("SELECT COUNT(*) FROM users WHERE id=" + std::to_string(fixture.user_id)) == 1);

    fixture.gc.run_cleanup();
    CHECK(fixture.count("SELECT used_storage_bytes FROM users WHERE id=" + std::to_string(fixture.user_id)) == 0);
    CHECK(fixture.count("SELECT COUNT(*) FROM pending_external_deletions WHERE external_storage_id=" + std::to_string(storage_id)) == 1);
}

TEST_CASE("B.43 pending external deletion blocks a file-less terminal user", "[b43][gc]") {
    B43Fixture fixture("pending-external");
    const auto storage_id = fixture.create_google_storage();
    auto conn = fixture.pool.acquire_connection();
    pqxx::work txn(*conn);
    txn.exec(
        "INSERT INTO pending_external_deletions(external_file_id,external_storage_id) VALUES($1,$2)",
        pqxx::params{"b43-pending-external", storage_id});
    txn.commit();
    fixture.gdrive.deletion_status = 503;
    fixture.soft_delete();

    fixture.gc.run_cleanup();

    CHECK(fixture.count("SELECT COUNT(*) FROM users WHERE id=" + std::to_string(fixture.user_id)) == 1);
    CHECK(fixture.count("SELECT COUNT(*) FROM pending_external_deletions WHERE external_storage_id=" + std::to_string(storage_id)) == 1);

    fixture.gdrive.deletion_status = 204;
    conn = fixture.pool.acquire_connection();
    pqxx::work resolve_txn(*conn);
    resolve_txn.exec("UPDATE pending_external_deletions SET next_retry_at=CURRENT_TIMESTAMP WHERE external_storage_id=$1", pqxx::params{storage_id});
    resolve_txn.commit();
    fixture.gc.run_cleanup();
    CHECK(fixture.count("SELECT COUNT(*) FROM users WHERE id=" + std::to_string(fixture.user_id)) == 0);
}

TEST_CASE("B.43 storage-move cleanup blockers retain deleted-user authority", "[b43][gc][storage-move]") {
    SECTION("pending local deletion") {
        B43Fixture fixture("move-local");
        const auto file_id = fixture.create_local_file("move-local");
        auto conn = fixture.pool.acquire_connection();
        pqxx::work txn(*conn);
        const auto move_id = txn.exec(
            "INSERT INTO storage_move_jobs(user_id,file_id,status,source_provider,target_provider,total_bytes) "
            "VALUES($1,$2,'cleanup_pending','local','google_drive',8) RETURNING id",
            pqxx::params{fixture.user_id, file_id})[0][0].as<uint64_t>();
        txn.exec("INSERT INTO pending_local_deletions(move_job_id) VALUES($1)", pqxx::params{move_id});
        txn.commit();
        fixture.soft_delete();

        fixture.gc.run_cleanup();
        CHECK(fixture.count("SELECT COUNT(*) FROM users WHERE id=" + std::to_string(fixture.user_id)) == 1);

        conn = fixture.pool.acquire_connection();
        pqxx::work resolve_txn(*conn);
        resolve_txn.exec("DELETE FROM pending_local_deletions WHERE move_job_id=$1", pqxx::params{move_id});
        resolve_txn.exec("UPDATE storage_move_jobs SET status='completed',completed_at=CURRENT_TIMESTAMP WHERE id=$1", pqxx::params{move_id});
        resolve_txn.commit();
        fixture.gc.run_cleanup();
        CHECK(fixture.count("SELECT COUNT(*) FROM users WHERE id=" + std::to_string(fixture.user_id)) == 0);
    }

    SECTION("pending Google reconciliation") {
        B43Fixture fixture("move-reconcile");
        const auto storage_id = fixture.create_google_storage();
        const auto file_id = fixture.create_local_file("move-reconcile");
        auto conn = fixture.pool.acquire_connection();
        pqxx::work txn(*conn);
        const auto move_id = txn.exec(
            "INSERT INTO storage_move_jobs(user_id,file_id,status,source_provider,target_provider,total_bytes) "
            "VALUES($1,$2,'cancelled','local','google_drive',8) RETURNING id",
            pqxx::params{fixture.user_id, file_id})[0][0].as<uint64_t>();
        txn.exec(
            "INSERT INTO pending_storage_move_reconciliations(move_job_id,external_storage_id,expires_at) "
            "VALUES($1,$2,CURRENT_TIMESTAMP+INTERVAL '1 hour')",
            pqxx::params{move_id, storage_id});
        txn.commit();
        fixture.gdrive.override_reconciliation = true;
        fixture.gdrive.reconciliation_targets.clear();
        fixture.soft_delete();

        fixture.gc.run_cleanup();
        CHECK(fixture.count("SELECT COUNT(*) FROM users WHERE id=" + std::to_string(fixture.user_id)) == 1);

        conn = fixture.pool.acquire_connection();
        pqxx::work resolve_txn(*conn);
        resolve_txn.exec("DELETE FROM pending_storage_move_reconciliations WHERE move_job_id=$1", pqxx::params{move_id});
        resolve_txn.exec("UPDATE storage_move_jobs SET status='completed',completed_at=CURRENT_TIMESTAMP WHERE id=$1", pqxx::params{move_id});
        resolve_txn.commit();
        fixture.gc.run_cleanup();
        CHECK(fixture.count("SELECT COUNT(*) FROM users WHERE id=" + std::to_string(fixture.user_id)) == 0);
    }

    SECTION("active move job") {
        B43Fixture fixture("move-active");
        const auto file_id = fixture.create_local_file("move-active");
        auto conn = fixture.pool.acquire_connection();
        pqxx::work txn(*conn);
        const auto move_id = txn.exec(
            "INSERT INTO storage_move_jobs(user_id,file_id,status,source_provider,target_provider,total_bytes) "
            "VALUES($1,$2,'transferring','local','google_drive',8) RETURNING id",
            pqxx::params{fixture.user_id, file_id})[0][0].as<uint64_t>();
        txn.commit();
        fixture.soft_delete();

        fixture.gc.run_cleanup();
        CHECK(fixture.count("SELECT COUNT(*) FROM users WHERE id=" + std::to_string(fixture.user_id)) == 1);
        CHECK(fixture.count("SELECT COUNT(*) FROM files WHERE id=" + std::to_string(file_id)) == 1);

        conn = fixture.pool.acquire_connection();
        pqxx::work resolve_txn(*conn);
        resolve_txn.exec("UPDATE storage_move_jobs SET status='completed',completed_at=CURRENT_TIMESTAMP WHERE id=$1",
                         pqxx::params{move_id});
        resolve_txn.commit();
        fixture.gc.run_cleanup();
        CHECK(fixture.count("SELECT COUNT(*) FROM users WHERE id=" + std::to_string(fixture.user_id)) == 0);
    }
}

TEST_CASE("B.43 active users remain untouched by account cleanup", "[b43][gc]") {
    B43Fixture fixture("active");
    const auto file_id = fixture.create_local_file("active");

    fixture.gc.run_cleanup();

    CHECK(fixture.count("SELECT COUNT(*) FROM users WHERE id=" + std::to_string(fixture.user_id) + " AND deleted_at IS NULL") == 1);
    CHECK(fixture.count("SELECT COUNT(*) FROM files WHERE id=" + std::to_string(file_id) + " AND deleted_at IS NULL") == 1);
    CHECK(std::filesystem::exists(fixture.vault / (std::to_string(file_id) + ".dat")));
}

TEST_CASE("B.43 local tombstone login does not regain authority", "[b43][api][auth]") {
    DatabasePool pool(3, get_secure_conn_string());
    MockEmailService email;
    AuthService auth("b43-pepper", "b43-secret", &email);
    FolderManager folder_mgr(pool);
    ApiRouter router(pool, auth, folder_mgr);

    const std::string username = "b43-local-login";
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username=$1", pqxx::params{username});
        const auto hash = auth.hash_password("correct-password");
        txn.exec(
            "INSERT INTO users(username,email,password_hash,is_email_verified) VALUES($1,$2,$3,TRUE)",
            pqxx::params{username, username + "@test.com", hash});
        txn.commit();
    }

    UsersManager users(pool);
    auto conn = pool.acquire_connection();
    pqxx::work txn(*conn);
    const auto user_id = txn.exec("SELECT id FROM users WHERE username=$1", pqxx::params{username})[0][0].as<uint64_t>();
    txn.commit();
    users.delete_user(user_id);

    crow::request request;
    request.body = R"({"username":"b43-local-login","password":"correct-password"})";
    CHECK(router.handle_login(request).code == 401);

    conn = pool.acquire_connection();
    pqxx::work cleanup(*conn);
    cleanup.exec("DELETE FROM users WHERE id=$1", pqxx::params{user_id});
    cleanup.commit();
}

TEST_CASE("B.43 soft-deleted local user loses all token authority", "[b43][auth]") {
    DatabasePool pool(2, get_secure_conn_string());
    MockEmailService email;
    AuthService auth("b43-pepper", "b43-secret", &email);
    auth.set_database_pool(pool);
    UsersManager users(pool);
    const std::string username = "b43-token-authority";

    auto conn = pool.acquire_connection();
    pqxx::work txn(*conn);
    txn.exec("DELETE FROM users WHERE username=$1", pqxx::params{username});
    const auto user_id = txn.exec(
        "INSERT INTO users(username,email,password_hash,is_email_verified) VALUES($1,$2,$3,TRUE) RETURNING id",
        pqxx::params{username, username + "@test.com", auth.hash_password("password")})[0][0].as<uint64_t>();
    txn.commit();

    const auto token = auth.generate_token(user_id);
    REQUIRE(auth.verify_token(token) == std::optional<uint64_t>(user_id));

    users.delete_user(user_id);

    CHECK(auth.verify_token(token) == std::nullopt);
    CHECK(auth.refresh_token(token) == std::nullopt);
    try {
        (void)auth.generate_token(user_id);
        FAIL("deleted local account unexpectedly issued a token");
    } catch (const std::runtime_error& error) {
        CHECK(std::string(error.what()) == "AUTH_USER_UNAVAILABLE");
    }

    conn = pool.acquire_connection();
    pqxx::work cleanup(*conn);
    cleanup.exec("DELETE FROM users WHERE id=$1", pqxx::params{user_id});
    cleanup.commit();
}

TEST_CASE("B.43 OAuth tombstone cannot issue a JWT", "[b43][auth]") {
    DatabasePool pool(2, get_secure_conn_string());
    UsersManager users(pool);
    const std::string email = "b43-oauth-tombstone@test.com";
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE email=$1", pqxx::params{email});
        txn.commit();
    }
    const auto user_id = users.create_oauth_user(email, "google", "b43-provider-id", "B43");
    users.delete_user(user_id);

    AuthService auth("b43-pepper", "b43-secret", static_cast<EmailService*>(nullptr));
    auth.set_database_pool(pool);
    try {
        (void)auth.generate_token(user_id);
        FAIL("deleted OAuth account unexpectedly issued a token");
    } catch (const std::runtime_error& error) {
        CHECK(std::string(error.what()) == "AUTH_USER_UNAVAILABLE");
    }

    auto conn = pool.acquire_connection();
    pqxx::work cleanup(*conn);
    cleanup.exec("DELETE FROM users WHERE id=$1", pqxx::params{user_id});
    cleanup.commit();
}

TEST_CASE("B.43 deleted OAuth identity cannot regain authenticated authority", "[b43][auth]") {
    DatabasePool pool(2, get_secure_conn_string());
    UsersManager users(pool);
    const std::string email = "b43-oauth-reentry@test.com";
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE email=$1", pqxx::params{email});
        txn.commit();
    }

    const auto original_id = users.create_oauth_user(email, "google", "b43-provider-reentry", "B43");
    users.delete_user(original_id);
    const auto reentry_id = users.create_oauth_user(email, "google", "b43-provider-reentry", "B43");
    CHECK(reentry_id == original_id);

    AuthService auth("b43-pepper", "b43-secret", static_cast<EmailService*>(nullptr));
    auth.set_database_pool(pool);
    try {
        (void)auth.generate_token(reentry_id);
        FAIL("deleted OAuth identity unexpectedly regained authority");
    } catch (const std::runtime_error& error) {
        CHECK(std::string(error.what()) == "AUTH_USER_UNAVAILABLE");
    }

    auto conn = pool.acquire_connection();
    pqxx::work cleanup(*conn);
    cleanup.exec("DELETE FROM users WHERE id=$1", pqxx::params{original_id});
    cleanup.commit();
}

TEST_CASE("B.43 terminal account deletion invalidates exact Google storage caches", "[b43][gc][service][googledrive]") {
    set_test_environment("GOOGLE_CLIENT_ID", "mock_client_id");
    set_test_environment("GOOGLE_CLIENT_SECRET", "mock_client_secret");
    B43Fixture fixture("cache-invalidation");

    const auto linked = fixture.gdrive.link_account(
        fixture.user_id, "valid_auth_code_123", fixture.gdrive.generate_test_state(fixture.user_id));
    CHECK(linked.root_folder_id == fixture.gdrive.mock_root_folder_id);
    const auto storage_id = fixture.gdrive.get_linked_accounts(fixture.user_id).at(0).id;
    fixture.gdrive.expect_refresh = true;
    REQUIRE(fixture.gdrive.get_access_token_for_storage(storage_id) == fixture.gdrive.mock_access_token);

    fixture.soft_delete();
    fixture.gc.run_cleanup();

    std::string error;
    try {
        (void)fixture.gdrive.get_access_token_for_storage(storage_id);
    } catch (const std::runtime_error& exception) {
        error = exception.what();
    }
    CHECK(error == "STORAGE_NOT_FOUND");
}

TEST_CASE("B.43 account deletion triggers the existing GC scheduler", "[b43][api][auth]") {
    DatabasePool pool(2, get_secure_conn_string());
    MockEmailService email;
    AuthService auth("b43-pepper", "b43-secret", &email);
    FolderManager folder_mgr(pool);
    int trigger_count = 0;
    ApiRouter router(pool, auth, folder_mgr, nullptr, nullptr, nullptr, [&] { ++trigger_count; });

    const std::string username = "b43-trigger";
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username=$1", pqxx::params{username});
        txn.exec(
            "INSERT INTO users(username,email,password_hash,is_email_verified) VALUES($1,$2,$3,TRUE)",
            pqxx::params{username, username + "@test.com", auth.hash_password("password")});
        txn.commit();
    }
    const auto token = auth.generate_token(
        [&] {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            const auto id = txn.exec("SELECT id FROM users WHERE username=$1", pqxx::params{username})[0][0].as<uint64_t>();
            txn.commit();
            return id;
        }());

    crow::request request;
    request.add_header("Authorization", "Bearer " + token);
    const auto response = router.handle_delete_user(request);
    CHECK(response.code == 200);
    CHECK(trigger_count == 1);

    auto conn = pool.acquire_connection();
    pqxx::work cleanup(*conn);
    cleanup.exec("DELETE FROM users WHERE username=$1", pqxx::params{username});
    cleanup.commit();
}
