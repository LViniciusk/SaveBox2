#include <catch2/catch_test_macros.hpp>
#include <catch2/benchmark/catch_benchmark.hpp>
#include <string>
#include <vector>
#include <cstring>

TEST_CASE("Microbenchmarking de I/O de Chunks na Memoria", "[benchmark][io]") {

    SECTION("Overhead de Buffer e String Cópia (4MB)") {
        const size_t CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB
        std::vector<char> raw_buffer(CHUNK_SIZE, 'A');
        
        BENCHMARK("memcpy 4MB raw buffer") {
            std::vector<char> dest_buffer(CHUNK_SIZE);
            std::memcpy(dest_buffer.data(), raw_buffer.data(), CHUNK_SIZE);
            return dest_buffer[0];
        };

        BENCHMARK("std::string copy construct 4MB") {
            std::string s(raw_buffer.data(), CHUNK_SIZE);
            return s[CHUNK_SIZE - 1];
        };
        
        BENCHMARK("std::string move (Zero-copy simulate)") {
            std::string src(raw_buffer.data(), CHUNK_SIZE);
            std::string dest = std::move(src);
            return dest.size();
        };
    }
}
