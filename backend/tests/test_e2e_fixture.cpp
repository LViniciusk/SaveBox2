#include "e2e_fixture_support.hpp"

#include "Services/AuthService.hpp"
#include "Services/EmailService.hpp"
#include "database/DatabasePool.hpp"
#include "test_helpers.hpp"

#include <catch2/catch_test_macros.hpp>
#include <pqxx/pqxx>

#include <chrono>
#include <filesystem>
#include <fstream>
#include <random>
#include <stdexcept>
#include <string>

namespace {

std::string unique_fixture_name(const char* label) {
    return std::string("nanika_e2e_") + label + "_" + std::to_string(
        std::chrono::steady_clock::now().time_since_epoch().count());
}

struct TempStorage {
    std::filesystem::path path;
    std::string identity;
};

TempStorage make_temp_storage(const char* label) {
    const auto path = std::filesystem::temp_directory_path() / unique_fixture_name(label);
    std::filesystem::create_directories(path);
    std::random_device random;
    constexpr char digits[] = "0123456789abcdef";
    std::string identity(64, '0');
    for (auto& digit : identity) digit = digits[random() & 0x0f];
    std::ofstream marker(path / ".nanika-e2e-storage-id", std::ios::binary);
    marker << identity;
    marker.close();
    return {path, identity};
}

struct CleanupGuard {
    DatabasePool& pool;
    std::string username;
    TempStorage storage;
    bool active = true;

    ~CleanupGuard() {
        if (active) {
            try {
                NanikaE2eFixture::cleanup_user(pool, username, storage.path.string(), storage.identity);
            } catch (...) {
            }
        }
    }
};

uint64_t insert_user(pqxx::work& transaction, const std::string& username) {
    const auto result = transaction.exec(
        "INSERT INTO users (username, email, password_hash, is_email_verified) "
        "VALUES ($1, $2, 'fixture-hash', TRUE) RETURNING id",
        pqxx::params{username, username + "@example.test"});
    return result[0][0].as<uint64_t>();
}

uint64_t insert_file(pqxx::work& transaction, uint64_t user_id, const char* name) {
    const auto result = transaction.exec(
        "INSERT INTO files (user_id, encrypted_name, name_hash, encrypted_fdk, size_bytes, is_upload_complete) "
        "VALUES ($1, $2, $3, 'fixture-fdk', 4, TRUE) RETURNING id",
        pqxx::params{user_id, name, std::string(name) + "-hash"});
    return result[0][0].as<uint64_t>();
}

void write_canonical_file(const std::filesystem::path& storage, uint64_t file_id) {
    std::ofstream output(storage / (std::to_string(file_id) + ".dat"), std::ios::binary);
    output << "data";
}

}

TEST_CASE("E2E fixture only accepts isolated usernames", "[e2e-fixture]") {
    REQUIRE_FALSE(NanikaE2eFixture::is_safe_username("alice"));
    REQUIRE_FALSE(NanikaE2eFixture::is_safe_username("nanika_e2e_"));
    REQUIRE_FALSE(NanikaE2eFixture::is_safe_username("nanika_e2e_bad/name"));
    REQUIRE(NanikaE2eFixture::is_safe_username("nanika_e2e_run_123"));
}

TEST_CASE("E2E fixture errors expose safe stable codes", "[e2e-fixture]") {
    REQUIRE(std::string(NanikaE2eFixture::error_code(NanikaE2eFixture::ErrorCode::guard_disabled)) ==
            "FIXTURE_GUARD_DISABLED");

    const auto storage = make_temp_storage("invalid-identity");
    try {
        NanikaE2eFixture::require_storage_identity(storage.path.string(), "not-an-identity");
        FAIL("Expected invalid fixture storage identity.");
    } catch (const NanikaE2eFixture::FixtureError& error) {
        REQUIRE(std::string(error.what()) == "FIXTURE_STORAGE_IDENTITY_INVALID");
    }
    std::filesystem::remove_all(storage.path);

    DatabasePool unused_pool(0, "");
    try {
        NanikaE2eFixture::cleanup_user(unused_pool, "not_fixture_user", "", "");
        FAIL("Expected invalid fixture username.");
    } catch (const NanikaE2eFixture::FixtureError& error) {
        REQUIRE(std::string(error.what()) == "FIXTURE_USERNAME_INVALID");
    }

    const auto internal = std::make_exception_ptr(std::runtime_error("SECRET_SENTINEL"));
    const std::string public_code = NanikaE2eFixture::public_error_code(internal);
    REQUIRE(public_code == "FIXTURE_INTERNAL_ERROR");
    REQUIRE(public_code.find("SECRET_SENTINEL") == std::string::npos);
}

