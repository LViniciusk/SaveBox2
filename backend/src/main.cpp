#include "controllers/ApiRouter.hpp"
#include "database/DatabaseMigration.hpp"
#include "database/DatabasePool.hpp"
#include "Services/AuthService.hpp"
#include "database/FolderManager.hpp"
#include "database/FileManager.hpp"
#include "storage/GarbageCollector.hpp"
#include "middlewares/RateLimitMiddleware.hpp"
#include "storage/FileChunker.hpp"
#include "utils.hpp"
#include <csignal>
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

    // Garbage Collector 
    GarbageCollector gc(pool, &chunker);
    gc.run_cleanup();
    std::atomic<bool> gc_running{true};
    std::mutex gc_mutex;
    std::condition_variable gc_cv;

    std::thread gc_thread([&]() {
        while (gc_running) {
            std::unique_lock<std::mutex> lock(gc_mutex);
            
            
            if (gc_cv.wait_for(lock, std::chrono::hours(24), [&]{ return !gc_running; })) {
                break;
            }
            
            try {
                gc.run_cleanup();
            } catch (const std::exception& e) {
                std::cerr << "[GC ERROR] Falha no ciclo de limpeza: " << e.what() << "\n";
            }
        }
    });

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

    std::cout << "\n[SERVER] Desligamento iniciado. Parando o Garbage Collector...\n";
    std::cout << "[SERVER] Fechando conexões com o banco de dados...\n";

    pool.close_all_connections();
    gc_running = false; 
    gc_cv.notify_all(); 
    
    if (gc_thread.joinable()) {
        gc_thread.join();
    }
    
    std::cout << "[SERVER] Garbage Collector parado com sucesso.\n";
    std::cout << "[SERVER] Banco de dados desconectado.\n";

    return 0;
}