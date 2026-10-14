#include <catch2/catch_test_macros.hpp>

#include "Services/AuthService.hpp"
#include "Services/EmailService.hpp"
#include "controllers/ApiRouter.hpp"
#include "database/DatabasePool.hpp"
#include "database/FolderManager.hpp"
#include "test_helpers.hpp"

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cpr/cpr.h>
#include <curl/curl.h>
#include <functional>
#include <mutex>
#include <pqxx/pqxx>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>

namespace {

class B59EmailService : public EmailService {
public:
    B59EmailService() : EmailService("b59-resend-key", "b59-validation-key") {}

    mutable cpr::Response validation_response;
    mutable cpr::Response delivery_response;
    mutable std::atomic<int> validation_calls{0};
    mutable std::atomic<int> delivery_calls{0};
    mutable bool throw_validation = false;

    void enable_validation_gate() const {
        std::lock_guard<std::mutex> lock(gate_mutex_);
        gate_enabled_ = true;
        gate_entered_ = false;
        gate_released_ = false;
    }

    bool wait_for_validation() const {
        std::unique_lock<std::mutex> lock(gate_mutex_);
        return gate_cv_.wait_for(lock, std::chrono::seconds(5), [&] { return gate_entered_; });
    }

    void release_validation() const {
        std::lock_guard<std::mutex> lock(gate_mutex_);
        gate_enabled_ = false;
        gate_released_ = true;
        gate_cv_.notify_all();
    }

protected:
    cpr::Response make_post_request(const std::string&, const cpr::Header&, const cpr::Body&) const override {
        ++delivery_calls;
        return delivery_response;
    }

    cpr::Response make_get_request(const std::string&) const override {
        ++validation_calls;
        {
            std::unique_lock<std::mutex> lock(gate_mutex_);
            if (gate_enabled_) {
                gate_entered_ = true;
                gate_cv_.notify_all();
                gate_cv_.wait(lock, [&] { return gate_released_; });
            }
        }

        if (throw_validation) {
            throw std::runtime_error("B59_PROVIDER_EXCEPTION");
        }
        return validation_response;
    }

private:
    mutable std::mutex gate_mutex_;
    mutable std::condition_variable gate_cv_;
    mutable bool gate_enabled_ = false;
    mutable bool gate_entered_ = false;
    mutable bool gate_released_ = false;
};

cpr::Response response(int status, const std::string& body,
                       cpr::ErrorCode error = cpr::ErrorCode::OK) {
    cpr::Response result;
    result.error = cpr::Error{};
    result.error.code = error;
    result.status_code = status;
    result.text = body;
    return result;
}

class HashHookScope {
public:
    explicit HashHookScope(std::atomic<int>& count) {
        AuthService::set_password_hash_test_hook([&count] { ++count; });
    }

    ~HashHookScope() { AuthService::clear_password_hash_test_hook(); }

    HashHookScope(const HashHookScope&) = delete;
    HashHookScope& operator=(const HashHookScope&) = delete;
};

struct B59RegistrationScenario {
    DatabasePool pool{2, get_secure_conn_string()};
    B59EmailService email;
    AuthService auth{"b59-test-pepper", "b59-test-secret", &email};
    FolderManager folders{pool};
    ApiRouter router{pool, auth, folders};
    const std::string prefix;
    const std::string registration_ip = "198.51.100.190";

    explicit B59RegistrationScenario(std::string name)
        : prefix("b59_" + std::move(name) + "_") {
        clear_users();
    }

    ~B59RegistrationScenario() {
        try {
            clear_users();
        } catch (...) {
        }
    }

    void clear_users() {
        auto connection = pool.acquire_connection();
        pqxx::work transaction(*connection);
        transaction.exec("DELETE FROM users WHERE username LIKE $1", pqxx::params{prefix + "%"});
        transaction.commit();
    }

