#include <catch2/catch_test_macros.hpp>

#include "database/DatabasePool.hpp"
#include "database/FolderManager.hpp"
#include "storage/FileChunker.hpp"
#include "storage/GarbageCollector.hpp"
#include "test_helpers.hpp"

#include <chrono>
#include <exception>
#include <filesystem>
#include <fstream>
#include <memory>
#include <string>
#include <thread>
#include <vector>

namespace {

constexpr long long B55_DELETE_GATE = 55055001;

struct OperationResult {
    std::string error;
    int deleted_count = 0;
};

bool wait_for_query_lock(const std::string& conn_str, const std::vector<std::string>& fragments) {
    pqxx::connection observer(conn_str);
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (std::chrono::steady_clock::now() < deadline) {
        for (const auto& fragment : fragments) {
            pqxx::nontransaction txn(observer);
            if (!txn.exec(
                "SELECT 1 FROM pg_stat_activity "
                "WHERE pid <> pg_backend_pid() AND state='active' AND wait_event IS NOT NULL "
                "AND wait_event_type <> 'Client' "
                "AND query ILIKE $1 LIMIT 1",
                    pqxx::params{"%" + fragment + "%"}).empty()) {
                return true;
            }
        }
        std::this_thread::yield();
    }
    return false;
}

struct FolderDeleteGate {
    DatabasePool& pool;
    uint64_t target_id;
    std::string function_name;
    std::string trigger_name;
    std::unique_ptr<pqxx::connection> blocker;
    bool held = false;

    FolderDeleteGate(DatabasePool& pool_ref, uint64_t folder_id)
        : pool(pool_ref),
          target_id(folder_id),
          function_name("b55_delete_gate_" + std::to_string(folder_id)),
          trigger_name("b55_delete_trigger_" + std::to_string(folder_id)),
          blocker(std::make_unique<pqxx::connection>(get_secure_conn_string())) {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DROP TRIGGER IF EXISTS " + trigger_name + " ON folders");
        txn.exec("DROP FUNCTION IF EXISTS " + function_name + "()");
        txn.exec(
            "CREATE FUNCTION " + function_name + "() RETURNS trigger LANGUAGE plpgsql AS $$ "
            "BEGIN IF OLD.id = " + std::to_string(target_id) + " THEN "
            "PERFORM pg_advisory_xact_lock(" + std::to_string(B55_DELETE_GATE) + "); END IF; "
            "RETURN OLD; END; $$");
        txn.exec(
            "CREATE TRIGGER " + trigger_name + " BEFORE DELETE ON folders "
            "FOR EACH ROW EXECUTE FUNCTION " + function_name + "()");
        txn.commit();

        pqxx::nontransaction lock_txn(*blocker);
        lock_txn.exec("SELECT pg_advisory_lock($1::bigint)", pqxx::params{B55_DELETE_GATE});
        held = true;
    }

    ~FolderDeleteGate() {
        release();
        try {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            txn.exec("DROP TRIGGER IF EXISTS " + trigger_name + " ON folders");
            txn.exec("DROP FUNCTION IF EXISTS " + function_name + "()");
            txn.commit();
        } catch (...) {
        }
    }

    void release() {
        if (!held) return;
        pqxx::nontransaction unlock_txn(*blocker);
        unlock_txn.exec("SELECT pg_advisory_unlock($1::bigint)", pqxx::params{B55_DELETE_GATE});
        held = false;
    }

    FolderDeleteGate(const FolderDeleteGate&) = delete;
    FolderDeleteGate& operator=(const FolderDeleteGate&) = delete;
};

struct B55Fixture {
    DatabasePool pool;
    FolderManager folders;
    std::filesystem::path storage_root;
    FileChunker chunker;
    std::string username;
    uint64_t user_id = 0;
    uint64_t root_id = 0;
    uint64_t child_id = 0;
    uint64_t file_id = 0;

