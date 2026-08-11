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
#include <algorithm>
#include <array>
#include <exception>
#include <thread>

TEST_CASE("API Google Drive - Endpoints", "[api][googledrive]") {
    set_test_environment("GOOGLE_CLIENT_ID", "mock_client_id");
    set_test_environment("GOOGLE_CLIENT_SECRET", "mock_client_secret");
    
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

    SECTION("vinculo preserva foto HTTPS e tolera foto ausente ou insegura") {
        gdrive.mock_account_picture = "https://lh3.googleusercontent.com/avatar";
        auto state = gdrive.generate_test_state(user_id);
        REQUIRE(gdrive.link_account(user_id, "valid_code_456", state).account_email == "mock@test.com");

        crow::request req;
        req.add_header("Authorization", "Bearer " + valid_token);
        const auto with_picture = router.handle_get_google_accounts(req);
        REQUIRE(with_picture.body.find("https://lh3.googleusercontent.com/avatar") != std::string::npos);

        gdrive.unlink_account(user_id);
        gdrive.mock_account_picture = "javascript:alert(1)";
        REQUIRE_NOTHROW(gdrive.link_account(user_id, "valid_code_456", gdrive.generate_test_state(user_id)));
        const auto without_picture = router.handle_get_google_accounts(req);
        REQUIRE(without_picture.body.find("javascript") == std::string::npos);
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

    SECTION("GET /files/{id}/external-upload-recovery-context - contexto vinculado e sem segredos extras") {
        gdrive.link_account(user_id, "valid_code_456", gdrive.generate_test_state(user_id));
        int storage_id = 0;
        int file_id = 0;
        {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            storage_id = txn.exec("SELECT id FROM user_external_storages WHERE user_id = $1", pqxx::params{user_id})[0][0].as<int>();
            file_id = txn.exec(
                "INSERT INTO files (user_id, encrypted_name, name_hash, encrypted_fdk, size_bytes, total_chunks, "
                "is_upload_complete, storage_provider, external_storage_id) VALUES ($1, 'cipher', 'opaque-recovery-name', "
                "'cipher-fdk', 100, 1, FALSE, 'google_drive', $2) RETURNING id",
                pqxx::params{user_id, storage_id})[0][0].as<int>();
            txn.commit();
        }

        crow::request req;
        req.url = "/files/" + std::to_string(file_id) + "/external-upload-recovery-context";
        req.add_header("Authorization", "Bearer " + valid_token);
        gdrive.expect_refresh = true;
        auto res = router.handle_get_external_upload_recovery_context(req, file_id);

        REQUIRE(res.code == 200);
        REQUIRE(res.get_header_value("Cache-Control") == "no-store");
        REQUIRE(res.get_header_value("Pragma") == "no-cache");
        REQUIRE(res.body.find("\"storage_provider\":\"google_drive\"") != std::string::npos);
        REQUIRE(res.body.find("\"external_storage_id\":" + std::to_string(storage_id)) != std::string::npos);
        REQUIRE(res.body.find("root_folder_id") == std::string::npos);
        REQUIRE(res.body.find("access_token") == std::string::npos);
        REQUIRE(res.body.find("\"name_hash\":\"opaque-recovery-name\"") != std::string::npos);
        REQUIRE(res.body.find("refresh_token") == std::string::npos);
        REQUIRE(res.body.find("client_secret") == std::string::npos);
        REQUIRE(res.body.find("encrypted_fdk") == std::string::npos);

        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        const auto state = txn.exec("SELECT is_upload_complete, storage_provider, external_storage_id FROM files WHERE id = $1", pqxx::params{file_id})[0];
        REQUIRE_FALSE(state[0].as<bool>());
        REQUIRE(state[1].as<std::string>() == "google_drive");
        REQUIRE(state[2].as<int>() == storage_id);
        txn.commit();
    }

    SECTION("GET /files/{id}/external-upload-recovery-context - bloqueios de identidade e estado") {
        crow::request missing_auth;
        missing_auth.url = "/files/999999/external-upload-recovery-context";
        REQUIRE(router.handle_get_external_upload_recovery_context(missing_auth, 999999).code == 401);

        int google_pending = 0;
        int google_complete = 0;
        int google_without_storage = 0;
        int local_pending = 0;
        {
            gdrive.link_account(user_id, "valid_code_456", gdrive.generate_test_state(user_id));
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            const int storage_id = txn.exec("SELECT id FROM user_external_storages WHERE user_id = $1", pqxx::params{user_id})[0][0].as<int>();
            google_pending = txn.exec(
                "INSERT INTO files (user_id, encrypted_name, name_hash, encrypted_fdk, size_bytes, total_chunks, "
                "is_upload_complete, storage_provider, external_storage_id) VALUES ($1, 'pending', 'pending-context', 'fdk', 10, 1, FALSE, 'google_drive', $2) RETURNING id",
                pqxx::params{user_id, storage_id})[0][0].as<int>();
            google_complete = txn.exec(
                "INSERT INTO files (user_id, encrypted_name, name_hash, encrypted_fdk, size_bytes, total_chunks, "
                "is_upload_complete, storage_provider, external_storage_id) VALUES ($1, 'complete', 'complete-context', 'fdk', 10, 1, TRUE, 'google_drive', $2) RETURNING id",
                pqxx::params{user_id, storage_id})[0][0].as<int>();
            google_without_storage = txn.exec(
                "INSERT INTO files (user_id, encrypted_name, name_hash, encrypted_fdk, size_bytes, total_chunks, "
                "is_upload_complete, storage_provider) VALUES ($1, 'orphan', 'orphan-context', 'fdk', 10, 1, FALSE, 'google_drive') RETURNING id",
                pqxx::params{user_id})[0][0].as<int>();
            local_pending = txn.exec(
                "INSERT INTO files (user_id, encrypted_name, name_hash, encrypted_fdk, size_bytes, total_chunks, "
                "is_upload_complete, storage_provider) VALUES ($1, 'local', 'local-context', 'fdk', 10, 1, FALSE, 'local') RETURNING id",
                pqxx::params{user_id})[0][0].as<int>();
            txn.commit();
        }

        auto request_for = [&](int file_id) {
            crow::request req;
            req.url = "/files/" + std::to_string(file_id) + "/external-upload-recovery-context";
            req.add_header("Authorization", "Bearer " + valid_token);
            return router.handle_get_external_upload_recovery_context(req, file_id);
        };
        uint64_t attacker_id = 1337;
        std::string attacker_token;
        int attacker_storage = 0;
        int victim_file = 0;
        int foreign_storage_file = 0;
        {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            txn.exec("INSERT INTO users (id, username, email, password_hash, max_storage_bytes, is_email_verified) "
                     "VALUES (1337, 'recovery_attacker', 'recovery-attacker@test.com', 'hash', 104857600, true)");
            txn.commit();
        }
        attacker_token = auth.generate_token(attacker_id);
        gdrive.link_account(attacker_id, "valid_code_456", gdrive.generate_test_state(attacker_id));
        {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            attacker_storage = txn.exec("SELECT id FROM user_external_storages WHERE user_id = $1", pqxx::params{attacker_id})[0][0].as<int>();
            victim_file = txn.exec(
                "INSERT INTO files (user_id, encrypted_name, name_hash, encrypted_fdk, size_bytes, total_chunks, "
                "is_upload_complete, storage_provider, external_storage_id) VALUES ($1, 'victim', 'victim-context', "
                "'fdk', 10, 1, FALSE, 'google_drive', $2) RETURNING id",
                pqxx::params{user_id, attacker_storage})[0][0].as<int>();
            foreign_storage_file = txn.exec(
                "INSERT INTO files (user_id, encrypted_name, name_hash, encrypted_fdk, size_bytes, total_chunks, "
                "is_upload_complete, storage_provider, external_storage_id) VALUES ($1, 'foreign', 'foreign-context', "
                "'fdk', 10, 1, FALSE, 'google_drive', $2) RETURNING id",
                pqxx::params{user_id, attacker_storage})[0][0].as<int>();
            txn.commit();
        }

        crow::request cross_user_req;
        cross_user_req.url = "/files/" + std::to_string(victim_file) + "/external-upload-recovery-context";
        cross_user_req.add_header("Authorization", "Bearer " + attacker_token);
        const auto cross_user_res = router.handle_get_external_upload_recovery_context(cross_user_req, victim_file);
        REQUIRE(cross_user_res.code == 404);
        REQUIRE(cross_user_res.body.find("access_token") == std::string::npos);
        REQUIRE(request_for(foreign_storage_file).code == 409);

        {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            txn.exec("DELETE FROM files WHERE user_id = $1", pqxx::params{attacker_id});
            txn.exec("DELETE FROM user_external_storages WHERE user_id = $1", pqxx::params{attacker_id});
            txn.exec("DELETE FROM users WHERE id = $1", pqxx::params{attacker_id});
            txn.commit();
        }
        REQUIRE(request_for(999999).code == 404);
        REQUIRE(request_for(google_complete).code == 409);
        REQUIRE(request_for(google_without_storage).code == 409);
        REQUIRE(request_for(local_pending).code == 400);
        REQUIRE(request_for(google_pending).code == 200);
    }

    SECTION("GET /files/{id}/external-upload-recovery-context - não exige token do provider") {
        gdrive.link_account(user_id, "valid_code_456", gdrive.generate_test_state(user_id));
        int storage_id = 0;
        int file_id = 0;
        {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            storage_id = txn.exec("SELECT id FROM user_external_storages WHERE user_id = $1", pqxx::params{user_id})[0][0].as<int>();
            file_id = txn.exec(
                "INSERT INTO files (user_id, encrypted_name, name_hash, encrypted_fdk, size_bytes, total_chunks, "
                "is_upload_complete, storage_provider, external_storage_id) VALUES ($1, 'pending', 'refresh-failure', "
                "'fdk', 10, 1, FALSE, 'google_drive', $2) RETURNING id",
                pqxx::params{user_id, storage_id})[0][0].as<int>();
            txn.commit();
        }

        crow::request req;
        req.url = "/files/" + std::to_string(file_id) + "/external-upload-recovery-context";
        req.add_header("Authorization", "Bearer " + valid_token);
        const auto res = router.handle_get_external_upload_recovery_context(req, file_id);

        REQUIRE(res.code == 200);
        REQUIRE(res.body.find("\"external_storage_id\":" + std::to_string(storage_id)) != std::string::npos);
        REQUIRE(res.body.find("access_token") == std::string::npos);
        REQUIRE(gdrive.refresh_requests.load() == 0);
    }

    SECTION("POST /files/{id}/external-upload-session - reconcilia e cria sessão sem expor metadata estrutural") {
        gdrive.link_account(user_id, "valid_code_456", gdrive.generate_test_state(user_id));
        int storage_id = 0;
        int file_id = 0;
        {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            storage_id = txn.exec("SELECT id FROM user_external_storages WHERE user_id = $1", pqxx::params{user_id})[0][0].as<int>();
            file_id = txn.exec(
                "INSERT INTO files (user_id, encrypted_name, name_hash, encrypted_fdk, size_bytes, total_chunks, "
                "is_upload_complete, storage_provider, external_storage_id) VALUES ($1, 'pending', 'upload-name-hash', "
                "'fdk', 10, 1, FALSE, 'google_drive', $2) RETURNING id",
                pqxx::params{user_id, storage_id})[0][0].as<int>();
            txn.commit();
        }

        gdrive.override_upload_reconciliation = true;
        crow::request req;
        req.url = "/files/" + std::to_string(file_id) + "/external-upload-session";
        req.add_header("Authorization", "Bearer " + valid_token);
        req.add_header("Origin", "http://localhost:4200");

        auto upload = router.handle_create_external_upload_session(req, file_id);
        REQUIRE(upload.code == 200);
        REQUIRE(upload.get_header_value("Cache-Control") == "no-store");
        REQUIRE(upload.get_header_value("Pragma") == "no-cache");
        REQUIRE(upload.body.find("\"status\":\"upload\"") != std::string::npos);
        REQUIRE(upload.body.find("session_uri") != std::string::npos);
        REQUIRE(upload.body.find("access_token") != std::string::npos);
        REQUIRE(upload.body.find("root_folder_id") == std::string::npos);
        REQUIRE(upload.body.find("encrypted_fdk") == std::string::npos);
        REQUIRE(gdrive.upload_reconciliation_requests == 1);
        REQUIRE(gdrive.last_json_body.find("nanika_upload_file_id") != std::string::npos);
        REQUIRE(gdrive.last_json_body.find(std::to_string(file_id)) != std::string::npos);
        REQUIRE(gdrive.last_json_body.find("upload-name-hash") != std::string::npos);
        REQUIRE(gdrive.last_session_headers.at("X-Upload-Content-Length") == "10");

        gdrive.upload_reconciliation_targets = {"completed-google-id"};
        auto completed = router.handle_create_external_upload_session(req, file_id);
        REQUIRE(completed.code == 200);
        REQUIRE(completed.body.find("\"status\":\"completed\"") != std::string::npos);
        REQUIRE(completed.body.find("completed-google-id") != std::string::npos);

        gdrive.upload_reconciliation_targets = {"orphan-a", "orphan-b"};
        auto ambiguous = router.handle_create_external_upload_session(req, file_id);
        REQUIRE(ambiguous.code == 409);
        REQUIRE(ambiguous.body.find("GOOGLE_UPLOAD_RECONCILIATION_AMBIGUOUS") != std::string::npos);
    }

    SECTION("POST /files/{id}/external-upload-cancel - marca tombstone sem falar com o Google") {
        gdrive.link_account(user_id, "valid_code_456", gdrive.generate_test_state(user_id));
        const auto storage_id = [&] {
            auto conn = pool.acquire_connection();
            pqxx::read_transaction txn(*conn);
            return txn.exec("SELECT id FROM user_external_storages WHERE user_id=$1", pqxx::params{user_id})[0][0].as<uint64_t>();
        }();
        const auto file_id = [&] {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            const auto id = txn.exec(
                "INSERT INTO files (user_id, encrypted_name, name_hash, encrypted_fdk, size_bytes, total_chunks, "
                "is_upload_complete, storage_provider, external_storage_id) "
                "VALUES ($1, 'cancel-cipher', 'cancel-name-hash', 'cancel-fdk', 2048, 1, FALSE, 'google_drive', $2) RETURNING id",
                pqxx::params{user_id, storage_id})[0][0].as<uint64_t>();
            txn.commit();
            return id;
        }();

        crow::request unauthorized;
        REQUIRE(router.handle_cancel_external_upload(unauthorized, static_cast<int>(file_id)).code == 401);

        crow::request request;
        request.url = "/files/" + std::to_string(file_id) + "/external-upload-cancel";
        request.add_header("Authorization", "Bearer " + valid_token);
        request.body = "{}";
        auto response = router.handle_cancel_external_upload(request, static_cast<int>(file_id));

        REQUIRE(response.code == 202);
        REQUIRE(response.body.find("cleanup_pending") != std::string::npos);
        REQUIRE(response.get_header_value("Cache-Control") == "no-store");
        REQUIRE(response.get_header_value("Pragma") == "no-cache");
        REQUIRE(gdrive.upload_reconciliation_requests == 0);
        REQUIRE(gdrive.deletion_requests == 0);

        {
            auto conn = pool.acquire_connection();
            pqxx::read_transaction txn(*conn);
            const auto row = txn.exec(
                "SELECT deleted_at IS NOT NULL, external_file_id, is_upload_complete, "
                "is_external_cleanup_pending, folder_id FROM files WHERE id=$1",
                pqxx::params{file_id});
            REQUIRE(row.size() == 1);
            REQUIRE(row[0][0].as<bool>());
            REQUIRE(row[0][1].is_null());
            REQUIRE_FALSE(row[0][2].as<bool>());
            REQUIRE(row[0][3].as<bool>());
            REQUIRE(row[0][4].is_null());
        }

        auto repeated = router.handle_cancel_external_upload(request, static_cast<int>(file_id));
        REQUIRE(repeated.code == 202);
        {
            auto conn = pool.acquire_connection();
            pqxx::read_transaction txn(*conn);
            const auto retained = txn.exec(
                "SELECT deleted_at IS NOT NULL, is_external_cleanup_pending, folder_id "
                "FROM files WHERE id=$1",
                pqxx::params{file_id});
            REQUIRE(retained.size() == 1);
            REQUIRE(retained[0][0].as<bool>());
            REQUIRE(retained[0][1].as<bool>());
            REQUIRE(retained[0][2].is_null());
        }
    }

    SECTION("GET storage targets - preserva conta quando quota fica indisponivel") {
        gdrive.link_account(user_id, "valid_code_456", gdrive.generate_test_state(user_id));
        gdrive.expect_refresh = true;
        gdrive.refresh_token_ok = false;

        crow::request accounts_req;
        accounts_req.url = "/api/storage/google/accounts";
        accounts_req.add_header("Authorization", "Bearer " + valid_token);
        const auto accounts_res = router.handle_get_google_accounts(accounts_req);
        REQUIRE(accounts_res.code == 200);
        REQUIRE(accounts_res.body.find("mock@test.com") != std::string::npos);
        REQUIRE(accounts_res.body.find("refresh_token") == std::string::npos);

        crow::request targets_req;
        targets_req.url = "/api/storage/targets";
        targets_req.add_header("Authorization", "Bearer " + valid_token);
        const auto targets_res = router.handle_get_storage_targets(targets_req);
        REQUIRE(targets_res.code == 200);
        REQUIRE(targets_res.body.find("\"key\":\"local\"") != std::string::npos);
        REQUIRE(targets_res.body.find("\"key\":\"google:") != std::string::npos);
        REQUIRE(targets_res.body.find("\"status\":\"unavailable\"") != std::string::npos);
        REQUIRE(targets_res.body.find("\"used_bytes\":null") != std::string::npos);
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
        REQUIRE(res_init.get_header_value("Cache-Control").find("no-store") != std::string::npos);
        REQUIRE(res_init.get_header_value("Pragma") == "no-cache");
        
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

    SECTION("respostas sensíveis usam no-store") {
        gdrive.link_account(user_id, "valid_code_456", gdrive.generate_test_state(user_id));
        const auto account_id = gdrive.get_linked_accounts(user_id).front().id;

        crow::request init_req;
        init_req.url = "/files";
        init_req.add_header("Authorization", "Bearer " + valid_token);
        init_req.body = R"({"folder_id":null,"encrypted_name":"metadata-cipher","name_hash":"metadata-hash","encrypted_fdk":"metadata-fdk","size_bytes":10,"storage_provider":"google_drive"})";
        auto init = router.handle_init_file_upload(init_req);
        REQUIRE(init.code == 201);
        REQUIRE(init.get_header_value("Cache-Control").find("no-store") != std::string::npos);
        REQUIRE(init.get_header_value("Pragma") == "no-cache");
        const auto file_id = crow::json::load(init.body)["file_id"].i();

        crow::request finalize_req;
        finalize_req.url = "/files/" + std::to_string(file_id) + "/finalize-external";
        finalize_req.add_header("Authorization", "Bearer " + valid_token);
        finalize_req.body = R"({"external_file_id":"metadata-google-id"})";
        REQUIRE(router.handle_finalize_external_upload(finalize_req, file_id).code == 200);

        crow::request metadata_req;
        metadata_req.url = "/files/" + std::to_string(file_id) + "/download";
        metadata_req.add_header("Authorization", "Bearer " + valid_token);
        auto metadata = router.handle_download_file(metadata_req, file_id);
        REQUIRE(metadata.code == 200);
        REQUIRE(metadata.get_header_value("Cache-Control").find("no-store") != std::string::npos);
        REQUIRE(metadata.get_header_value("Pragma") == "no-cache");
        REQUIRE(crow::json::load(metadata.body).has("access_token"));

        auto move = crow::json::load(file_mgr.start_storage_move(user_id, file_id, "local", std::nullopt, std::nullopt).dump());
        const auto source_item_id = move["items"][0]["id"].i();
        crow::request source_req;
        source_req.url = "/storage-moves/" + std::to_string(move["id"].i()) + "/items/" + std::to_string(source_item_id) + "/source";
        source_req.add_header("Authorization", "Bearer " + valid_token);
        auto source = router.handle_get_storage_move_source(source_req, move["id"].i(), source_item_id);
        REQUIRE(source.code == 200);
        REQUIRE(source.get_header_value("Cache-Control").find("no-store") != std::string::npos);
        REQUIRE(source.get_header_value("Pragma") == "no-cache");
        REQUIRE(crow::json::load(source.body).has("access_token"));

        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        const auto local_file_id = txn.exec(
            "INSERT INTO files(user_id,encrypted_name,name_hash,encrypted_fdk,size_bytes,total_chunks,is_upload_complete,storage_provider) "
            "VALUES($1,'session-cipher','session-hash','session-fdk',10,1,TRUE,'local') RETURNING id",
            pqxx::params{user_id})[0][0].as<int>();
        txn.commit();
        auto google_move = crow::json::load(file_mgr.start_storage_move(user_id, local_file_id, "google_drive", account_id, 1000).dump());
        const auto google_item_id = google_move["items"][0]["id"].i();
        crow::request session_req;
        session_req.url = "/storage-moves/" + std::to_string(google_move["id"].i()) + "/items/" + std::to_string(google_item_id) + "/google-session";
        session_req.add_header("Authorization", "Bearer " + valid_token);
        auto session = router.handle_create_storage_move_google_session(session_req, google_move["id"].i(), google_item_id);
        REQUIRE(session.code == 200);
        REQUIRE(session.get_header_value("Cache-Control").find("no-store") != std::string::npos);
        REQUIRE(session.get_header_value("Pragma") == "no-cache");
        REQUIRE(crow::json::load(session.body).has("session_uri"));
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

TEST_CASE("B.40 API expired OAuth state is rejected before provider work", "[api][googledrive][b40]") {
    set_test_environment("GOOGLE_CLIENT_ID", "mock_client_id");
    set_test_environment("GOOGLE_CLIENT_SECRET", "mock_client_secret");

    DatabasePool pool(4, get_secure_conn_string());
    MockEmailService email;
    AuthService auth("pepper", "secret", &email);
    FolderManager folders(pool);
    FileManager files(pool);
    FileChunker chunker("./test_storage");
    MockGoogleDriveService gdrive(pool);
    ApiRouter router(pool, auth, folders, &files, &chunker, &gdrive);
    const uint64_t user_id = 9944;

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE id=$1", pqxx::params{user_id});
        txn.exec(
            "INSERT INTO users(id,username,email,password_hash,max_storage_bytes,is_email_verified) "
            "VALUES($1,'b40_api_expiry','b40-api-expiry@test.com','hash',104857600,TRUE)",
            pqxx::params{user_id});
        txn.commit();
    }

    struct Cleanup {
        DatabasePool& pool;
        uint64_t user_id;
        ~Cleanup() {
            try {
                auto conn = pool.acquire_connection();
                pqxx::work txn(*conn);
                txn.exec("DELETE FROM files WHERE user_id=$1", pqxx::params{user_id});
                txn.exec("DELETE FROM user_external_storages WHERE user_id=$1", pqxx::params{user_id});
                txn.exec("DELETE FROM folders WHERE user_id=$1", pqxx::params{user_id});
                txn.exec("DELETE FROM users WHERE id=$1", pqxx::params{user_id});
                txn.commit();
            } catch (...) {}
        }
    } cleanup{pool, user_id};

    const auto token = auth.generate_token(user_id);
    crow::request generate_request;
    generate_request.url = "/api/storage/google/generate-state";
    generate_request.add_header("Authorization", "Bearer " + token);
    const auto generated = router.handle_generate_google_state(generate_request);
    REQUIRE(generated.code == 200);
    const auto generated_json = crow::json::load(generated.body);
    REQUIRE(generated_json);
    const std::string state = generated_json["state"].s();

    gdrive.expire_test_state(user_id);
    crow::request link_request;
    link_request.url = "/api/storage/google/link";
    link_request.add_header("Authorization", "Bearer " + token);
    link_request.body = R"({"auth_code":"valid_code","state":")" + state + R"("})";

    const auto first = router.handle_link_google_drive(link_request);
    REQUIRE(first.code == 400);
    REQUIRE(first.body.find("State invalido ou expirado") != std::string::npos);
    CHECK(gdrive.token_exchange_requests.load() == 0);
    CHECK(gdrive.folder_search_requests.load() == 0);
    CHECK(gdrive.folder_create_requests.load() == 0);

    const auto replay = router.handle_link_google_drive(link_request);
    REQUIRE(replay.code == 400);
    CHECK(gdrive.token_exchange_requests.load() == 0);

    auto conn = pool.acquire_connection();
    pqxx::work txn(*conn);
    const auto rows = txn.exec(
        "SELECT count(*) FROM user_external_storages WHERE user_id=$1",
        pqxx::params{user_id});
    txn.commit();
    REQUIRE(rows[0][0].as<int>() == 0);
}

TEST_CASE("B.41 API storage targets returns the DB lease before quota HTTP", "[api][googledrive][b41]") {
    set_test_environment("GOOGLE_CLIENT_ID", "mock_client_id");
    set_test_environment("GOOGLE_CLIENT_SECRET", "mock_client_secret");

    DatabasePool pool(2, get_secure_conn_string());
    MockEmailService email;
    AuthService auth("pepper", "secret", &email);
    FolderManager folders(pool);
    FileManager files(pool);
    FileChunker chunker("./test_storage");
    MockGoogleDriveService gdrive(pool);
    ApiRouter router(pool, auth, folders, &files, &chunker, &gdrive);
    const uint64_t user_id = 9946;
    uint64_t storage_id = 0;

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE id=$1", pqxx::params{user_id});
        txn.exec(
            "INSERT INTO users(id,username,email,password_hash,max_storage_bytes,is_email_verified) "
            "VALUES($1,'b41_api_targets','b41-api-targets@test.com','hash',104857600,TRUE)",
            pqxx::params{user_id});
        txn.commit();
    }

    REQUIRE_NOTHROW(gdrive.link_account(user_id, "valid_code", gdrive.generate_test_state(user_id)));
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        storage_id = txn.exec(
            "SELECT id FROM user_external_storages WHERE user_id=$1 AND provider='google_drive'",
            pqxx::params{user_id})[0][0].as<uint64_t>();
        txn.commit();
    }

    struct Cleanup {
        DatabasePool& pool;
        uint64_t user_id;
        ~Cleanup() {
            try {
                auto conn = pool.acquire_connection();
                pqxx::work txn(*conn);
                txn.exec("DELETE FROM users WHERE id=$1", pqxx::params{user_id});
                txn.commit();
            } catch (...) {}
        }
    } cleanup{pool, user_id};

    gdrive.expect_refresh = true;
    REQUIRE(gdrive.get_access_token_for_storage(storage_id) == gdrive.mock_access_token);
    REQUIRE(gdrive.refresh_requests.load() == 1);

    const auto token = auth.generate_token(user_id);
    crow::request request;
    request.url = "/api/storage/targets";
    request.add_header("Authorization", "Bearer " + token);

    gdrive.enable_quota_gate();
    crow::response response;
    std::exception_ptr error;
    std::thread worker([&] {
        try {
            response = router.handle_get_storage_targets(request);
        } catch (...) {
            error = std::current_exception();
        }
    });

    const bool quota_blocked = gdrive.wait_for_quota_waiters(1);
    const size_t available_at_quota_gate = quota_blocked ? pool.get_available_count() : 0;
    gdrive.release_quota_gate();
    worker.join();

    REQUIRE(quota_blocked);
    REQUIRE_FALSE(error);
    CHECK(available_at_quota_gate == 2);
    REQUIRE(response.code == 200);
    CHECK(response.body.find("\"key\":\"local\"") != std::string::npos);
    CHECK(response.body.find("\"key\":\"google:" + std::to_string(storage_id) + "\"") != std::string::npos);
    CHECK(response.body.find("\"status\":\"ready\"") != std::string::npos);
    CHECK(response.body.find("500000000000") != std::string::npos);
    CHECK(gdrive.quota_requests == 1);
}

TEST_CASE("B.37 API Google link concorrente tem um winner e um 409", "[api][googledrive][b37]") {
    set_test_environment("GOOGLE_CLIENT_ID", "mock_client_id");
    set_test_environment("GOOGLE_CLIENT_SECRET", "mock_client_secret");

    DatabasePool pool(8, get_secure_conn_string());
    MockEmailService email;
    AuthService auth("pepper", "secret", &email);
    FolderManager folders(pool);
    FileManager files(pool);
    FileChunker chunker("./test_storage");
    MockGoogleDriveService gdrive(pool);
    ApiRouter router(pool, auth, folders, &files, &chunker, &gdrive);
    const uint64_t user_id = 9936;
    gdrive.mock_account_email = "b37-api-same-account@test.com";
    gdrive.numbered_folder_ids = true;

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE id=$1 OR username='api_gd_b37_user'", pqxx::params{user_id});
        txn.exec(
            "INSERT INTO users(id,username,email,password_hash,max_storage_bytes,is_email_verified) "
            "VALUES($1,'api_gd_b37_user','api_gd_b37@test.com','hash',104857600,TRUE)",
            pqxx::params{user_id});
        txn.commit();
    }
    struct Cleanup {
        DatabasePool& pool;
        uint64_t user_id;
        ~Cleanup() {
            try {
                auto conn = pool.acquire_connection();
                pqxx::work txn(*conn);
                txn.exec("DELETE FROM users WHERE id=$1", pqxx::params{user_id});
                txn.commit();
            } catch (...) {}
        }
    } cleanup{pool, user_id};

    const auto token = auth.generate_token(user_id);
    const auto request = [&](const std::string& code, const std::string& state) {
        crow::request req;
        req.url = "/api/storage/google/link";
        req.add_header("Authorization", "Bearer " + token);
        req.body = R"({"auth_code":")" + code + R"(","state":")" + state + R"("})";
        return router.handle_link_google_drive(req);
    };

    gdrive.enable_link_gate(2);
    std::array<int, 2> statuses{};
    const auto state_a = gdrive.generate_test_state(user_id);
    std::thread first([&] { statuses[0] = request("b37_api_code_a", state_a).code; });
    const bool first_reached_provider = gdrive.wait_for_link_waiters(1);
    if (!first_reached_provider) {
        gdrive.release_link_gate();
        first.join();
        REQUIRE(first_reached_provider);
    }

    const auto state_b = gdrive.generate_test_state(user_id);
    std::thread second([&] { statuses[1] = request("b37_api_code_b", state_b).code; });
    const bool both_reached_provider = gdrive.wait_for_link_waiters(2);
    gdrive.release_link_gate();
    first.join();
    second.join();
    std::sort(statuses.begin(), statuses.end());

    auto conn = pool.acquire_connection();
    pqxx::work txn(*conn);
    const int active_rows = txn.exec(
        "SELECT count(*) FROM user_external_storages WHERE user_id=$1 AND provider='google_drive' "
        "AND account_email=$2 AND is_unlinking=FALSE",
        pqxx::params{user_id, gdrive.mock_account_email})[0][0].as<int>();
    txn.commit();
    INFO("both_provider=" << both_reached_provider << " statuses=" << statuses[0] << ',' << statuses[1]
         << " searches=" << gdrive.folder_search_requests.load()
         << " creates=" << gdrive.folder_create_requests.load() << " active_rows=" << active_rows);

    CHECK_FALSE(both_reached_provider);
    CHECK(statuses == std::array<int, 2>{200, 409});
    CHECK(gdrive.folder_search_requests.load() == 1);
    CHECK(gdrive.folder_create_requests.load() == 1);
    CHECK(active_rows == 1);
}

