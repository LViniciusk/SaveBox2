#include <catch2/catch_test_macros.hpp>

#include "Services/AuthService.hpp"
#include "controllers/ApiRouter.hpp"
#include "database/DatabasePool.hpp"
#include "database/FolderManager.hpp"
#include "test_helpers.hpp"

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cpr/cpr.h>
#include <exception>
#include <mutex>
#include <pqxx/pqxx>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>

namespace {

class B58EmailService : public EmailService {
public:
    B58EmailService() : EmailService("b58-resend-key", "b58-validation-key") {}

    mutable std::atomic<int> validation_requests{0};
    mutable std::atomic<int> send_requests{0};
    mutable int validation_status = 200;
    mutable int delivery_status = 200;
    mutable cpr::ErrorCode delivery_error = cpr::ErrorCode::OK;
    mutable bool throw_delivery = false;

    void enable_delivery_gate() const {
        std::lock_guard<std::mutex> lock(gate_mutex_);
        gate_enabled_ = true;
        gate_entered_ = false;
        gate_released_ = false;
    }

    bool wait_for_delivery() const {
        std::unique_lock<std::mutex> lock(gate_mutex_);
        return gate_cv_.wait_for(lock, std::chrono::seconds(5), [&] { return gate_entered_; });
    }

    void release_delivery() const {
        std::lock_guard<std::mutex> lock(gate_mutex_);
        gate_enabled_ = false;
        gate_released_ = true;
        gate_cv_.notify_all();
    }

protected:
    cpr::Response make_post_request(const std::string&, const cpr::Header&, const cpr::Body&) const override {
        ++send_requests;
        {
            std::unique_lock<std::mutex> lock(gate_mutex_);
            if (gate_enabled_) {
                gate_entered_ = true;
                gate_cv_.notify_all();
                gate_cv_.wait(lock, [&] { return gate_released_; });
            }
        }

        if (throw_delivery) {
            throw std::runtime_error("b58 provider failure fixture");
        }

        cpr::Response response;
        response.error = cpr::Error{};
        response.error.code = delivery_error;
        response.status_code = delivery_status;
        return response;
    }

    cpr::Response make_get_request(const std::string&) const override {
        ++validation_requests;
        cpr::Response response;
        response.error = cpr::Error{};
        response.error.code = cpr::ErrorCode::OK;
        response.status_code = validation_status;
        response.text = "{}";
        return response;
    }

private:
    mutable std::mutex gate_mutex_;
    mutable std::condition_variable gate_cv_;
    mutable bool gate_enabled_ = false;
    mutable bool gate_entered_ = false;
    mutable bool gate_released_ = false;
};

struct UserState {
    bool exists = false;
    bool verified = false;
    bool token_present = false;
    bool expiry_present = false;
    int id = 0;
    std::string token;
};

struct B58Scenario {
    DatabasePool pool{2, get_secure_conn_string()};
    B58EmailService email;
    AuthService auth{"b58-test-pepper", "b58-test-secret", &email};
    FolderManager folders{pool};
    ApiRouter router{pool, auth, folders};
    const std::string prefix;
    const std::string registration_ip = "198.51.100.180";

    explicit B58Scenario(std::string name) : prefix("b58_" + std::move(name) + "_") {
        clear_users();
    }

    ~B58Scenario() {
        try {
            clear_users();
        } catch (...) {
        }
    }

    void clear_users() {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username LIKE $1", pqxx::params{prefix + "%"});
        txn.commit();
    }

    UserState user_state(const std::string& username) {
        auto conn = pool.acquire_connection();
        pqxx::nontransaction txn(*conn);
        const auto result = txn.exec(
            "SELECT id, is_email_verified, verification_token, token_expires_at "
            "FROM users WHERE username = $1",
            pqxx::params{username});
        if (result.empty()) return {};

        UserState state;
        state.exists = true;
        state.id = result[0][0].as<int>();
        state.verified = result[0][1].as<bool>();
        state.token_present = !result[0][2].is_null();
        state.expiry_present = !result[0][3].is_null();
        if (state.token_present) state.token = result[0][2].as<std::string>();
        return state;
    }

