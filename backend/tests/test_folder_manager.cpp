#include <catch2/catch_test_macros.hpp>
#include "storage/FolderManager.hpp"
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
        
        auto res = W.exec("INSERT INTO users (username, password_hash) VALUES ('fantasma_das_pastas', 'hash_secreto') RETURNING id;");
        fake_user_id = res[0][0].as<uint64_t>();
        W.commit();
    }

    SECTION("Criar pasta raiz retorna um ID válido") {
        uint64_t parent_id = manager.create_folder(fake_user_id, std::nullopt, "Pasta Raiz");
        REQUIRE(parent_id > 0);
    }

    SECTION("Criar subpasta dentro de uma pasta existente") {
        uint64_t parent_id = manager.create_folder(fake_user_id, std::nullopt, "Pasta Raiz");
        REQUIRE(parent_id > 0);

        uint64_t child_id = manager.create_folder(fake_user_id, parent_id, "Subpasta");
        REQUIRE(child_id > 0);
        REQUIRE(child_id != parent_id);
    }

    SECTION("Deletar pasta pai remove toda a hierarquia (Cascata)") {
        uint64_t parent_id = manager.create_folder(fake_user_id, std::nullopt, "Pasta Para Deletar");    
        uint64_t child_id = manager.create_folder(fake_user_id, parent_id, "Subpasta Filha");

        bool success = manager.delete_folder(parent_id);
        REQUIRE(success == true);

        bool parent_exists = manager.folder_exists(parent_id);
        bool child_exists = manager.folder_exists(child_id);

        REQUIRE(parent_exists == false);
        REQUIRE(child_exists == false);
    }

    {
        auto conn = pool.acquire_connection();
        pqxx::work W(*conn);

        W.exec("DELETE FROM users WHERE id = $1;", pqxx::params{fake_user_id});
        W.commit();
    }
}