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

    {
        auto conn = pool.acquire_connection();
        pqxx::work W(*conn);

        W.exec("DELETE FROM users WHERE id = $1;", pqxx::params{fake_user_id});
        W.commit();
    }
}