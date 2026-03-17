#include "controllers/ApiRouter.hpp"
#include "database/DatabasePool.hpp"
#include "services/AuthService.hpp"
#include "database/FolderManager.hpp"
#include "utils.hpp"
#include <crow_all.h>
#include <iostream>




int main() {
    std::string conn_str = get_secure_conn_string();
    std::string pepper = get_pepper();

    // Instancia as dependências
    DatabasePool pool(2, conn_str);
    AuthService auth(pepper);
    FolderManager folder_mgr(pool);

    // Instancia o servidor web Crow
    crow::SimpleApp app;

    // Instancia o roteador com injeção de dependência
    ApiRouter router(pool, auth, folder_mgr);

    // Acopla as rotas ao servidor
    router.setup_routes(app);

    std::cout << "====================================================\n";
    std::cout << "             SaveBox Backend Iniciado\n             ";
    std::cout << "Servidor escutando na porta: http://localhost:8080\n";
    std::cout << "====================================================\n";

    // Roda o servidor na porta 8080 usando múltiplas threads
    app.port(8080).multithreaded().run();

    return 0;
}