#include <catch2/catch_test_macros.hpp>
#include "storage/FileChunker.hpp"




TEST_CASE("File Chunker - Limites de Memória (Anti-OOM)", "[chunker][memory][security]") {
    FileChunker chunker("temp_memory_test.bin");

    SECTION("Deve rejeitar chunks maiores que o limite de segurança (ex: 50MB)") {
        size_t malicious_chunk_size = 5ULL * 1024 * 1024 * 1024;
        
        bool is_accepted = chunker.validate_chunk_size(malicious_chunk_size);
        
        REQUIRE(is_accepted == false);
    }
}