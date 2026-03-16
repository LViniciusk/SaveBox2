#include <catch2/catch_test_macros.hpp>
#include "database/DatabasePool.hpp"
#include "test_helpers.hpp"
#include <pqxx/pqxx>




TEST_CASE("Integração Bruta - Regras de Negócio do PostgreSQL", "[db][integration][raw]") {
    DatabasePool pool(1, get_secure_conn_string());

    SECTION("Bloqueia a criação de usuários com o mesmo username (UNIQUE Constraint)") {
        auto conn = pool.acquire_connection();
        pqxx::work W(*conn);

        W.exec("DELETE FROM users WHERE username = 'clone_user';");

        W.exec("INSERT INTO users (username, password_hash) VALUES ('clone_user', 'hash123');");


        REQUIRE_THROWS_AS(
            W.exec("INSERT INTO users (username, password_hash) VALUES ('clone_user', 'hash_diferente');"),
            pqxx::integrity_constraint_violation
        );

        W.abort();

        pqxx::work W_limpeza(*conn);
        W_limpeza.exec("DELETE FROM users WHERE username = 'clone_user';");
        W_limpeza.commit();
    }
}