TEST_CASE("B.81 API maps a live Google link claim to conflict",
          "[api][googledrive][b81]") {
    set_test_environment("GOOGLE_CLIENT_ID", "mock_client_id");
    set_test_environment("GOOGLE_CLIENT_SECRET", "mock_client_secret");

    DatabasePool pool(2, get_secure_conn_string());
    MockEmailService email;
    AuthService auth("pepper", "secret", &email);
    FolderManager folders(pool);
    FileManager files(pool);
    FileChunker chunker("./test_storage");
    MockGoogleDriveService gdrive(pool);
    ApiRouter router(pool, auth, folders, &files, &chunker, &gdrive);
    const uint64_t user_id = 9815;

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE id=$1", pqxx::params{user_id});
        txn.exec(
            "INSERT INTO users(id,username,email,password_hash,max_storage_bytes,is_email_verified) "
            "VALUES($1,'b81_api_claim','b81-api-claim@test.com','hash',104857600,TRUE)",
            pqxx::params{user_id});
        txn.exec(
            "INSERT INTO google_link_claims(user_id,account_email,claim_id,expires_at) "
            "VALUES($1,$2,'claim-live',CURRENT_TIMESTAMP + INTERVAL '5 minutes')",
            pqxx::params{user_id, gdrive.mock_account_email});
        txn.commit();
    }

    struct Cleanup {
        DatabasePool& pool;
        uint64_t user_id;
        ~Cleanup() {
            try {
                auto conn = pool.acquire_connection();
                pqxx::work txn(*conn);
                txn.exec("DELETE FROM users WHERE id=$1", pqxx::params{user_id});
                txn.commit();
            } catch (...) {
            }
        }
    } cleanup{pool, user_id};

    const auto token = auth.generate_token(user_id);
    crow::request request;
    request.url = "/api/storage/google/link";
    request.add_header("Authorization", "Bearer " + token);
    request.body = R"({"auth_code":"b81-api-code","state":")" +
                   gdrive.generate_test_state(user_id) + R"("})";

    const auto response = router.handle_link_google_drive(request);
    REQUIRE(response.code == 409);
    CHECK(response.body.find("Vinculacao ja em andamento") != std::string::npos);
    CHECK(gdrive.folder_search_requests.load() == 0);
    CHECK(gdrive.folder_create_requests.load() == 0);
}

