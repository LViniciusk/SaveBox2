#include "Services/AuthService.hpp"
#include "database/DatabasePool.hpp"
#include "Services/EmailService.hpp"
#include "utils.hpp"
#include "utils/utils.hpp"

#include <crow_all.h>

#include <jwt-cpp/jwt.h>
#include <sodium.h>
#include <pqxx/pqxx>
#include <stdexcept>
#include <cstring>
#include <vector>
#include <chrono>

AuthService::AuthService(const std::string& pepper, const std::string& jwt_secret,
                         const std::string& resend_api_key, const std::string& validation_api_key)
    : pepper_(pepper), jwt_secret_(jwt_secret) {
    if (sodium_init() == -1) {
        throw std::runtime_error("Falha critica: libsodium nao pode ser inicializada.");
    }
    if (pepper_.empty()) {
        throw std::invalid_argument("O Pepper do servidor nao pode ser vazio.");
    }
    if (jwt_secret_.empty()) {
        throw std::invalid_argument("O segredo JWT nao pode ser vazio.");
    }
    if (resend_api_key.empty()) {
        throw std::invalid_argument("O Resend API Key nao pode ser vazio.");
    }
    if (validation_api_key.empty()) {
        throw std::invalid_argument("O Email Validation API Key nao pode ser vazio.");
    }

    owned_email_service_ = std::make_unique<EmailService>(resend_api_key, validation_api_key);
    email_service_ = owned_email_service_.get();
}

AuthService::AuthService(const std::string& pepper, const std::string& jwt_secret, EmailService* email_service)
    : pepper_(pepper), jwt_secret_(jwt_secret), email_service_(email_service) {
    if (sodium_init() == -1) {
        throw std::runtime_error("Falha critica: libsodium nao pode ser inicializada.");
    }
    if (pepper_.empty()) {
        throw std::invalid_argument("O Pepper do servidor nao pode ser vazio.");
    }
    if (jwt_secret_.empty()) {
        throw std::invalid_argument("O segredo JWT nao pode ser vazio.");
    }

    if (email_service_ == nullptr) {
        owned_email_service_ = std::make_unique<EmailService>(
            Utils::get().get_var("RESEND_API_KEY", ""),
            Utils::get().get_var("EMAIL_VALIDATION_API_KEY", "")
        );
        email_service_ = owned_email_service_.get();
    }
}

void AuthService::set_database_pool(DatabasePool& pool) {
    pool_ = &pool;
}

void AuthService::set_email_service(EmailService* email_service) {
    email_service_ = email_service;
    if (email_service_ != nullptr) {
        owned_email_service_.reset();
    }
}

std::string AuthService::apply_pepper(const std::string& plain_password) const {
    std::vector<unsigned char> pre_hash(crypto_generichash_BYTES);
    
    crypto_generichash(
        pre_hash.data(), pre_hash.size(),
        reinterpret_cast<const unsigned char*>(plain_password.data()), plain_password.size(),
        reinterpret_cast<const unsigned char*>(pepper_.data()), pepper_.size()
    );

    std::string hex_pre_hash(crypto_generichash_BYTES * 2 + 1, '\0');
    sodium_bin2hex(hex_pre_hash.data(), hex_pre_hash.size(), pre_hash.data(), pre_hash.size());
    
    hex_pre_hash.resize(crypto_generichash_BYTES * 2);
    
    return hex_pre_hash;
}

std::string AuthService::hash_password(const std::string& plain_password) {
    std::string peppered_password = apply_pepper(plain_password);

    char hashed[crypto_pwhash_STRBYTES];
    std::memset(hashed, 0, sizeof(hashed));

    if (crypto_pwhash_str(
            hashed,
            peppered_password.c_str(),
            peppered_password.size(),
            crypto_pwhash_OPSLIMIT_INTERACTIVE,
            crypto_pwhash_MEMLIMIT_INTERACTIVE) != 0) {
        throw std::runtime_error("Falha ao gerar hash da senha (memoria insuficiente?).");
    }

    sodium_memzero(peppered_password.data(), peppered_password.size());

    return std::string(hashed);
}

bool AuthService::verify_password(const std::string& plain_password, const std::string& hashed_password) {
    std::string peppered_password = apply_pepper(plain_password);

    bool is_valid = crypto_pwhash_str_verify(
        hashed_password.c_str(),
        peppered_password.c_str(),
        peppered_password.size()
    ) == 0;

    sodium_memzero(peppered_password.data(), peppered_password.size());

    return is_valid;
}

std::string AuthService::generate_uuid_v4() const {
    return UuidUtils::generate_uuid_v4();
}

