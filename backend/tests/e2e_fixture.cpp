#include "e2e_fixture_support.hpp"

#include "Services/AuthService.hpp"
#include "Services/EmailService.hpp"
#include "database/DatabasePool.hpp"
#include "utils.hpp"

#include <nlohmann/json.hpp>
#include <pqxx/pqxx>

#include <cstdlib>
#include <iostream>
#include <string>
#include <vector>

namespace {

using Json = nlohmann::json;
constexpr const char* STORAGE_IDENTITY_ENV = "NANIKA_E2E_STORAGE_ID";
constexpr const char* STORAGE_PATH_ENV = "NANIKA_E2E_STORAGE_PATH";

struct FixtureStorage {
    std::string path;
    std::string identity;
};

std::string read_stdin() {
    return std::string(std::istreambuf_iterator<char>(std::cin), std::istreambuf_iterator<char>());
}

std::string required_string(const Json& payload, const char* key) {
    if (!payload.is_object() || !payload.contains(key) || !payload.at(key).is_string()) {
        throw NanikaE2eFixture::FixtureError(NanikaE2eFixture::ErrorCode::input_invalid);
    }
    const auto value = payload.at(key).get<std::string>();
    if (value.empty() || value.size() > 16 * 1024) {
        throw NanikaE2eFixture::FixtureError(NanikaE2eFixture::ErrorCode::input_invalid);
    }
    return value;
}

FixtureStorage require_fixture_guard() {
    const char* enabled = std::getenv("NANIKA_E2E_FIXTURE");
    if (!enabled || std::string_view(enabled) != "1") {
        throw NanikaE2eFixture::FixtureError(NanikaE2eFixture::ErrorCode::guard_disabled);
    }

    std::string database_name;
    try {
        database_name = Utils::get().get_required_var("DB_NAME");
    } catch (...) {
        throw NanikaE2eFixture::FixtureError(NanikaE2eFixture::ErrorCode::config_missing);
    }
    if (!NanikaE2eFixture::is_safe_database_name(database_name)) {
        throw NanikaE2eFixture::FixtureError(NanikaE2eFixture::ErrorCode::database_not_isolated);
    }

    const char* path = std::getenv(STORAGE_PATH_ENV);
    const char* identity = std::getenv(STORAGE_IDENTITY_ENV);
    if (!path || !identity) {
        throw NanikaE2eFixture::FixtureError(NanikaE2eFixture::ErrorCode::storage_not_configured);
    }

    FixtureStorage storage{path, identity};
    NanikaE2eFixture::require_storage_identity(storage.path, storage.identity);
    return storage;
}

void validate_username(const std::string& username) {
    if (!NanikaE2eFixture::is_safe_username(username)) {
        throw NanikaE2eFixture::FixtureError(NanikaE2eFixture::ErrorCode::username_invalid);
    }
}

DatabasePool make_pool() {
    std::string connection_string;
    try {
        connection_string = DotEnv::get_secure_conn_string();
    } catch (...) {
        throw NanikaE2eFixture::FixtureError(NanikaE2eFixture::ErrorCode::config_missing);
    }
    try {
        return DatabasePool(2, connection_string);
    } catch (...) {
        throw NanikaE2eFixture::FixtureError(NanikaE2eFixture::ErrorCode::db_operation_failed);
    }
}

void provision(const Json& payload) {
    const auto username = required_string(payload, "username");
    const auto email = required_string(payload, "email");
    const auto password = required_string(payload, "password");
    validate_username(username);

    auto pool = make_pool();
    std::string pepper;
    std::string jwt_secret;
    try {
        pepper = DotEnv::get_pepper();
        jwt_secret = DotEnv::get_jwt_secret();
    } catch (...) {
        throw NanikaE2eFixture::FixtureError(NanikaE2eFixture::ErrorCode::config_missing);
    }

    std::string password_hash;
    try {
        EmailService email_service("", "");
        AuthService auth(pepper, jwt_secret, &email_service);
        password_hash = auth.hash_password(password);
    } catch (...) {
        throw NanikaE2eFixture::FixtureError(NanikaE2eFixture::ErrorCode::password_hash_failed);
    }

    uint64_t user_id = 0;
    try {
        auto connection = pool.acquire_connection();
        pqxx::work transaction(*connection);
        const auto existing = transaction.exec(
            "SELECT 1 FROM users WHERE username = $1 OR email = $2",
            pqxx::params{username, email});
        if (!existing.empty()) {
            throw NanikaE2eFixture::FixtureError(NanikaE2eFixture::ErrorCode::user_already_exists);
        }

        const auto result = transaction.exec(
            "INSERT INTO users (username, email, password_hash, full_name, is_email_verified) "
            "VALUES ($1, $2, $3, $1, TRUE) RETURNING id",
            pqxx::params{username, email, password_hash});
        user_id = result[0][0].as<uint64_t>();
        transaction.commit();
    } catch (const NanikaE2eFixture::FixtureError&) {
        throw;
    } catch (...) {
        throw NanikaE2eFixture::FixtureError(NanikaE2eFixture::ErrorCode::db_operation_failed);
    }

    Json response{{"ok", true}, {"user_id", user_id}};
    std::cout << response.dump() << '\n';
}

void cleanup(const Json& payload, const FixtureStorage& storage) {
    const auto username = required_string(payload, "username");
    validate_username(username);

    auto pool = make_pool();
    std::vector<uint64_t> removed_file_ids;
    try {
        removed_file_ids = NanikaE2eFixture::cleanup_user(
            pool, username, storage.path, storage.identity);
    } catch (const NanikaE2eFixture::FixtureError&) {
        throw;
    } catch (...) {
        throw NanikaE2eFixture::FixtureError(NanikaE2eFixture::ErrorCode::cleanup_failed);
    }

    std::cout << Json{{"ok", true}, {"removed_file_ids", removed_file_ids}}.dump() << '\n';
}

} // namespace

int main(int argc, char** argv) {
    try {
        const auto storage = require_fixture_guard();
        if (argc != 2 || (std::string(argv[1]) != "provision" && std::string(argv[1]) != "cleanup")) {
            throw NanikaE2eFixture::FixtureError(NanikaE2eFixture::ErrorCode::command_invalid);
        }

        const auto payload = Json::parse(read_stdin(), nullptr, false);
        if (payload.is_discarded()) {
            throw NanikaE2eFixture::FixtureError(NanikaE2eFixture::ErrorCode::input_invalid);
        }
        if (std::string(argv[1]) == "provision") provision(payload);
        else cleanup(payload, storage);
        return 0;
    } catch (...) {
        std::cerr << NanikaE2eFixture::public_error_code(std::current_exception()) << '\n';
        return 1;
    }
}