    bool user_exists(const std::string& username) {
        auto connection = pool.acquire_connection();
        pqxx::nontransaction transaction(*connection);
        return !transaction.exec(
            "SELECT id FROM users WHERE username = $1",
            pqxx::params{username}).empty();
    }
};

struct RegistrationResult {
    bool success = false;
    int user_id = 0;
    std::string error;
};

RegistrationResult register_direct(
    B59RegistrationScenario& scenario, const std::string& username, const std::string& email) {
    RegistrationResult result;
    try {
        result.user_id = scenario.auth.register_user(
            username, email, "b59-password", scenario.registration_ip);
        result.success = true;
    } catch (const std::exception& error) {
        result.error = error.what();
    } catch (...) {
        result.error = "unknown exception";
    }
    return result;
}

crow::request registration_request(const std::string& username, const std::string& email,
                                   const std::string& ip) {
    crow::request request;
    request.remote_ip_address = ip;
    request.body = "{\"username\":\"" + username + "\",\"email\":\"" + email +
                   "\",\"password\":\"b59-password\"}";
    return request;
}

} // namespace

TEST_CASE("B.59 direct validator classifies tri-state outcomes", "[b59][email][service][policy]") {
    B59EmailService service;

    SECTION("recognized positive response is Accepted") {
        service.validation_response = response(200, R"({
            "email_deliverability": {"status": "deliverable", "is_smtp_valid": true, "is_mx_valid": true},
            "email_quality": {"score": 0.95, "is_disposable": false},
            "email_risk": {"address_risk_status": "low"}
        })");
        REQUIRE(service.validate_email_via_api("user@gmail.com") == EmailValidationResult::Accepted);
    }

    SECTION("partial recognized positive response is Accepted") {
        service.validation_response = response(200, R"({
            "email_quality": {"is_disposable": false}
        })");
        REQUIRE(service.validate_email_via_api("user@example.com") == EmailValidationResult::Accepted);
    }

    SECTION("recognized negative response is Rejected") {
        service.validation_response = response(200, R"({
            "email_quality": {"is_disposable": false},
            "email_deliverability": {"is_mx_valid": false}
        })");
        REQUIRE(service.validate_email_via_api("user@example.com") == EmailValidationResult::Rejected);
    }

    SECTION("all existing negative signals are Rejected") {
        for (const auto& body : {
                 R"({"email_quality":{"is_disposable":true}})",
                 R"({"email_quality":{"score":0.1}})",
                 R"({"email_deliverability":{"status":"Undeliverable"}})",
                 R"({"email_deliverability":{"is_smtp_valid":false}})",
                 R"({"email_deliverability":{"is_mx_valid":false}})",
                 R"({"email_risk":{"address_risk_status":"HIGH"}})"}) {
            service.validation_response = response(200, body);
            REQUIRE(service.validate_email_via_api("user@example.com") == EmailValidationResult::Rejected);
        }
    }

    SECTION("non-2xx statuses are Unavailable") {
        for (const int status : {400, 401, 403, 404, 408, 429, 500, 502, 503}) {
            service.validation_response = response(status, "provider error");
            REQUIRE(service.validate_email_via_api("user@gmail.com") == EmailValidationResult::Unavailable);
        }
    }

    SECTION("network error and status zero are Unavailable") {
        service.validation_response = response(0, "", cpr::Error{CURLE_COULDNT_CONNECT, {}}.code);
        REQUIRE(service.validate_email_via_api("user@gmail.com") == EmailValidationResult::Unavailable);
        service.validation_response = response(0, "");
        REQUIRE(service.validate_email_via_api("user@gmail.com") == EmailValidationResult::Unavailable);
    }

    SECTION("malformed, empty and unknown-only payloads are Unavailable") {
        for (const auto& body : {"not json", "{}", R"({"foo":"bar"})", "[]", "null", "42"}) {
            service.validation_response = response(200, body);
            REQUIRE(service.validate_email_via_api("user@gmail.com") == EmailValidationResult::Unavailable);
        }
    }

    SECTION("malformed recognized fields are Unavailable") {
        for (const auto& body : {
                 R"({"email_quality":{"is_disposable":"false"}})",
                 R"({"email_quality":{"score":"banana"}})",
                 R"({"email_deliverability":{"is_mx_valid":"false"}})",
                 R"({"email_risk":{"address_risk_status":false}})",
                 R"({"email_quality":{"is_disposable":{"value":"false"}}})",
                 R"({"email_quality":false})"}) {
            service.validation_response = response(200, body);
            REQUIRE(service.validate_email_via_api("user@gmail.com") == EmailValidationResult::Unavailable);
        }
    }

    SECTION("numeric score strings require a complete finite value") {
        service.validation_response = response(200, R"({"email_quality":{"score":"0.95"}})");
        REQUIRE(service.validate_email_via_api("user@gmail.com") == EmailValidationResult::Accepted);

        for (const auto& body : {
                 R"({"email_quality":{"score":"0.95suffix"}})",
                 R"({"email_quality":{"score":"nan"}})",
                 R"({"email_quality":{"score":"inf"}})"}) {
            service.validation_response = response(200, body);
            REQUIRE(service.validate_email_via_api("user@gmail.com") == EmailValidationResult::Unavailable);
        }
    }

    SECTION("negative evidence wins over malformed evidence") {
        service.validation_response = response(200, R"({
            "email_quality": {"is_disposable": true},
            "email_deliverability": {"is_mx_valid": "garbage"}
        })");
        REQUIRE(service.validate_email_via_api("user@example.com") == EmailValidationResult::Rejected);
    }

    SECTION("positive evidence tolerates unknown fields") {
        service.validation_response = response(200, R"({
            "email_quality": {"is_disposable": false},
            "unknown": {"future_provider_field": true}
        })");
        REQUIRE(service.validate_email_via_api("user@example.com") == EmailValidationResult::Accepted);
    }

    SECTION("empty email is Rejected before provider access") {
        REQUIRE(service.validate_email_via_api("") == EmailValidationResult::Rejected);
        REQUIRE(service.validation_calls == 0);
    }
}

