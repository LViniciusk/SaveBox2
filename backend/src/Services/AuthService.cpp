#include "Services/AuthService.hpp"
#include "database/DatabasePool.hpp"
#include "Services/EmailService.hpp"
#include "utils.hpp"
#include "utils/RandomIds.hpp"
#include <crow_all.h>

#include <jwt-cpp/jwt.h>
#include <sodium.h>
#include <pqxx/pqxx>
#include <stdexcept>
#include <cstring>
#include <array>
#include <chrono>
#ifdef NANIKA_TESTING
#include <functional>
#include <mutex>
#endif

#ifdef NANIKA_TESTING
namespace {
std::mutex password_hash_test_hook_mutex;
std::function<void()> password_hash_test_hook;
std::function<void()> password_verify_test_hook;
}
#endif

namespace {
void validate_pepper_or_throw(const std::string& pepper) {
    if (pepper.empty()) {
        throw std::invalid_argument("O Pepper do servidor nao pode ser vazio.");
    }
    if (pepper.size() > crypto_generichash_KEYBYTES_MAX) {
        throw std::invalid_argument("Configuracao criptografica invalida.");
    }
}
}

AuthService::AuthService(const std::string& pepper, const std::string& jwt_secret,
                         const std::string& resend_api_key, const std::string& validation_api_key)
    : pepper_(pepper), jwt_secret_(jwt_secret) {
    if (sodium_init() == -1) {
        throw std::runtime_error("Falha critica: libsodium nao pode ser inicializada.");
    }
    validate_pepper_or_throw(pepper_);
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
    init_dummy_hash();
}

AuthService::AuthService(const std::string& pepper, const std::string& jwt_secret, EmailService* email_service)
    : pepper_(pepper), jwt_secret_(jwt_secret), email_service_(email_service) {
    if (sodium_init() == -1) {
        throw std::runtime_error("Falha critica: libsodium nao pode ser inicializada.");
    }
    validate_pepper_or_throw(pepper_);
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
    init_dummy_hash();
}

void AuthService::init_dummy_hash() {
    dummy_hash_ = hash_password("dummy_constant_time_password");
}

void AuthService::set_database_pool(DatabasePool& pool) {
    pool_ = &pool;
}

#ifdef NANIKA_TESTING
void AuthService::set_password_hash_test_hook(std::function<void()> hook) {
    std::lock_guard<std::mutex> lock(password_hash_test_hook_mutex);
    password_hash_test_hook = std::move(hook);
}

void AuthService::clear_password_hash_test_hook() {
    std::lock_guard<std::mutex> lock(password_hash_test_hook_mutex);
    password_hash_test_hook = nullptr;
}

void AuthService::set_password_verify_test_hook(std::function<void()> hook) {
    std::lock_guard<std::mutex> lock(password_hash_test_hook_mutex);
    password_verify_test_hook = std::move(hook);
}

void AuthService::clear_password_verify_test_hook() {
    std::lock_guard<std::mutex> lock(password_hash_test_hook_mutex);
    password_verify_test_hook = nullptr;
}
#endif

std::string AuthService::apply_pepper(const std::string& plain_password) const {
    std::array<unsigned char, crypto_generichash_BYTES> pre_hash{};

    const int rc = crypto_generichash(
        pre_hash.data(), pre_hash.size(),
        reinterpret_cast<const unsigned char*>(plain_password.data()), plain_password.size(),
        reinterpret_cast<const unsigned char*>(pepper_.data()), pepper_.size()
    );

    if (rc != 0) {
        sodium_memzero(pre_hash.data(), pre_hash.size());
        throw std::runtime_error("AUTH_CRYPTO_FAILURE");
    }

    std::string hex_pre_hash(crypto_generichash_BYTES * 2 + 1, '\0');
    sodium_bin2hex(hex_pre_hash.data(), hex_pre_hash.size(), pre_hash.data(), pre_hash.size());

    sodium_memzero(pre_hash.data(), pre_hash.size());
    
    hex_pre_hash.resize(crypto_generichash_BYTES * 2);
    
    return hex_pre_hash;
}