    explicit B55Fixture(int seed)
        : pool(2, get_secure_conn_string()),
          folders(pool),
          storage_root("./test_storage_b55_" + std::to_string(seed)),
          chunker(storage_root.string()),
          username("b55_" + std::to_string(seed)) {
        std::filesystem::remove_all(storage_root);
        std::filesystem::create_directories(storage_root);

        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username=$1", pqxx::params{username});
        user_id = txn.exec(
            "INSERT INTO users(username,email,password_hash,is_email_verified,used_storage_bytes) "
            "VALUES($1,$2,'hash',TRUE,64) RETURNING id",
            pqxx::params{username, username + "@test.com"})[0][0].as<uint64_t>();
        txn.commit();
    }

    ~B55Fixture() {
        try {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            txn.exec("DELETE FROM pending_external_deletions WHERE external_file_id LIKE 'b55-%'");
            txn.exec("DELETE FROM users WHERE id=$1", pqxx::params{user_id});
            txn.commit();
        } catch (...) {
        }
        std::filesystem::remove_all(storage_root);
    }

    void create_tree(bool with_child = true) {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        root_id = txn.exec(
            "INSERT INTO folders(user_id,encrypted_name,name_hash,deleted_at) "
            "VALUES($1,'root','b55-root',CURRENT_TIMESTAMP) RETURNING id",
            pqxx::params{user_id})[0][0].as<uint64_t>();
        if (with_child) {
            child_id = txn.exec(
                "INSERT INTO folders(user_id,parent_id,encrypted_name,name_hash,deleted_at) "
                "VALUES($1,$2,'child','b55-child',CURRENT_TIMESTAMP) RETURNING id",
                pqxx::params{user_id, root_id})[0][0].as<uint64_t>();
        }
        const auto folder_id = with_child ? child_id : root_id;
        file_id = txn.exec(
            "INSERT INTO files(user_id,folder_id,encrypted_name,name_hash,encrypted_fdk,size_bytes,total_chunks,"
            "is_upload_complete,storage_provider,deleted_at) "
            "VALUES($1,$2,'file','b55-file','fdk',64,1,TRUE,'local',CURRENT_TIMESTAMP) RETURNING id",
            pqxx::params{user_id, folder_id})[0][0].as<uint64_t>();
        txn.commit();
        std::ofstream(storage_root / (std::to_string(file_id) + ".dat"), std::ios::binary)
            << std::string(64, 'x');
    }

    void create_deep_tree() {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        root_id = txn.exec(
            "INSERT INTO folders(user_id,encrypted_name,name_hash,deleted_at) "
            "VALUES($1,'a','b55-a',CURRENT_TIMESTAMP) RETURNING id",
            pqxx::params{user_id})[0][0].as<uint64_t>();
        const auto b = txn.exec(
            "INSERT INTO folders(user_id,parent_id,encrypted_name,name_hash,deleted_at) "
            "VALUES($1,$2,'b','b55-b',CURRENT_TIMESTAMP) RETURNING id",
            pqxx::params{user_id, root_id})[0][0].as<uint64_t>();
        child_id = txn.exec(
            "INSERT INTO folders(user_id,parent_id,encrypted_name,name_hash,deleted_at) "
            "VALUES($1,$2,'c','b55-c',CURRENT_TIMESTAMP) RETURNING id",
            pqxx::params{user_id, b})[0][0].as<uint64_t>();
        file_id = txn.exec(
            "INSERT INTO files(user_id,folder_id,encrypted_name,name_hash,encrypted_fdk,size_bytes,total_chunks,"
            "is_upload_complete,storage_provider,deleted_at) "
            "VALUES($1,$2,'file','b55-deep-file','fdk',64,1,TRUE,'local',CURRENT_TIMESTAMP) RETURNING id",
            pqxx::params{user_id, child_id})[0][0].as<uint64_t>();
        txn.commit();
        std::ofstream(storage_root / (std::to_string(file_id) + ".dat"), std::ios::binary)
            << std::string(64, 'x');
    }

    long long count(const std::string& sql, uint64_t id) {
        auto conn = pool.acquire_connection();
        pqxx::nontransaction txn(*conn);
        return txn.exec(sql, pqxx::params{id})[0][0].as<long long>();
    }

