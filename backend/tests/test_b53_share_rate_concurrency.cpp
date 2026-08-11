#include <catch2/catch_test_macros.hpp>

#include "Services/AuthService.hpp"
#include "controllers/ApiRouter.hpp"
#include "database/DatabasePool.hpp"
#include "database/FileManager.hpp"
#include "database/FolderManager.hpp"
#include "test_helpers.hpp"
#include "utils/RandomIds.hpp"

#include <chrono>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <pqxx/pqxx>
#include <string>
#include <thread>
#include <vector>

namespace {

constexpr long long B53_TEST_GATE_KEY = 53053053;

struct ShareResult {
    int code = 0;
    std::string body;
    std::string error;
};

struct ShareState {
    int hourly_changes = 0;
    std::string share_uuid;
    std::string encrypted_name_fdk;
};

struct B53Scenario {
    const std::string conn_str;
    DatabasePool pool;
    MockEmailService email;
    AuthService auth;
    FolderManager folders;
    FileManager files;
    ApiRouter router;
    const std::string prefix;
    uint64_t user_id = 0;
    std::vector<uint64_t> file_ids;
    std::string token;

    explicit B53Scenario(const std::string& suffix, int file_count = 1)
        : conn_str(get_secure_conn_string()),
          pool(2, conn_str),
          email(),
          auth("B53_test_pepper", "B53_test_secret", &email),
          folders(pool),
          files(pool),
          router(pool, auth, folders, &files),
          prefix("b53_" + suffix + "_") {
        auth.set_database_pool(pool);

        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username LIKE $1", pqxx::params{prefix + "%"});
        user_id = txn.exec(
            "INSERT INTO users (username, email, password_hash, is_email_verified) "
            "VALUES ($1, $2, 'b53-hash', TRUE) RETURNING id",
            pqxx::params{prefix + "user", prefix + "user@test.com"})[0][0].as<uint64_t>();

        for (int index = 0; index < file_count; ++index) {
            const auto file_id = txn.exec(
                "INSERT INTO files (user_id, encrypted_name, name_hash, encrypted_fdk, size_bytes, "
                "total_chunks, is_upload_complete, storage_provider) "
                "VALUES ($1, $2, $3, 'b53-fdk', 15, 1, TRUE, 'local') RETURNING id",
                pqxx::params{user_id, "b53-file-" + std::to_string(index),
                             "b53-hash-" + std::to_string(index)})[0][0].as<uint64_t>();
            file_ids.push_back(file_id);
            txn.exec(
                "INSERT INTO shared_links (file_id, share_uuid, encrypted_name_fdk, hourly_changes, last_changed_at) "
                "VALUES ($1, $2, $3, 9, CURRENT_TIMESTAMP)",
                pqxx::params{file_id, "B53S" + std::to_string(index), "b53-seed-fdk"});
        }
        txn.commit();

        token = auth.generate_token(user_id);
    }

    ~B53Scenario() {
        try {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            txn.exec("DELETE FROM users WHERE id = $1", pqxx::params{user_id});
            txn.commit();
        } catch (...) {
        }
    }

    ShareResult share(uint64_t file_id, const std::string& generated_token,
                      const std::string& encrypted_name_fdk) {
        crow::request request;
        request.method = crow::HTTPMethod::Post;
        request.url = "/files/" + std::to_string(file_id) + "/share";
        request.add_header("Authorization", "Bearer " + token);
        request.body = "{\"encrypted_name_fdk\":\"" + encrypted_name_fdk + "\"}";

        try {
            Base62Generator::test_next_token() = generated_token;
            const auto response = router.handle_share_file(request, static_cast<int>(file_id));
            return {response.code, response.body, {}};
        } catch (const std::exception& error) {
            return {0, {}, error.what()};
        } catch (...) {
            return {0, {}, "unknown exception"};
        }
    }

    ShareState state(uint64_t file_id) {
        auto conn = pool.acquire_connection();
        pqxx::nontransaction txn(*conn);
        const auto row = txn.exec(
            "SELECT hourly_changes, share_uuid, encrypted_name_fdk FROM shared_links WHERE file_id = $1",
            pqxx::params{file_id});
        REQUIRE_FALSE(row.empty());
        return {row[0][0].as<int>(), row[0][1].as<std::string>(), row[0][2].as<std::string>()};
    }
};

class B53ShareInsertGate {
public:
    B53ShareInsertGate(B53Scenario& scenario, uint64_t target_file_id)
        : scenario_(scenario), target_file_id_(target_file_id) {
        auto conn = scenario_.pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DROP TRIGGER IF EXISTS b53_share_insert_gate_trigger ON shared_links");
        txn.exec("DROP FUNCTION IF EXISTS b53_share_insert_gate()");
        txn.exec(
            "CREATE FUNCTION b53_share_insert_gate() RETURNS trigger LANGUAGE plpgsql AS $$ "
            "BEGIN IF NEW.file_id = " + std::to_string(target_file_id_) +
            " THEN PERFORM pg_advisory_xact_lock(53053053); END IF; "
            "RETURN NEW; END; $$");
        txn.exec(
            "CREATE TRIGGER b53_share_insert_gate_trigger BEFORE INSERT ON shared_links "
            "FOR EACH ROW EXECUTE FUNCTION b53_share_insert_gate()");
        txn.commit();

        blocker_ = std::make_unique<pqxx::connection>(scenario_.conn_str);
        pqxx::nontransaction blocker(*blocker_);
        blocker.exec("SELECT pg_advisory_lock($1::bigint)", pqxx::params{B53_TEST_GATE_KEY});
        locked_ = true;
    }

