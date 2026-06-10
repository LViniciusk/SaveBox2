#pragma once

#include <string>
#include <optional>
#include <cstdint>
#include <memory>

#include "Services/EmailService.hpp"
#include "Services/GoogleJwksCache.hpp"
#include "database/UsersManager.hpp"

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
    void logout_local(const std::string& jti) const;
    std::string extract_jti(const std::string& token) const;
    
    int handle_google_login(const std::string& id_token, const std::string& expected_nonce);

    struct GoogleClaims {
        std::string sub;
        std::string email;
        std::string name;
        std::string picture;
    };
    static GoogleClaims validate_google_claims(const std::string& payload_json, const std::string& expected_client_id);

private:

    std::string pepper_;
    std::string jwt_secret_;
    std::string dummy_hash_;
    DatabasePool* pool_ = nullptr;
    EmailService* email_service_ = nullptr;
    std::unique_ptr<EmailService> owned_email_service_;
    GoogleJwksCache jwks_cache_;

    std::string apply_pepper(const std::string& plain_password) const;
    std::string generate_uuid_v4() const;
    void init_dummy_hash();
};
