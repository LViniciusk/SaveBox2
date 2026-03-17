#include "controllers/ApiRouter.hpp"
#include "database/DatabasePool.hpp"
#include "services/AuthService.hpp"
#include "database/FolderManager.hpp"
#include "database/FileManager.hpp"
#include "storage/FileChunker.hpp"
#include "utils.hpp"
#include <crow_all.h>
#include <iostream>




int main() {
    std::string conn_str = get_secure_conn_string();
    std::string pepper = get_pepper();
    std::string jwt_secret = get_jwt_secret();
    std::string storage_path = get_storage_path();

    // Instancia as dependências
    DatabasePool pool(2, conn_str);
    AuthService auth(pepper, jwt_secret);
    FolderManager folder_mgr(pool);
    FileManager file_mgr(pool);
    FileChunker chunker(storage_path);

    // Instancia o servidor web Crow
    crow::SimpleApp app;

    // Instancia o roteador com injeção de dependência
    ApiRouter router(pool, auth, folder_mgr, &file_mgr, &chunker);

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