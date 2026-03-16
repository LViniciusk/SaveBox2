#include "ApiRouter.hpp"
#include "database/DatabasePool.hpp"
#include "AuthService.hpp"
#include <crow_all.h>
#include <iostream>
#include "../tests/test_helpers.hpp"



int main() {
    std::string conn_str = get_secure_conn_string();

    // Instancia as dependências
    DatabasePool pool(2, conn_str);
    AuthService auth;

    // Instancia o servidor web Crow
    crow::SimpleApp app;

    // Instancia o roteador com injeção de dependência
    ApiRouter router(pool, auth);

    // Acopla as rotas ao servidor
    router.setup_routes(app);

    std::cout << "====================================================\n";
    std::cout << "🚀 SaveBox Backend Iniciado com Sucesso!\n";
    std::cout << "🌐 Servidor escutando na porta: http://localhost:8080\n";
    std::cout << "====================================================\n";

    // Roda o servidor na porta 8080 usando múltiplas threads
    app.port(8080).multithreaded().run();

    return 0;
}