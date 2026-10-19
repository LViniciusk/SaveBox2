#include <catch2/catch_test_macros.hpp>
#include "database/FolderManager.hpp"
#include "database/DatabasePool.hpp"
#include "test_helpers.hpp"
#include <pqxx/pqxx>
#include <chrono>
#include <cstdint>
#include <optional>
#include <string>
#include <thread>
#include <unordered_map>
#include <unordered_set>

namespace {

struct MoveResult {
    bool success = false;
    std::string error;
};

struct FolderLockSnapshot {
    int update_waiters = 0;
    int advisory_waiters = 0;
};

FolderLockSnapshot wait_for_folder_move_waiters(const std::string& conn_str) {
    pqxx::connection observer_connection(conn_str);
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    FolderLockSnapshot snapshot;
    while (std::chrono::steady_clock::now() < deadline) {
        pqxx::nontransaction observer(observer_connection);
        const auto row = observer.exec(
            "SELECT count(*) FILTER (WHERE query ILIKE '%UPDATE folders SET parent_id%'), "
            "count(*) FILTER (WHERE query ILIKE '%pg_advisory_xact_lock%') "
            "FROM pg_stat_activity "
            "WHERE datname = current_database() AND pid <> pg_backend_pid() "
            "AND state = 'active' AND wait_event_type = 'Lock'")[0];
        snapshot.update_waiters = row[0].as<int>();
        snapshot.advisory_waiters = row[1].as<int>();
        if (snapshot.update_waiters + snapshot.advisory_waiters >= 2) return snapshot;
        std::this_thread::yield();
    }
    return snapshot;
}

bool active_folder_tree_has_cycle(const std::string& conn_str, uint64_t user_id) {
    pqxx::connection connection(conn_str);
    pqxx::nontransaction txn(connection);
    const auto rows = txn.exec(
        "SELECT id, parent_id FROM folders "
        "WHERE user_id = $1 AND deleted_at IS NULL",
        pqxx::params{user_id});

    std::unordered_map<uint64_t, std::optional<uint64_t>> parents;
    for (const auto& row : rows) {
        parents.emplace(
            row[0].as<uint64_t>(),
            row[1].is_null() ? std::nullopt : std::optional<uint64_t>(row[1].as<uint64_t>()));
    }

    for (const auto& [folder_id, ignored_parent] : parents) {
        (void)ignored_parent;
        std::unordered_set<uint64_t> visited;
        auto current = folder_id;
        while (true) {
            if (!visited.insert(current).second) return true;
            const auto it = parents.find(current);
            if (it == parents.end() || !it->second.has_value()) break;
            current = *it->second;
        }
    }
    return false;
}

MoveResult run_folder_move(FolderManager& manager, uint64_t folder_id, uint64_t user_id, uint64_t parent_id) {
    try {
        manager.update_folder(folder_id, user_id, std::nullopt, std::nullopt, parent_id);
        return {true, {}};
    } catch (const std::exception& error) {
        return {false, error.what()};
    } catch (...) {
        return {false, "unknown exception"};
    }
}

} // namespace




