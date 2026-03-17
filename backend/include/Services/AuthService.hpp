#pragma once

#include <string>
#include <optional>
#include <cstdint>

class AuthService {
public:

    AuthService(const std::string& pepper, const std::string& jwt_secret);

    std::string hash_password(const std::string& plain_password);
    bool verify_password(const std::string& plain_password, const std::string& hashed_password);

    std::string generate_token(uint64_t user_id) const;
    std::optional<uint64_t> verify_token(const std::string& token) const;

private:

    std::string pepper_;
    std::string jwt_secret_;
    std::string apply_pepper(const std::string& plain_password) const;
};