TEST_CASE("E2E fixture accepts only isolated database names", "[e2e-fixture]") {
    REQUIRE(NanikaE2eFixture::is_safe_database_name("nanika_e2e"));
    REQUIRE(NanikaE2eFixture::is_safe_database_name("nanika_e2e_m6"));
    REQUIRE_FALSE(NanikaE2eFixture::is_safe_database_name("nanika"));
    REQUIRE_FALSE(NanikaE2eFixture::is_safe_database_name("nanika_prod"));
    REQUIRE_FALSE(NanikaE2eFixture::is_safe_database_name("nanika_e2e_bad-name"));
}

TEST_CASE("E2E fixture password preparation uses the production hash verifier", "[e2e-fixture]") {
    EmailService email_service("", "");
    AuthService auth("fixture-pepper", "fixture-jwt-secret", &email_service);
    const auto password_hash = auth.hash_password("fixture-password");

    REQUIRE(auth.verify_password("fixture-password", password_hash));
    REQUIRE_FALSE(auth.verify_password("different-password", password_hash));
}

TEST_CASE("E2E fixture cleanup is idempotent for missing users", "[e2e-fixture]") {
    DatabasePool pool(2, get_secure_conn_string());
    const auto storage = make_temp_storage("missing");
    const auto username = unique_fixture_name("missing");

    REQUIRE_NOTHROW(NanikaE2eFixture::cleanup_user(pool, username, storage.path.string(), storage.identity));
    REQUIRE_NOTHROW(NanikaE2eFixture::cleanup_user(pool, username, storage.path.string(), storage.identity));

    std::filesystem::remove_all(storage.path);
}

TEST_CASE("E2E fixture cleanup rejects a storage root that misses the owned file", "[e2e-fixture]") {
    DatabasePool pool(2, get_secure_conn_string());
    const auto backend_storage = make_temp_storage("backend-storage");
    const auto fixture_storage = make_temp_storage("fixture-storage");
    const auto username = unique_fixture_name("storage-mismatch");

    uint64_t file_id = 0;
    {
        auto connection = pool.acquire_connection();
        pqxx::work transaction(*connection);
        const auto user_id = insert_user(transaction, username);
        file_id = insert_file(transaction, user_id, "mismatch-file");
        transaction.commit();
    }
    write_canonical_file(backend_storage.path, file_id);

    CHECK_THROWS(NanikaE2eFixture::cleanup_user(
        pool, username, fixture_storage.path.string(), backend_storage.identity));
    CHECK(std::filesystem::exists(backend_storage.path / (std::to_string(file_id) + ".dat")));
    {
        auto connection = pool.acquire_connection();
        pqxx::read_transaction read(*connection);
        CHECK(read.exec("SELECT COUNT(*) FROM users WHERE username = $1", pqxx::params{username})[0][0].as<int>() == 1);
    }

    NanikaE2eFixture::cleanup_user(
        pool, username, backend_storage.path.string(), backend_storage.identity);
    CHECK_FALSE(std::filesystem::exists(backend_storage.path / (std::to_string(file_id) + ".dat")));
    std::filesystem::remove_all(backend_storage.path);
    std::filesystem::remove_all(fixture_storage.path);
}

