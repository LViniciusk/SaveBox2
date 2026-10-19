#include <catch2/catch_test_macros.hpp>

#include "controllers/ApiRouter.hpp"
#include "database/DatabasePool.hpp"
#include "database/FileManager.hpp"
#include "database/FolderManager.hpp"
#include "Services/AuthService.hpp"
#include "Services/GoogleDriveService.hpp"
#include "storage/FileChunker.hpp"
#include "test_helpers.hpp"

#include <pqxx/pqxx>

#include <atomic>
#include <chrono>
#include <exception>
#include <string>
#include <thread>

namespace {

struct B50Fixture {
    DatabasePool pool;
    MockGoogleDriveService google;
    FileManager files;
    uint64_t user_id;
    uint64_t storage_id = 0;
    uint64_t file_id = 0;

    explicit B50Fixture(uint64_t id, bool with_file = true, bool unlinking = false,
                        bool complete = false, std::string external_file_id = {})
        : pool(2, get_secure_conn_string()), google(pool), files(pool), user_id(id) {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE id = $1", pqxx::params{user_id});
        txn.exec(
            "INSERT INTO users (id, username, email, password_hash, max_storage_bytes, used_storage_bytes, is_email_verified) "
            "VALUES ($1, $2, $3, 'b50-hash', 104857600, 2048, TRUE)",
            pqxx::params{user_id, "b50_user_" + std::to_string(user_id),
                         "b50_" + std::to_string(user_id) + "@test.com"});
        storage_id = txn.exec(
            "INSERT INTO user_external_storages "
            "(user_id, provider, account_email, refresh_token, root_folder_id, is_unlinking) "
            "VALUES ($1, 'google_drive', $2, 'b50-refresh', 'b50-root', $3) RETURNING id",
            pqxx::params{user_id, "b50_google_" + std::to_string(user_id) + "@test.com", unlinking})[0][0].as<uint64_t>();

        if (with_file) {
            if (external_file_id.empty()) {
                file_id = txn.exec(
                    "INSERT INTO files (user_id, encrypted_name, name_hash, encrypted_fdk, size_bytes, total_chunks, "
                    "is_upload_complete, storage_provider, external_storage_id, external_file_id) "
                    "VALUES ($1, 'b50-cipher', $2, 'b50-fdk', 2048, 1, $3, 'google_drive', $4, NULL) RETURNING id",
                    pqxx::params{user_id, "b50-hash_" + std::to_string(user_id), complete, storage_id})[0][0].as<uint64_t>();
            } else {
                file_id = txn.exec(
                    "INSERT INTO files (user_id, encrypted_name, name_hash, encrypted_fdk, size_bytes, total_chunks, "
                    "is_upload_complete, storage_provider, external_storage_id, external_file_id) "
                    "VALUES ($1, 'b50-cipher', $2, 'b50-fdk', 2048, 1, $3, 'google_drive', $4, $5) RETURNING id",
                    pqxx::params{user_id, "b50-hash_" + std::to_string(user_id), complete, storage_id, external_file_id})[0][0].as<uint64_t>();
            }
        }
        txn.commit();
    }

    ~B50Fixture() {
        try {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            txn.exec("DELETE FROM users WHERE id = $1", pqxx::params{user_id});
            txn.commit();
        } catch (...) {
        }
    }
};

struct B50ApiFixture {
    DatabasePool pool;
    MockEmailService email;
    AuthService auth;
    FolderManager folders;
    FileManager files;
    FileChunker chunker;
    MockGoogleDriveService google;
    ApiRouter router;
    uint64_t user_id;
    std::string token;
    uint64_t storage_id = 0;
    int file_sequence = 0;

    explicit B50ApiFixture(uint64_t id)
        : pool(2, get_secure_conn_string()),
          email(),
          auth("b50-pepper", "b50-secret", &email),
          folders(pool),
          files(pool),
          chunker("./test_storage_b50"),
          google(pool),
          router(pool, auth, folders, &files, &chunker, &google),
          user_id(id),
          token() {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE id = $1", pqxx::params{user_id});
        txn.exec(
            "INSERT INTO users (id, username, email, password_hash, max_storage_bytes, used_storage_bytes, is_email_verified) "
            "VALUES ($1, $2, $3, 'b50-hash', 104857600, 2048, TRUE)",
            pqxx::params{user_id, "b50_api_user_" + std::to_string(user_id),
                         "b50_api_" + std::to_string(user_id) + "@test.com"});
        storage_id = txn.exec(
            "INSERT INTO user_external_storages "
            "(user_id, provider, account_email, refresh_token, root_folder_id) "
            "VALUES ($1, 'google_drive', $2, 'b50-refresh', 'b50-root') RETURNING id",
            pqxx::params{user_id, "b50_api_google_" + std::to_string(user_id) + "@test.com"})[0][0].as<uint64_t>();
        txn.commit();
        token = auth.generate_token(user_id);
    }

