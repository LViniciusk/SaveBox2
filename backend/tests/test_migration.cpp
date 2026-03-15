#include <catch2/catch_test_macros.hpp>
#include "DatabasePool.hpp"
#include "DatabaseMigration.hpp"
#include <pqxx/pqxx>
#include <fstream>
#include <string>
#include <map>
#include <cstdlib>
#include <iostream>




// Lê o .env para ofuscar as credenciais
std::string get_secure_conn_string() {
    std::map<std::string, std::string> env_vars;
    
    std::ifstream file("../../.env");

    if (file.is_open()) {
        std::string line;
        while (std::getline(file, line)) {
            if (line.empty() || line[0] == '#') continue;
            
            auto pos = line.find('=');
            if (pos != std::string::npos) {
                std::string key = line.substr(0, pos);
                std::string value = line.substr(pos + 1);
                env_vars[key] = value;
            }
        }
    }

    auto get_var = [&](const std::string& key, const std::string& default_val) {
        if (env_vars.count(key)) return env_vars[key];
        if (const char* sys_val = std::getenv(key.c_str())) return std::string(sys_val);

        return default_val;
    };

    // Monta a url de conexão
    std::string user = get_var("DB_USER", "As_vezes_no_silencio_da_noite");
    std::string pass = get_var("DB_PASSWORD", "Eu_fico_imaginando_nois_dois");
    std::string db   = get_var("DB_NAME", "Eu_fico_ali_sonhando_acordado");
    std::string host = get_var("DB_HOST", "Juntando");
    std::string port = get_var("DB_PORT", "O_antes_o_agora_e_o_depois");

    return "postgresql://" + user + ":" + pass + "@" + host + ":" + port + "/" + db;
}




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