    ~B53ShareInsertGate() {
        try {
            release();
            auto conn = scenario_.pool.acquire_connection();
            pqxx::work txn(*conn);
            txn.exec("DROP TRIGGER IF EXISTS b53_share_insert_gate_trigger ON shared_links");
            txn.exec("DROP FUNCTION IF EXISTS b53_share_insert_gate()");
            txn.commit();
        } catch (...) {
        }
    }

    void release() {
        if (!locked_) return;
        pqxx::nontransaction blocker(*blocker_);
        blocker.exec("SELECT pg_advisory_unlock($1::bigint)", pqxx::params{B53_TEST_GATE_KEY});
        locked_ = false;
    }

    B53ShareInsertGate(const B53ShareInsertGate&) = delete;
    B53ShareInsertGate& operator=(const B53ShareInsertGate&) = delete;

private:
    B53Scenario& scenario_;
    uint64_t target_file_id_;
    std::unique_ptr<pqxx::connection> blocker_;
    bool locked_ = false;
};

bool wait_for_share_lock_waiters(const std::string& conn_str, int expected) {
    pqxx::connection observer_connection(conn_str);
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (std::chrono::steady_clock::now() < deadline) {
        pqxx::nontransaction observer(observer_connection);
        const auto waiting = observer.exec(
            "SELECT count(*) FROM pg_stat_activity "
            "WHERE datname = current_database() AND pid <> pg_backend_pid() "
            "AND state = 'active' AND wait_event_type = 'Lock' AND query ILIKE $1",
            pqxx::params{"%INSERT INTO shared_links%"});
        if (waiting[0][0].as<int>() >= expected) return true;
        std::this_thread::yield();
    }
    return false;
}

} // namespace

TEST_CASE("B.53 same-file share rate limit is concurrency authoritative", "[b53][files][share][regression][race]") {
    B53Scenario scenario("same");
    B53ShareInsertGate gate(scenario, scenario.file_ids[0]);
    ShareResult first;
    ShareResult second;

    std::thread first_thread([&] {
        first = scenario.share(scenario.file_ids[0], "B53A01A", "b53-wrapped-a");
    });
    const bool first_waiting = wait_for_share_lock_waiters(scenario.conn_str, 1);

    std::thread second_thread([&] {
        second = scenario.share(scenario.file_ids[0], "B53B01B", "b53-wrapped-b");
    });
    const bool both_waiting = wait_for_share_lock_waiters(scenario.conn_str, 2);

    gate.release();
    first_thread.join();
    second_thread.join();

    REQUIRE(first_waiting);
    REQUIRE(both_waiting);
    CHECK((first.code == 200 ? 1 : 0) + (second.code == 200 ? 1 : 0) == 1);
    CHECK((first.code == 429 ? 1 : 0) + (second.code == 429 ? 1 : 0) == 1);
    CHECK(first.error.empty());
    CHECK(second.error.empty());

    const auto state = scenario.state(scenario.file_ids[0]);
    CHECK(state.hourly_changes == 10);
    const bool first_won = first.code == 200;
    CHECK(state.share_uuid == (first_won ? "B53A01A" : "B53B01B"));
    CHECK(state.encrypted_name_fdk == (first_won ? "b53-wrapped-a" : "b53-wrapped-b"));
}

TEST_CASE("B.53 different-file share mutations remain independent", "[b53][files][share][regression][parallel]") {
    B53Scenario scenario("different", 2);
    B53ShareInsertGate gate(scenario, scenario.file_ids[0]);
    ShareResult blocked;
    ShareResult independent;
    std::mutex result_mutex;
    std::condition_variable result_cv;
    bool independent_done = false;

    std::thread blocked_thread([&] {
        blocked = scenario.share(scenario.file_ids[0], "B53C01C", "b53-wrapped-c");
    });
    const bool blocked_waiting = wait_for_share_lock_waiters(scenario.conn_str, 1);

    std::thread independent_thread([&] {
        independent = scenario.share(scenario.file_ids[1], "B53D01D", "b53-wrapped-d");
        {
            std::lock_guard<std::mutex> lock(result_mutex);
            independent_done = true;
        }
        result_cv.notify_one();
    });

    std::unique_lock<std::mutex> lock(result_mutex);
    const bool independent_completed = result_cv.wait_for(
        lock, std::chrono::seconds(5), [&] { return independent_done; });
    lock.unlock();

    gate.release();
    blocked_thread.join();
    independent_thread.join();

    REQUIRE(blocked_waiting);
    REQUIRE(independent_completed);
    REQUIRE(blocked.code == 200);
    REQUIRE(independent.code == 200);
    REQUIRE(blocked.error.empty());
    REQUIRE(independent.error.empty());
    REQUIRE(scenario.state(scenario.file_ids[0]).hourly_changes == 10);
    REQUIRE(scenario.state(scenario.file_ids[1]).hourly_changes == 10);
}