int AuthService::register_user(const std::string& username, const std::string& email, const std::string& password, const std::string& ip_address) {
    if (pool_ == nullptr) {
        throw std::runtime_error("AUTH_DB_NOT_CONFIGURED");
    }

    if (!EmailUtils::is_valid_format(email)) {
        throw std::runtime_error("INVALID_EMAIL_FORMAT");
    }

    if (EmailUtils::is_disposable(email)) {
        throw std::runtime_error("DISPOSABLE_EMAIL_LOCAL");
    }

    if (email_service_ != nullptr && !email_service_->is_domain_valid_via_api(email)) {
        throw std::runtime_error("DISPOSABLE_EMAIL_API");
    }

    auto conn = pool_->acquire_connection();
    pqxx::work txn(*conn);

    auto ip_count = txn.exec(
        "SELECT count(*) FROM users WHERE registration_ip = $1 AND created_at > NOW() - INTERVAL '24 hours'",
        pqxx::params{ip_address}
    );

    if (ip_count[0][0].as<int>() >= 3) {
        throw std::runtime_error("TOO_MANY_ACCOUNTS_FROM_IP");
    }

    auto check = txn.exec(
        "SELECT count(*) FROM users WHERE username = $1 OR email = $2",
        pqxx::params{username, email}
    );

    if (check[0][0].as<int>() > 0) {
        throw std::runtime_error("USER_ALREADY_EXISTS");
    }

    const std::string hash = hash_password(password);
    const std::string verification_token = generate_uuid_v4();

    auto result = txn.exec(
        "INSERT INTO users (username, email, password_hash, verification_token, token_expires_at, registration_ip) "
        "VALUES ($1, $2, $3, $4, NOW() + INTERVAL '24 hours', $5) RETURNING id",
        pqxx::params{username, email, hash, verification_token, ip_address}
    );

    txn.commit();

    if (email_service_ != nullptr) {
        email_service_->send_verification_email(email, verification_token);
    }

    return result[0][0].as<int>();
}

int AuthService::authenticate_user(const std::string& username, const std::string& password) {
    if (pool_ == nullptr) {
        throw std::runtime_error("AUTH_DB_NOT_CONFIGURED");
    }

    auto conn = pool_->acquire_connection();
    pqxx::work txn(*conn);

    auto result = txn.exec(
        "SELECT id, password_hash, is_email_verified FROM users WHERE username = $1",
        pqxx::params{username}
    );
    txn.commit();

    if (result.empty()) {
        throw std::runtime_error("INVALID_CREDENTIALS");
    }

    const int user_id = result[0][0].as<int>();
    const std::string hash_do_banco = result[0][1].as<std::string>();
    const bool is_email_verified = result[0][2].as<bool>();

    if (!verify_password(password, hash_do_banco)) {
        throw std::runtime_error("INVALID_CREDENTIALS");
    }

    if (!is_email_verified) {
        throw std::runtime_error("EMAIL_NOT_VERIFIED");
    }

    return user_id;
}

bool AuthService::verify_email(const std::string& token) {
    if (pool_ == nullptr) {
        throw std::runtime_error("AUTH_DB_NOT_CONFIGURED");
    }

    auto conn = pool_->acquire_connection();
    pqxx::work txn(*conn);

    auto result = txn.exec(
        "SELECT id, token_expires_at FROM users WHERE verification_token = $1",
        pqxx::params{token}
    );

    if (result.empty()) {
        throw std::runtime_error("INVALID_OR_EXPIRED_TOKEN");
    }

    const int user_id = result[0][0].as<int>();

    auto expiry_check = txn.exec(
        "SELECT CASE WHEN token_expires_at < NOW() THEN true ELSE false END FROM users WHERE id = $1",
        pqxx::params{user_id}
    );

    if (!expiry_check.empty() && expiry_check[0][0].as<bool>()) {
        throw std::runtime_error("INVALID_OR_EXPIRED_TOKEN");
    }

    txn.exec(
        "UPDATE users SET is_email_verified = TRUE, verification_token = NULL, token_expires_at = NULL WHERE id = $1",
        pqxx::params{user_id}
    );

    txn.commit();
    return true;
}

std::string AuthService::generate_token(uint64_t user_id) const {
    auto now = std::chrono::system_clock::now();
    auto expiry = now + std::chrono::hours(24);

    return jwt::create()
        .set_type("JWT")
        .set_issued_at(now)
        .set_expires_at(expiry)
        .set_payload_claim("user_id", jwt::claim(std::to_string(user_id)))
        .sign(jwt::algorithm::hs256{jwt_secret_});
}

std::optional<uint64_t> AuthService::verify_token(const std::string& token) const {
    try {
        auto verifier = jwt::verify()
            .allow_algorithm(jwt::algorithm::hs256{jwt_secret_})
            .with_type("JWT");

        auto decoded = jwt::decode(token);
        verifier.verify(decoded);

        uint64_t user_id = std::stoull(decoded.get_payload_claim("user_id").as_string());
        return user_id;
    } catch (...) {
        return std::nullopt;
    }
}