TEST_CASE("Gestão de Pastas - Hierarquia e Cascata", "[folders][hierarchy][cascade]") {
    DatabasePool pool(1, get_secure_conn_string());
    FolderManager manager(pool);

    uint64_t fake_user_id = 0;

    {
        auto conn = pool.acquire_connection();
        pqxx::work W(*conn);
        W.exec("DELETE FROM users WHERE username = 'fantasma_das_pastas';");
        
        auto res = W.exec("INSERT INTO users (username, email, password_hash, is_email_verified) VALUES ('fantasma_das_pastas', 'fantasma_das_pastas@test.com', 'hash_secreto', true) RETURNING id;");
        fake_user_id = res[0][0].as<uint64_t>();
        W.commit();
    }

    SECTION("Criar pasta raiz retorna um ID válido") {
        uint64_t parent_id = manager.create_folder(fake_user_id, std::nullopt, "Pasta Raiz", "hash_pasta_raiz");
        REQUIRE(parent_id > 0);
    }

    SECTION("Criar subpasta dentro de uma pasta existente") {
        uint64_t parent_id = manager.create_folder(fake_user_id, std::nullopt, "Pasta Raiz", "hash_pasta_raiz2");
        REQUIRE(parent_id > 0);

        uint64_t child_id = manager.create_folder(fake_user_id, parent_id, "Subpasta", "hash_subpasta");
        REQUIRE(child_id > 0);
        REQUIRE(child_id != parent_id);
    }

    SECTION("Impedir criação de pastas duplicadas na mesma raiz (Blind Index)") {
        uint64_t id1 = manager.create_folder(fake_user_id, std::nullopt, "Fotos", "hash_fotos");
        REQUIRE(id1 > 0);

        REQUIRE_THROWS_AS(
            manager.create_folder(fake_user_id, std::nullopt, "Fotos_Copia", "hash_fotos"),
            std::runtime_error
        );
    }

    SECTION("Deletar pasta pai remove toda a hierarquia (Cascata)") {
        uint64_t parent_id = manager.create_folder(fake_user_id, std::nullopt, "Pasta Para Deletar", "hash_deletar");    
        uint64_t child_id = manager.create_folder(fake_user_id, parent_id, "Subpasta Filha", "hash_filha");

        REQUIRE_NOTHROW(manager.delete_folder(parent_id, fake_user_id));

        {
            auto conn = pool.acquire_connection();
            pqxx::work W(*conn);
            auto res_parent = W.exec("SELECT count(*) FROM folders WHERE id = $1 AND deleted_at IS NOT NULL", pqxx::params{parent_id});
            auto res_child = W.exec("SELECT count(*) FROM folders WHERE id = $1 AND deleted_at IS NOT NULL", pqxx::params{child_id});
            REQUIRE(res_parent[0][0].as<int>() == 1);
            REQUIRE(res_child[0][0].as<int>() == 1);
        }
    }

    SECTION("Proteção contra SQL Injection (Mass Assignment)") {
        std::string malicious_payload = "' OR 1=1; DROP TABLE folders; --";
        uint64_t parent_id = manager.create_folder(fake_user_id, std::nullopt, malicious_payload, malicious_payload);
        REQUIRE(parent_id > 0);

        auto conn = pool.acquire_connection();
        pqxx::work W(*conn);
        auto res = W.exec("SELECT encrypted_name FROM folders WHERE id = $1", pqxx::params{parent_id});
        REQUIRE(res[0][0].as<std::string>() == malicious_payload);

        auto table_check = W.exec("SELECT count(*) FROM folders");
        REQUIRE(table_check[0][0].as<int>() >= 1);
    }

    {
        auto conn = pool.acquire_connection();
        pqxx::work W(*conn);

        W.exec("DELETE FROM users WHERE id = $1;", pqxx::params{fake_user_id});
        W.commit();
    }
}

TEST_CASE("FolderManager - Pastas fixadas", "[folders][pinned][manager]") {
    DatabasePool pool(2, get_secure_conn_string());
    FolderManager manager(pool);
    const auto suffix = std::to_string(rand());
    const auto username = "manager_pins_" + suffix;
    const auto email = username + "@test.com";
    uint64_t user_id = 0;
    uint64_t other_user_id = 0;

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        user_id = txn.exec(
            "INSERT INTO users (username, email, password_hash, is_email_verified) VALUES ($1, $2, 'hash', true) RETURNING id",
            pqxx::params{username, email}
        )[0][0].as<uint64_t>();
        other_user_id = txn.exec(
            "INSERT INTO users (username, email, password_hash, is_email_verified) VALUES ($1, $2, 'hash', true) RETURNING id",
            pqxx::params{username + "_other", username + "_other@test.com"}
        )[0][0].as<uint64_t>();
        txn.commit();
    }

    const auto root_id = manager.create_folder(user_id, std::nullopt, "root", "manager-pin-root-" + suffix);
    const auto child_id = manager.create_folder(user_id, root_id, "child", "manager-pin-child-" + suffix);
    const auto other_folder_id = manager.create_folder(other_user_id, std::nullopt, "other", "manager-pin-other-" + suffix);

    REQUIRE(manager.get_pinned_folders(user_id).empty());
    REQUIRE_NOTHROW(manager.pin_folder(root_id, user_id));
    REQUIRE_NOTHROW(manager.pin_folder(root_id, user_id));
    REQUIRE_NOTHROW(manager.pin_folder(child_id, user_id));
    REQUIRE_THROWS_AS(manager.pin_folder(other_folder_id, user_id), std::runtime_error);

    auto pins = manager.get_pinned_folders(user_id);
    REQUIRE(pins.size() == 2);
    REQUIRE(pins[0].folder_id == root_id);
    REQUIRE(pins[0].position == 0);
    REQUIRE(pins[1].folder_id == child_id);
    REQUIRE(pins[1].position == 1);

    REQUIRE_NOTHROW(manager.reorder_pinned_folders(user_id, {child_id, root_id}));
    pins = manager.get_pinned_folders(user_id);
    REQUIRE(pins[0].folder_id == child_id);
    REQUIRE(pins[1].folder_id == root_id);
    REQUIRE_THROWS_AS(manager.reorder_pinned_folders(user_id, {root_id}), std::runtime_error);

    REQUIRE_NOTHROW(manager.unpin_folder(child_id, user_id));
    REQUIRE_NOTHROW(manager.unpin_folder(child_id, user_id));
    pins = manager.get_pinned_folders(user_id);
    REQUIRE(pins.size() == 1);
    REQUIRE(pins[0].folder_id == root_id);
    REQUIRE(pins[0].position == 0);

    auto conn = pool.acquire_connection();
    pqxx::work cleanup(*conn);
    cleanup.exec("DELETE FROM users WHERE id IN ($1, $2)", pqxx::params{user_id, other_user_id});
    cleanup.commit();
}

