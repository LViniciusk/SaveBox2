#include <catch2/catch_session.hpp>
#include <iostream>
#include <cstdlib>
#include "database/DatabasePool.hpp"
#include "database/DatabaseMigration.hpp"
#include "test_helpers.hpp"

int main(int argc, char* argv[]) {
    Catch::Session session;
    
    int returnCode = session.applyCommandLine(argc, argv);
    if (returnCode != 0) {
        return returnCode;
    }

    try {
        std::cout << "[TEST SETUP] Inicializando banco de dados na nuvem/local...\n";
        
        std::string conn_str = get_secure_conn_string(); 
        
        DatabasePool pool(2, conn_str);
        
        DatabaseMigration migrator;
        if (!migrator.run(pool)) {
            std::cerr << "[TEST FATAL ERROR] Falha ao criar as tabelas do banco de dados!\n";
            return 1;
        }
        
        std::cout << "[TEST SETUP] Tabelas criadas com sucesso. Iniciando suite do Catch2...\n";

    } catch (const std::exception& e) {
        std::cerr << "[TEST FATAL ERROR] Exceção durante setup do banco: " << e.what() << "\n";
        return 1;
    }

    int result = session.run();

    return result;
}