    uint64_t add_file(const std::string& provider = "google_drive", bool complete = false,
                      std::optional<uint64_t> external_storage_id = std::nullopt,
                      std::string external_file_id = {}) {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        const auto name_hash = "b50-api-hash-" + std::to_string(user_id) + "-" + std::to_string(++file_sequence);
        const auto storage = provider == "google_drive"
            ? external_storage_id.value_or(storage_id)
            : 0;
        const auto file = external_file_id.empty()
            ? txn.exec(
                "INSERT INTO files (user_id, encrypted_name, name_hash, encrypted_fdk, size_bytes, total_chunks, "
                "is_upload_complete, storage_provider, external_storage_id, external_file_id) "
                "VALUES ($1, $2, $3, 'b50-fdk', 2048, 1, $4, $5, $6, NULL) RETURNING id",
                pqxx::params{user_id, "b50-api-cipher", name_hash, complete,
                             provider, provider == "google_drive" ? std::optional<uint64_t>(storage) : std::nullopt})[0][0].as<uint64_t>()
            : txn.exec(
                "INSERT INTO files (user_id, encrypted_name, name_hash, encrypted_fdk, size_bytes, total_chunks, "
                "is_upload_complete, storage_provider, external_storage_id, external_file_id) "
                "VALUES ($1, $2, $3, 'b50-fdk', 2048, 1, $4, $5, $6, $7) RETURNING id",
                pqxx::params{user_id, "b50-api-cipher", name_hash, complete,
                             provider, provider == "google_drive" ? std::optional<uint64_t>(storage) : std::nullopt,
                             external_file_id})[0][0].as<uint64_t>();
        txn.commit();
        return file;
    }

    ~B50ApiFixture() {
        try {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            txn.exec("DELETE FROM users WHERE id = $1", pqxx::params{user_id});
            txn.commit();
        } catch (...) {
        }
    }
};

bool wait_for_locking_query(const std::string& conn_str, const std::string& query_fragment) {
    pqxx::connection observer_connection(conn_str);
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (std::chrono::steady_clock::now() < deadline) {
        pqxx::nontransaction observer(observer_connection);
        const auto waiting = observer.exec(
            "SELECT 1 FROM pg_stat_activity "
            "WHERE pid <> pg_backend_pid() AND state = 'active' AND wait_event_type = 'Lock' "
            "AND query ILIKE $1 LIMIT 1",
            pqxx::params{"%" + query_fragment + "%"});
        if (!waiting.empty()) return true;
        std::this_thread::yield();
    }
    return false;
}

} // namespace

TEST_CASE("B.50 pending Google upload blocks unlink before mutation", "[service][googledrive][b50][regression]") {
    B50Fixture fixture(95050);

    std::string error;
    try {
        fixture.google.unlink_account(fixture.user_id, fixture.storage_id);
    } catch (const std::exception& exception) {
        error = exception.what();
    }

    auto conn = fixture.pool.acquire_connection();
    pqxx::work txn(*conn);
    const auto storage = txn.exec(
        "SELECT is_unlinking FROM user_external_storages WHERE id = $1",
        pqxx::params{fixture.storage_id})[0][0].as<bool>();
    const auto file_count = txn.exec(
        "SELECT count(*) FROM files WHERE id = $1",
        pqxx::params{fixture.file_id})[0][0].as<int>();
    const auto quota = txn.exec(
        "SELECT used_storage_bytes FROM users WHERE id = $1",
        pqxx::params{fixture.user_id})[0][0].as<uint64_t>();
    const auto pending_deletions = txn.exec(
        "SELECT count(*) FROM pending_external_deletions WHERE external_storage_id = $1",
        pqxx::params{fixture.storage_id})[0][0].as<int>();
    txn.commit();

    REQUIRE(error == "ACCOUNT_HAS_PENDING_UPLOADS");
    REQUIRE_FALSE(storage);
    REQUIRE(file_count == 1);
    REQUIRE(quota == 2048);
    REQUIRE(pending_deletions == 0);
}