AuthService::GoogleClaims AuthService::validate_google_claims(const std::string& payload_json, const std::string& expected_client_id) {
    auto data = crow::json::load(payload_json);
    if (!data) {
        throw std::invalid_argument("INVALID_ID_TOKEN");
    }

    if (!data.has("sub") || !data.has("email") || !data.has("iss")) {
        throw std::invalid_argument("INVALID_ID_TOKEN");
    }

    std::string iss = data["iss"].s();
    if (iss != "accounts.google.com" && iss != "https://accounts.google.com") {
        throw std::invalid_argument("INVALID_ID_TOKEN");
    }

    if (expected_client_id.empty()) {
        throw std::invalid_argument("GOOGLE_CLIENT_ID_REQUIRED");
    }

    if (!data.has("aud")) {
        throw std::invalid_argument("INVALID_ID_TOKEN");
    }
    std::string aud = data["aud"].s();
    if (aud != expected_client_id) {
        throw std::invalid_argument("INVALID_ID_TOKEN");
    }

    if (!data.has("email_verified")) {
        throw std::invalid_argument("EMAIL_NOT_VERIFIED_BY_PROVIDER");
    }

    bool email_is_verified = false;
    auto ev = data["email_verified"];
    if (ev.t() == crow::json::type::True) {
        email_is_verified = true;
    } else if (ev.t() == crow::json::type::String) {
        email_is_verified = (std::string(ev.s()) == "true");
    }

    if (!email_is_verified) {
        throw std::invalid_argument("EMAIL_NOT_VERIFIED_BY_PROVIDER");
    }

    std::string sub = data["sub"].s();
    if (sub.empty()) {
        throw std::invalid_argument("INVALID_ID_TOKEN");
    }

    GoogleClaims claims;
    claims.sub = sub;
    claims.email = data["email"].s();
    claims.name = data.has("name") ? std::string(data["name"].s()) : std::string("");
    claims.picture = data.has("picture") ? std::string(data["picture"].s()) : std::string("");

    return claims;
}

int AuthService::handle_google_login(const std::string& id_token, const std::string& expected_nonce) {
    if (pool_ == nullptr) {
        throw std::runtime_error("AUTH_DB_NOT_CONFIGURED");
    }

    if (expected_nonce.empty()) {
        throw std::invalid_argument("NONCE_REQUIRED");
    }

    std::string expected_client_id = Utils::get().get_required_var("GOOGLE_CLIENT_ID");

    try {
        auto decoded = jwt::decode(id_token);

        if (!decoded.has_key_id()) {
            throw std::invalid_argument("MISSING_KID_HEADER");
        }

        std::string kid = decoded.get_key_id();
        std::string pem_key = jwks_cache_.get_pem_for_kid(kid);

        auto verifier = jwt::verify()
            .allow_algorithm(jwt::algorithm::rs256(pem_key, "", "", ""))
            .with_audience(expected_client_id)
            .with_claim("nonce", jwt::claim(expected_nonce))
            .leeway(60UL);

        verifier.verify(decoded);

        if (!decoded.has_payload_claim("iss")) {
            throw std::invalid_argument("INVALID_ID_TOKEN");
        }
        std::string iss = decoded.get_payload_claim("iss").as_string();
        if (iss != "https://accounts.google.com" && iss != "accounts.google.com") {
            throw std::invalid_argument("INVALID_ID_TOKEN");
        }

        if (!decoded.has_payload_claim("exp")) {
            throw std::invalid_argument("INVALID_ID_TOKEN");
        }
        if (!decoded.has_payload_claim("sub") || !decoded.has_payload_claim("email")) {
            throw std::invalid_argument("INVALID_ID_TOKEN");
        }

        std::string sub = decoded.get_payload_claim("sub").as_string();
        std::string email = decoded.get_payload_claim("email").as_string();

        if (sub.empty()) {
            throw std::invalid_argument("INVALID_ID_TOKEN");
        }

        if (!decoded.has_payload_claim("email_verified")) {
            throw std::invalid_argument("EMAIL_NOT_VERIFIED_BY_PROVIDER");
        }

        auto ev_claim = decoded.get_payload_claim("email_verified");
        bool email_is_verified = false;

        if (ev_claim.get_type() == jwt::json::type::boolean) {
            email_is_verified = ev_claim.as_boolean();
        } else if (ev_claim.get_type() == jwt::json::type::string) {
            email_is_verified = (ev_claim.as_string() == "true");
        }

        if (!email_is_verified) {
            throw std::invalid_argument("EMAIL_NOT_VERIFIED_BY_PROVIDER");
        }

        std::string name = decoded.has_payload_claim("name") 
            ? decoded.get_payload_claim("name").as_string() : "";
        std::string picture = decoded.has_payload_claim("picture") 
            ? decoded.get_payload_claim("picture").as_string() : "";

        UsersManager users_mgr(*pool_);
        return users_mgr.create_oauth_user(email, "google", sub, name, picture);

    } catch (const std::invalid_argument&) {
        throw;
    } catch (const std::runtime_error&) {
        throw;
    } catch (const std::exception&) {
        throw std::invalid_argument("INVALID_ID_TOKEN");
    }
}
