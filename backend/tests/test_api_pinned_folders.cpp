#include <catch2/catch_test_macros.hpp>
#include "Services/AuthService.hpp"
#include "controllers/ApiRouter.hpp"
#include "database/DatabasePool.hpp"
#include "database/FolderManager.hpp"
#include "test_helpers.hpp"
#include <crow_all.h>
#include <cstdint>
#include <string>
#include <vector>

namespace {

struct PinFixture {
    DatabasePool pool{2, get_secure_conn_string()};
    MockEmailService email;
    AuthService auth{"pin_test_pepper", "pin_test_jwt_secret", &email};
    FolderManager folders{pool};
    ApiRouter router{pool, auth, folders};
    int user_id = 0;
    int other_user_id = 0;
    int root_id = 0;
    int child_id = 0;
    int second_root_id = 0;
    std::string username;
    std::string other_username;

    PinFixture() {
        const auto suffix = std::to_string(reinterpret_cast<uintptr_t>(this));
        username = "pins_user_" + suffix;
        other_username = "pins_other_" + suffix;

        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        user_id = txn.exec(
            "INSERT INTO users (username, email, password_hash, is_email_verified) "
            "VALUES ($1, $2, 'hash', true) RETURNING id",
            pqxx::params{username, username + "@test.com"}
        )[0][0].as<int>();
        other_user_id = txn.exec(
            "INSERT INTO users (username, email, password_hash, is_email_verified) "
            "VALUES ($1, $2, 'hash', true) RETURNING id",
            pqxx::params{other_username, other_username + "@test.com"}
        )[0][0].as<int>();
        root_id = txn.exec(
            "INSERT INTO folders (user_id, encrypted_name, name_hash) VALUES ($1, 'enc-root', $2) RETURNING id",
            pqxx::params{user_id, "hash-root-" + suffix}
        )[0][0].as<int>();
        child_id = txn.exec(
            "INSERT INTO folders (user_id, parent_id, encrypted_name, name_hash) "
            "VALUES ($1, $2, 'enc-child', $3) RETURNING id",
            pqxx::params{user_id, root_id, "hash-child-" + suffix}
        )[0][0].as<int>();
        second_root_id = txn.exec(
            "INSERT INTO folders (user_id, encrypted_name, name_hash) VALUES ($1, 'enc-second', $2) RETURNING id",
            pqxx::params{user_id, "hash-second-" + suffix}
        )[0][0].as<int>();
        txn.commit();
    }

    ~PinFixture() {
        try {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            txn.exec("DELETE FROM users WHERE id IN ($1, $2)", pqxx::params{user_id, other_user_id});
            txn.commit();
        } catch (...) {
        }
    }

    std::string token(int id) const {
        return auth.generate_token(static_cast<uint64_t>(id));
    }

    crow::request request(const std::string& token_value = {}, const std::string& body = {}) const {
        crow::request req;
        if (!token_value.empty()) req.add_header("Authorization", "Bearer " + token_value);
        req.body = body;
        return req;
    }

    crow::json::rvalue list(const std::string& token_value) {
        auto res = router.handle_get_pinned_folders(request(token_value));
        REQUIRE(res.code == 200);
        return crow::json::load(res.body);
    }
};

}

TEST_CASE("Pastas fixadas: autenticação e isolamento por usuário", "[api][pinned][auth][idor]") {
    PinFixture fixture;

    REQUIRE(fixture.router.handle_get_pinned_folders(fixture.request()).code == 401);
    REQUIRE(fixture.router.handle_pin_folder(fixture.request(), fixture.root_id).code == 401);
    REQUIRE(fixture.router.handle_unpin_folder(fixture.request(), fixture.root_id).code == 401);
    REQUIRE(fixture.router.handle_reorder_pinned_folders(fixture.request("", R"({"folder_ids":[]})")).code == 401);

    REQUIRE(fixture.router.handle_get_pinned_folders(fixture.request("invalid-token")).code == 401);

    auto empty = fixture.list(fixture.token(fixture.user_id));
    REQUIRE(empty["folders"].size() == 0);

    REQUIRE(fixture.router.handle_pin_folder(fixture.request(fixture.token(fixture.user_id)), fixture.root_id).code == 204);
    REQUIRE(fixture.router.handle_pin_folder(fixture.request(fixture.token(fixture.user_id)), fixture.child_id).code == 204);
    REQUIRE(fixture.router.handle_pin_folder(fixture.request(fixture.token(fixture.user_id)), fixture.root_id).code == 204);

    auto listed = fixture.list(fixture.token(fixture.user_id));
    REQUIRE(listed["folders"].size() == 2);
    REQUIRE(listed["folders"][0]["folder_id"].i() == fixture.root_id);
    REQUIRE(listed["folders"][0]["position"].i() == 0);
    REQUIRE(listed["folders"][1]["folder_id"].i() == fixture.child_id);
    REQUIRE(listed["folders"][1]["position"].i() == 1);
    REQUIRE(listed["folders"][0].size() == 2);
    REQUIRE_FALSE(listed["folders"][0].has("encrypted_name"));

    REQUIRE(fixture.router.handle_pin_folder(fixture.request(fixture.token(fixture.other_user_id)), fixture.root_id).code == 403);
    REQUIRE(fixture.router.handle_unpin_folder(fixture.request(fixture.token(fixture.other_user_id)), fixture.root_id).code == 403);
    REQUIRE(fixture.list(fixture.token(fixture.other_user_id))["folders"].size() == 0);
}

