#include <catch2/catch_test_macros.hpp>
#include "storage/FileChunker.hpp"
#include <vector>
#include <cstdint>
#include <cstddef>




TEST_CASE("Montagem de Arquivo por Chunks", "[storage][chunker]") {
    std::string path = "caminho_ficticio/arquivo_temp.bin";
    std::filesystem::remove(path);
    FileChunker chunker(path);

    SECTION("Append de chunks individuais deve retornar true") {
        std::vector<uint8_t> chunk1 = { 0x48, 0x65, 0x6C, 0x6C, 0x6F }; // "Hello"
        std::vector<uint8_t> chunk2 = { 0x57, 0x6F, 0x72, 0x6C, 0x64 }; // "World"

        REQUIRE(chunker.append_chunk(chunk1) == true);
        REQUIRE(chunker.append_chunk(chunk2) == true);
    }

    SECTION("Tamanho acumulado deve ser a soma dos chunks") {
        std::vector<uint8_t> chunk1 = { 0x48, 0x65, 0x6C, 0x6C, 0x6F }; // 5 bytes
        std::vector<uint8_t> chunk2 = { 0x57, 0x6F, 0x72, 0x6C, 0x64 }; // 5 bytes

        chunker.append_chunk(chunk1);
        chunker.append_chunk(chunk2);

        size_t total_size = chunker.get_current_size();
        
        REQUIRE(total_size == (chunk1.size() + chunk2.size()));
    }

    SECTION("Finalizar upload deve fechar o arquivo com sucesso") {
        std::vector<uint8_t> chunk1 = { 0x48, 0x65, 0x6C, 0x6C, 0x6F };
        std::vector<uint8_t> chunk2 = { 0x57, 0x6F, 0x72, 0x6C, 0x64 };

        chunker.append_chunk(chunk1);
        chunker.append_chunk(chunk2);

        size_t expected_total_size = chunk1.size() + chunk2.size();
        bool is_complete = chunker.finalize_upload(expected_total_size);

        REQUIRE(is_complete == true);
    }
}