TEST_CASE("B.65 concurrent cross-folder moves cannot commit a cycle", "[folders][concurrency][b65]") {
    const auto conn_str = get_secure_conn_string();
    DatabasePool pool(4, conn_str);
    FolderManager manager(pool);
    const auto suffix = std::to_string(rand());
    const auto username = "b65_cycle_" + suffix;
    const auto email = username + "@test.com";
    uint64_t user_id = 0;

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        user_id = txn.exec(
            "INSERT INTO users (username, email, password_hash, is_email_verified) "
            "VALUES ($1, $2, 'hash', true) RETURNING id",
            pqxx::params{username, email})[0][0].as<uint64_t>();
        txn.commit();
    }

    const auto folder_a = manager.create_folder(user_id, std::nullopt, "a", "b65-a-" + suffix);
    const auto folder_b = manager.create_folder(user_id, std::nullopt, "b", "b65-b-" + suffix);

    pqxx::connection blocker_connection(conn_str);
    pqxx::work blocker(blocker_connection);
    blocker.exec(
        "SELECT id FROM folders WHERE id IN ($1, $2) ORDER BY id FOR UPDATE",
        pqxx::params{folder_a, folder_b});

    MoveResult move_a;
    MoveResult move_b;
    std::thread first([&] { move_a = run_folder_move(manager, folder_a, user_id, folder_b); });
    std::thread second([&] { move_b = run_folder_move(manager, folder_b, user_id, folder_a); });

    const auto waiters = wait_for_folder_move_waiters(conn_str);
    blocker.commit();
    first.join();
    second.join();

    const int success_count = static_cast<int>(move_a.success) + static_cast<int>(move_b.success);
    const int bad_request_count = (!move_a.success && move_a.error == "BAD_REQUEST")
        + (!move_b.success && move_b.error == "BAD_REQUEST");
    const int unexpected_error_count = 2 - success_count - bad_request_count;
    const bool cycle = active_folder_tree_has_cycle(conn_str, user_id);

    {
        auto conn = pool.acquire_connection();
        pqxx::work cleanup(*conn);
        cleanup.exec("DELETE FROM users WHERE id = $1", pqxx::params{user_id});
        cleanup.commit();
    }

    INFO("update waiters: " << waiters.update_waiters);
    INFO("advisory waiters: " << waiters.advisory_waiters);
    INFO("successes: " << success_count);
    INFO("BAD_REQUEST: " << bad_request_count);
    INFO("unexpected errors: " << unexpected_error_count);
    INFO("cycle: " << cycle);
    CHECK(waiters.update_waiters == 1);
    CHECK(waiters.advisory_waiters >= 1);
    CHECK(success_count == 1);
    CHECK(bad_request_count == 1);
    CHECK(unexpected_error_count == 0);
    CHECK_FALSE(cycle);
}

