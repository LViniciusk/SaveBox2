#include <catch2/catch_test_macros.hpp>
#include "Services/StorageService.hpp"
#include <filesystem>
#include <vector>




TEST_CASE("Storage Service - Escrita e Leitura Final no SSD", "[storage][io]") {
    std::string base_path = "test_storage_vault/";
    StorageService storage(base_path);
    
    std::string relative_path = "user_1/meu_documento.bin";
    std::vector<uint8_t> fake_data = {0x48, 0x65, 0x6C, 0x6C, 0x6F};

    SECTION("Deve criar subpastas automaticamente e salvar o arquivo") {
        bool saved = storage.save_file(relative_path, fake_data);
        REQUIRE(saved == true);
        REQUIRE(std::filesystem::exists(base_path + relative_path) == true);
    }

    SECTION("Deve ler os bytes corretos do disco") {
        storage.save_file(relative_path, fake_data);
        auto read_data = storage.read_file(relative_path);
        
        REQUIRE(read_data.has_value() == true);
        REQUIRE(read_data.value() == fake_data);
    }

    SECTION("Deve deletar o arquivo fisicamente") {
        storage.save_file(relative_path, fake_data);
        bool deleted = storage.delete_file(relative_path);
        
        REQUIRE(deleted == true);
        REQUIRE(std::filesystem::exists(base_path + relative_path) == false);
    }

    SECTION("Bloqueia path traversal fora do vault") {
        std::string escape_path = "../../../../etc/passwd";

        bool saved = storage.save_file(escape_path, fake_data);
        REQUIRE(saved == false);

        auto read_data = storage.read_file(escape_path);
        REQUIRE(read_data.has_value() == false);
    }

    std::filesystem::remove_all(base_path);
}