#include <catch2/catch_session.hpp>
#include <iostream>
#include <cstdlib>




int main(int argc, char* argv[]) {
    std::cout << "====================================================\n";
    std::cout << "[PRE-FLIGHT CHECK] Iniciando bateria de testes do SaveBox2...\n";
    std::cout << "====================================================\n";

    Catch::Session session;
    
    int returnCode = session.applyCommandLine(argc, argv);
    if (returnCode != 0) {
        return returnCode;
    }

    int result = session.run();

    std::cout << "====================================================\n";
    std::cout << "[FIM DOS TESTES] Bateria finalizada.\n";
    std::cout << "====================================================\n";

    return result;
}