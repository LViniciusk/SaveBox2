#include <catch2/catch_test_macros.hpp>

#include "Services/AuthService.hpp"
#include "database/DatabasePool.hpp"
#include "test_helpers.hpp"

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <exception>
#include <functional>
#include <mutex>
#include <pqxx/pqxx>
#include <string>
#include <thread>

namespace {

class B57EmailService : public EmailService {
public:
    B57EmailService() : EmailService("b57-resend-key", "b57-validation-key") {}

    mutable std::atomic<int> validation_requests{0};
    mutable std::atomic<int> sent_requests{0};

protected:
    cpr::Response make_post_request(const std::string&, const cpr::Header&, const cpr::Body&) const override {
        ++sent_requests;
        cpr::Response response;
        response.error.code = cpr::ErrorCode::OK;
        response.status_code = 200;
        return response;
    }

    cpr::Response make_get_request(const std::string&) const override {
        ++validation_requests;
        cpr::Response response;
        response.error.code = cpr::ErrorCode::OK;
        response.status_code = 200;
        response.text = "{}";
        return response;
    }
};

struct RegistrationResult {
    bool success = false;
    bool rate_limited = false;
    std::string error;
};

struct B57Scenario {
    const std::string conn_str = get_secure_conn_string();
    DatabasePool pool{2, conn_str};
    B57EmailService email;
    AuthService auth{"B57_test_pepper", "B57_test_secret", &email};
    const std::string prefix;
    const std::string registration_ip;

    B57Scenario(const std::string& suffix, std::string ip)
        : prefix("b57_" + suffix + "_"), registration_ip(std::move(ip)) {
        auth.set_database_pool(pool);
        clear_users();
    }

    ~B57Scenario() {
        AuthService::clear_password_hash_test_hook();
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

    void seed_user(const std::string& username, const std::string& email_address, const std::string& ip_override = "") {
        const std::string& ip = ip_override.empty() ? registration_ip : ip_override;
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec(
            "INSERT INTO users (username, email, password_hash, is_email_verified, registration_ip) "
            "VALUES ($1, $2, 'b57-seed-hash', TRUE, $3)",
            pqxx::params{username, email_address, ip});
        txn.commit();
    }

    void seed_registrations(int count, const std::string& ip_override = "") {
        const std::string& ip = ip_override.empty() ? registration_ip : ip_override;
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        for (int index = 0; index < count; ++index) {
            const auto username = prefix + "seed_" + std::to_string(index);
            txn.exec(
                "INSERT INTO users (username, email, password_hash, is_email_verified, registration_ip) "
                "VALUES ($1, $2, 'b57-seed-hash', TRUE, $3)",
                pqxx::params{username, username + "@test.com", ip});
        }
        txn.commit();
    }

    bool user_exists(const std::string& username) {
        auto conn = pool.acquire_connection();
        pqxx::nontransaction txn(*conn);
        return txn.exec(
            "SELECT 1 FROM users WHERE username = $1",
            pqxx::params{username}).size() == 1;
    }

    int recent_count(const std::string& ip_override = "") {
        const std::string& ip = ip_override.empty() ? registration_ip : ip_override;
        auto conn = pool.acquire_connection();
        pqxx::nontransaction txn(*conn);
        return txn.exec(
            "SELECT count(*) FROM users WHERE registration_ip = $1 "
            "AND created_at > NOW() - INTERVAL '24 hours'",
            pqxx::params{ip})[0][0].as<int>();
    }
};

class HashGate {
public:
    void hook() {
        const int entry = entries_.fetch_add(1) + 1;
        if (entry != 1) return;

        std::unique_lock<std::mutex> lock(mutex_);
        condition_.notify_all();
        condition_.wait(lock, [&] { return first_released_; });
    }

    bool wait_for_entries(int count) {
        std::unique_lock<std::mutex> lock(mutex_);
        return condition_.wait_for(lock, std::chrono::seconds(5), [&] {
            return entries_.load() >= count;
        });
    }

    void release_first() {
        std::lock_guard<std::mutex> lock(mutex_);
        first_released_ = true;
        condition_.notify_all();
    }

