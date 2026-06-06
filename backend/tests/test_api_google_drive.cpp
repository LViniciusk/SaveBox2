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

    // ==========================================
    // Testes AppSec - Cloud Aggregation (Fase 3)
    // ==========================================

    SECTION("Seguranca: Replay Attack / CSRF no OAuth State (Cloud)") {
        // Gera o state
        std::string state = gdrive.generate_test_state(user_id);

        // 1ª Tentativa de Vinculacao (Valida)
        crow::request req;
        req.url = "/api/storage/google/link";
        req.add_header("Authorization", "Bearer " + valid_token);
        req.body = R"({"auth_code": "valid_code_456", "state": ")" + state + R"("})";

        crow::response res1 = router.handle_link_google_drive(req);
        REQUIRE(res1.code == 200); // Vinculado com sucesso

        // 2ª Tentativa (Replay Attack) usando o mesmo state que ja foi consumido
        crow::response res2 = router.handle_link_google_drive(req);
        REQUIRE(res2.code == 400); // Rejeitado
        REQUIRE(res2.body.find("State invalido ou expirado") != std::string::npos);
    }

    SECTION("Seguranca: BOLA / IDOR em Unlink Account") {
        std::string state = gdrive.generate_test_state(user_id);
        gdrive.link_account(user_id, "valid_code_456", state);
        
        // Vamos obter o account_id do user_id
        auto accounts = gdrive.get_linked_accounts(user_id);
        REQUIRE(accounts.size() == 1);
        uint64_t account_id = accounts[0].id;

        // Criamos o Atacante (user_id = 1337)
        uint64_t attacker_id = 1337;
        {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            txn.exec("INSERT INTO users (id, username, email, password_hash, max_storage_bytes, is_email_verified) "
                     "VALUES (1337, 'attacker', 'attacker@test.com', 'hash', 104857600, true)");
            txn.commit();
        }

        std::string attacker_token = auth.generate_token(attacker_id);

        // Atacante tenta desvincular o account_id da Vitima
        crow::request req;
        req.url = "/api/storage/google/accounts/" + std::to_string(account_id);
        req.add_header("Authorization", "Bearer " + attacker_token);

        crow::response res = router.handle_unlink_google_account(req, account_id);
        
        // A API deve negar pois account_id nao pertence ao Atacante (retorna 404 para ocultar presenca)
        REQUIRE(res.code == 404);
        REQUIRE(res.body.find("Conta nao encontrada ou nao pertence ao usuario") != std::string::npos);

        // Limpeza do Atacante
        {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            txn.exec("DELETE FROM users WHERE id = 1337");
            txn.commit();
        }
    }

    SECTION("Seguranca: BOLA em Finalize External Upload") {
        std::string state = gdrive.generate_test_state(user_id);
        gdrive.link_account(user_id, "valid_code_456", state);
        
        // Init file com a Vítima
        crow::request req_init;
        req_init.url = "/files";
        req_init.add_header("Authorization", "Bearer " + valid_token);
        req_init.body = R"({"folder_id": null, "encrypted_name": "secreto.txt", "name_hash": "hash789", "encrypted_fdk": "fdk789", "size_bytes": 1024, "storage_provider": "google_drive"})";
        
        crow::response res_init = router.handle_init_file_upload(req_init);
        auto json_res = crow::json::load(res_init.body);
        int file_id = json_res["file_id"].i();
        
        // Criar Atacante (user_id = 1337)
        uint64_t attacker_id = 1337;
        {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            txn.exec("INSERT INTO users (id, username, email, password_hash, max_storage_bytes, is_email_verified) "
                     "VALUES (1337, 'attacker', 'attacker@test.com', 'hash', 104857600, true)");
            txn.commit();
        }
        std::string attacker_token = auth.generate_token(attacker_id);

        // Atacante tenta Finalizar o file_id da Vítima (injeção de fake Google File ID)
        crow::request req_fin;
        req_fin.url = "/files/" + std::to_string(file_id) + "/finalize-external";
        req_fin.add_header("Authorization", "Bearer " + attacker_token);
        req_fin.body = R"({"external_file_id": "malicious_fake_file_id"})";
        
        crow::response res_fin = router.handle_finalize_external_upload(req_fin, file_id);
        
        // Proteção na query do FileManager deve abortar a tentativa cruzada
        REQUIRE(res_fin.code == 403);
        REQUIRE(res_fin.body.find("Sem permissao") != std::string::npos);

        // Limpeza do Atacante
        {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            txn.exec("DELETE FROM users WHERE id = 1337");
            txn.commit();
        }
    }

    // ==========================================
    // Testes AppSec - Client-Side Sync (Fase 4)
    // ==========================================

    SECTION("Client-Side Sync: Map e Cleanup com BOLA Protection") {
        std::string state = gdrive.generate_test_state(user_id);
        gdrive.link_account(user_id, "valid_code_456", state);
        
        auto accounts = gdrive.get_linked_accounts(user_id);
        REQUIRE(accounts.size() == 1);
        uint64_t account_id = accounts[0].id;

        // Init e Finalize File 1
        crow::request req_init1;
        req_init1.url = "/files";
        req_init1.add_header("Authorization", "Bearer " + valid_token);
        req_init1.body = R"({"folder_id": null, "encrypted_name": "sync_test1.txt", "name_hash": "hashA", "encrypted_fdk": "fdkA", "size_bytes": 1024, "storage_provider": "google_drive"})";
        crow::response res_init1 = router.handle_init_file_upload(req_init1);
        int file_id1 = crow::json::load(res_init1.body)["file_id"].i();
        
        crow::request req_fin1;
        req_fin1.url = "/files/" + std::to_string(file_id1) + "/finalize-external";
        req_fin1.add_header("Authorization", "Bearer " + valid_token);
        req_fin1.body = R"({"external_file_id": "google_file_A"})";
        router.handle_finalize_external_upload(req_fin1, file_id1);

        // Obter Sync Map
        crow::request req_map;
        req_map.url = "/api/storage/google/accounts/" + std::to_string(account_id) + "/sync-map";
        req_map.add_header("Authorization", "Bearer " + valid_token);
        crow::response res_map = router.handle_get_google_sync_map(req_map, account_id);
        
        REQUIRE(res_map.code == 200);
        auto map_json = crow::json::load(res_map.body);
        REQUIRE(map_json["files"].size() == 1);
        REQUIRE(map_json["files"][0]["external_file_id"].s() == "google_file_A");

        // Fazer Sync Cleanup
        crow::request req_clean;
        req_clean.url = "/api/storage/google/accounts/" + std::to_string(account_id) + "/sync-cleanup";
        req_clean.add_header("Authorization", "Bearer " + valid_token);
        req_clean.body = R"({"missing_external_ids": ["google_file_A"]})";
        crow::response res_clean = router.handle_google_sync_cleanup(req_clean, account_id);
        
        REQUIRE(res_clean.code == 200);

        // Obter Sync Map novamente, deve estar vazio
        crow::response res_map2 = router.handle_get_google_sync_map(req_map, account_id);
        auto map_json2 = crow::json::load(res_map2.body);
        REQUIRE(map_json2["files"].size() == 0);

        // BOLA Test: Atacante tenta fazer cleanup de um arquivo da Vítima
        uint64_t attacker_id = 1337;
        {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            txn.exec("INSERT INTO users (id, username, email, password_hash, max_storage_bytes, is_email_verified) "
                     "VALUES (1337, 'attacker', 'attacker@test.com', 'hash', 104857600, true)");
            txn.commit();
        }
        std::string attacker_token = auth.generate_token(attacker_id);

        // Init e Finalize File 2 (Vítima)
        crow::request req_init2;
        req_init2.url = "/files";
        req_init2.add_header("Authorization", "Bearer " + valid_token);
        req_init2.body = R"({"folder_id": null, "encrypted_name": "sync_test2.txt", "name_hash": "hashB", "encrypted_fdk": "fdkB", "size_bytes": 1024, "storage_provider": "google_drive"})";
        crow::response res_init2 = router.handle_init_file_upload(req_init2);
        int file_id2 = crow::json::load(res_init2.body)["file_id"].i();
        
        crow::request req_fin2;
        req_fin2.url = "/files/" + std::to_string(file_id2) + "/finalize-external";
        req_fin2.add_header("Authorization", "Bearer " + valid_token);
        req_fin2.body = R"({"external_file_id": "google_file_B"})";
        router.handle_finalize_external_upload(req_fin2, file_id2);

        // Atacante tenta limpar o arquivo da vítima (enviando account_id da vítima e external_file_id da vítima)
        crow::request req_clean_att;
        req_clean_att.url = "/api/storage/google/accounts/" + std::to_string(account_id) + "/sync-cleanup";
        req_clean_att.add_header("Authorization", "Bearer " + attacker_token);
        req_clean_att.body = R"({"missing_external_ids": ["google_file_B"]})";
        crow::response res_clean_att = router.handle_google_sync_cleanup(req_clean_att, account_id);
        
        // A requisição retorna 200 mas NENHUM ARQUIVO é deletado porque a query do FileManager usa user_id
        REQUIRE(res_clean_att.code == 200);

        // Verificar que o arquivo B ainda existe no mapa da Vítima
        crow::response res_map3 = router.handle_get_google_sync_map(req_map, account_id);
        auto map_json3 = crow::json::load(res_map3.body);
        REQUIRE(map_json3["files"].size() == 1);
        REQUIRE(map_json3["files"][0]["external_file_id"].s() == "google_file_B");

        // Limpeza do Atacante
        {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            txn.exec("DELETE FROM users WHERE id = 1337");
            txn.commit();
        }
    }
}