    bool exists(uint64_t id, const std::string& table) {
        return count("SELECT COUNT(*) FROM " + table + " WHERE id=$1", id) == 1;
    }

    bool value(const std::string& sql, uint64_t id) {
        auto conn = pool.acquire_connection();
        pqxx::nontransaction txn(*conn);
        return txn.exec(sql, pqxx::params{id})[0][0].as<bool>();
    }
};

void run_hard_delete(FolderManager& folders, B55Fixture& fixture, uint64_t folder_id, OperationResult& result) {
    try {
        result.deleted_count = static_cast<int>(folders.hard_delete_folder(folder_id, fixture.user_id, &fixture.chunker).size());
    } catch (const std::exception& error) {
        result.error = error.what();
    }
}

void run_batch_hard_delete(
    FolderManager& folders,
    B55Fixture& fixture,
    const std::vector<int>& folder_ids,
    OperationResult& result) {
    try {
        result.deleted_count = folders.batch_hard_delete_folders(
            fixture.user_id, folder_ids, &fixture.chunker).deleted_count;
    } catch (const std::exception& error) {
        result.error = error.what();
    }
}

void run_restore(FolderManager& folders, B55Fixture& fixture, uint64_t folder_id, OperationResult& result) {
    try {
        folders.restore_folder(folder_id, fixture.user_id);
    } catch (const std::exception& error) {
        result.error = error.what();
    }
}

} // namespace

TEST_CASE("B.55 same root hard-delete winner is authoritative", "[b55][folders][trash][restore][hard-delete][race]") {
    B55Fixture fixture(55020);
    fixture.create_tree(false);
    FolderDeleteGate gate(fixture.pool, fixture.root_id);
    OperationResult hard_delete;
    OperationResult restore;

    std::thread hard_thread([&] { run_hard_delete(fixture.folders, fixture, fixture.root_id, hard_delete); });
    const bool hard_waiting = wait_for_query_lock(
        get_secure_conn_string(), {"DELETE FROM folders", "pg_advisory_xact_lock"});
    std::thread restore_thread([&] { run_restore(fixture.folders, fixture, fixture.root_id, restore); });
    const bool restore_waiting = wait_for_query_lock(
        get_secure_conn_string(), {"WITH RECURSIVE ancestors", "UPDATE folders SET parent_id"});

    gate.release();
    if (hard_thread.joinable()) hard_thread.join();
    if (restore_thread.joinable()) restore_thread.join();

    CAPTURE(hard_delete.error, restore.error, restore_waiting);
    CHECK(hard_waiting);
    CHECK(hard_delete.error.empty());
    CHECK(restore.error == "NOT_FOUND");
    CHECK_FALSE(fixture.exists(fixture.root_id, "folders"));
    CHECK_FALSE(fixture.exists(fixture.file_id, "files"));
    CHECK(fixture.count("SELECT used_storage_bytes FROM users WHERE id=$1", fixture.user_id) == 0);
    CHECK_FALSE(std::filesystem::exists(fixture.storage_root / (std::to_string(fixture.file_id) + ".dat")));
}

TEST_CASE("B.55 restore winner prevents a stale hard-delete success", "[b55][folders][trash][restore][hard-delete]") {
    B55Fixture fixture(55021);
    fixture.create_tree(false);

    OperationResult restore;
    run_restore(fixture.folders, fixture, fixture.root_id, restore);
    OperationResult hard_delete;
    run_hard_delete(fixture.folders, fixture, fixture.root_id, hard_delete);

    CHECK(restore.error.empty());
    CHECK(hard_delete.error == "NOT_FOUND");
    CHECK(fixture.exists(fixture.root_id, "folders"));
    CHECK(fixture.exists(fixture.file_id, "files"));
    CHECK(fixture.value("SELECT deleted_at IS NULL FROM folders WHERE id=$1", fixture.root_id));
    CHECK(fixture.count("SELECT used_storage_bytes FROM users WHERE id=$1", fixture.user_id) == 64);
    CHECK(std::filesystem::exists(fixture.storage_root / (std::to_string(fixture.file_id) + ".dat")));
}

