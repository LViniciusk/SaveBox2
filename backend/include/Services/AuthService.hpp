#pragma once

#include <string>

class AuthService {
public:

    explicit AuthService(const std::string& server_pepper);

    std::string hash_password(const std::string& plain_password);
    bool verify_password(const std::string& plain_password, const std::string& hashed_password);

private:

    std::string pepper_;
    std::string apply_pepper(const std::string& plain_password) const;
};
