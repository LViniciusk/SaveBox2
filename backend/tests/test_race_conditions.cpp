#include <catch2/catch_test_macros.hpp>
#include "database/FolderManager.hpp"
#include "database/DatabasePool.hpp"
#include "test_helpers.hpp"
#include <vector>
#include <thread>
#include <atomic>
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