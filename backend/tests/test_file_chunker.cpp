#include <catch2/catch_test_macros.hpp>
#include "storage/FileChunker.hpp"
#include <string>
#include <filesystem>
#include <cstdint>
#include <cstddef>


TEST_CASE("FileChunker - Escrita Cirurgica", "[storage][chunker]") {
    const std::string test_dir = "./test_storage_chunker/";
    const uint64_t fake_file_id = 999;
    const uint64_t MAX_CHUNK = 5 * 1024 * 1024;

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
