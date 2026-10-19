#pragma once

#include <cstdint>
#include <exception>
#include <string>
#include <string_view>
#include <vector>

class DatabasePool;

namespace NanikaE2eFixture {

enum class ErrorCode {
    guard_disabled,
    database_not_isolated,
    storage_not_configured,
    storage_identity_invalid,
    storage_root_invalid,
    storage_unavailable,
    storage_identity_mismatch,
    command_invalid,
    input_invalid,
    username_invalid,
    config_missing,
    db_operation_failed,
    password_hash_failed,
    user_already_exists,
    cleanup_failed,
    internal_error,
};

const char* error_code(ErrorCode code) noexcept;

class FixtureError final : public std::exception {
public:
    explicit FixtureError(ErrorCode code) noexcept : code_(code) {}
    const char* what() const noexcept override { return error_code(code_); }

private:
    ErrorCode code_;
};

const char* public_error_code(std::exception_ptr error) noexcept;

inline constexpr std::string_view USERNAME_PREFIX = "nanika_e2e_";

inline bool is_safe_username(std::string_view username) {
    return username.size() > USERNAME_PREFIX.size()
        && username.compare(0, USERNAME_PREFIX.size(), USERNAME_PREFIX) == 0
        && username.find_first_of("/\\\r\n") == std::string_view::npos;
}

inline bool is_safe_database_name(std::string_view name) {
    constexpr std::string_view prefix = "nanika_e2e_";
    if (name == "nanika_e2e") return true;
    if (name.size() <= prefix.size() || name.compare(0, prefix.size(), prefix) != 0) return false;
    for (const char value : name.substr(prefix.size())) {
        if (!((value >= 'a' && value <= 'z') || (value >= 'A' && value <= 'Z') ||
              (value >= '0' && value <= '9') || value == '_')) return false;
    }
    return true;
}

void require_storage_identity(const std::string& storage_path, std::string_view expected_identity);
std::vector<uint64_t> cleanup_user(DatabasePool& pool, std::string_view username,
                                   const std::string& storage_path, std::string_view expected_identity);

}
