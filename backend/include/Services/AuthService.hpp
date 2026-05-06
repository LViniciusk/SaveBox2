#pragma once

#include <string>
#include <optional>
#include <cstdint>
#include <memory>

#include "Services/EmailService.hpp"

class DatabasePool;

class AuthService {
public:

    AuthService(const std::string& pepper, const std::string& jwt_secret,
                const std::string& resend_api_key, const std::string& validation_api_key);
    AuthService(const std::string& pepper, const std::string& jwt_secret, EmailService* email_service);

    std::string hash_password(const std::string& plain_password);
    bool verify_password(const std::string& plain_password, const std::string& hashed_password);

    int register_user(const std::string& username, const std::string& email, const std::string& password, const std::string& ip_address);
    int authenticate_user(const std::string& username, const std::string& password);
    bool verify_email(const std::string& token);

    void set_database_pool(DatabasePool& pool);
    void set_email_service(EmailService* email_service);

    std::string generate_token(uint64_t user_id) const;
    std::optional<uint64_t> verify_token(const std::string& token) const;

private:

    std::string pepper_;
    std::string jwt_secret_;
    DatabasePool* pool_ = nullptr;
    EmailService* email_service_ = nullptr;
    std::unique_ptr<EmailService> owned_email_service_;

    std::string apply_pepper(const std::string& plain_password) const;
    std::string generate_uuid_v4() const;
};
