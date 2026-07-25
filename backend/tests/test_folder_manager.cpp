#include <catch2/catch_test_macros.hpp>
#include "database/FolderManager.hpp"
#include "database/DatabasePool.hpp"
#include "test_helpers.hpp"
#include <pqxx/pqxx>
#include <cstdint>
#include <optional>
#include <string>




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
