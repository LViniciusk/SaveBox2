#include <catch2/catch_test_macros.hpp>
#include "database/DatabasePool.hpp"
#include <vector>
#include <thread>
#include <chrono>




TEST_CASE("Inicialização Saudável do DatabasePool", "[database][pool]") {
    DatabasePool pool(5);
    
    REQUIRE(pool.get_available_count() == 5);
}


TEST_CASE("Empréstimo e Devolução Simples (RAII)", "[database][pool]") {
    DatabasePool pool(5);
    REQUIRE(pool.get_available_count() == 5);

    {
        auto conn = pool.acquire_connection();
        
        REQUIRE(pool.get_available_count() == 4);
    }

    REQUIRE(pool.get_available_count() == 5);
}


TEST_CASE("Estresse de Concorrência (Thread-Safety)", "[database][pool][stress]") {
    DatabasePool pool(5);
    REQUIRE(pool.get_available_count() == 5);

    constexpr int num_threads = 50;
    std::vector<std::thread> threads;
    threads.reserve(num_threads);

    for (int i = 0; i < num_threads; ++i) {
        threads.emplace_back([&pool]() {
            auto conn = pool.acquire_connection();
            
            std::this_thread::sleep_for(std::chrono::milliseconds(5));
        });
    }

    for (auto& t : threads) {
        if (t.joinable()) {
            t.join();
        }
    }

    REQUIRE(pool.get_available_count() == 5);
}