#include <catch2/catch_test_macros.hpp>
#include "database/DatabasePool.hpp"
#include "database/DatabaseMigration.hpp"
#include "test_helpers.hpp"
#include <pqxx/pqxx>
#include <string>




TEST_CASE("Migração do Banco de Dados - Integração", "[database][migration][integration]") {
    std::string conn_string = get_secure_conn_string();
    
    DatabasePool pool(1, conn_string);
    
    bool success = DatabaseMigration::run(pool);

    REQUIRE(success == true);

    {
        auto conn_wrapper = pool.acquire_connection();
        REQUIRE(conn_wrapper.is_valid());
        
        pqxx::nontransaction ntx(*conn_wrapper);
        
        auto check_table_exists = [&ntx](const std::string& table_name) {
            pqxx::result res = ntx.exec(
                "SELECT EXISTS ("
                "SELECT FROM information_schema.tables "
                "WHERE table_schema = 'public' "
                "AND table_name = $1"
                ");", 
                pqxx::params{table_name}
            );
            return res[0][0].as<bool>();
        };

        REQUIRE(check_table_exists("users"));
        REQUIRE(check_table_exists("folders"));
        REQUIRE(check_table_exists("files"));
    }
}