TEST_CASE("B.59 transport exceptions are normalized to Unavailable", "[b59][email][service][policy]") {
    B59EmailService service;
    service.throw_validation = true;

    REQUIRE(service.validate_email_via_api("user@gmail.com") == EmailValidationResult::Unavailable);
    REQUIRE(service.validation_calls == 1);
}

TEST_CASE("B.59 external rejection has truthful registration semantics", "[b59][auth][registration][policy]") {
    B59RegistrationScenario scenario("rejected");
    scenario.email.validation_response = response(200, R"({
        "email_quality": {"is_disposable": false},
        "email_deliverability": {"is_mx_valid": false}
    })");
    scenario.email.delivery_response = response(201, "");
    std::atomic<int> hash_calls{0};
    HashHookScope hash_hook(hash_calls);

    const std::string username = scenario.prefix + "user";
    const auto result = scenario.router.handle_register(
        registration_request(username, username + "@example.com", scenario.registration_ip));

    REQUIRE(result.code == 400);
    REQUIRE(result.body.find("EMAIL_VALIDATION_REJECTED") != std::string::npos);
    REQUIRE(result.body.find("descartavel") == std::string::npos);
    REQUIRE(hash_calls == 0);
    REQUIRE_FALSE(scenario.user_exists(username));
    REQUIRE(scenario.email.delivery_calls == 0);
}

TEST_CASE("B.59 local validation remains authoritative before provider", "[b59][auth][registration][policy]") {
    SECTION("invalid format skips provider, hash and delivery") {
        B59RegistrationScenario scenario("invalid_format");
        std::atomic<int> hash_calls{0};
        HashHookScope hash_hook(hash_calls);

        const std::string username = scenario.prefix + "user";
        const auto result = scenario.router.handle_register(
            registration_request(username, "not-an-email", scenario.registration_ip));

        REQUIRE(result.code == 400);
        REQUIRE(scenario.email.validation_calls == 0);
        REQUIRE(hash_calls == 0);
        REQUIRE_FALSE(scenario.user_exists(username));
        REQUIRE(scenario.email.delivery_calls == 0);
    }

    SECTION("known local disposable domain skips provider, hash and delivery") {
        B59RegistrationScenario scenario("local_disposable");
        std::atomic<int> hash_calls{0};
        HashHookScope hash_hook(hash_calls);

        const std::string username = scenario.prefix + "user";
        const auto result = scenario.router.handle_register(
            registration_request(username, username + "@mailinator.com", scenario.registration_ip));

        REQUIRE(result.code == 400);
        REQUIRE(result.body.find("E-mail descartavel nao permitido") != std::string::npos);
        REQUIRE(scenario.email.validation_calls == 0);
        REQUIRE(hash_calls == 0);
        REQUIRE_FALSE(scenario.user_exists(username));
        REQUIRE(scenario.email.delivery_calls == 0);
    }
}