TEST_CASE("E2E fixture preserves database ownership when storage deletion cannot complete", "[e2e-fixture]") {
    DatabasePool pool(2, get_secure_conn_string());
    const auto storage = make_temp_storage("storage-failure");
    const auto username = unique_fixture_name("storage-failure");
    uint64_t file_id = 0;
    {
        auto connection = pool.acquire_connection();
        pqxx::work transaction(*connection);
        const auto user_id = insert_user(transaction, username);
        file_id = insert_file(transaction, user_id, "unremovable-file");
        transaction.commit();
    }
    const auto artifact = storage.path / (std::to_string(file_id) + ".dat");
    std::filesystem::create_directory(artifact);
    std::ofstream(artifact / "owned-child") << "preserve";

    CHECK_THROWS(NanikaE2eFixture::cleanup_user(pool, username, storage.path.string(), storage.identity));
    CHECK(std::filesystem::exists(artifact / "owned-child"));
    {
        auto connection = pool.acquire_connection();
        pqxx::read_transaction read(*connection);
        CHECK(read.exec("SELECT COUNT(*) FROM users WHERE username = $1", pqxx::params{username})[0][0].as<int>() == 1);
    }

    std::filesystem::remove_all(artifact);
    NanikaE2eFixture::cleanup_user(pool, username, storage.path.string(), storage.identity);
    std::filesystem::remove_all(storage.path);
}

TEST_CASE("E2E fixture cleanup isolates target user and canonical bytes", "[e2e-fixture]") {
    DatabasePool pool(2, get_secure_conn_string());
    const auto storage = make_temp_storage("isolation");
    const auto target_username = unique_fixture_name("target");
    const auto control_username = unique_fixture_name("control");
    CleanupGuard target_guard{pool, target_username, storage};
    CleanupGuard control_guard{pool, control_username, storage};

    uint64_t target_file_id = 0;
    uint64_t control_file_id = 0;
    {
        auto connection = pool.acquire_connection();
        pqxx::work transaction(*connection);
        const auto target_user_id = insert_user(transaction, target_username);
        const auto control_user_id = insert_user(transaction, control_username);
        target_file_id = insert_file(transaction, target_user_id, "target-file");
        control_file_id = insert_file(transaction, control_user_id, "control-file");
        transaction.commit();
    }

    write_canonical_file(storage.path, target_file_id);
    write_canonical_file(storage.path, control_file_id);

    NanikaE2eFixture::cleanup_user(pool, target_username, storage.path.string(), storage.identity);
    REQUIRE_FALSE(std::filesystem::exists(storage.path / (std::to_string(target_file_id) + ".dat")));
    REQUIRE(std::filesystem::exists(storage.path / (std::to_string(control_file_id) + ".dat")));

    {
        auto connection = pool.acquire_connection();
        pqxx::read_transaction read(*connection);
        REQUIRE(read.exec("SELECT COUNT(*) FROM users WHERE username = $1", pqxx::params{target_username})[0][0].as<int>() == 0);
        REQUIRE(read.exec("SELECT COUNT(*) FROM users WHERE username = $1", pqxx::params{control_username})[0][0].as<int>() == 1);
        REQUIRE(read.exec("SELECT COUNT(*) FROM files WHERE user_id = (SELECT id FROM users WHERE username = $1)", pqxx::params{control_username})[0][0].as<int>() == 1);
    }

    REQUIRE_NOTHROW(NanikaE2eFixture::cleanup_user(
        pool, control_username, storage.path.string(), storage.identity));
    {
        auto connection = pool.acquire_connection();
        pqxx::read_transaction read(*connection);
        REQUIRE(read.exec("SELECT COUNT(*) FROM users WHERE username = $1", pqxx::params{control_username})[0][0].as<int>() == 0);
    }
    REQUIRE_NOTHROW(NanikaE2eFixture::cleanup_user(
        pool, target_username, storage.path.string(), storage.identity));
    REQUIRE_FALSE(std::filesystem::exists(storage.path / (std::to_string(control_file_id) + ".dat")));
    target_guard.active = false;
    control_guard.active = false;
    std::filesystem::remove_all(storage.path);
}