TEST_CASE("B.50 finalize cannot report success after the file disappears",
          "[api][googledrive][b50][race][regression]") {
    B50ApiFixture fixture(95051);
    const auto file_id = fixture.add_file();
    const auto conn_str = get_secure_conn_string();

    pqxx::connection blocker_connection(conn_str);
    pqxx::work blocker(blocker_connection);
    REQUIRE_FALSE(blocker.exec(
        "SELECT id FROM files WHERE id = $1 FOR UPDATE",
        pqxx::params{file_id}).empty());

    std::exception_ptr delete_error;
    std::thread deleter([&] {
        try {
            pqxx::connection connection(conn_str);
            pqxx::work txn(connection);
            txn.exec("DELETE FROM files WHERE id = $1", pqxx::params{file_id});
            txn.commit();
        } catch (...) {
            delete_error = std::current_exception();
        }
    });

    const bool delete_waiting = wait_for_locking_query(conn_str, "DELETE FROM files");

    int finalize_code = 0;
    std::string finalize_body;
    std::thread finalizer([&] {
        crow::request request;
        request.url = "/files/" + std::to_string(file_id) + "/finalize-external";
        request.add_header("Authorization", "Bearer " + fixture.token);
        request.body = R"({"external_file_id":"b50-pre-remote"})";
        const auto response = fixture.router.handle_finalize_external_upload(request, static_cast<int>(file_id));
        finalize_code = response.code;
        finalize_body = response.body;
    });

    const bool finalize_waiting = wait_for_locking_query(conn_str, "UPDATE files SET external_file_id");
    blocker.commit();
    deleter.join();
    finalizer.join();

    REQUIRE(delete_waiting);
    REQUIRE(finalize_waiting);
    REQUIRE_FALSE(delete_error);
    REQUIRE(finalize_code == 409);
    REQUIRE(finalize_body.find("EXTERNAL_UPLOAD_FINALIZE_CONFLICT") != std::string::npos);
}

TEST_CASE("B.50 API finalize persists identity and rejects duplicate finalize",
          "[api][googledrive][b50][finalize][regression]") {
    B50ApiFixture fixture(95052);
    const auto file_id = fixture.add_file();

    crow::request request;
    request.url = "/files/" + std::to_string(file_id) + "/finalize-external";
    request.add_header("Authorization", "Bearer " + fixture.token);
    request.body = R"({"external_file_id":"b50-remote-success"})";

    REQUIRE(fixture.router.handle_finalize_external_upload(request, static_cast<int>(file_id)).code == 200);
    REQUIRE(fixture.router.handle_finalize_external_upload(request, static_cast<int>(file_id)).code == 409);
    REQUIRE(fixture.google.refresh_requests.load() == 0);

    auto conn = fixture.pool.acquire_connection();
    pqxx::work txn(*conn);
    const auto state = txn.exec(
        "SELECT external_file_id, is_upload_complete FROM files WHERE id = $1",
        pqxx::params{file_id})[0];
    REQUIRE(state[0].as<std::string>() == "b50-remote-success");
    REQUIRE(state[1].as<bool>());
    txn.commit();
}

