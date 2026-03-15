#include <catch2/catch_test_macros.hpp>
#include "FolderManager.hpp"
#include <cstdint>
#include <optional>
#include <string>




TEST_CASE("Criação de Pastas", "[folders][hierarchy]") {
    DatabasePool pool(1, get_secure_conn_string());
    FolderManager manager(pool);

    uint64_t user_id = 1;

    SECTION("Criar pasta raiz retorna um ID válido") {
        uint64_t parent_id = manager.create_folder(user_id, std::nullopt, "Pasta Raiz");

        REQUIRE(parent_id > 0);
    }

    SECTION("Criar subpasta dentro de uma pasta existente") {
        uint64_t parent_id = manager.create_folder(user_id, std::nullopt, "Pasta Raiz");
        
        REQUIRE(parent_id > 0);

        uint64_t child_id = manager.create_folder(user_id, parent_id, "Subpasta");

        REQUIRE(child_id > 0);
        REQUIRE(child_id != parent_id);
    }
}

TEST_CASE("Deleção em Cascata", "[folders][cascade]") {
    DatabasePool pool(1, get_secure_conn_string());
    FolderManager manager(pool);

    uint64_t user_id = 1;

    uint64_t parent_id = manager.create_folder(user_id, std::nullopt, "Pasta Para Deletar");    
    uint64_t child_id = manager.create_folder(user_id, parent_id, "Subpasta Filha");

    SECTION("Deletar pasta pai remove toda a hierarquia") {
        bool success = manager.delete_folder(parent_id);
        
        REQUIRE(success == true);

        bool parent_exists = manager.folder_exists(parent_id);
        bool child_exists = manager.folder_exists(child_id);

        REQUIRE(parent_exists == false);
        REQUIRE(child_exists == false);
    }
}