TEST_CASE("B.33 unauthorized unlink does not evict another user's Google caches",
          "[api][googledrive][b33]") {
    set_test_environment("GOOGLE_CLIENT_ID", "mock_client_id");
    set_test_environment("GOOGLE_CLIENT_SECRET", "mock_client_secret");

    DatabasePool pool(3, get_secure_conn_string());
    MockEmailService email;
    AuthService auth("pepper", "secret", &email);
    FolderManager folders(pool);
    FileManager files(pool);
    FileChunker chunker("./test_storage");
    MockGoogleDriveService gdrive(pool);
    ApiRouter router(pool, auth, folders, &files, &chunker, &gdrive);

    const uint64_t victim_id = 9988;
    const uint64_t attacker_id = 9989;
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE id IN ($1,$2) OR username IN ('gd_b33_victim','gd_b33_attacker')",
                 pqxx::params{victim_id, attacker_id});
        txn.exec(
            "INSERT INTO users(id,username,email,password_hash,max_storage_bytes,is_email_verified) VALUES "
            "($1,'gd_b33_victim','gd_b33_victim@test.com','hash',104857600,TRUE),"
            "($2,'gd_b33_attacker','gd_b33_attacker@test.com','hash',104857600,TRUE)",
            pqxx::params{victim_id, attacker_id});
        txn.commit();
    }

    struct Cleanup {
        DatabasePool& pool;
        uint64_t victim_id;
        uint64_t attacker_id;
        ~Cleanup() {
            try {
                auto conn = pool.acquire_connection();
                pqxx::work txn(*conn);
                txn.exec("DELETE FROM users WHERE id IN ($1,$2)", pqxx::params{victim_id, attacker_id});
                txn.commit();
            } catch (...) {}
        }
    } cleanup{pool, victim_id, attacker_id};

    gdrive.link_account(victim_id, "valid_code", gdrive.generate_test_state(victim_id));
    const auto storage_id = gdrive.get_linked_accounts(victim_id).at(0).id;
    gdrive.expect_refresh = true;

    REQUIRE(gdrive.get_access_token_for_storage(storage_id) == gdrive.mock_access_token);
    REQUIRE(gdrive.get_access_token_for_storage(storage_id) == gdrive.mock_access_token);
    REQUIRE(gdrive.refresh_requests.load() == 1);
    REQUIRE(gdrive.get_storage_targets(victim_id).at(0).status == "ready");
    REQUIRE(gdrive.get_storage_targets(victim_id).at(0).status == "ready");
    REQUIRE(gdrive.quota_requests == 1);

    crow::request request;
    request.add_header("Authorization", "Bearer " + auth.generate_token(attacker_id));
    const auto response = router.handle_unlink_google_account(request, static_cast<int>(storage_id));

    REQUIRE(response.code == 404);
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        const auto owned = txn.exec(
            "SELECT is_unlinking FROM user_external_storages WHERE id=$1 AND user_id=$2",
            pqxx::params{storage_id, victim_id});
        REQUIRE(owned.size() == 1);
        REQUIRE_FALSE(owned[0][0].as<bool>());
        txn.commit();
    }

    CHECK(gdrive.get_access_token_for_storage(storage_id) == gdrive.mock_access_token);
    CHECK(gdrive.refresh_requests.load() == 1);
    CHECK(gdrive.get_storage_targets(victim_id).at(0).status == "ready");
    CHECK(gdrive.quota_requests == 1);
}