TEST_CASE("B.50 API finalize preserves closed error contracts",
          "[api][googledrive][b50][finalize][regression]") {
    B50ApiFixture fixture(95053);
    const auto local_file = fixture.add_file("local");
    const auto missing_storage_file = fixture.add_file();

    auto finalize_request = [&](uint64_t file_id, const std::string& body) {
        crow::request request;
        request.url = "/files/" + std::to_string(file_id) + "/finalize-external";
        request.add_header("Authorization", "Bearer " + fixture.token);
        request.body = body;
        return fixture.router.handle_finalize_external_upload(request, static_cast<int>(file_id));
    };

    REQUIRE(finalize_request(local_file, R"({"external_file_id":"b50-local"})").code == 400);
    {
        auto conn = fixture.pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("UPDATE files SET external_storage_id = NULL WHERE id = $1", pqxx::params{missing_storage_file});
        txn.commit();
    }
    REQUIRE(finalize_request(missing_storage_file, R"({"external_file_id":"b50-no-storage"})").code == 409);
    REQUIRE(finalize_request(missing_storage_file, "{}").code == 400);

    const auto unlinking_file = fixture.add_file();
    {
        auto conn = fixture.pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("UPDATE user_external_storages SET is_unlinking = TRUE WHERE id = $1",
                 pqxx::params{fixture.storage_id});
        txn.commit();
    }
    REQUIRE(finalize_request(unlinking_file, R"({"external_file_id":"b50-unlinking"})").code == 409);

    const uint64_t foreign_user = 95063;
    uint64_t foreign_file = 0;
    {
        auto conn = fixture.pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec(
            "INSERT INTO users (id, username, email, password_hash, max_storage_bytes, is_email_verified) "
            "VALUES ($1, 'b50-foreign', 'b50-foreign@test.com', 'b50-hash', 104857600, TRUE)",
            pqxx::params{foreign_user});
        const auto foreign_storage = txn.exec(
            "INSERT INTO user_external_storages (user_id, provider, account_email, refresh_token, root_folder_id) "
            "VALUES ($1, 'google_drive', 'b50-foreign-google@test.com', 'b50-refresh', 'b50-root') RETURNING id",
            pqxx::params{foreign_user})[0][0].as<uint64_t>();
        foreign_file = txn.exec(
            "INSERT INTO files (user_id, encrypted_name, name_hash, encrypted_fdk, size_bytes, total_chunks, "
            "is_upload_complete, storage_provider, external_storage_id) "
            "VALUES ($1, 'b50-foreign-cipher', 'b50-foreign-hash', 'b50-fdk', 2048, 1, FALSE, 'google_drive', $2) RETURNING id",
            pqxx::params{foreign_user, foreign_storage})[0][0].as<uint64_t>();
        txn.commit();
    }
    REQUIRE(finalize_request(foreign_file, R"({"external_file_id":"b50-foreign-id"})").code == 403);
    {
        auto conn = fixture.pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE id = $1", pqxx::params{foreign_user});
        txn.commit();
    }
}

TEST_CASE("B.50 pending unlink is rejected without mutation through the API",
          "[api][googledrive][b50][unlink][regression]") {
    B50ApiFixture fixture(95054);
    const auto file_id = fixture.add_file();
    crow::request request;
    request.url = "/api/storage/google/accounts/" + std::to_string(fixture.storage_id);
    request.add_header("Authorization", "Bearer " + fixture.token);

    const auto response = fixture.router.handle_unlink_google_account(
        request, static_cast<int>(fixture.storage_id));
    REQUIRE(response.code == 409);
    REQUIRE(response.body.find("ACCOUNT_HAS_PENDING_UPLOADS") != std::string::npos);

    auto conn = fixture.pool.acquire_connection();
    pqxx::work txn(*conn);
    REQUIRE_FALSE(txn.exec(
        "SELECT is_unlinking FROM user_external_storages WHERE id = $1",
        pqxx::params{fixture.storage_id})[0][0].as<bool>());
    REQUIRE(txn.exec("SELECT count(*) FROM files WHERE id = $1", pqxx::params{file_id})[0][0].as<int>() == 1);
    REQUIRE(txn.exec("SELECT used_storage_bytes FROM users WHERE id = $1", pqxx::params{fixture.user_id})[0][0].as<uint64_t>() == 2048);
    REQUIRE(txn.exec(
        "SELECT count(*) FROM pending_external_deletions WHERE external_storage_id = $1",
        pqxx::params{fixture.storage_id})[0][0].as<int>() == 0);
    txn.commit();
}

TEST_CASE("B.50 tombstoned pending Google upload still blocks unlink",
          "[service][googledrive][b50][unlink][regression]") {
    B50Fixture fixture(950541);
    {
        auto conn = fixture.pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("UPDATE files SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1", pqxx::params{fixture.file_id});
        txn.commit();
    }

    std::string error;
    try {
        fixture.google.unlink_account(fixture.user_id, fixture.storage_id);
    } catch (const std::exception& exception) {
        error = exception.what();
    }
    REQUIRE(error == "ACCOUNT_HAS_PENDING_UPLOADS");

    auto conn = fixture.pool.acquire_connection();
    pqxx::read_transaction txn(*conn);
    REQUIRE_FALSE(txn.exec(
        "SELECT is_unlinking FROM user_external_storages WHERE id=$1",
        pqxx::params{fixture.storage_id})[0][0].as<bool>());
    REQUIRE(txn.exec("SELECT count(*) FROM files WHERE id=$1", pqxx::params{fixture.file_id})[0][0].as<int>() == 1);
}