    void expire_token(const std::string& username) {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec(
            "UPDATE users SET token_expires_at = NOW() - INTERVAL '1 minute' WHERE username = $1",
            pqxx::params{username});
        txn.commit();
    }

    void change_identity(int user_id) {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec(
            "UPDATE users SET auth_provider = 'google', provider_id = $1 WHERE id = $2",
            pqxx::params{"b58-provider-identity", user_id});
        txn.commit();
    }

    int recent_registration_count(const std::string& ip) {
        auto conn = pool.acquire_connection();
        pqxx::nontransaction txn(*conn);
        return txn.exec(
            "SELECT count(*) FROM users WHERE registration_ip = $1 "
            "AND created_at > NOW() - INTERVAL '24 hours'",
            pqxx::params{ip})[0][0].as<int>();
    }

};

struct RegistrationResult {
    bool success = false;
    int user_id = 0;
    std::string error;
};

RegistrationResult register_direct(
    B58Scenario& scenario, const std::string& username, const std::string& email) {
    RegistrationResult result;
    try {
        result.user_id = scenario.auth.register_user(
            username, email, "b58-password", scenario.registration_ip);
        result.success = true;
    } catch (const std::exception& error) {
        result.error = error.what();
    } catch (...) {
        result.error = "unknown exception";
    }
    return result;
}

crow::request registration_request(
    const std::string& username, const std::string& email, const std::string& ip) {
    crow::request request;
    request.remote_ip_address = ip;
    request.body = "{\"username\":\"" + username + "\",\"email\":\"" + email +
                   "\",\"password\":\"b58-password\"}";
    return request;
}

} // namespace

TEST_CASE("B.58 failed HTTP delivery is compensated and retryable", "[b58][auth][registration][email][recovery]") {
    B58Scenario scenario("http_failure");
    const auto username = scenario.prefix + "user";
    const auto email = username + "@test.com";
    scenario.email.delivery_status = 500;

    const auto response = scenario.router.handle_register(
        registration_request(username, email, scenario.registration_ip));

    REQUIRE(response.code == 503);
    REQUIRE(response.body.find("VERIFICATION_EMAIL_DELIVERY_FAILED") != std::string::npos);
    REQUIRE(response.body.find("token") == std::string::npos);
    REQUIRE(scenario.email.send_requests.load() == 1);
    REQUIRE_FALSE(scenario.user_state(username).exists);
    REQUIRE(scenario.recent_registration_count(scenario.registration_ip) == 0);

    scenario.email.delivery_status = 201;
    const auto retry = scenario.router.handle_register(
        registration_request(username, email, scenario.registration_ip));
    REQUIRE(retry.code == 201);
    REQUIRE(scenario.email.send_requests.load() == 2);
    REQUIRE(scenario.user_state(username).exists);
    REQUIRE(scenario.recent_registration_count(scenario.registration_ip) == 1);
}

TEST_CASE("B.58 network delivery failure is normalized and compensated", "[b58][auth][registration][email][recovery]") {
    B58Scenario scenario("network_failure");
    const auto username = scenario.prefix + "user";
    const auto email = username + "@test.com";
    scenario.email.delivery_error = cpr::ErrorCode::COULDNT_CONNECT;
    scenario.email.delivery_status = 0;

    const auto response = scenario.router.handle_register(
        registration_request(username, email, scenario.registration_ip));

    REQUIRE(response.code == 503);
    REQUIRE(scenario.email.send_requests.load() == 1);
    REQUIRE_FALSE(scenario.user_state(username).exists);
}

