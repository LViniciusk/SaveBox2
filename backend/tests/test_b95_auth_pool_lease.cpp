#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers.hpp>

#include "Services/AuthService.hpp"
#include "database/DatabasePool.hpp"
#include "test_helpers.hpp"
#include "utils/RandomIds.hpp"

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <exception>
#include <mutex>
#include <thread>

namespace {

struct B95Scenario {
    DatabasePool pool{1, get_secure_conn_string()};
    MockEmailService email;
    AuthService auth{"b95-synthetic-pepper", "b95-synthetic-secret", &email};
    const std::string username = "b95_" + UuidUtils::generate_uuid_v4();
    const std::string address = username + "@test.invalid";

    B95Scenario() {
        auth.set_database_pool(pool);
        clear_user();
    }

    ~B95Scenario() {
        AuthService::clear_password_verify_test_hook();
        AuthService::clear_password_hash_test_hook();
        try {
            clear_user();
        } catch (...) {
        }
    }

    void clear_user() {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username = $1", pqxx::params{username});
        txn.commit();
    }

    int seed_user(bool verified = true, bool deleted = false) {
        const std::string hash = auth.hash_password("b95-correct-password");
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        const auto result = txn.exec(
            "INSERT INTO users (username, email, password_hash, is_email_verified, deleted_at) "
            "VALUES ($1, $2, $3, $4, CASE WHEN $5 THEN NOW() ELSE NULL END) RETURNING id",
            pqxx::params{username, address, hash, verified, deleted});
        const int id = result[0][0].as<int>();
        txn.commit();
        return id;
    }
};

struct VerifyGate {
    std::mutex mutex;
    std::condition_variable cv;
    bool entered = false;
    bool released = false;
    std::thread worker;

    ~VerifyGate() {
        release_and_join();
        AuthService::clear_password_verify_test_hook();
    }

    void block() {
        std::unique_lock<std::mutex> lock(mutex);
        entered = true;
        cv.notify_all();
        cv.wait(lock, [&] { return released; });
    }

    bool wait_for_entry() {
        std::unique_lock<std::mutex> lock(mutex);
        return cv.wait_for(lock, std::chrono::seconds(5), [&] { return entered; });
    }

    void release_and_join() {
        {
            std::lock_guard<std::mutex> lock(mutex);
            released = true;
        }
        cv.notify_all();
        if (worker.joinable()) worker.join();
    }
};

void check_lease_at_verify(B95Scenario& scenario, int expected_user_id) {
    int user_id = 0;
    std::exception_ptr worker_error;
    VerifyGate gate;
    AuthService::set_password_verify_test_hook([&] { gate.block(); });
    gate.worker = std::thread([&] {
        try {
            user_id = scenario.auth.authenticate_user(scenario.username, "b95-correct-password");
        } catch (...) {
            worker_error = std::current_exception();
        }
    });

    REQUIRE(gate.wait_for_entry());
    // The worker cannot leave verification while this lease count is observed.
    CHECK(scenario.pool.get_available_count() == 1);
    gate.release_and_join();

    if (expected_user_id != 0) {
        if (worker_error) std::rethrow_exception(worker_error);
        CHECK(user_id == expected_user_id);
    } else {
        REQUIRE(worker_error != nullptr);
        CHECK_THROWS_WITH(std::rethrow_exception(worker_error), "INVALID_CREDENTIALS");
    }
    CHECK(scenario.pool.get_available_count() == 1);
}

} // namespace

TEST_CASE("B.95 authenticate_user releases database lease before real password verification",
          "[b95][auth][database][pool][lease][real][regression]") {
    B95Scenario scenario;
    const int user_id = scenario.seed_user();
    check_lease_at_verify(scenario, user_id);
}

TEST_CASE("B.95 authenticate_user releases database lease before dummy password verification",
          "[b95][auth][database][pool][lease][dummy][security][regression]") {
    B95Scenario scenario;
    check_lease_at_verify(scenario, 0);
}

TEST_CASE("B.95 transaction commit does not return the connection lease",
          "[b95][database][pool][lease]") {
    DatabasePool pool{1, get_secure_conn_string()};
    REQUIRE(pool.get_available_count() == 1);
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("SELECT 1");
        txn.commit();
        CHECK(pool.get_available_count() == 0);
    }
    CHECK(pool.get_available_count() == 1);
}

TEST_CASE("B.95 verified credentials work by username and email",
          "[b95][auth][security][functional]") {
    B95Scenario scenario;
    const int user_id = scenario.seed_user();
    std::atomic<int> calls{0};
    AuthService::set_password_verify_test_hook([&] { ++calls; });
    CHECK(scenario.auth.authenticate_user(scenario.username, "b95-correct-password") == user_id);
    CHECK(calls.load() == 1);
    CHECK(scenario.auth.authenticate_user(scenario.address, "b95-correct-password") == user_id);
    CHECK(calls.load() == 2);
}

TEST_CASE("B.95 wrong password preserves INVALID_CREDENTIALS",
          "[b95][auth][security][functional]") {
    B95Scenario scenario;
    scenario.seed_user();
    std::atomic<int> calls{0};
    AuthService::set_password_verify_test_hook([&] { ++calls; });
    CHECK_THROWS_WITH(scenario.auth.authenticate_user(scenario.username, "b95-wrong-password"),
                      "INVALID_CREDENTIALS");
    CHECK(calls.load() == 1);
}

TEST_CASE("B.95 missing account performs exactly one dummy verify",
          "[b95][auth][security][functional]") {
    B95Scenario scenario;
    std::atomic<int> calls{0};
    AuthService::set_password_verify_test_hook([&] { ++calls; });
    CHECK_THROWS_WITH(scenario.auth.authenticate_user(scenario.username, "b95-correct-password"),
                      "INVALID_CREDENTIALS");
    CHECK(calls.load() == 1);
}

TEST_CASE("B.95 unverified account checks correct password before EMAIL_NOT_VERIFIED",
          "[b95][auth][security][functional]") {
    B95Scenario scenario;
    scenario.seed_user(false);
    std::atomic<int> calls{0};
    AuthService::set_password_verify_test_hook([&] { ++calls; });
    CHECK_THROWS_WITH(scenario.auth.authenticate_user(scenario.username, "b95-correct-password"),
                      "EMAIL_NOT_VERIFIED");
    CHECK(calls.load() == 1);
}

TEST_CASE("B.95 unverified account with wrong password preserves INVALID_CREDENTIALS",
          "[b95][auth][security][functional]") {
    B95Scenario scenario;
    scenario.seed_user(false);
    std::atomic<int> calls{0};
    AuthService::set_password_verify_test_hook([&] { ++calls; });
    CHECK_THROWS_WITH(scenario.auth.authenticate_user(scenario.username, "b95-wrong-password"),
                      "INVALID_CREDENTIALS");
    CHECK(calls.load() == 1);
}

TEST_CASE("B.95 soft-deleted credentials are treated as missing",
          "[b95][auth][security][functional]") {
    B95Scenario scenario;
    scenario.seed_user(true, true);
    std::atomic<int> calls{0};
    AuthService::set_password_verify_test_hook([&] { ++calls; });
    CHECK_THROWS_WITH(scenario.auth.authenticate_user(scenario.username, "b95-correct-password"),
                      "INVALID_CREDENTIALS");
    CHECK(calls.load() == 1);
}