TEST_CASE("B.55 trash-tree authority protects descendant restore from ancestor delete", "[b55][folders][trash][restore][hard-delete][race]") {
    B55Fixture fixture(55022);
    fixture.create_deep_tree();
    FolderDeleteGate gate(fixture.pool, fixture.root_id);
    OperationResult hard_delete;
    OperationResult restore;

    std::thread hard_thread([&] { run_hard_delete(fixture.folders, fixture, fixture.root_id, hard_delete); });
    const bool hard_waiting = wait_for_query_lock(
        get_secure_conn_string(), {"DELETE FROM folders", "pg_advisory_xact_lock"});
    std::thread restore_thread([&] { run_restore(fixture.folders, fixture, fixture.child_id, restore); });
    const bool restore_waiting = wait_for_query_lock(
        get_secure_conn_string(), {"WITH RECURSIVE ancestors", "UPDATE folders SET parent_id"});

    gate.release();
    if (hard_thread.joinable()) hard_thread.join();
    if (restore_thread.joinable()) restore_thread.join();

    CAPTURE(hard_delete.error, restore.error, restore_waiting);
    CHECK(hard_waiting);
    CHECK(hard_delete.error.empty());
    CHECK(restore.error == "NOT_FOUND");
    CHECK_FALSE(fixture.exists(fixture.root_id, "folders"));
    CHECK_FALSE(fixture.exists(fixture.child_id, "folders"));
    CHECK_FALSE(fixture.exists(fixture.file_id, "files"));
    CHECK(fixture.count("SELECT used_storage_bytes FROM users WHERE id=$1", fixture.user_id) == 0);
}

TEST_CASE("B.55 restoring a descendant detaches it before ancestor hard-delete", "[b55][folders][trash][restore][hard-delete]") {
    B55Fixture fixture(55023);
    fixture.create_deep_tree();

    OperationResult restore;
    run_restore(fixture.folders, fixture, fixture.child_id, restore);
    OperationResult hard_delete;
    run_hard_delete(fixture.folders, fixture, fixture.root_id, hard_delete);

    CHECK(restore.error.empty());
    CHECK(hard_delete.error.empty());
    CHECK_FALSE(fixture.exists(fixture.root_id, "folders"));
    CHECK(fixture.exists(fixture.child_id, "folders"));
    CHECK(fixture.exists(fixture.file_id, "files"));
    CHECK(fixture.value("SELECT parent_id IS NULL FROM folders WHERE id=$1", fixture.child_id));
    CHECK(fixture.value("SELECT deleted_at IS NULL FROM folders WHERE id=$1", fixture.child_id));
    CHECK(fixture.count("SELECT used_storage_bytes FROM users WHERE id=$1", fixture.user_id) == 64);
    CHECK(std::filesystem::exists(fixture.storage_root / (std::to_string(fixture.file_id) + ".dat")));
}

TEST_CASE("B.55 batch hard-delete and restore share the same authority", "[b55][folders][trash][restore][hard-delete][batch][race]") {
    B55Fixture fixture(55024);
    fixture.create_tree(false);
    FolderDeleteGate gate(fixture.pool, fixture.root_id);
    OperationResult batch;
    OperationResult restore;

    std::thread batch_thread([&] {
        run_batch_hard_delete(
            fixture.folders,
            fixture,
            {static_cast<int>(fixture.root_id), static_cast<int>(fixture.root_id)},
            batch);
    });
    const bool batch_waiting = wait_for_query_lock(
        get_secure_conn_string(), {"DELETE FROM folders", "pg_advisory_xact_lock"});
    std::thread restore_thread([&] { run_restore(fixture.folders, fixture, fixture.root_id, restore); });
    const bool restore_waiting = wait_for_query_lock(
        get_secure_conn_string(), {"WITH RECURSIVE ancestors", "UPDATE folders SET parent_id"});

    gate.release();
    if (batch_thread.joinable()) batch_thread.join();
    if (restore_thread.joinable()) restore_thread.join();

    CAPTURE(batch.error, restore.error, restore_waiting);
    CHECK(batch_waiting);
    CHECK(batch.error.empty());
    CHECK(batch.deleted_count == 1);
    CHECK(restore.error == "NOT_FOUND");
    CHECK_FALSE(fixture.exists(fixture.root_id, "folders"));
    CHECK_FALSE(fixture.exists(fixture.file_id, "files"));
    CHECK(fixture.count("SELECT used_storage_bytes FROM users WHERE id=$1", fixture.user_id) == 0);
}