TEST_CASE("B.58 provider exception is normalized and compensated", "[b58][auth][registration][email][recovery]") {
    B58Scenario scenario("provider_exception");
    const auto username = scenario.prefix + "user";
    const auto email = username + "@test.com";
    scenario.email.throw_delivery = true;

    const auto response = scenario.router.handle_register(
        registration_request(username, email, scenario.registration_ip));

    REQUIRE(response.code == 503);
    REQUIRE(scenario.email.send_requests.load() == 1);
    REQUIRE_FALSE(scenario.user_state(username).exists);
}

TEST_CASE("B.58 recovery fails closed when registration ownership changes", "[b58][auth][registration][email][recovery]") {
    B58Scenario scenario("ownership_changed");
    const auto username = scenario.prefix + "user";
    const auto email = username + "@test.com";
    scenario.email.delivery_error = cpr::ErrorCode::COULDNT_CONNECT;
    scenario.email.delivery_status = 0;
    scenario.email.enable_delivery_gate();

    crow::response response;
    std::thread registration_thread([&] {
        response = scenario.router.handle_register(
            registration_request(username, email, scenario.registration_ip));
    });
    const bool send_entered = scenario.email.wait_for_delivery();
    std::exception_ptr identity_error;
    if (send_entered) {
        try {
            scenario.change_identity(scenario.user_state(username).id);
        } catch (...) {
            identity_error = std::current_exception();
        }
    }
    scenario.email.release_delivery();
    if (registration_thread.joinable()) registration_thread.join();

    REQUIRE(send_entered);
    if (identity_error) std::rethrow_exception(identity_error);
    REQUIRE(response.code == 500);
    REQUIRE(scenario.email.send_requests.load() == 1);

    const auto state = scenario.user_state(username);
    REQUIRE(state.exists);
    REQUIRE_FALSE(state.verified);
}

TEST_CASE("B.58 verification wins the ambiguous delivery race", "[b58][auth][registration][email][recovery][concurrency]") {
    B58Scenario scenario("verify_wins");
    const auto username = scenario.prefix + "user";
    const auto email = username + "@test.com";
    scenario.email.delivery_error = cpr::ErrorCode::COULDNT_CONNECT;
    scenario.email.delivery_status = 0;
    scenario.email.enable_delivery_gate();

    RegistrationResult registration;
    std::thread registration_thread([&] {
        registration = register_direct(scenario, username, email);
    });
    const bool send_entered = scenario.email.wait_for_delivery();
    UserState before_verify;
    std::exception_ptr verify_error;
    bool verified = false;
    size_t available_connections = 0;
    if (send_entered) {
        try {
            before_verify = scenario.user_state(username);
            available_connections = scenario.pool.get_available_count();
            verified = scenario.auth.verify_email(before_verify.token);
        } catch (...) {
            verify_error = std::current_exception();
        }
    }
    scenario.email.release_delivery();
    if (registration_thread.joinable()) registration_thread.join();

    REQUIRE(send_entered);
    if (verify_error) std::rethrow_exception(verify_error);
    REQUIRE(available_connections == 2);
    REQUIRE(verified);
    REQUIRE(registration.success);
    REQUIRE(registration.error.empty());
    REQUIRE(scenario.email.send_requests.load() == 1);

    const auto state = scenario.user_state(username);
    REQUIRE(state.exists);
    REQUIRE(state.verified);
    REQUIRE_FALSE(state.token_present);
    REQUIRE_FALSE(state.expiry_present);
}

