#pragma once

#include <string>

class AuthService {
public:
    AuthService();

    std::string hash_password(const std::string& plain_password);
    bool verify_password(const std::string& plain_password, const std::string& hashed_password);
};
