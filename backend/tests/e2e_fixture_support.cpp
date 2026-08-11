#include "e2e_fixture_support.hpp"

#include "database/DatabasePool.hpp"
#include "storage/FileChunker.hpp"

#include <pqxx/pqxx>

#include <algorithm>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

namespace NanikaE2eFixture {

const char* error_code(ErrorCode code) noexcept {
    switch (code) {
        case ErrorCode::guard_disabled: return "FIXTURE_GUARD_DISABLED";
        case ErrorCode::database_not_isolated: return "FIXTURE_DATABASE_NOT_ISOLATED";
        case ErrorCode::storage_not_configured: return "FIXTURE_STORAGE_NOT_CONFIGURED";
        case ErrorCode::storage_identity_invalid: return "FIXTURE_STORAGE_IDENTITY_INVALID";
        case ErrorCode::storage_root_invalid: return "FIXTURE_STORAGE_ROOT_INVALID";
        case ErrorCode::storage_unavailable: return "FIXTURE_STORAGE_UNAVAILABLE";
        case ErrorCode::storage_identity_mismatch: return "FIXTURE_STORAGE_IDENTITY_MISMATCH";
        case ErrorCode::command_invalid: return "FIXTURE_COMMAND_INVALID";
        case ErrorCode::input_invalid: return "FIXTURE_INPUT_INVALID";
        case ErrorCode::username_invalid: return "FIXTURE_USERNAME_INVALID";
        case ErrorCode::config_missing: return "FIXTURE_CONFIG_MISSING";
        case ErrorCode::db_operation_failed: return "FIXTURE_DB_OPERATION_FAILED";
        case ErrorCode::password_hash_failed: return "FIXTURE_PASSWORD_HASH_FAILED";
        case ErrorCode::user_already_exists: return "FIXTURE_USER_ALREADY_EXISTS";
        case ErrorCode::cleanup_failed: return "FIXTURE_CLEANUP_FAILED";
        case ErrorCode::internal_error: return "FIXTURE_INTERNAL_ERROR";
    }
    return "FIXTURE_INTERNAL_ERROR";
}

const char* public_error_code(std::exception_ptr error) noexcept {
    try {
        if (error) std::rethrow_exception(error);
    } catch (const FixtureError& fixture_error) {
        return fixture_error.what();
    } catch (...) {
    }
    return error_code(ErrorCode::internal_error);
}

namespace {

constexpr const char* STORAGE_IDENTITY_FILENAME = ".nanika-e2e-storage-id";

std::optional<std::filesystem::file_status> inspect_artifact(const std::filesystem::path& path) {
    std::error_code error;
    const auto status = std::filesystem::symlink_status(path, error);
    if (error == std::errc::no_such_file_or_directory || status.type() == std::filesystem::file_type::not_found) {
        return std::nullopt;
    }
    if (error || std::filesystem::is_symlink(status) || !std::filesystem::is_regular_file(status)) {
        throw std::runtime_error("fixture storage artifact is not a regular file");
    }
    return status;
}

template <typename Remove>
void remove_and_verify(const std::filesystem::path& path, Remove&& remove) {
    inspect_artifact(path);
    remove();
    if (inspect_artifact(path)) throw std::runtime_error("fixture storage artifact remains after cleanup");
}

}

void require_storage_identity(const std::string& storage_path, std::string_view expected_identity) {
    if (expected_identity.size() != 64 ||
        !std::all_of(expected_identity.begin(), expected_identity.end(), [](unsigned char value) {
            return (value >= '0' && value <= '9') || (value >= 'a' && value <= 'f');
        })) {
        throw FixtureError(ErrorCode::storage_identity_invalid);
    }

    const std::filesystem::path root(storage_path);
    if (!root.is_absolute()) throw FixtureError(ErrorCode::storage_root_invalid);

    std::error_code error;
    const auto root_status = std::filesystem::symlink_status(root, error);
    if (error || std::filesystem::is_symlink(root_status) || !std::filesystem::is_directory(root_status)) {
        throw FixtureError(ErrorCode::storage_unavailable);
    }

    const auto marker = root / STORAGE_IDENTITY_FILENAME;
    const auto marker_status = std::filesystem::symlink_status(marker, error);
    if (error || std::filesystem::is_symlink(marker_status) || !std::filesystem::is_regular_file(marker_status)) {
        throw FixtureError(ErrorCode::storage_unavailable);
    }

    std::ifstream input(marker, std::ios::binary);
    if (!input.is_open()) throw FixtureError(ErrorCode::storage_unavailable);
    std::string actual_identity((std::istreambuf_iterator<char>(input)), std::istreambuf_iterator<char>());
    while (!actual_identity.empty() && (actual_identity.back() == '\n' || actual_identity.back() == '\r')) {
        actual_identity.pop_back();
    }
    if (input.bad()) throw FixtureError(ErrorCode::storage_unavailable);
    if (actual_identity != expected_identity) throw FixtureError(ErrorCode::storage_identity_mismatch);
}

std::vector<uint64_t> cleanup_user(DatabasePool& pool, std::string_view username,
                                   const std::string& storage_path, std::string_view expected_identity) {
    if (!is_safe_username(username)) {
        throw FixtureError(ErrorCode::username_invalid);
    }
    require_storage_identity(storage_path, expected_identity);

    const std::string username_string(username);
    const std::filesystem::path root(storage_path);
    auto connection = pool.acquire_connection();
    pqxx::work transaction(*connection);

    const auto user_rows = transaction.exec(
        "SELECT id FROM users WHERE username = $1 FOR UPDATE",
        pqxx::params{username_string});
    if (user_rows.empty()) {
        transaction.commit();
        return {};
    }
    const auto user_id = user_rows[0][0].as<uint64_t>();

    std::vector<uint64_t> file_ids;
    for (const auto& row : transaction.exec("SELECT id FROM files WHERE user_id = $1", pqxx::params{user_id})) {
        file_ids.push_back(row[0].as<uint64_t>());
    }

    std::vector<uint64_t> move_item_ids;
    for (const auto& row : transaction.exec(
             "SELECT i.id FROM storage_move_items i "
             "JOIN storage_move_jobs j ON j.id = i.move_job_id "
             "WHERE j.user_id = $1",
             pqxx::params{user_id})) {
        move_item_ids.push_back(row[0].as<uint64_t>());
    }

    std::vector<uint64_t> move_job_ids;
    for (const auto& row : transaction.exec(
             "SELECT id FROM storage_move_jobs WHERE user_id = $1",
             pqxx::params{user_id})) {
        move_job_ids.push_back(row[0].as<uint64_t>());
    }

    FileChunker chunker(storage_path);
    for (const auto file_id : file_ids) {
        remove_and_verify(root / (std::to_string(file_id) + ".dat"), [&] { chunker.delete_file(file_id); });
        remove_and_verify(root / (std::to_string(file_id) + ".proxy.dat"), [&] {
            chunker.delete_uncommitted_move_target(file_id, true);
        });
    }
    for (const auto item_id : move_item_ids) {
        const auto path = root / "storage-moves" / ("item-" + std::to_string(item_id) + ".part");
        remove_and_verify(path, [&] { chunker.delete_move_file(item_id); });
    }
    for (const auto job_id : move_job_ids) {
        const auto data_path = root / "storage-moves" / ("cleanup-" + std::to_string(job_id) + ".dat");
        const auto proxy_path = root / "storage-moves" / ("cleanup-" + std::to_string(job_id) + ".proxy.dat");
        inspect_artifact(data_path);
        inspect_artifact(proxy_path);
        chunker.delete_quarantined_file(job_id);
        if (inspect_artifact(data_path) || inspect_artifact(proxy_path)) {
            throw std::runtime_error("fixture quarantined artifacts remain after cleanup");
        }
    }

    transaction.exec("DELETE FROM users WHERE id = $1", pqxx::params{user_id});
    transaction.commit();

    auto verify_connection = pool.acquire_connection();
    pqxx::read_transaction verify(*verify_connection);
    if (!verify.exec("SELECT 1 FROM users WHERE id = $1", pqxx::params{user_id}).empty()) {
        throw std::runtime_error("fixture user remains after cleanup");
    }
    for (const auto file_id : file_ids) {
        if (!verify.exec("SELECT 1 FROM files WHERE id = $1", pqxx::params{file_id}).empty()) {
            throw std::runtime_error("fixture file metadata remains after cleanup");
        }
    }
    verify.commit();
    return file_ids;
}

}