    int entries() const { return entries_.load(); }

private:
    std::atomic<int> entries_{0};
    std::mutex mutex_;
    std::condition_variable condition_;
    bool first_released_ = false;
};

class HashHookScope {
public:
    explicit HashHookScope(std::function<void()> hook) {
        AuthService::set_password_hash_test_hook(std::move(hook));
    }

    ~HashHookScope() { AuthService::clear_password_hash_test_hook(); }

    HashHookScope(const HashHookScope&) = delete;
    HashHookScope& operator=(const HashHookScope&) = delete;
};

RegistrationResult register_user(
    AuthService& auth, const std::string& username, const std::string& email, const std::string& ip) {
    RegistrationResult result;
    try {
        auth.register_user(username, email, "b57-password", ip);
        result.success = true;
    } catch (const std::runtime_error& error) {
        if (std::string(error.what()) == "TOO_MANY_ACCOUNTS_FROM_IP") {
            result.rate_limited = true;
        } else {
            result.error = error.what();
        }
    } catch (const std::exception& error) {
        result.error = error.what();
    } catch (...) {
        result.error = "unknown exception";
    }
    return result;
}

} // namespace

TEST_CASE("B.57 same-IP hashes no longer hold the registration lease", "[b57][auth][registration][db][concurrency][regression]") {
    B57Scenario scenario("same_ip", "198.51.100.157");
    scenario.seed_registrations(2);
    HashGate gate;
    HashHookScope hook([&] { gate.hook(); });
    RegistrationResult first;
    RegistrationResult second;

    std::thread first_thread([&] {
        first = register_user(
            scenario.auth, scenario.prefix + "race_a", scenario.prefix + "race_a@test.com", scenario.registration_ip);
    });
    const bool first_hash_entered = gate.wait_for_entries(1);

    std::thread second_thread([&] {
        second = register_user(
            scenario.auth, scenario.prefix + "race_b", scenario.prefix + "race_b@test.com", scenario.registration_ip);
    });
    const bool second_hash_entered = first_hash_entered && gate.wait_for_entries(2);

    gate.release_first();
    if (first_thread.joinable()) first_thread.join();
    if (second_thread.joinable()) second_thread.join();

    REQUIRE(first_hash_entered);
    REQUIRE(second_hash_entered);
    REQUIRE(gate.entries() == 2);
    REQUIRE((first.success ? 1 : 0) + (second.success ? 1 : 0) == 1);
    REQUIRE((first.rate_limited ? 1 : 0) + (second.rate_limited ? 1 : 0) == 1);
    REQUIRE(first.error.empty());
    REQUIRE(second.error.empty());
    REQUIRE(scenario.recent_count() == 3);
}

TEST_CASE("B.57 already rate-limited registration hashes zero times", "[b57][auth][registration]") {
    B57Scenario scenario("rate_limit", "198.51.100.158");
    scenario.seed_registrations(3);
    std::atomic<int> hash_calls{0};
    HashHookScope hook([&] { ++hash_calls; });

    const auto result = register_user(
        scenario.auth, scenario.prefix + "rejected", scenario.prefix + "rejected@test.com", scenario.registration_ip);

    REQUIRE_FALSE(result.success);
    REQUIRE(result.rate_limited);
    REQUIRE(result.error.empty());
    REQUIRE(hash_calls.load() == 0);
    REQUIRE(scenario.email.sent_requests.load() == 0);
    REQUIRE_FALSE(scenario.user_exists(scenario.prefix + "rejected"));
    REQUIRE(scenario.recent_count() == 3);
}

TEST_CASE("B.57 duplicate username is rejected before hashing", "[b57][auth][registration]") {
    B57Scenario scenario("duplicate_username", "198.51.100.159");
    scenario.seed_user(scenario.prefix + "existing", scenario.prefix + "existing@test.com");
    std::atomic<int> hash_calls{0};
    HashHookScope hook([&] { ++hash_calls; });

    const auto result = register_user(
        scenario.auth, scenario.prefix + "existing", scenario.prefix + "new@test.com", scenario.registration_ip);

    REQUIRE_FALSE(result.success);
    REQUIRE(result.error == "USER_ALREADY_EXISTS");
    REQUIRE(hash_calls.load() == 0);
    REQUIRE(scenario.email.sent_requests.load() == 0);
}

TEST_CASE("B.57 duplicate email is rejected before hashing", "[b57][auth][registration]") {
    B57Scenario scenario("duplicate_email", "198.51.100.160");
    scenario.seed_user(scenario.prefix + "existing", scenario.prefix + "duplicate@test.com");
    std::atomic<int> hash_calls{0};
    HashHookScope hook([&] { ++hash_calls; });

    const auto result = register_user(
        scenario.auth, scenario.prefix + "new", scenario.prefix + "duplicate@test.com", scenario.registration_ip);

    REQUIRE_FALSE(result.success);
    REQUIRE(result.error == "USER_ALREADY_EXISTS");
    REQUIRE(hash_calls.load() == 0);
    REQUIRE(scenario.email.sent_requests.load() == 0);
}

TEST_CASE("B.57 stale username precheck fails closed", "[b57][auth][registration][concurrency]") {
    B57Scenario scenario("stale_username", "198.51.100.161");
    HashGate gate;
    HashHookScope hook([&] { gate.hook(); });
    RegistrationResult result;

    std::thread registration_thread([&] {
        result = register_user(
            scenario.auth, scenario.prefix + "race", scenario.prefix + "race@test.com", scenario.registration_ip);
    });
    const bool hash_entered = gate.wait_for_entries(1);
    std::exception_ptr seed_error;
    if (hash_entered) {
        try {
            scenario.seed_user(scenario.prefix + "race", scenario.prefix + "winner@test.com");
        } catch (...) {
            seed_error = std::current_exception();
        }
    }
    gate.release_first();
    if (registration_thread.joinable()) registration_thread.join();

    REQUIRE(hash_entered);
    if (seed_error) std::rethrow_exception(seed_error);
    REQUIRE_FALSE(result.success);
    REQUIRE(result.error == "USER_ALREADY_EXISTS");
    REQUIRE(gate.entries() == 1);
    REQUIRE(scenario.email.sent_requests.load() == 0);
    REQUIRE(scenario.user_exists(scenario.prefix + "race"));
}

TEST_CASE("B.57 stale email precheck fails closed", "[b57][auth][registration][concurrency]") {
    B57Scenario scenario("stale_email", "198.51.100.162");
    HashGate gate;
    HashHookScope hook([&] { gate.hook(); });
    RegistrationResult result;

    std::thread registration_thread([&] {
        result = register_user(
            scenario.auth, scenario.prefix + "race", scenario.prefix + "race@test.com", scenario.registration_ip);
    });
    const bool hash_entered = gate.wait_for_entries(1);
    std::exception_ptr seed_error;
    if (hash_entered) {
        try {
            scenario.seed_user(scenario.prefix + "winner", scenario.prefix + "race@test.com");
        } catch (...) {
            seed_error = std::current_exception();
        }
    }
    gate.release_first();
    if (registration_thread.joinable()) registration_thread.join();

    REQUIRE(hash_entered);
    if (seed_error) std::rethrow_exception(seed_error);
    REQUIRE_FALSE(result.success);
    REQUIRE(result.error == "USER_ALREADY_EXISTS");
    REQUIRE(gate.entries() == 1);
    REQUIRE(scenario.email.sent_requests.load() == 0);
    REQUIRE_FALSE(scenario.user_exists(scenario.prefix + "race"));
}

TEST_CASE("B.57 successful registration hashes exactly once", "[b57][auth][registration]") {
    B57Scenario scenario("success", "198.51.100.163");
    std::atomic<int> hash_calls{0};
    HashHookScope hook([&] { ++hash_calls; });

    const auto result = register_user(
        scenario.auth, scenario.prefix + "created", scenario.prefix + "created@test.com", scenario.registration_ip);

    REQUIRE(result.success);
    REQUIRE(result.error.empty());
    REQUIRE(hash_calls.load() == 1);
    REQUIRE(scenario.email.sent_requests.load() == 1);
    REQUIRE(scenario.user_exists(scenario.prefix + "created"));
    REQUIRE(scenario.recent_count() == 1);
}
