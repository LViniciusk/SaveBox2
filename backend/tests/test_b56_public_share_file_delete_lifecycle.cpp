#include <catch2/catch_test_macros.hpp>

#include "database/DatabasePool.hpp"
#include "database/FileManager.hpp"
#include "database/FolderManager.hpp"
#include "test_helpers.hpp"
#include "utils/RandomIds.hpp"

#include <chrono>
#include <exception>
#include <memory>
#include <pqxx/pqxx>
#include <string>
#include <thread>

namespace {

constexpr long long B56_TEST_GATE_KEY = 56056001;

struct ShareResult {
    std::string share_uuid;
    std::string error;
};

struct LinkState {
    bool exists = false;
    std::string share_uuid;
    std::string encrypted_name_fdk;
    int hourly_changes = 0;
    std::string last_changed_at;
};

struct B56Fixture {
    const std::string conn_str = get_secure_conn_string();
    DatabasePool pool{2, conn_str};
    FileManager files{pool};
    const std::string prefix;
    uint64_t user_id = 0;
    uint64_t file_id = 0;

    explicit B56Fixture(const std::string& suffix)
        : prefix("b56_" + suffix + "_") {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username LIKE $1", pqxx::params{prefix + "%"});
        user_id = txn.exec(
            "INSERT INTO users (username, email, password_hash, is_email_verified) "
            "VALUES ($1, $2, 'b56-hash', TRUE) RETURNING id",
            pqxx::params{prefix + "user", prefix + "user@test.com"})[0][0].as<uint64_t>();
        file_id = txn.exec(
            "INSERT INTO files (user_id, encrypted_name, name_hash, encrypted_fdk, size_bytes, "
            "total_chunks, is_upload_complete, storage_provider) "
            "VALUES ($1, 'b56-file', 'b56-hash', 'b56-fdk', 15, 1, TRUE, 'local') RETURNING id",
            pqxx::params{user_id})[0][0].as<uint64_t>();
        txn.commit();
    }

    ~B56Fixture() {
        Base62Generator::test_next_token().clear();
        try {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            txn.exec("DELETE FROM users WHERE id = $1", pqxx::params{user_id});
            txn.commit();
        } catch (...) {
        }
    }

    ShareResult share(const std::string& token) {
        Base62Generator::test_next_token() = token;
        try {
            return {files.share_file(file_id, user_id, "b56-wrapped-fdk"), {}};
        } catch (const std::exception& error) {
            return {{}, error.what()};
        } catch (...) {
            return {{}, "unknown exception"};
        }
    }

    void seed_share(const std::string& token, const std::string& encrypted_name_fdk, int hourly_changes = 1) {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec(
            "INSERT INTO shared_links (file_id, share_uuid, encrypted_name_fdk, hourly_changes, last_changed_at) "
            "VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)",
            pqxx::params{file_id, token, encrypted_name_fdk, hourly_changes});
        txn.commit();
    }

    LinkState link_state() {
        auto conn = pool.acquire_connection();
        pqxx::nontransaction txn(*conn);
        const auto rows = txn.exec(
            "SELECT share_uuid, encrypted_name_fdk, hourly_changes, last_changed_at::text "
            "FROM shared_links WHERE file_id = $1",
            pqxx::params{file_id});
        if (rows.empty()) return {};
        return {
            true,
            rows[0][0].as<std::string>(),
            rows[0][1].as<std::string>(),
            rows[0][2].as<int>(),
            rows[0][3].as<std::string>(),
        };
    }

    bool file_deleted() {
        auto conn = pool.acquire_connection();
        pqxx::nontransaction txn(*conn);
        return txn.exec(
            "SELECT deleted_at IS NOT NULL FROM files WHERE id = $1",
            pqxx::params{file_id})[0][0].as<bool>();
    }

    void restore() {
        REQUIRE_NOTHROW(files.restore_file(file_id, user_id));
    }

    bool public_share_available(const std::string& token) {
        try {
            return files.get_shared_file_info(token).file_id == file_id;
        } catch (const std::runtime_error& error) {
            REQUIRE(std::string(error.what()) == "NOT_FOUND");
            return false;
        }
    }
};

class B56ShareInsertGate {
public:
    B56ShareInsertGate(B56Fixture& fixture, uint64_t target_file_id)
        : fixture_(fixture), target_file_id_(target_file_id), blocker_(std::make_unique<pqxx::connection>(fixture.conn_str)) {
        auto conn = fixture_.pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DROP TRIGGER IF EXISTS b56_share_insert_gate_trigger ON shared_links");
        txn.exec("DROP FUNCTION IF EXISTS b56_share_insert_gate()");
        txn.exec(
            "CREATE FUNCTION b56_share_insert_gate() RETURNS trigger LANGUAGE plpgsql AS $$ "
            "BEGIN IF NEW.file_id = " + std::to_string(target_file_id_) +
            " THEN PERFORM pg_advisory_xact_lock(" + std::to_string(B56_TEST_GATE_KEY) + "); END IF; "
            "RETURN NEW; END; $$");
        txn.exec(
            "CREATE TRIGGER b56_share_insert_gate_trigger BEFORE INSERT ON shared_links "
            "FOR EACH ROW EXECUTE FUNCTION b56_share_insert_gate()");
        txn.commit();

        pqxx::nontransaction lock_txn(*blocker_);
        lock_txn.exec("SELECT pg_advisory_lock($1::bigint)", pqxx::params{B56_TEST_GATE_KEY});
        held_ = true;
    }