TEST_CASE("B.34 stale Google download cannot acquire token after unlink",
          "[api][googledrive][b34]") {
    set_test_environment("GOOGLE_CLIENT_ID", "mock_client_id");
    set_test_environment("GOOGLE_CLIENT_SECRET", "mock_client_secret");

    DatabasePool pool(3, get_secure_conn_string());
    MockEmailService email;
    AuthService auth("pepper", "secret", &email);
    FolderManager folders(pool);
    FileManager files(pool);
    FileChunker chunker("./test_storage");
    MockGoogleDriveService gdrive(pool);
    ApiRouter router(pool, auth, folders, &files, &chunker, &gdrive);

    const uint64_t user_id = 9995;
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE id=$1", pqxx::params{user_id});
        txn.exec(
            "INSERT INTO users(id,username,email,password_hash,max_storage_bytes,is_email_verified) "
            "VALUES($1,'api_b34_user','api_b34@test.com','hash',104857600,TRUE)",
            pqxx::params{user_id});
        txn.commit();
    }

    struct Cleanup {
        DatabasePool& pool;
        uint64_t user_id;
        ~Cleanup() {
            try {
                auto conn = pool.acquire_connection();
                pqxx::work txn(*conn);
                txn.exec("DELETE FROM users WHERE id=$1", pqxx::params{user_id});
                txn.commit();
            } catch (...) {}
        }
    } cleanup{pool, user_id};

    gdrive.link_account(user_id, "valid_code_456", gdrive.generate_test_state(user_id));
    const auto storage_id = gdrive.get_linked_accounts(user_id).at(0).id;
    int file_id;
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        file_id = txn.exec(
            "INSERT INTO files(user_id,encrypted_name,name_hash,encrypted_fdk,size_bytes,total_chunks,"
            "is_upload_complete,storage_provider,external_file_id,external_storage_id) "
            "VALUES($1,'cipher','download-b34','fdk',10,1,TRUE,'google_drive','external-b34',$2) RETURNING id",
            pqxx::params{user_id, storage_id})[0][0].as<int>();
        txn.commit();
    }

    gdrive.unlink_account(user_id, storage_id);
    gdrive.expect_refresh = true;

    crow::request request;
    request.url = "/files/" + std::to_string(file_id) + "/download";
    request.add_header("Authorization", "Bearer " + auth.generate_token(user_id));
    const auto response = router.handle_download_file(request, file_id);

    REQUIRE(response.code == 404);
    REQUIRE(response.body.find("access_token") == std::string::npos);
    REQUIRE(gdrive.refresh_requests.load() == 0);
}