TEST_CASE("B.50 finalize then unlink preserves exact cleanup identity",
          "[service][googledrive][b50][unlink][regression]") {
    B50Fixture fixture(95055);
    fixture.files.finalize_external_upload(fixture.file_id, fixture.user_id, "b50-cleanup-id");
    fixture.google.unlink_account(fixture.user_id, fixture.storage_id);

    auto conn = fixture.pool.acquire_connection();
    pqxx::work txn(*conn);
    REQUIRE(txn.exec("SELECT count(*) FROM files WHERE id = $1", pqxx::params{fixture.file_id})[0][0].as<int>() == 0);
    const auto pending = txn.exec(
        "SELECT external_file_id, external_storage_id FROM pending_external_deletions WHERE external_storage_id = $1",
        pqxx::params{fixture.storage_id});
    REQUIRE(pending.size() == 1);
    REQUIRE(pending[0][0].as<std::string>() == "b50-cleanup-id");
    REQUIRE(pending[0][1].as<uint64_t>() == fixture.storage_id);
    REQUIRE(txn.exec("SELECT is_unlinking FROM user_external_storages WHERE id = $1", pqxx::params{fixture.storage_id})[0][0].as<bool>());
    REQUIRE(txn.exec("SELECT used_storage_bytes FROM users WHERE id = $1", pqxx::params{fixture.user_id})[0][0].as<uint64_t>() == 0);
    txn.commit();
}

TEST_CASE("B.50 rejected unlink can converge through finalize and retry",
          "[service][googledrive][b50][unlink][regression]") {
    B50Fixture fixture(95056);
    std::string error;
    try {
        fixture.google.unlink_account(fixture.user_id, fixture.storage_id);
    } catch (const std::exception& exception) {
        error = exception.what();
    }
    REQUIRE(error == "ACCOUNT_HAS_PENDING_UPLOADS");

    fixture.files.finalize_external_upload(fixture.file_id, fixture.user_id, "b50-retry-id");
    REQUIRE_NOTHROW(fixture.google.unlink_account(fixture.user_id, fixture.storage_id));

    auto conn = fixture.pool.acquire_connection();
    pqxx::work txn(*conn);
    REQUIRE(txn.exec("SELECT count(*) FROM files WHERE id = $1", pqxx::params{fixture.file_id})[0][0].as<int>() == 0);
    REQUIRE(txn.exec(
        "SELECT count(*) FROM pending_external_deletions WHERE external_file_id = $1 AND external_storage_id = $2",
        pqxx::params{"b50-retry-id", fixture.storage_id})[0][0].as<int>() == 1);
    txn.commit();
}