TEST_CASE("B.58 compensation wins and consumes the old token", "[b58][auth][registration][email][recovery][concurrency]") {
    B58Scenario scenario("compensation_wins");
    const auto username = scenario.prefix + "user";
    const auto email = username + "@test.com";
    scenario.email.delivery_error = cpr::ErrorCode::COULDNT_CONNECT;
    scenario.email.delivery_status = 0;
    scenario.email.enable_delivery_gate();

    RegistrationResult registration;
    std::thread registration_thread([&] {
        registration = register_direct(scenario, username, email);
    });
    const bool send_entered = scenario.email.wait_for_delivery();
    UserState committed;
    std::exception_ptr state_error;
    if (send_entered) {
        try {
            committed = scenario.user_state(username);
        } catch (...) {
            state_error = std::current_exception();
        }
    }
    scenario.email.release_delivery();
    if (registration_thread.joinable()) registration_thread.join();

    REQUIRE(send_entered);
    if (state_error) std::rethrow_exception(state_error);
    REQUIRE(registration.error == "VERIFICATION_EMAIL_DELIVERY_FAILED");
    REQUIRE_FALSE(scenario.user_state(username).exists);
    bool invalid_token = false;
    try {
        scenario.auth.verify_email(committed.token);
    } catch (const std::runtime_error& error) {
        invalid_token = std::string(error.what()) == "INVALID_OR_EXPIRED_TOKEN";
    }
    REQUIRE(invalid_token);
}

TEST_CASE("B.58 successful delivery keeps 201 and provider 201 is accepted", "[b58][auth][registration][email]") {
    B58Scenario scenario("delivery_success");
    const auto username = scenario.prefix + "user";
    const auto email = username + "@test.com";
    scenario.email.delivery_status = 201;

    const auto response = scenario.router.handle_register(
        registration_request(username, email, scenario.registration_ip));

    REQUIRE(response.code == 201);
    REQUIRE(scenario.email.send_requests.load() == 1);
    const auto state = scenario.user_state(username);
    REQUIRE(state.exists);
    REQUIRE_FALSE(state.verified);
    REQUIRE(state.token_present);
    REQUIRE(state.expiry_present);
}

TEST_CASE("B.58 verify is authoritative, single-use and preserves login contract", "[b58][auth][registration][email][verify]") {
    B58Scenario scenario("verify_contract");
    const auto username = scenario.prefix + "user";
    const auto email = username + "@test.com";

    REQUIRE(scenario.router.handle_register(
        registration_request(username, email, scenario.registration_ip)).code == 201);
    crow::request login_request;
    login_request.body = "{\"username\":\"" + username + "\",\"password\":\"b58-password\"}";
    REQUIRE(scenario.router.handle_login(login_request).code == 403);

    const auto committed = scenario.user_state(username);
    crow::request verify_request;
    verify_request.url = "/verify?token=" + committed.token;
    verify_request.url_params = crow::query_string(verify_request.url.substr(verify_request.url.find('?')));
    REQUIRE(scenario.router.handle_verify_email(verify_request).code == 200);
    REQUIRE(scenario.router.handle_verify_email(verify_request).code == 400);
    REQUIRE(scenario.router.handle_login(login_request).code == 200);

    const auto verified = scenario.user_state(username);
    REQUIRE(verified.verified);
    REQUIRE_FALSE(verified.token_present);
    REQUIRE_FALSE(verified.expiry_present);
}

TEST_CASE("B.58 expired and unknown verification tokens remain invalid", "[b58][auth][email][verify]") {
    B58Scenario scenario("verify_invalid");
    const auto username = scenario.prefix + "user";
    const auto email = username + "@test.com";

    REQUIRE(scenario.router.handle_register(
        registration_request(username, email, scenario.registration_ip)).code == 201);
    const auto committed = scenario.user_state(username);
    scenario.expire_token(username);

    crow::request expired_request;
    expired_request.url = "/verify?token=" + committed.token;
    expired_request.url_params = crow::query_string(expired_request.url.substr(expired_request.url.find('?')));
    REQUIRE(scenario.router.handle_verify_email(expired_request).code == 400);

    crow::request unknown_request;
    unknown_request.url = "/verify?token=b58-unknown-token";
    unknown_request.url_params = crow::query_string(unknown_request.url.substr(unknown_request.url.find('?')));
    REQUIRE(scenario.router.handle_verify_email(unknown_request).code == 400);
    REQUIRE(scenario.user_state(username).exists);
    REQUIRE_FALSE(scenario.user_state(username).verified);
}
