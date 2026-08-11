#include <catch2/catch_test_macros.hpp>

#include "Services/AuthService.hpp"
#include "database/DatabasePool.hpp"
#include "test_helpers.hpp"

#include <chrono>
#include <condition_variable>
#include <exception>
#include <mutex>
#include <pqxx/pqxx>
#include <string>
#include <thread>

namespace {

constexpr const char* B51_IP = "198.51.100.51";

struct RegistrationResult {
    bool success = false;
    bool rate_limited = false;
    std::string error;
};

struct B51Scenario {
    const std::string conn_str;
    DatabasePool pool;
    MockEmailService email;
    AuthService auth;
    const std::string prefix;

    explicit B51Scenario(const std::string& suffix)
        : conn_str(get_secure_conn_string()),
          pool(2, conn_str),
          email(),
          auth("B51_test_pepper", "B51_test_secret", &email),
          prefix("b51_" + suffix + "_") {
        auth.set_database_pool(pool);

        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        // B.51 owns this username namespace; clear stale rows left by an aborted process
        // before asserting the rate-limit count for the fixed diagnostic IP.
        txn.exec("DELETE FROM users WHERE username LIKE 'b51_%'");
        txn.exec(
            "INSERT INTO users (username, email, password_hash, is_email_verified, registration_ip) "
            "VALUES ($1, $2, 'b51-hash', TRUE, $3), ($4, $5, 'b51-hash', TRUE, $3)",
            pqxx::params{prefix + "seed_a", prefix + "seed_a@test.com", B51_IP,
                         prefix + "seed_b", prefix + "seed_b@test.com"});
        txn.commit();
    }

    ~B51Scenario() {
        try {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            txn.exec("DELETE FROM users WHERE username LIKE $1", pqxx::params{prefix + "%"});
            txn.commit();
        } catch (...) {
        }
    }

    int recent_count(const std::string& ip) {
        auto conn = pool.acquire_connection();
        pqxx::nontransaction txn(*conn);
        return txn.exec(
            "SELECT count(*) FROM users WHERE registration_ip = $1 "
            "AND created_at > NOW() - INTERVAL '24 hours'",
            pqxx::params{ip})[0][0].as<int>();
    }
};

class B51RegistrationIpBlocker {
public:
    B51RegistrationIpBlocker(const std::string& conn_str, const std::string& ip)
        : connection_(conn_str), ip_(ip) {
        pqxx::nontransaction transaction(connection_);
        transaction.exec(
            "SELECT pg_advisory_lock("
            "hashtextextended('nanika:register-ip:' || $1, 0))",
            pqxx::params{ip_});
        locked_ = true;
    }

    ~B51RegistrationIpBlocker() {
        try {
            release();
        } catch (...) {
        }
    }

    void release() {
        if (!locked_) {
            return;
        }

        pqxx::nontransaction transaction(connection_);
        transaction.exec(
            "SELECT pg_advisory_unlock("
            "hashtextextended('nanika:register-ip:' || $1, 0))",
            pqxx::params{ip_});
        locked_ = false;
    }