    ~B56ShareInsertGate() {
        release();
        try {
            auto conn = fixture_.pool.acquire_connection();
            pqxx::work txn(*conn);
            txn.exec("DROP TRIGGER IF EXISTS b56_share_insert_gate_trigger ON shared_links");
            txn.exec("DROP FUNCTION IF EXISTS b56_share_insert_gate()");
            txn.commit();
        } catch (...) {
        }
    }

    void release() {
        if (!held_) return;
        pqxx::nontransaction unlock_txn(*blocker_);
        unlock_txn.exec("SELECT pg_advisory_unlock($1::bigint)", pqxx::params{B56_TEST_GATE_KEY});
        held_ = false;
    }

    B56ShareInsertGate(const B56ShareInsertGate&) = delete;
    B56ShareInsertGate& operator=(const B56ShareInsertGate&) = delete;

private:
    B56Fixture& fixture_;
    uint64_t target_file_id_;
    std::unique_ptr<pqxx::connection> blocker_;
    bool held_ = false;
};

bool wait_for_share_insert_waiter(const std::string& conn_str) {
    pqxx::connection observer_connection(conn_str);
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (std::chrono::steady_clock::now() < deadline) {
        pqxx::nontransaction observer(observer_connection);
        const auto waiting = observer.exec(
            "SELECT count(*) FROM pg_stat_activity "
            "WHERE datname = current_database() AND pid <> pg_backend_pid() "
            "AND state = 'active' AND wait_event_type = 'Lock' AND query ILIKE $1",
            pqxx::params{"%INSERT INTO shared_links%"});
        if (waiting[0][0].as<int>() >= 1) return true;
        std::this_thread::yield();
    }
    return false;
}

bool wait_for_query_lock_waiter(const std::string& conn_str, const std::string& fragment) {
    pqxx::connection observer_connection(conn_str);
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (std::chrono::steady_clock::now() < deadline) {
        pqxx::nontransaction observer(observer_connection);
        const auto waiting = observer.exec(
            "SELECT count(*) FROM pg_stat_activity "
            "WHERE datname = current_database() AND pid <> pg_backend_pid() "
            "AND state = 'active' AND wait_event_type = 'Lock' AND query ILIKE $1",
            pqxx::params{"%" + fragment + "%"});
        if (waiting[0][0].as<int>() >= 1) return true;
        std::this_thread::yield();
    }
    return false;
}

struct DeleteResult {
    std::string error;
};

DeleteResult delete_file(B56Fixture& fixture) {
    try {
        fixture.files.delete_file(fixture.file_id, fixture.user_id);
        return {};
    } catch (const std::exception& error) {
        return {error.what()};
    } catch (...) {
        return {"unknown exception"};
    }
}

} // namespace

TEST_CASE(
    "B.56 delete-first fails closed without creating a public capability",
    "[b56][files][share][delete][race][regression]") {
    B56Fixture fixture("pre");
    REQUIRE_NOTHROW(fixture.files.delete_file(fixture.file_id, fixture.user_id));

    Base62Generator::test_next_token() = "B56A001";
    const auto share_result = fixture.share("B56A001");

    REQUIRE(fixture.file_deleted());
    REQUIRE(share_result.share_uuid.empty());
    REQUIRE(share_result.error == "NOT_FOUND");
    REQUIRE(Base62Generator::test_next_token() == "B56A001");
    REQUIRE_FALSE(fixture.link_state().exists);
    REQUIRE_FALSE(fixture.public_share_available("B56A001"));
}

TEST_CASE(
    "B.56 delete-first does not rotate an existing capability or consume budget",
    "[b56][files][share][delete][rate-limit][regression]") {
    B56Fixture fixture("existing");
    fixture.seed_share("B56OLD1", "b56-old-fdk", 9);
    const auto before = fixture.link_state();

    REQUIRE_NOTHROW(fixture.files.delete_file(fixture.file_id, fixture.user_id));
    const auto share_result = fixture.share("B56NEW1");
    const auto after = fixture.link_state();

    REQUIRE(share_result.error == "NOT_FOUND");
    REQUIRE(after.exists);
    REQUIRE(after.share_uuid == before.share_uuid);
    REQUIRE(after.encrypted_name_fdk == before.encrypted_name_fdk);
    REQUIRE(after.hourly_changes == 9);
    REQUIRE(after.last_changed_at == before.last_changed_at);
    REQUIRE_FALSE(fixture.public_share_available("B56NEW1"));

    fixture.restore();
    REQUIRE(fixture.public_share_available("B56OLD1"));
}

