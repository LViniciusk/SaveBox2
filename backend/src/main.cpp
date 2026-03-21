#include "controllers/ApiRouter.hpp"
#include "database/DatabaseMigration.hpp"
#include "database/DatabasePool.hpp"
#include "services/AuthService.hpp"
#include "database/FolderManager.hpp"
#include "database/FileManager.hpp"
#include "middlewares/RateLimitMiddleware.hpp"
#include "storage/FileChunker.hpp"
#include "utils.hpp"
#include <crow_all.h>
#include <iostream>




int main() {
    std::string conn_str = DotEnv::get_secure_conn_string();
    std::string pepper = DotEnv::get_pepper();
    std::string jwt_secret = DotEnv::get_jwt_secret();
    std::string storage_path = DotEnv::get_storage_path();
    std::string resend_api_key = DotEnv::get_resend_api_key();
    std::string email_validation_api_key = DotEnv::get_email_validation_api_key();

    // Instancia as dependências
    DatabasePool pool(2, conn_str);
    DatabaseMigration::run(pool);
    AuthService auth(pepper, jwt_secret, resend_api_key, email_validation_api_key);
    FolderManager folder_mgr(pool);
    FileManager file_mgr(pool);
    FileChunker chunker(storage_path);

    // Configurando Instância do Crow WebServer
    crow::App<crow::CORSHandler, RateLimitMiddleware> app;
    app.get_middleware<RateLimitMiddleware>().init(pool);

    // Configurando Rotaseador com injeção de dependência
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