TEST_CASE("B.55 independent trash trees do not share lifecycle locks", "[b55][folders][trash][hard-delete]") {
    B55Fixture fixture(55025);
    fixture.create_tree(false);
    const auto first_root = fixture.root_id;
    const auto second_root = [&] {
        auto conn = fixture.pool.acquire_connection();
        pqxx::work txn(*conn);
        const auto id = txn.exec(
            "INSERT INTO folders(user_id,encrypted_name,name_hash,deleted_at) "
            "VALUES($1,'other','b55-other',CURRENT_TIMESTAMP) RETURNING id",
            pqxx::params{fixture.user_id})[0][0].as<uint64_t>();
        txn.commit();
        return id;
    }();

    auto blocker = std::make_unique<pqxx::connection>(get_secure_conn_string());
    auto blocker_txn = std::make_unique<pqxx::work>(*blocker);
    CHECK_FALSE(blocker_txn->exec(
        "SELECT id FROM folders WHERE id=$1 FOR UPDATE", pqxx::params{first_root}).empty());

    OperationResult first_delete;
    std::thread first_thread([&] { run_hard_delete(fixture.folders, fixture, first_root, first_delete); });
    const bool first_waiting = wait_for_query_lock(
        get_secure_conn_string(), {"SELECT id", "DELETE FROM files"});

    OperationResult second_delete;
    run_hard_delete(fixture.folders, fixture, second_root, second_delete);
    blocker_txn->commit();
    if (first_thread.joinable()) first_thread.join();

    CHECK(first_waiting);
    CHECK(first_delete.error.empty());
    CHECK(second_delete.error.empty());
    CHECK_FALSE(fixture.exists(first_root, "folders"));
    CHECK_FALSE(fixture.exists(second_root, "folders"));
}

TEST_CASE("B.55 restore preserves deleted-parent and active-parent semantics", "[b55][folders][trash][restore]") {
    B55Fixture fixture(55026);
    fixture.create_tree(true);

    OperationResult restore;
    run_restore(fixture.folders, fixture, fixture.child_id, restore);

    CHECK(restore.error.empty());
    CHECK(fixture.value("SELECT deleted_at IS NOT NULL FROM folders WHERE id=$1", fixture.root_id));
    CHECK(fixture.value("SELECT deleted_at IS NULL FROM folders WHERE id=$1", fixture.child_id));
    CHECK(fixture.value("SELECT parent_id IS NULL FROM folders WHERE id=$1", fixture.child_id));

    uint64_t active_parent = 0;
    uint64_t active_child = 0;
    {
        auto conn = fixture.pool.acquire_connection();
        pqxx::work txn(*conn);
        active_parent = txn.exec(
            "INSERT INTO folders(user_id,encrypted_name,name_hash) VALUES($1,'active','b55-active') RETURNING id",
            pqxx::params{fixture.user_id})[0][0].as<uint64_t>();
        active_child = txn.exec(
            "INSERT INTO folders(user_id,parent_id,encrypted_name,name_hash,deleted_at) "
            "VALUES($1,$2,'active-child','b55-active-child',CURRENT_TIMESTAMP) RETURNING id",
            pqxx::params{fixture.user_id, active_parent})[0][0].as<uint64_t>();
        txn.commit();
    }
    OperationResult active_restore;
    run_restore(fixture.folders, fixture, active_child, active_restore);
    CHECK(active_restore.error.empty());
    auto verify = fixture.pool.acquire_connection();
    pqxx::nontransaction verify_txn(*verify);
    CHECK(verify_txn.exec(
        "SELECT parent_id=$1 FROM folders WHERE id=$2", pqxx::params{active_parent, active_child})[0][0].as<bool>());
}

