#include "controllers/ApiRouter.hpp"
#include "database/DatabaseMigration.hpp"
#include "database/DatabasePool.hpp"
#include "Services/AuthService.hpp"
#include "database/FolderManager.hpp"
#include "database/FileManager.hpp"
#include "storage/GarbageCollector.hpp"
#include "middlewares/RateLimitMiddleware.hpp"
#include "storage/FileChunker.hpp"
#include "Services/GoogleDriveService.hpp"
#include "utils.hpp"
#include <csignal>
#include <crow_all.h>
#include <iostream>
#include <sodium.h>
#include <openssl/provider.h>
#include <openssl/crypto.h>
#include "middlewares/CustomCorsMiddleware.hpp"
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <mutex>
#include <thread>

#ifdef NANIKA_AP06_LOCAL_TEST_SERVER
int main(int argc, char* argv[]) {
    if (argc == 2 && std::string_view(argv[1]) == "--version") {
        std::cout << "Nanika AP06 local laboratory R10-R3\n";
        return 0;
    }
#else
int main() {
#endif

    std::string bind_address;
#ifdef NANIKA_AP06_LOCAL_TEST_SERVER
    std::optional<Ap06LocalRuntime::Config> ap06_config;
#endif
    try {
        bind_address = DotEnv::get_bind_address();
#ifdef NANIKA_AP06_LOCAL_TEST_SERVER
        ap06_config = Ap06LocalRuntime::from_environment(bind_address, DotEnv::get_storage_path());
#endif
    } catch (const std::exception&) {
#ifdef NANIKA_AP06_LOCAL_TEST_SERVER
        std::cerr << "[FATAL] AP06_LOCAL_RUNTIME_INVALID\n";
#else
        std::cerr << "[FATAL] Invalid NANIKA_BIND_ADDRESS; expected 0.0.0.0 or 127.0.0.1.\n";
#endif
        return 1;
    }

    if (sodium_init() == -1) {
        std::cerr << "[FATAL] libsodium nao pode ser inicializada.\n";
        return 1;
    }

    // Inicialização manual do provedor OpenSSL para jwt-cpp / verificação RSA no Windows.
    OSSL_PROVIDER* prov_def = OSSL_PROVIDER_load(nullptr, "default");


    std::string conn_str = DotEnv::get_secure_conn_string();
    std::string pepper = DotEnv::get_pepper();
    std::string jwt_secret = DotEnv::get_jwt_secret();
    std::string storage_path = DotEnv::get_storage_path();
    std::string resend_api_key = DotEnv::get_resend_api_key();
    std::string email_validation_api_key = DotEnv::get_email_validation_api_key();

    // Instancia as dependências
    DatabasePool pool(2, conn_str);
#ifdef NANIKA_AP06_LOCAL_TEST_SERVER
    std::optional<Ap06LocalRuntime> ap06_runtime;
    try {
        ap06_runtime = Ap06LocalRuntime::verify(*ap06_config, pool);
    } catch (const std::exception&) {
        std::cerr << "[FATAL] AP06_LOCAL_RUNTIME_INVALID\n";
        if (prov_def) OSSL_PROVIDER_unload(prov_def);
        return 1;
    }
#endif
    if (!DatabaseMigration::run(pool)) {
        std::cerr << "[FATAL] Schema do banco incompatível ou migração inicial falhou. Servidor não será iniciado.\n";
        if (prov_def) OSSL_PROVIDER_unload(prov_def);
        return 1;
    }



    AuthService auth(pepper, jwt_secret, resend_api_key, email_validation_api_key);
    FolderManager folder_mgr(pool);
    FileManager file_mgr(pool);
    FileChunker chunker(storage_path);
    GoogleDriveService gdrive(pool);

    // Garbage Collector 
    GarbageCollector gc(pool, &chunker, &gdrive);
    gc.run_cleanup();
    std::atomic<bool> gc_running{true};
    std::mutex gc_mutex;
    std::condition_variable gc_cv;
    bool gc_requested = false;

    std::thread gc_thread([&]() {
        std::unique_lock<std::mutex> lock(gc_mutex);
        while (gc_running) {
            lock.unlock();
            std::chrono::milliseconds wait_delay;
            try {
                wait_delay = gc.next_wake_delay();
            } catch (const std::exception& e) {
                std::cerr << "[GC ERROR] Falha ao calcular proximo ciclo: " << e.what() << "\n";
                wait_delay = std::chrono::minutes(1);
            }
            lock.lock();
            if (!gc_running) break;
            if (!gc_requested) {
                gc_cv.wait_for(lock, wait_delay, [&] { return !gc_running || gc_requested; });
            }
            if (!gc_running) break;
            gc_requested = false;
            lock.unlock();
            try {
                gc.run_cleanup();
            } catch (const std::exception& e) {
                std::cerr << "[GC ERROR] Falha no ciclo de limpeza: " << e.what() << "\n";
            }
            lock.lock();
        }
    });

    auto request_gc_cleanup = [&]() {
        {
            std::lock_guard<std::mutex> lock(gc_mutex);
            if (!gc_running) return;
            gc_requested = true;
        }
        gc_cv.notify_one();
    };

    // Configurando Instância do Crow WebServer
    NanikaCrowApp app;
    const bool trust_proxy_headers = DotEnv::trust_proxy_headers();
#ifdef NANIKA_AP06_LOCAL_TEST_SERVER
    app.get_middleware<RateLimitMiddleware>().init_ap06_local(pool, *ap06_runtime);
#else
    app.get_middleware<RateLimitMiddleware>().init(pool, trust_proxy_headers);
#endif

    // Configurando Rotaseador com injeção de dependência
    ApiRouter router(pool, auth, folder_mgr, &file_mgr, &chunker, &gdrive,
                     request_gc_cleanup, trust_proxy_headers);

    // Acopla as rotas ao servidor
    router.setup_routes(app);

    uint16_t port = DotEnv::get_port();

    std::cout << "====================================================\n";
    std::cout << "             Nanika Backend Iniciado\n             ";
    std::cout << "Servidor escutando em: http://" << bind_address << ":" << port << "\n";
    std::cout << "====================================================\n";

    // Roda o servidor na porta configurada usando múltiplas threads
    app.bindaddr(bind_address).port(port).multithreaded().run();



    
    std::cout << "\n[SERVER] Desligamento iniciado. Parando o Garbage Collector...\n";

    {
        std::lock_guard<std::mutex> lock(gc_mutex);
        gc_running = false;
    }
    gc_cv.notify_all();
    
    if (gc_thread.joinable()) {
        gc_thread.join();
    }
    
    std::cout << "[SERVER] Garbage Collector parado com sucesso.\n";
    std::cout << "[SERVER] Fechando conexões com o banco de dados...\n";

    pool.close_all_connections();

    std::cout << "[SERVER] Banco de dados desconectado.\n";

    if (prov_def) OSSL_PROVIDER_unload(prov_def);

    return 0;
}
