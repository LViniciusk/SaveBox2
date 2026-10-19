#include <catch2/catch_test_macros.hpp>
#include "database/DatabasePool.hpp"
#include "test_helpers.hpp"
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

TEST_CASE("DatabasePool - Resiliência contra Conexões Zumbis", "[database][pool][resilience]") {
    DatabasePool pool(1, get_secure_conn_string());

    {
        auto conn = pool.acquire_connection();

        try {
            pqxx::work w(*conn);
            w.exec("SELECT pg_terminate_backend(pg_backend_pid());");
            w.commit();
        } catch (...) {
        }

        REQUIRE_THROWS(pqxx::work(*conn).exec("SELECT 1"));
    }

    auto conn2 = pool.acquire_connection();

    REQUIRE_NOTHROW([&conn2]() {
        pqxx::work w2(*conn2);
        w2.exec("SELECT 1");
        w2.commit();
    }());
}

TEST_CASE("B.62 falha de reconnect preserva capacidade logica do DatabasePool",
          "[database][pool][resilience][b62]") {
    const std::string invalid_conn_str =
        "nanika_invalid_connection_option=1";
    DatabasePool pool(0, invalid_conn_str);

    {
        DatabasePool::ConnectionWrapper slot(&pool, nullptr);
    }

    REQUIRE(pool.get_available_count() == 1);

    for (int attempt = 0; attempt < 2; ++attempt) {
        std::string error;
        try {
            auto connection = pool.acquire_connection();
            (void)connection;
        } catch (const std::runtime_error& exception) {
            error = exception.what();
        }

        CHECK(error == "DATABASE_OFFLINE");
        REQUIRE(pool.get_available_count() == 1);
    }
}

TEST_CASE("B.62 shutdown continua impedindo novas aquisicoes",
          "[database][pool][resilience][b62]") {
    DatabasePool pool(1);
    pool.close_all_connections();

    std::string error;
    try {
        auto connection = pool.acquire_connection();
        (void)connection;
    } catch (const std::runtime_error& exception) {
        error = exception.what();
    }

    CHECK(error == "SERVER_IS_SHUTTING_DOWN");
}