TEST_CASE("B.55 Google cleanup is created only by the hard-delete winner", "[b55][folders][trash][hard-delete][google]") {
    B55Fixture fixture(55028);
    fixture.create_tree(false);
    uint64_t storage_id = 0;
    const std::string external_file_id = "b55-google-external";
    {
        auto conn = fixture.pool.acquire_connection();
        pqxx::work txn(*conn);
        storage_id = txn.exec(
            "INSERT INTO user_external_storages(user_id,provider,account_email,refresh_token,root_folder_id) "
            "VALUES($1,'google_drive',$2,'refresh','root') RETURNING id",
            pqxx::params{fixture.user_id, fixture.username + "@google.test"})[0][0].as<uint64_t>();
        txn.exec(
            "INSERT INTO files(user_id,folder_id,encrypted_name,name_hash,encrypted_fdk,size_bytes,total_chunks,"
            "is_upload_complete,storage_provider,external_file_id,external_storage_id,deleted_at) "
            "VALUES($1,$2,'google','b55-google-file','fdk',4096,1,TRUE,'google_drive',$3,$4,CURRENT_TIMESTAMP)",
            pqxx::params{fixture.user_id, fixture.root_id, external_file_id, storage_id});
        txn.exec("UPDATE users SET used_storage_bytes=2112 WHERE id=$1", pqxx::params{fixture.user_id});
        txn.commit();
    }

    const auto external_files = fixture.folders.hard_delete_folder(
        fixture.root_id, fixture.user_id, &fixture.chunker);

    REQUIRE(external_files.size() == 1);
    CHECK(external_files[0] == external_file_id);
    CHECK(fixture.count("SELECT used_storage_bytes FROM users WHERE id=$1", fixture.user_id) == 0);

    auto conn = fixture.pool.acquire_connection();
    pqxx::nontransaction txn(*conn);
    CHECK(txn.exec(
        "SELECT COUNT(*) FROM pending_external_deletions WHERE external_file_id=$1",
        pqxx::params{external_file_id})[0][0].as<int>() == 1);
    CHECK(txn.exec(
        "SELECT COUNT(*) FROM user_external_storages WHERE id=$1",
        pqxx::params{storage_id})[0][0].as<int>() == 1);
}

TEST_CASE("B.55 GC same-folder race does not produce restore success after delete", "[b55][folders][trash][restore][gc][race]") {
    B55Fixture fixture(55027);
    fixture.create_tree(false);
    {
        auto conn = fixture.pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("UPDATE folders SET deleted_at=NOW()-INTERVAL '31 days' WHERE id=$1", pqxx::params{fixture.root_id});
        txn.commit();
    }

    GarbageCollector gc(fixture.pool, &fixture.chunker);
    auto blocker = std::make_unique<pqxx::connection>(get_secure_conn_string());
    auto blocker_txn = std::make_unique<pqxx::work>(*blocker);
    CHECK_FALSE(blocker_txn->exec(
        "SELECT id FROM folders WHERE id=$1 FOR UPDATE", pqxx::params{fixture.root_id}).empty());

    std::thread gc_thread([&] { gc.run_cleanup(); });
    const bool gc_waiting = wait_for_query_lock(get_secure_conn_string(), {"DELETE FROM folders"});
    OperationResult restore;
    std::thread restore_thread([&] { run_restore(fixture.folders, fixture, fixture.root_id, restore); });
    const bool restore_waiting = wait_for_query_lock(
        get_secure_conn_string(), {"SELECT id, parent_id, name_hash", "UPDATE folders SET parent_id"});

    blocker_txn->commit();
    if (gc_thread.joinable()) gc_thread.join();
    if (restore_thread.joinable()) restore_thread.join();

    CAPTURE(gc_waiting, restore_waiting, restore.error);
    CHECK(gc_waiting);
    CHECK(restore.error == "NOT_FOUND");
    CHECK_FALSE(fixture.exists(fixture.root_id, "folders"));
}