TEST_CASE("B.59 Accepted validation preserves registration", "[b59][auth][registration][policy]") {
    B59RegistrationScenario scenario("accepted");
    scenario.email.validation_response = response(200, R"({
        "email_deliverability": {"status":"deliverable", "is_smtp_valid":true, "is_mx_valid":true},
        "email_quality": {"score":0.95, "is_disposable":false},
        "email_risk": {"address_risk_status":"low"}
    })");
    scenario.email.delivery_response = response(201, "");
    std::atomic<int> hash_calls{0};
    HashHookScope hash_hook(hash_calls);

    const std::string username = scenario.prefix + "user";
    const auto result = scenario.router.handle_register(
        registration_request(username, username + "@example.com", scenario.registration_ip));

    REQUIRE(result.code == 201);
    REQUIRE(scenario.email.validation_calls == 1);
    REQUIRE(scenario.email.delivery_calls == 1);
    REQUIRE(hash_calls == 1);
    REQUIRE(scenario.user_exists(username));
}

TEST_CASE("B.59 Unavailable validation intentionally degrades before B.58", "[b59][b58][auth][registration][policy]") {
    SECTION("delivery success completes registration") {
        B59RegistrationScenario scenario("unavailable_delivery_success");
        scenario.email.validation_response = response(500, "provider error");
        scenario.email.delivery_response = response(201, "");
        std::atomic<int> hash_calls{0};
        HashHookScope hash_hook(hash_calls);

        const std::string username = scenario.prefix + "user";
        const auto result = scenario.router.handle_register(
            registration_request(username, username + "@example.com", scenario.registration_ip));

        REQUIRE(result.code == 201);
        REQUIRE(scenario.email.validation_calls == 1);
        REQUIRE(scenario.email.delivery_calls == 1);
        REQUIRE(hash_calls == 1);
        REQUIRE(scenario.user_exists(username));
    }

    SECTION("delivery failure preserves B.58 compensation and retry") {
        B59RegistrationScenario scenario("unavailable_delivery_failure");
        scenario.email.validation_response = response(500, "provider error");
        scenario.email.delivery_response = response(500, "delivery error");
        const std::string username = scenario.prefix + "user";
        const std::string email = username + "@example.com";

        const auto failed = scenario.router.handle_register(
            registration_request(username, email, scenario.registration_ip));
        REQUIRE(failed.code == 503);
        REQUIRE(failed.body.find("VERIFICATION_EMAIL_DELIVERY_FAILED") != std::string::npos);
        REQUIRE_FALSE(scenario.user_exists(username));

        scenario.email.delivery_response = response(201, "");
        const auto retried = scenario.router.handle_register(
            registration_request(username, email, scenario.registration_ip));
        REQUIRE(retried.code == 201);
        REQUIRE(scenario.email.validation_calls == 2);
        REQUIRE(scenario.email.delivery_calls == 2);
        REQUIRE(scenario.user_exists(username));
    }

    SECTION("validation transport exception also degrades") {
        B59RegistrationScenario scenario("exception_delivery_success");
        scenario.email.throw_validation = true;
        scenario.email.delivery_response = response(201, "");

        const std::string username = scenario.prefix + "user";
        const auto result = scenario.router.handle_register(
            registration_request(username, username + "@example.com", scenario.registration_ip));

        REQUIRE(result.code == 201);
        REQUIRE(scenario.email.validation_calls == 1);
        REQUIRE(scenario.email.delivery_calls == 1);
        REQUIRE(scenario.user_exists(username));
    }
}

TEST_CASE("B.59 validation holds no application DB lease", "[b59][auth][registration][policy][concurrency]") {
    B59RegistrationScenario scenario("validation_gate");
    scenario.email.validation_response = response(200, "{}");
    scenario.email.delivery_response = response(201, "");
    scenario.email.enable_validation_gate();
    std::atomic<int> hash_calls{0};
    HashHookScope hash_hook(hash_calls);
    RegistrationResult registration;
    std::thread registration_thread([&] {
        registration = register_direct(
            scenario, scenario.prefix + "user", scenario.prefix + "user@example.com");
    });

    const bool entered = scenario.email.wait_for_validation();
    const auto available_before_release = scenario.pool.get_available_count();
    const auto hash_calls_before_release = hash_calls.load();
    scenario.email.release_validation();
    if (registration_thread.joinable()) registration_thread.join();

    REQUIRE(entered);
    REQUIRE(available_before_release == 2);
    REQUIRE(hash_calls_before_release == 0);
    REQUIRE(registration.success);
    REQUIRE(scenario.email.validation_calls == 1);
    REQUIRE(scenario.email.delivery_calls == 1);
}
