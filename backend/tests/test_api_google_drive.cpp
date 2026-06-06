#include <catch2/catch_test_macros.hpp>
#include "controllers/ApiRouter.hpp"
#include "database/DatabasePool.hpp"
#include "Services/AuthService.hpp"
#include "database/FolderManager.hpp"
#include "database/FileManager.hpp"
#include "storage/FileChunker.hpp"
#include "test_helpers.hpp"
#include <crow_all.h>
#include <stdlib.h>

TEST_CASE("API Google Drive - Endpoints", "[api][googledrive]") {
    _putenv_s("GOOGLE_CLIENT_ID", "mock_client_id");
    _putenv_s("GOOGLE_CLIENT_SECRET", "mock_client_secret");
    
    std::string conn_str = get_secure_conn_string();
    DatabasePool pool(2, conn_str);
    MockEmailService mock_email_service;
    AuthService auth("pepper", "secret", &mock_email_service);
    FolderManager folder_mgr(pool);
    FileManager file_mgr(pool);
    FileChunker chunker("./test_storage");
    MockGoogleDriveService gdrive(pool);

    ApiRouter router(pool, auth, folder_mgr, &file_mgr, &chunker, &gdrive);

    uint64_t user_id = 9998;
    
    // Preparar DB
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM files WHERE user_id = 9998");
        txn.exec("DELETE FROM user_external_storages WHERE user_id = 9998");
        txn.exec("DELETE FROM users WHERE id = 9998");
        txn.exec("INSERT INTO users (id, username, email, password_hash, max_storage_bytes, is_email_verified) "
                 "VALUES (9998, 'api_gd_user', 'gdapi@test.com', 'hash', 104857600, true)");
        txn.commit();
    }

    struct DbCleanup {
        DatabasePool& p;
        uint64_t uid;
        ~DbCleanup() {
            try {
                auto c = p.acquire_connection();
                pqxx::work t(*c);
                t.exec("DELETE FROM files WHERE user_id = " + std::to_string(uid));
                t.exec("DELETE FROM user_external_storages WHERE user_id = " + std::to_string(uid));
                t.exec("DELETE FROM folders WHERE user_id = " + std::to_string(uid));
                t.exec("DELETE FROM users WHERE id = " + std::to_string(uid));
                t.commit();
            } catch(...) {}
        }
    } cleanup{pool, user_id};

    std::string valid_token = auth.generate_token(user_id);
    
    SECTION("POST /api/storage/google/link - Sucesso") {
        std::string state = gdrive.generate_test_state(user_id);

        crow::request req;
        req.url = "/api/storage/google/link";
        req.add_header("Authorization", "Bearer " + valid_token);
        req.body = R"({"auth_code": "valid_code_456", "state": ")" + state + R"("})";

        crow::response res = router.handle_link_google_drive(req);
        
        REQUIRE(res.code == 200);
        REQUIRE(res.body.find("Conta vinculada com sucesso") != std::string::npos);
        REQUIRE(res.body.find("mock_folder_123") != std::string::npos);
        REQUIRE(gdrive.is_linked(user_id));
    }

    SECTION("POST /api/storage/google/link - Falha por Code Invalido") {
        gdrive.token_exchange_ok = false;
        std::string state = gdrive.generate_test_state(user_id);
        
        crow::request req;
        req.url = "/api/storage/google/link";
        req.add_header("Authorization", "Bearer " + valid_token);
        req.body = R"({"auth_code": "invalid_code", "state": ")" + state + R"("})";

        crow::response res = router.handle_link_google_drive(req);
        
        REQUIRE(res.code == 400);
        REQUIRE(res.body.find("Falha ao trocar o codigo") != std::string::npos);
    }

    SECTION("POST /api/storage/google/link - Falha por State Invalido") {
        crow::request req;
        req.url = "/api/storage/google/link";
        req.add_header("Authorization", "Bearer " + valid_token);
        req.body = R"({"auth_code": "valid_code_456", "state": "invalid_state_uuid"})";

        crow::response res = router.handle_link_google_drive(req);
        
        REQUIRE(res.code == 400);
        REQUIRE(res.body.find("State invalido") != std::string::npos);
    }

    SECTION("GET /api/storage/google/token - Sucesso") {
        std::string state = gdrive.generate_test_state(user_id);
        gdrive.link_account(user_id, "valid_code_456", state);

        crow::request req;
        req.url = "/api/storage/google/accounts";
        req.add_header("Authorization", "Bearer " + valid_token);

        gdrive.expect_refresh = true;
        crow::response res = router.handle_get_google_accounts(req);
        
        REQUIRE(res.code == 200);
        REQUIRE(res.body.find("mock_folder_123") != std::string::npos);
    }
    
    SECTION("GET /api/storage/google/token - Nao Vinculado") {
        crow::request req;
        req.url = "/api/storage/google/accounts";
        req.add_header("Authorization", "Bearer " + valid_token);

        crow::response res = router.handle_get_google_accounts(req);
        
        REQUIRE(res.code == 200);
        bool has_empty_accounts = res.body.find("\"accounts\":[]") != std::string::npos || 
                                  res.body.find("\"accounts\": []") != std::string::npos;
        REQUIRE(has_empty_accounts);
    }

    SECTION("POST /files - Inicializacao google_drive e bloqueio de Chunks") {
        std::string state = gdrive.generate_test_state(user_id);
        gdrive.link_account(user_id, "valid_code_456", state);
        
        crow::request req_init;
        req_init.url = "/files";
        req_init.add_header("Authorization", "Bearer " + valid_token);
        req_init.body = R"({
            "folder_id": null,
            "encrypted_name": "teste_drive.txt",
            "name_hash": "hash123",
            "encrypted_fdk": "fdk123",
            "size_bytes": 1024,
            "storage_provider": "google_drive"
        })";
        
        crow::response res_init = router.handle_init_file_upload(req_init);
        REQUIRE(res_init.code == 201);
        
        auto json_res = crow::json::load(res_init.body);
        int file_id = json_res["file_id"].i();
        
        // Tentar enviar chunk local deve falhar (400)
        crow::request req_chunk;
        req_chunk.add_header("Authorization", "Bearer " + valid_token);
        req_chunk.add_header("X-Chunk-Index", "0");
        req_chunk.body = "dados";
        
        crow::response res_chunk = router.handle_upload_chunk(req_chunk, file_id);
        REQUIRE(res_chunk.code == 400);
        REQUIRE(res_chunk.body.find("Operacao de chunks nao suportada para armazenamento externo") != std::string::npos);
    }

    SECTION("POST /files/{id}/finalize-external - Sucesso") {
        std::string state = gdrive.generate_test_state(user_id);
        gdrive.link_account(user_id, "valid_code_456", state);
        // Init file
        crow::request req_init;
        req_init.url = "/files";
        req_init.add_header("Authorization", "Bearer " + valid_token);
        req_init.body = R"({"folder_id": null, "encrypted_name": "final_drive.txt", "name_hash": "hash456", "encrypted_fdk": "fdk456", "size_bytes": 1024, "storage_provider": "google_drive"})";
        
        crow::response res_init = router.handle_init_file_upload(req_init);
        auto json_res = crow::json::load(res_init.body);
        int file_id = json_res["file_id"].i();
        
        // Finalize
        crow::request req_fin;
        req_fin.url = "/files/" + std::to_string(file_id) + "/finalize-external";
        req_fin.add_header("Authorization", "Bearer " + valid_token);
        req_fin.body = R"({"external_file_id": "google_drive_file_id_123"})";
        
        crow::response res_fin = router.handle_finalize_external_upload(req_fin, file_id);
        REQUIRE(res_fin.code == 200);
        
        // Finalizar novamente deve dar 409
        crow::response res_fin2 = router.handle_finalize_external_upload(req_fin, file_id);
        REQUIRE(res_fin2.code == 409);
    }

    SECTION("GET /api/storage/google/generate-state - Gera State UUID") {
        crow::request req;
        req.url = "/api/storage/google/generate-state";
        req.add_header("Authorization", "Bearer " + valid_token);

        crow::response res = router.handle_generate_google_state(req);
        
        REQUIRE(res.code == 200);
        REQUIRE(res.body.find("state") != std::string::npos);
    }
}