TEST_CASE("B.50 unlink-all is atomic and scoped to pending Google uploads",
          "[service][googledrive][b50][unlink][regression]") {
    B50Fixture fixture(95057);
    uint64_t second_storage_id = 0;
    {
        auto conn = fixture.pool.acquire_connection();
        pqxx::work txn(*conn);
        second_storage_id = txn.exec(
            "INSERT INTO user_external_storages (user_id, provider, account_email, refresh_token, root_folder_id) "
            "VALUES ($1, 'google_drive', 'b50-second@test.com', 'b50-refresh-2', 'b50-root-2') RETURNING id",
            pqxx::params{fixture.user_id})[0][0].as<uint64_t>();
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
    REQUIRE_FALSE(txn.exec("SELECT is_unlinking FROM user_external_storages WHERE id = $1", pqxx::params{fixture.storage_id})[0][0].as<bool>());
    REQUIRE_FALSE(txn.exec("SELECT is_unlinking FROM user_external_storages WHERE id = $1", pqxx::params{second_storage_id})[0][0].as<bool>());
    REQUIRE(txn.exec("SELECT count(*) FROM files WHERE id = $1", pqxx::params{fixture.file_id})[0][0].as<int>() == 1);
    REQUIRE(txn.exec("SELECT used_storage_bytes FROM users WHERE id = $1", pqxx::params{fixture.user_id})[0][0].as<uint64_t>() == 2048);
    txn.commit();
}

TEST_CASE("B.50 unlink blocker ignores completed files and unrelated storage",
          "[service][googledrive][b50][unlink][regression]") {
    B50Fixture completed(95058, true, false, true, "b50-complete-id");
    REQUIRE_NOTHROW(completed.google.unlink_account(completed.user_id, completed.storage_id));

    B50Fixture pending(95059);
    uint64_t second_storage_id = 0;
    {
        auto conn = pending.pool.acquire_connection();
        pqxx::work txn(*conn);
        second_storage_id = txn.exec(
            "INSERT INTO user_external_storages (user_id, provider, account_email, refresh_token, root_folder_id) "
            "VALUES ($1, 'google_drive', 'b50-unrelated@test.com', 'b50-refresh-2', 'b50-root-2') RETURNING id",
            pqxx::params{pending.user_id})[0][0].as<uint64_t>();
        txn.commit();
    }
    REQUIRE_NOTHROW(pending.google.unlink_account(pending.user_id, second_storage_id));

    auto conn = pending.pool.acquire_connection();
    pqxx::work txn(*conn);
    REQUIRE_FALSE(txn.exec("SELECT is_unlinking FROM user_external_storages WHERE id = $1", pqxx::params{pending.storage_id})[0][0].as<bool>());
    REQUIRE(txn.exec("SELECT is_unlinking FROM user_external_storages WHERE id = $1", pqxx::params{second_storage_id})[0][0].as<bool>());
    REQUIRE(txn.exec("SELECT count(*) FROM files WHERE id = $1", pqxx::params{pending.file_id})[0][0].as<int>() == 1);
    txn.commit();
}

TEST_CASE("B.50 pending local and another user do not block Google unlink",
          "[service][googledrive][b50][unlink][regression]") {
    B50Fixture fixture(95064, false);
    const uint64_t other_user = 95065;
    const uint64_t unrelated_user = 95066;
    uint64_t other_storage = 0;
    uint64_t unrelated_storage = 0;
    {
        auto conn = fixture.pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE id IN ($1, $2)", pqxx::params{other_user, unrelated_user});
        txn.exec(
            "INSERT INTO files (user_id, encrypted_name, name_hash, encrypted_fdk, size_bytes, total_chunks, "
            "is_upload_complete, storage_provider) VALUES ($1, 'b50-local', 'b50-local-hash', 'b50-fdk', 2048, 1, FALSE, 'local')",
            pqxx::params{fixture.user_id});
        txn.exec(
            "INSERT INTO users (id, username, email, password_hash, max_storage_bytes, is_email_verified) "
            "VALUES ($1, 'b50-other', 'b50-other@test.com', 'b50-hash', 104857600, TRUE)",
            pqxx::params{other_user});
        other_storage = txn.exec(
            "INSERT INTO user_external_storages (user_id, provider, account_email, refresh_token, root_folder_id) "
            "VALUES ($1, 'google_drive', 'b50-other-google@test.com', 'b50-refresh', 'b50-root') RETURNING id",
            pqxx::params{other_user})[0][0].as<uint64_t>();
        txn.exec(
            "INSERT INTO files (user_id, encrypted_name, name_hash, encrypted_fdk, size_bytes, total_chunks, "
            "is_upload_complete, storage_provider, external_storage_id) "
            "VALUES ($1, 'b50-other-pending', 'b50-other-pending-hash', 'b50-fdk', 2048, 1, FALSE, 'google_drive', $2)",
            pqxx::params{other_user, other_storage});
        txn.exec(
            "INSERT INTO users (id, username, email, password_hash, max_storage_bytes, is_email_verified) "
            "VALUES ($1, 'b50-unrelated', 'b50-unrelated@test.com', 'b50-hash', 104857600, TRUE)",
            pqxx::params{unrelated_user});
        unrelated_storage = txn.exec(
            "INSERT INTO user_external_storages (user_id, provider, account_email, refresh_token, root_folder_id) "
            "VALUES ($1, 'google_drive', 'b50-unrelated-google@test.com', 'b50-refresh', 'b50-root') RETURNING id",
            pqxx::params{unrelated_user})[0][0].as<uint64_t>();
        txn.commit();
    }

    REQUIRE_NOTHROW(fixture.google.unlink_account(fixture.user_id, fixture.storage_id));
    REQUIRE_NOTHROW(fixture.google.unlink_account(unrelated_user, unrelated_storage));

    auto conn = fixture.pool.acquire_connection();
    pqxx::work txn(*conn);
    REQUIRE(txn.exec("SELECT count(*) FROM files WHERE user_id = $1 AND storage_provider = 'local'", pqxx::params{fixture.user_id})[0][0].as<int>() == 1);
    REQUIRE(txn.exec("SELECT count(*) FROM files WHERE user_id = $1", pqxx::params{other_user})[0][0].as<int>() == 1);
    txn.exec("DELETE FROM users WHERE id IN ($1, $2)", pqxx::params{other_user, unrelated_user});
    txn.commit();
}