TEST_CASE("Pastas fixadas: reordenação, validação e remoção idempotente", "[api][pinned][order]") {
    PinFixture fixture;
    const auto token = fixture.token(fixture.user_id);

    REQUIRE(fixture.router.handle_pin_folder(fixture.request(token), fixture.root_id).code == 204);
    REQUIRE(fixture.router.handle_pin_folder(fixture.request(token), fixture.child_id).code == 204);

    auto reorder = fixture.request(token, "{\"folder_ids\":[" + std::to_string(fixture.child_id) + "," + std::to_string(fixture.root_id) + "]}");
    REQUIRE(fixture.router.handle_reorder_pinned_folders(reorder).code == 204);
    auto reversed = fixture.list(token);
    REQUIRE(reversed["folders"][0]["folder_id"].i() == fixture.child_id);
    REQUIRE(reversed["folders"][1]["folder_id"].i() == fixture.root_id);

    REQUIRE(fixture.router.handle_reorder_pinned_folders(
        fixture.request(token, "{\"folder_ids\":[" + std::to_string(fixture.child_id) + "," + std::to_string(fixture.child_id) + "]}"))
        .code == 400);
    REQUIRE(fixture.router.handle_reorder_pinned_folders(fixture.request(token, "{}" )).code == 400);
    REQUIRE(fixture.router.handle_reorder_pinned_folders(fixture.request(token, "{\"folder_ids\":\"bad\"}" )).code == 400);
    REQUIRE(fixture.router.handle_reorder_pinned_folders(
        fixture.request(token, "{\"folder_ids\":[" + std::to_string(fixture.second_root_id) + "," + std::to_string(fixture.root_id) + "]}"))
        .code == 400);

    REQUIRE(fixture.router.handle_unpin_folder(fixture.request(token), fixture.child_id).code == 204);
    auto normalized = fixture.list(token);
    REQUIRE(normalized["folders"].size() == 1);
    REQUIRE(normalized["folders"][0]["folder_id"].i() == fixture.root_id);
    REQUIRE(normalized["folders"][0]["position"].i() == 0);
    REQUIRE(fixture.router.handle_unpin_folder(fixture.request(token), fixture.child_id).code == 204);
    REQUIRE(fixture.router.handle_unpin_folder(fixture.request(token), 999999999).code == 404);
    REQUIRE(fixture.router.handle_unpin_folder(fixture.request(token), fixture.root_id).code == 204);
    REQUIRE(fixture.router.handle_reorder_pinned_folders(fixture.request(token, R"({"folder_ids":[]})")).code == 204);
}

TEST_CASE("Pastas fixadas: soft delete oculta e hard delete remove a associação", "[api][pinned][lifecycle]") {
    PinFixture fixture;
    const auto token = fixture.token(fixture.user_id);

    REQUIRE(fixture.router.handle_pin_folder(fixture.request(token), fixture.second_root_id).code == 204);
    {
        auto conn = fixture.pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("UPDATE folders SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1", pqxx::params{fixture.second_root_id});
        txn.commit();
    }

    REQUIRE(fixture.router.handle_pin_folder(fixture.request(token), fixture.second_root_id).code == 404);
    REQUIRE(fixture.list(token)["folders"].size() == 0);

    {
        auto conn = fixture.pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("UPDATE folders SET deleted_at = NULL WHERE id = $1", pqxx::params{fixture.second_root_id});
        txn.commit();
    }
    REQUIRE(fixture.list(token)["folders"].size() == 1);

    REQUIRE(fixture.router.handle_pin_folder(fixture.request(token), fixture.child_id).code == 204);
    {
        auto conn = fixture.pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("UPDATE folders SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1", pqxx::params{fixture.child_id});
        txn.commit();
    }
    REQUIRE_NOTHROW(fixture.folders.hard_delete_folder(fixture.child_id, fixture.user_id, nullptr));
    auto conn = fixture.pool.acquire_connection();
    pqxx::nontransaction txn(*conn);
    REQUIRE(txn.exec("SELECT count(*) FROM pinned_folders WHERE folder_id = $1", pqxx::params{fixture.child_id})[0][0].as<int>() == 0);
}

TEST_CASE("Pastas fixadas: cascade ao excluir usuário", "[api][pinned][cascade]") {
    PinFixture fixture;
    auto conn = fixture.pool.acquire_connection();
    pqxx::work txn(*conn);
    const int folder_id = txn.exec(
        "INSERT INTO folders (user_id, encrypted_name, name_hash) VALUES ($1, 'cascade-enc', 'cascade-hash') RETURNING id",
        pqxx::params{fixture.other_user_id}
    )[0][0].as<int>();
    txn.exec("INSERT INTO pinned_folders (user_id, folder_id, position) VALUES ($1, $2, 0)", pqxx::params{fixture.other_user_id, folder_id});
    txn.exec("DELETE FROM users WHERE id = $1", pqxx::params{fixture.other_user_id});
    txn.commit();

    auto check = fixture.pool.acquire_connection();
    pqxx::nontransaction read(*check);
    REQUIRE(read.exec("SELECT count(*) FROM pinned_folders WHERE user_id = $1", pqxx::params{fixture.other_user_id})[0][0].as<int>() == 0);
}