std::string AuthService::hash_password(const std::string& plain_password) {
#ifdef NANIKA_TESTING
    std::function<void()> hook;
    {
        std::lock_guard<std::mutex> lock(password_hash_test_hook_mutex);
        hook = password_hash_test_hook;
    }
    if (hook) {
        hook();
    }
#endif

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
#ifdef NANIKA_TESTING
    std::function<void()> hook;
    {
        std::lock_guard<std::mutex> lock(password_hash_test_hook_mutex);
        hook = password_verify_test_hook;
    }
    if (hook) {
        hook();
    }
#endif

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

    const auto external_validation = email_service_ == nullptr
        ? EmailValidationResult::Unavailable
        : email_service_->validate_email_via_api(email);

    switch (external_validation) {
    case EmailValidationResult::Accepted:
        break;
    case EmailValidationResult::Rejected:
        throw std::runtime_error("EMAIL_VALIDATION_REJECTED");
    case EmailValidationResult::Unavailable:
        // Provider unavailability does not block registration; local validation and
        // B.58 verification delivery remain authoritative.
        break;
    }

    const auto check_registration_constraints = [&](pqxx::work& txn) {
        txn.exec(
            "SELECT pg_advisory_xact_lock(hashtextextended('nanika:register-ip:' || $1, 0))",
            pqxx::params{ip_address}
        );

        const auto ip_count = txn.exec(
            "SELECT count(*) FROM users WHERE registration_ip = $1 AND created_at > NOW() - INTERVAL '24 hours'",
            pqxx::params{ip_address}
        );

        if (ip_count[0][0].as<int>() >= 3) {
            throw std::runtime_error("TOO_MANY_ACCOUNTS_FROM_IP");
        }

        const auto check = txn.exec(
            "SELECT count(*) FROM users WHERE username = $1 OR email = $2",
            pqxx::params{username, email}
        );

        if (check[0][0].as<int>() > 0) {
            throw std::runtime_error("USER_ALREADY_EXISTS");
        }
    };

    // Cheap precheck only; Phase B repeats these constraints authoritatively.
    {
        auto conn = pool_->acquire_connection();
        pqxx::work txn(*conn);
        check_registration_constraints(txn);
        txn.commit();
    }

    // No database connection, transaction or B.51 lock is held while hashing.
    const std::string hash = hash_password(password);
    const std::string verification_token = Base62Generator::generate(6);
    int user_id = 0;

    // Authoritative B.51 recheck and insert.
    {
        auto conn = pool_->acquire_connection();
        pqxx::work txn(*conn);
        check_registration_constraints(txn);

        const auto result = txn.exec(
            "INSERT INTO users (username, email, password_hash, verification_token, token_expires_at, registration_ip, full_name) "
            "VALUES ($1, $2, $3, $4, NOW() + INTERVAL '5 minutes', $5, $6) RETURNING id",
            pqxx::params{username, email, hash, verification_token, ip_address, username}
        );

        user_id = result[0][0].as<int>();
        txn.commit();
    }

    bool delivered = false;
    try {
        delivered = email_service_ != nullptr &&
                    email_service_->send_verification_email(email, verification_token);
    } catch (...) {
        delivered = false;
    }

    if (delivered) {
        return user_id;
    }

    enum class FailedRegistrationRecovery {
        Removed,
        Missing,
        AlreadyVerified,
        OwnershipChanged,
    } recovery = FailedRegistrationRecovery::OwnershipChanged;

    try {
        auto conn = pool_->acquire_connection();
        pqxx::work txn(*conn);
        const auto deleted = txn.exec(
            "DELETE FROM users "
            "WHERE id = $1 "
            "AND auth_provider = 'local' "
            "AND provider_id IS NULL "
            "AND is_email_verified = FALSE "
            "AND verification_token = $2 "
            "AND deleted_at IS NULL "
            "RETURNING id",
            pqxx::params{user_id, verification_token});

        if (!deleted.empty()) {
            recovery = FailedRegistrationRecovery::Removed;
        } else {
            const auto state = txn.exec(
                "SELECT is_email_verified FROM users WHERE id = $1",
                pqxx::params{user_id});
            if (state.empty()) {
                recovery = FailedRegistrationRecovery::Missing;
            } else if (state[0][0].as<bool>()) {
                recovery = FailedRegistrationRecovery::AlreadyVerified;
            }
        }
        txn.commit();
    } catch (...) {
        throw std::runtime_error("VERIFICATION_EMAIL_RECOVERY_FAILED");
    }

    if (recovery == FailedRegistrationRecovery::AlreadyVerified) {
        return user_id;
    }
    if (recovery == FailedRegistrationRecovery::Removed ||
        recovery == FailedRegistrationRecovery::Missing) {
        throw std::runtime_error("VERIFICATION_EMAIL_DELIVERY_FAILED");
    }
    throw std::runtime_error("VERIFICATION_EMAIL_RECOVERY_FAILED");
}

