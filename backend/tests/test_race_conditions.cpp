#include <catch2/catch_test_macros.hpp>
#include "database/FolderManager.hpp"
#include "database/DatabasePool.hpp"
#include "storage/FileChunker.hpp"
#include "test_helpers.hpp"
#include <vector>
#include <thread>
#include <atomic>
#include <filesystem>
#include <fstream>
#include <string>
#include <algorithm>
#include <pqxx/pqxx>




TEST_CASE("Race Condition - Criação de Pastas Simultâneas", "[concurrency][folders]") {
    DatabasePool pool(5, get_secure_conn_string());
    FolderManager manager(pool);
    
    uint64_t fake_user_id = 0;
    std::string folder_name = "Pasta_Disputada";

    {
        auto conn = pool.acquire_connection();
        pqxx::work W(*conn);
        
        W.exec("DELETE FROM users WHERE username = 'ninja_da_concorrencia';");
        
        auto res = W.exec("INSERT INTO users (username, email, password_hash, is_email_verified) VALUES ('ninja_da_concorrencia', 'ninja_da_concorrencia@test.com', 'hash_secreto', true) RETURNING id;");
        fake_user_id = res[0][0].as<uint64_t>();
        
        W.commit();
    }

    SECTION("50 threads tentando criar a mesma pasta ao mesmo tempo") {
        constexpr int num_threads = 50;
        std::vector<std::thread> threads;
        std::atomic<int> success_count{0};
        std::atomic<int> error_count{0};

        for (int i = 0; i < num_threads; ++i) {
            threads.emplace_back([&]() {
                try {
                    uint64_t id = manager.create_folder(fake_user_id, std::nullopt, folder_name, "hash_disputada");
                    if (id > 0) success_count++;
                } catch (...) {
                    error_count++;
                }
            });
        }

        for (auto& t : threads) {
            if (t.joinable()) t.join();
        }

        REQUIRE(success_count == 1);
        REQUIRE(error_count == 49);
    }

    {
        auto conn = pool.acquire_connection();
        pqxx::work W(*conn);
        W.exec("DELETE FROM users WHERE id = $1;", pqxx::params{fake_user_id});
        W.commit();
    }
}

TEST_CASE("Race Condition - Upload de Chunks Simultâneos", "[concurrency][chunks]") {
    const std::string test_dir = "./test_race_chunks/";
    constexpr uint64_t file_id = 9999;
    constexpr int num_threads = 10;
    constexpr size_t chunk_size = 5 * 1024 * 1024;

    std::filesystem::remove_all(test_dir);
    std::filesystem::create_directories(test_dir);

    FileChunker chunker(test_dir);

    std::vector<std::thread> threads;
    threads.reserve(num_threads);
    std::atomic<int> errors{0};
    std::atomic<bool> start{false};

    for (int i = 0; i < num_threads; ++i) {
        threads.emplace_back([&, i]() {
            while (!start.load(std::memory_order_acquire)) {
            }

            try {
                const char marker = static_cast<char>('A' + (i % 26));
                std::string payload(chunk_size, marker);
                bool ok = chunker.write_chunk(file_id, i, payload);
                if (!ok) {
                    errors.fetch_add(1, std::memory_order_relaxed);
                }
            } catch (...) {
                errors.fetch_add(1, std::memory_order_relaxed);
            }
        });
    }

    start.store(true, std::memory_order_release);

    for (auto& t : threads) {
        if (t.joinable()) {
            t.join();
        }
    }

    REQUIRE(errors.load() == 0);

    auto file_path = std::filesystem::path(test_dir) / (std::to_string(file_id) + ".dat");
    REQUIRE(std::filesystem::exists(file_path));
    REQUIRE(std::filesystem::file_size(file_path) == static_cast<uintmax_t>(num_threads * chunk_size));

    std::ifstream in(file_path, std::ios::binary);
    REQUIRE(in.is_open());

    for (int i = 0; i < num_threads; ++i) {
        const char expected = static_cast<char>('A' + (i % 26));
        const std::streamoff offset = static_cast<std::streamoff>(i) * static_cast<std::streamoff>(chunk_size);

        in.clear();
        in.seekg(offset, std::ios::beg);
        REQUIRE(in.good());

        std::string segment(chunk_size, '\0');
        in.read(segment.data(), static_cast<std::streamsize>(segment.size()));
        REQUIRE(static_cast<size_t>(in.gcount()) == chunk_size);
        bool isValid = std::all_of(segment.begin(), segment.end(), [expected](char c) { return c == expected; });
        REQUIRE(isValid);
    }

    in.close();

    std::filesystem::remove_all(test_dir);
}