TEST_CASE("B.61 Google download releases DB lease before cold token refresh",
          "[api][googledrive][download][b61]") {
    set_test_environment("GOOGLE_CLIENT_ID", "mock_client_id");
    set_test_environment("GOOGLE_CLIENT_SECRET", "mock_client_secret");

    DatabasePool pool(2, get_secure_conn_string());
    MockEmailService email;
    AuthService auth("B61_pepper", "B61_secret", &email);
    FolderManager folders(pool);
    FileManager files(pool);
    FileChunker chunker("./test_storage");
    MockGoogleDriveService gdrive(pool);
    ApiRouter router(pool, auth, folders, &files, &chunker, &gdrive);

    const uint64_t user_id = 9611;
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE id=$1", pqxx::params{user_id});
        txn.exec(
            "INSERT INTO users(id,username,email,password_hash,max_storage_bytes,is_email_verified) "
            "VALUES($1,'b61_download_user','b61-download@test.com','hash',104857600,TRUE)",
            pqxx::params{user_id});
        txn.commit();
    }

    struct Cleanup {
        DatabasePool& pool;
        uint64_t user_id;
        ~Cleanup() {
            try {
                auto conn = pool.acquire_connection();
                pqxx::work txn(*conn);
                txn.exec("DELETE FROM files WHERE user_id=$1", pqxx::params{user_id});
                txn.exec("DELETE FROM user_external_storages WHERE user_id=$1", pqxx::params{user_id});
                txn.exec("DELETE FROM folders WHERE user_id=$1", pqxx::params{user_id});
                txn.exec("DELETE FROM users WHERE id=$1", pqxx::params{user_id});
                txn.commit();
            } catch (...) {}
        }
    } cleanup{pool, user_id};

    REQUIRE_NOTHROW(gdrive.link_account(user_id, "b61_valid_code", gdrive.generate_test_state(user_id)));
    const auto storage_id = gdrive.get_linked_accounts(user_id).at(0).id;
    int file_id;
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        file_id = txn.exec(
            "INSERT INTO files(user_id,encrypted_name,name_hash,encrypted_fdk,size_bytes,total_chunks,"
            "is_upload_complete,storage_provider,external_file_id,external_storage_id) "
            "VALUES($1,'cipher','b61-download-name','fdk',10,1,TRUE,'google_drive','b61-remote-file',$2) "
            "RETURNING id",
            pqxx::params{user_id, storage_id})[0][0].as<int>();
        txn.commit();
    }

    const auto token = auth.generate_token(user_id);
    crow::request request;
    request.url = "/files/" + std::to_string(file_id) + "/download";
    request.add_header("Authorization", "Bearer " + token);

    gdrive.expect_refresh = true;
    gdrive.enable_refresh_gate();

    crow::response response;
    std::exception_ptr error;
    std::thread worker([&] {
        try {
            response = router.handle_download_file(request, file_id);
        } catch (...) {
            error = std::current_exception();
        }
    });

    const bool refresh_blocked = gdrive.wait_for_refresh_waiters(1);
    const size_t available_at_refresh = refresh_blocked ? pool.get_available_count() : 0;
    gdrive.release_refresh_gate();
    worker.join();

    REQUIRE(refresh_blocked);
    REQUIRE_FALSE(error);
    CHECK(available_at_refresh == 2);
    REQUIRE(response.code == 200);
    CHECK(response.body.find("\"storage_provider\":\"google_drive\"") != std::string::npos);
    CHECK(response.body.find("\"external_file_id\":\"b61-remote-file\"") != std::string::npos);
    CHECK(response.body.find("\"access_token\":\"mock_access_token_xyz\"") != std::string::npos);
    CHECK(response.get_header_value("Cache-Control") == "no-store");
    CHECK(response.get_header_value("Pragma") == "no-cache");
    CHECK(gdrive.refresh_requests.load() == 1);
}