    B51RegistrationIpBlocker(const B51RegistrationIpBlocker&) = delete;
    B51RegistrationIpBlocker& operator=(const B51RegistrationIpBlocker&) = delete;

private:
    pqxx::connection connection_;
    const std::string ip_;
    bool locked_ = false;
};

struct WaitObservation {
    bool observed = false;
    std::exception_ptr error;
};

WaitObservation wait_for_registration_ip_waiters(
    const std::string& conn_str, int expected) {
    WaitObservation result;
    try {
        pqxx::connection observer_connection(conn_str);
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
        while (std::chrono::steady_clock::now() < deadline) {
            pqxx::nontransaction observer(observer_connection);
            const auto waiting = observer.exec(
                "SELECT count(*) FROM pg_stat_activity "
                "WHERE datname = current_database() AND pid <> pg_backend_pid() "
                "AND state = 'active' AND wait_event_type = 'Lock' AND query ILIKE $1",
                pqxx::params{"%nanika:register-ip:%"});
            if (waiting[0][0].as<int>() >= expected) {
                result.observed = true;
                return result;
            }
            std::this_thread::yield();
        }
    } catch (...) {
        result.error = std::current_exception();
    }
    return result;
}

RegistrationResult register_user(
    AuthService& auth, const std::string& username, const std::string& email, const std::string& ip) {
    RegistrationResult result;
    try {
        auth.register_user(username, email, "b51-password", ip);
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

TEST_CASE("B.51 same-IP registrations serialize the temporal limit", "[auth][b51][regression]") {
    B51Scenario scenario("same");
    B51RegistrationIpBlocker blocker(scenario.conn_str, B51_IP);
    RegistrationResult first;
    RegistrationResult second;

    std::thread first_thread([&] {
        first = register_user(scenario.auth, scenario.prefix + "race_a", scenario.prefix + "race_a@test.com", B51_IP);
    });
    const auto first_waiting = wait_for_registration_ip_waiters(scenario.conn_str, 1);

    std::thread second_thread([&] {
        second = register_user(scenario.auth, scenario.prefix + "race_b", scenario.prefix + "race_b@test.com", B51_IP);
    });
    const auto both_waiting = wait_for_registration_ip_waiters(scenario.conn_str, 2);

    blocker.release();
    if (first_thread.joinable()) first_thread.join();
    if (second_thread.joinable()) second_thread.join();

    if (first_waiting.error) std::rethrow_exception(first_waiting.error);
    if (both_waiting.error) std::rethrow_exception(both_waiting.error);
    REQUIRE(first_waiting.observed);
    REQUIRE(both_waiting.observed);
    REQUIRE((first.success ? 1 : 0) + (second.success ? 1 : 0) == 1);
    REQUIRE((first.rate_limited ? 1 : 0) + (second.rate_limited ? 1 : 0) == 1);
    REQUIRE(first.error.empty());
    REQUIRE(second.error.empty());
    REQUIRE(scenario.recent_count(B51_IP) == 3);
}

TEST_CASE("B.51 different IPs keep independent admission locks", "[auth][b51][regression]") {
    B51Scenario scenario("different");
    B51RegistrationIpBlocker blocker(scenario.conn_str, B51_IP);
    RegistrationResult first;
    RegistrationResult second;
    std::mutex result_mutex;
    std::condition_variable result_cv;
    bool second_done = false;

    std::thread first_thread([&] {
        first = register_user(scenario.auth, scenario.prefix + "race_a", scenario.prefix + "race_a@test.com", B51_IP);
    });
    const auto first_waiting = wait_for_registration_ip_waiters(scenario.conn_str, 1);

    std::thread second_thread([&] {
        second = register_user(
            scenario.auth, scenario.prefix + "other_ip", scenario.prefix + "other_ip@test.com", "198.51.100.52");
        {
            std::lock_guard<std::mutex> lock(result_mutex);
            second_done = true;
        }
        result_cv.notify_one();
    });

    std::unique_lock<std::mutex> lock(result_mutex);
    const bool second_completed_while_first_blocked = result_cv.wait_for(
        lock, std::chrono::seconds(5), [&] { return second_done; });
    lock.unlock();

    blocker.release();
    if (first_thread.joinable()) first_thread.join();
    if (second_thread.joinable()) second_thread.join();

    if (first_waiting.error) std::rethrow_exception(first_waiting.error);
    REQUIRE(first_waiting.observed);
    REQUIRE(second_completed_while_first_blocked);
    REQUIRE(first.success);
    REQUIRE(second.success);
    REQUIRE(first.error.empty());
    REQUIRE(second.error.empty());
    REQUIRE(scenario.recent_count(B51_IP) == 3);
    REQUIRE(scenario.recent_count("198.51.100.52") == 1);
}