TEST_CASE(
    "B.56 share-first commits before soft-delete and preserves temporary hide/restore",
    "[b56][files][share][delete][restore][race][regression]") {
    B56Fixture fixture("share_first");
    B56ShareInsertGate gate(fixture, fixture.file_id);
    ShareResult share_result;
    DeleteResult delete_result;

    std::thread share_thread([&] {
        share_result = fixture.share("B56B001");
    });
    const bool share_waiter_seen = wait_for_share_insert_waiter(fixture.conn_str);

    std::thread delete_thread;
    bool delete_waiter_seen = false;
    if (share_waiter_seen) {
        delete_thread = std::thread([&] {
            delete_result = delete_file(fixture);
        });
        delete_waiter_seen = wait_for_query_lock_waiter(fixture.conn_str, "UPDATE files SET deleted_at");
    }

    gate.release();
    if (share_thread.joinable()) share_thread.join();
    if (delete_thread.joinable()) delete_thread.join();

    REQUIRE(share_waiter_seen);
    REQUIRE(delete_waiter_seen);
    REQUIRE(share_result.error.empty());
    REQUIRE(share_result.share_uuid == "B56B001");
    REQUIRE(delete_result.error.empty());
    REQUIRE(fixture.file_deleted());
    REQUIRE_FALSE(fixture.public_share_available("B56B001"));

    fixture.restore();
    REQUIRE(fixture.public_share_available("B56B001"));
}

TEST_CASE(
    "B.56 batch soft-delete and folder soft-delete reject a stale share",
    "[b56][files][share][delete][batch][folders][regression]") {
    B56Fixture batch_fixture("batch");
    REQUIRE_NOTHROW(batch_fixture.files.batch_delete_files(
        batch_fixture.user_id, {static_cast<int>(batch_fixture.file_id)}));
    const auto batch_share = batch_fixture.share("B56C001");
    REQUIRE(batch_share.error == "NOT_FOUND");
    REQUIRE_FALSE(batch_fixture.link_state().exists);

    B56Fixture folder_fixture("folder");
    FolderManager folders(folder_fixture.pool);
    uint64_t folder_id = 0;
    {
        auto conn = folder_fixture.pool.acquire_connection();
        pqxx::work txn(*conn);
        folder_id = txn.exec(
            "INSERT INTO folders (user_id, encrypted_name, name_hash) "
            "VALUES ($1, 'b56-folder', 'b56-folder-hash') RETURNING id",
            pqxx::params{folder_fixture.user_id})[0][0].as<uint64_t>();
        txn.exec("UPDATE files SET folder_id = $1 WHERE id = $2",
                 pqxx::params{folder_id, folder_fixture.file_id});
        txn.commit();
    }
    REQUIRE_NOTHROW(folders.delete_folder(folder_id, folder_fixture.user_id));
    const auto folder_share = folder_fixture.share("B56D001");
    REQUIRE(folder_share.error == "NOT_FOUND");
    REQUIRE_FALSE(folder_fixture.link_state().exists);
}

TEST_CASE(
    "B.56 hard-delete winner leaves no stale share mutation",
    "[b56][files][share][delete][hard-delete][regression]") {
    B56Fixture fixture("hard");
    REQUIRE_NOTHROW(fixture.files.delete_file(fixture.file_id, fixture.user_id));
    REQUIRE_NOTHROW(fixture.files.hard_delete_file(fixture.file_id, fixture.user_id, nullptr));

    const auto share_result = fixture.share("B56E001");
    REQUIRE(share_result.error == "NOT_FOUND");
    REQUIRE_FALSE(fixture.link_state().exists);
}

TEST_CASE(
    "B.56 legitimate pre-delete capability remains usable after restore",
    "[b56][files][share][delete][restore][regression]") {
    B56Fixture fixture("legitimate");
    const auto share_result = fixture.share("B56F001");
    REQUIRE(share_result.error.empty());
    REQUIRE(fixture.public_share_available("B56F001"));

    REQUIRE_NOTHROW(fixture.files.delete_file(fixture.file_id, fixture.user_id));
    REQUIRE_FALSE(fixture.public_share_available("B56F001"));
    fixture.restore();
    REQUIRE(fixture.public_share_available("B56F001"));
}

TEST_CASE(
    "B.56 UUID collision retries with a fresh file lifecycle transaction",
    "[b56][files][share][collision][regression]") {
    B56Fixture fixture("collision");
    B56Fixture other("collision_other");
    other.seed_share("B56COL1", "b56-collision-existing");

    const auto first_attempt = fixture.share("B56COL1");
    REQUIRE(first_attempt.error.empty());
    REQUIRE(first_attempt.share_uuid != "B56COL1");
    REQUIRE(fixture.link_state().hourly_changes == 1);
}