TEST_CASE("B.65 disjoint cross-folder moves cannot commit a multi-node cycle", "[folders][concurrency][b65]") {
    const auto conn_str = get_secure_conn_string();
    DatabasePool pool(4, conn_str);
    FolderManager manager(pool);
    const auto suffix = std::to_string(rand());
    const auto username = "b65_multi_cycle_" + suffix;
    const auto email = username + "@test.com";
    uint64_t user_id = 0;

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        user_id = txn.exec(
            "INSERT INTO users (username, email, password_hash, is_email_verified) "
            "VALUES ($1, $2, 'hash', true) RETURNING id",
            pqxx::params{username, email})[0][0].as<uint64_t>();
        txn.commit();
    }

    const auto folder_a = manager.create_folder(user_id, std::nullopt, "a", "b65-multi-a-" + suffix);
    const auto folder_c = manager.create_folder(user_id, std::nullopt, "c", "b65-multi-c-" + suffix);
    const auto folder_b = manager.create_folder(user_id, folder_c, "b", "b65-multi-b-" + suffix);
    const auto folder_d = manager.create_folder(user_id, folder_a, "d", "b65-multi-d-" + suffix);

    pqxx::connection blocker_connection(conn_str);
    pqxx::work blocker(blocker_connection);
    blocker.exec(
        "SELECT id FROM folders WHERE id IN ($1, $2, $3, $4) ORDER BY id FOR UPDATE",
        pqxx::params{folder_a, folder_b, folder_c, folder_d});

    MoveResult move_a;
    MoveResult move_c;
    std::thread first([&] { move_a = run_folder_move(manager, folder_a, user_id, folder_b); });
    std::thread second([&] { move_c = run_folder_move(manager, folder_c, user_id, folder_d); });

    const auto waiters = wait_for_folder_move_waiters(conn_str);
    blocker.commit();
    first.join();
    second.join();

    const int success_count = static_cast<int>(move_a.success) + static_cast<int>(move_c.success);
    const int bad_request_count = (!move_a.success && move_a.error == "BAD_REQUEST")
        + (!move_c.success && move_c.error == "BAD_REQUEST");
    const int unexpected_error_count = 2 - success_count - bad_request_count;
    const bool cycle = active_folder_tree_has_cycle(conn_str, user_id);
    int active_folder_count = 0;

    {
        auto conn = pool.acquire_connection();
        pqxx::work verify(*conn);
        active_folder_count = verify.exec(
            "SELECT count(*) FROM folders WHERE user_id = $1 AND deleted_at IS NULL",
            pqxx::params{user_id})[0][0].as<int>();
        verify.commit();
    }

    {
        auto conn = pool.acquire_connection();
        pqxx::work cleanup(*conn);
        cleanup.exec("DELETE FROM users WHERE id = $1", pqxx::params{user_id});
        cleanup.commit();
    }

    INFO("update waiters: " << waiters.update_waiters);
    INFO("advisory waiters: " << waiters.advisory_waiters);
    INFO("successes: " << success_count);
    INFO("BAD_REQUEST: " << bad_request_count);
    INFO("unexpected errors: " << unexpected_error_count);
    INFO("active folders: " << active_folder_count);
    INFO("cycle: " << cycle);
    CHECK(waiters.update_waiters == 1);
    CHECK(waiters.advisory_waiters >= 1);
    CHECK(success_count == 1);
    CHECK(bad_request_count == 1);
    CHECK(unexpected_error_count == 0);
    CHECK(active_folder_count == 4);
    CHECK_FALSE(cycle);
}

TEST_CASE("B.65 preserves sequential folder move semantics", "[folders][b65]") {
    DatabasePool pool(2, get_secure_conn_string());
    FolderManager manager(pool);
    const auto suffix = std::to_string(rand());
    const auto username = "b65_sequential_" + suffix;
    const auto email = username + "@test.com";
    uint64_t user_id = 0;

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        user_id = txn.exec(
            "INSERT INTO users (username, email, password_hash, is_email_verified) "
            "VALUES ($1, $2, 'hash', true) RETURNING id",
            pqxx::params{username, email})[0][0].as<uint64_t>();
        txn.commit();
    }

    const auto root_a = manager.create_folder(user_id, std::nullopt, "a", "b65-seq-a-" + suffix);
    const auto root_b = manager.create_folder(user_id, std::nullopt, "b", "b65-seq-b-" + suffix);
    const auto root_c = manager.create_folder(user_id, std::nullopt, "c", "b65-seq-c-" + suffix);
    const auto child_c = manager.create_folder(user_id, root_c, "child", "b65-seq-child-" + suffix);

    REQUIRE_NOTHROW(manager.update_folder(root_a, user_id, std::nullopt, std::nullopt, root_b));
    REQUIRE_NOTHROW(manager.update_folder(root_a, user_id, std::nullopt, std::nullopt, 0));
    std::string descendant_error;
    try {
        manager.update_folder(root_c, user_id, std::nullopt, std::nullopt, child_c);
    } catch (const std::exception& error) {
        descendant_error = error.what();
    }
    REQUIRE(descendant_error == "BAD_REQUEST");

    auto conn = pool.acquire_connection();
    pqxx::nontransaction verify(*conn);
    const auto root_parent = verify.exec(
        "SELECT parent_id IS NULL FROM folders WHERE id = $1",
        pqxx::params{root_a})[0][0].as<bool>();
    const auto descendant_parent = verify.exec(
        "SELECT parent_id FROM folders WHERE id = $1",
        pqxx::params{root_c})[0][0].is_null();

    REQUIRE(root_parent);
    REQUIRE(descendant_parent);

    auto cleanup_conn = pool.acquire_connection();
    pqxx::work cleanup(*cleanup_conn);
    cleanup.exec("DELETE FROM users WHERE id = $1", pqxx::params{user_id});
    cleanup.commit();
}