int AuthService::authenticate_user(const std::string& username, const std::string& password) {
    if (pool_ == nullptr) {
        throw std::runtime_error("AUTH_DB_NOT_CONFIGURED");
    }

    int user_id = 0;
    std::string password_hash;
    bool is_email_verified = false;
    bool found = false;

    {
        auto conn = pool_->acquire_connection();
        pqxx::work txn(*conn);

        const auto result = txn.exec(
            "SELECT id, password_hash, is_email_verified FROM users "
            "WHERE (username = $1 OR email = $1) AND deleted_at IS NULL",
            pqxx::params{username}
        );
        if (!result.empty()) {
            found = true;
            user_id = result[0][0].as<int>();
            password_hash = result[0][1].as<std::string>();
            is_email_verified = result[0][2].as<bool>();
        }
        txn.commit();
    }

    // Password verification owns no database lease.
    if (!found) {
        // [AppSec] Constant-time mitigation against User Enumeration Timing Attack
        verify_password(password, dummy_hash_);
        throw std::runtime_error("INVALID_CREDENTIALS");
    }

    if (!verify_password(password, password_hash)) {
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

    const auto result = txn.exec(
        "UPDATE users SET is_email_verified = TRUE, verification_token = NULL, token_expires_at = NULL "
        "WHERE verification_token = $1 "
        "AND token_expires_at >= NOW() "
        "AND is_email_verified = FALSE "
        "AND deleted_at IS NULL "
        "RETURNING id",
        pqxx::params{token});

    if (result.empty()) {
        throw std::runtime_error("INVALID_OR_EXPIRED_TOKEN");
    }

    txn.commit();
    return true;
}

std::string AuthService::sign_token(uint64_t user_id, int token_version, bool is_vault_initialized,
                                    const std::string& email, const std::string& full_name,
                                    const std::string& avatar_url, const std::string& jti) const {
    const auto now = std::chrono::system_clock::now();
    return jwt::create()
        .set_type("JWT")
        .set_issued_at(now)
        .set_expires_at(now + std::chrono::hours(24))
        .set_payload_claim("user_id", jwt::claim(std::to_string(user_id)))
        .set_payload_claim("tver", jwt::claim(std::to_string(token_version)))
        .set_payload_claim("jti", jwt::claim(jti))
        .set_payload_claim("is_vault_initialized", jwt::claim(std::string(is_vault_initialized ? "true" : "false")))
        .set_payload_claim("email", jwt::claim(email))
        .set_payload_claim("name", jwt::claim(full_name))
        .set_payload_claim("picture", jwt::claim(avatar_url))
        .sign(jwt::algorithm::hs256{jwt_secret_});
}

std::string AuthService::generate_token(uint64_t user_id) const {
    if (pool_ == nullptr) {
        throw std::runtime_error("AUTH_DB_NOT_CONFIGURED");
    }

    const std::string jti = Base62Generator::generate(7);
    auto conn = pool_->acquire_connection();
    pqxx::work txn(*conn);
    const auto res = txn.exec(
        "SELECT token_version, is_vault_initialized, email, full_name, avatar_url "
        "FROM users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
        pqxx::params{user_id});
    if (res.empty()) {
        throw std::runtime_error("AUTH_USER_UNAVAILABLE");
    }

    const int token_version = res[0][0].is_null() ? 1 : res[0][0].as<int>();
    const bool is_vault_initialized = !res[0][1].is_null() && res[0][1].as<bool>();
    const std::string email = res[0][2].is_null() ? "" : res[0][2].as<std::string>();
    const std::string full_name = res[0][3].is_null() ? "" : res[0][3].as<std::string>();
    const std::string avatar_url = res[0][4].is_null() ? "" : res[0][4].as<std::string>();

    txn.exec(
        "INSERT INTO user_sessions (session_id, user_id) VALUES ($1, $2)",
        pqxx::params{jti, user_id});
    txn.exec(
        "DELETE FROM user_sessions "
        "WHERE user_id = $1 AND session_id IN ("
        "SELECT session_id FROM user_sessions "
        "WHERE user_id = $1 AND session_id <> $2 "
        "ORDER BY created_at DESC, session_id DESC OFFSET 9"
        ")",
        pqxx::params{user_id, jti});

    const std::string token = sign_token(
        user_id, token_version, is_vault_initialized, email, full_name, avatar_url, jti);
    txn.commit();
    return token;
}

std::optional<uint64_t> AuthService::verify_token(const std::string& token) const {
    if (pool_ == nullptr) {
        return std::nullopt;
    }

    try {
        auto verifier = jwt::verify()
            .allow_algorithm(jwt::algorithm::hs256{jwt_secret_})
            .with_type("JWT");
        auto decoded = jwt::decode(token);
        verifier.verify(decoded);

        const uint64_t user_id = std::stoull(decoded.get_payload_claim("user_id").as_string());
        if (!decoded.has_payload_claim("jti")) {
            return std::nullopt;
        }
        const std::string jti = decoded.get_payload_claim("jti").as_string();
        int token_tver = 1;
        if (decoded.has_payload_claim("tver")) {
            token_tver = std::stoi(decoded.get_payload_claim("tver").as_string());
        }

        auto conn = pool_->acquire_connection();
        pqxx::work txn(*conn);
        const auto result = txn.exec(
            "SELECT u.token_version, u.deleted_at "
            "FROM users u JOIN user_sessions s ON s.user_id = u.id "
            "WHERE u.id = $1 AND s.session_id = $2",
            pqxx::params{user_id, jti});
        txn.commit();
        if (result.empty() || !result[0][1].is_null()) {
            return std::nullopt;
        }
        const int db_token_version = result[0][0].is_null() ? 1 : result[0][0].as<int>();
        if (token_tver < db_token_version) {
            return std::nullopt;
        }
        return user_id;
    } catch (...) {
        return std::nullopt;
    }
}

std::optional<std::string> AuthService::refresh_token(const std::string& current_token) const {
    if (pool_ == nullptr) {
        return std::nullopt;
    }

    uint64_t user_id;
    int token_tver = 1;
    std::string jti;
    try {
        auto verifier = jwt::verify()
            .allow_algorithm(jwt::algorithm::hs256{jwt_secret_})
            .with_type("JWT");
        auto decoded = jwt::decode(current_token);
        verifier.verify(decoded);
        user_id = std::stoull(decoded.get_payload_claim("user_id").as_string());
        if (!decoded.has_payload_claim("jti")) {
            return std::nullopt;
        }
        jti = decoded.get_payload_claim("jti").as_string();
        if (decoded.has_payload_claim("tver")) {
            token_tver = std::stoi(decoded.get_payload_claim("tver").as_string());
        }
    } catch (...) {
        return std::nullopt;
    }

    auto conn = pool_->acquire_connection();
    pqxx::work txn(*conn);
    const auto result = txn.exec(
        "SELECT u.token_version, u.is_vault_initialized, u.email, u.full_name, "
        "u.avatar_url, u.deleted_at "
        "FROM users u JOIN user_sessions s ON s.user_id = u.id "
        "WHERE u.id = $1 AND s.session_id = $2 "
        "FOR SHARE OF u, s",
        pqxx::params{user_id, jti});
    if (result.empty() || !result[0][5].is_null()) {
        return std::nullopt;
    }

    const int db_token_version = result[0][0].is_null() ? 1 : result[0][0].as<int>();
    if (token_tver < db_token_version) {
        return std::nullopt;
    }
    const bool is_vault_initialized = !result[0][1].is_null() && result[0][1].as<bool>();
    const std::string email = result[0][2].is_null() ? "" : result[0][2].as<std::string>();
    const std::string full_name = result[0][3].is_null() ? "" : result[0][3].as<std::string>();
    const std::string avatar_url = result[0][4].is_null() ? "" : result[0][4].as<std::string>();
    const std::string refreshed = sign_token(
        user_id, db_token_version, is_vault_initialized, email, full_name, avatar_url, jti);
    txn.commit();
    return refreshed;
}

void AuthService::logout_local(const std::string& jti) const {
    if (pool_ == nullptr) {
        throw std::runtime_error("AUTH_DB_NOT_CONFIGURED");
    }

    auto conn = pool_->acquire_connection();
    pqxx::work txn(*conn);
    txn.exec("DELETE FROM user_sessions WHERE session_id = $1", pqxx::params{jti});
    txn.commit();
}

std::string AuthService::extract_jti(const std::string& token) const {
    try {
        auto decoded = jwt::decode(token);
        if (decoded.has_payload_claim("jti")) {
            return decoded.get_payload_claim("jti").as_string();
        }
    } catch (...) {}
    return "";
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
