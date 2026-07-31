#include <catch2/catch_test_macros.hpp>
#include "storage/FileChunker.hpp"
#include <string>
#include <filesystem>
#include <cstdint>
#include <cstddef>


TEST_CASE("FileChunker - Escrita Cirurgica", "[storage][chunker]") {
    const std::string test_dir = "./test_storage_chunker/";
    const uint64_t fake_file_id = 999;
    const uint64_t MAX_CHUNK = 4 * 1024 * 1024;

    std::filesystem::remove_all(test_dir);
    FileChunker chunker(test_dir);

    auto file_path = std::filesystem::path(test_dir) / (std::to_string(fake_file_id) + ".dat");

    SECTION("Escrita Simples") {
        bool ok = chunker.write_chunk(fake_file_id, 0, "Hello");

        REQUIRE(ok == true);
        REQUIRE(std::filesystem::file_size(file_path) == 5);
    }

    SECTION("Trava de Seguranca") {
        std::string payload(MAX_CHUNK + 1, 'X');

        bool ok = chunker.write_chunk(fake_file_id, 0, payload);

        REQUIRE(ok == false);
    }

    SECTION("Salto com Offset (Sparse File)") {
        chunker.write_chunk(fake_file_id, 0, "Hello");
        chunker.write_chunk(fake_file_id, 1, "World");

        auto expected_size = MAX_CHUNK + 5;
        REQUIRE(std::filesystem::file_size(file_path) == expected_size);
    }

    SECTION("Idempotencia (Sobrescrita)") {
        chunker.write_chunk(fake_file_id, 0, "Test");
        chunker.write_chunk(fake_file_id, 0, "Test");

        REQUIRE(std::filesystem::file_size(file_path) == 4);
    }

    std::filesystem::remove_all(test_dir);
}

TEST_CASE("FileChunker - staging atomico de movimentacao", "[storage][chunker][move]") {
    const std::string test_dir = "./test_storage_move_chunker/";
    const uint64_t file_id = 91;
    const uint64_t item_id = 501;
    const uint64_t proxy_item_id = 502;
    const uint64_t move_id = 77;
    std::filesystem::remove_all(test_dir);
    FileChunker chunker(test_dir);

    REQUIRE(chunker.write_move_chunk(item_id, 0, "ciphertext"));
    REQUIRE(chunker.write_move_chunk(proxy_item_id, 0, "proxy"));
    REQUIRE(chunker.get_move_file_size(item_id) == 10);

    chunker.promote_move_file(item_id, file_id);
    chunker.promote_move_proxy(proxy_item_id, file_id);
    REQUIRE(chunker.read_file_portion(file_id, 0, 10) == "ciphertext");
    REQUIRE(chunker.read_proxy_file_portion(file_id, 0, 5) == "proxy");

    SECTION("rollback devolve o destino ao staging") {
        chunker.demote_move_proxy(proxy_item_id, file_id);
        chunker.demote_move_file(item_id, file_id);
        REQUIRE(chunker.get_move_file_size(item_id) == 10);
        REQUIRE(chunker.get_move_file_size(proxy_item_id) == 5);
    }

    SECTION("origem em quarentena pode ser restaurada") {
        chunker.quarantine_file(file_id, move_id);
        chunker.quarantine_proxy(file_id, move_id);
        REQUIRE_THROWS(chunker.get_file_size(file_id));
        chunker.restore_quarantined_file(file_id, move_id);
        chunker.restore_quarantined_proxy(file_id, move_id);
        REQUIRE(chunker.read_file_portion(file_id, 0, 10) == "ciphertext");
        REQUIRE(chunker.read_proxy_file_portion(file_id, 0, 5) == "proxy");
    }

    std::filesystem::remove_all(test_dir);
}
