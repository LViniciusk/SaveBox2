#include <catch2/catch_test_macros.hpp>
#include "controllers/ApiRouter.hpp"
#include "database/DatabasePool.hpp"
#include "Services/AuthService.hpp"
#include "database/FolderManager.hpp"
#include "database/FileManager.hpp"
#include "storage/FileChunker.hpp"
#include "test_helpers.hpp"
#include <crow_all.h>
#include <filesystem>
#include <string>




TEST_CASE("API de Arquivos - Upload em Chunks", "[api][files]") {
    const std::string test_storage_dir = "./test_api_files_storage/";
    std::filesystem::remove_all(test_storage_dir);
    std::filesystem::create_directories(test_storage_dir);

    std::string conn_str = get_secure_conn_string();
    DatabasePool pool(2, conn_str);
    MockEmailService mock_email;
    AuthService auth("A_noite_é_mais_escura_perto_do_amanhecer", "eu_trouxe_uma_primavera_pra_você", &mock_email);
    FolderManager folder_mgr(pool);
    FileManager file_mgr(pool);
    FileChunker file_chunker(test_storage_dir);

    ApiRouter router(pool, auth, folder_mgr, &file_mgr, &file_chunker);

    int fake_user_id = 0;
    int fake_folder_id = 0;

    std::string test_username = "file_upload_ghost_" + std::to_string(rand());
    std::string test_username_b = "file_upload_ghost_b_" + std::to_string(rand());
    int fake_user_id_b = 0;

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        auto user_res = txn.exec(
            "INSERT INTO users (username, email, password_hash, is_email_verified) VALUES ('" + test_username + "', '" + test_username + "@test.com', 'hash_fake', true) RETURNING id"
        );
        fake_user_id = user_res[0][0].as<int>();

        auto user_res_b = txn.exec(
            "INSERT INTO users (username, email, password_hash, is_email_verified) VALUES ('" + test_username_b + "', '" + test_username_b + "@test.com', 'hash_fake_b', true) RETURNING id"
        );
        fake_user_id_b = user_res_b[0][0].as<int>();

        auto folder_res = txn.exec(
            "INSERT INTO folders (user_id, encrypted_name, name_hash) VALUES ($1, 'enc_ghost_folder', 'ghost_folder_hash') RETURNING id",
            pqxx::params{fake_user_id}
        );
        fake_folder_id = folder_res[0][0].as<int>();
        txn.commit();
    }

    std::string token = auth.generate_token(static_cast<uint64_t>(fake_user_id));
    std::string token_b = auth.generate_token(static_cast<uint64_t>(fake_user_id_b));

    SECTION("Inicializar, enviar chunks e completar upload") {
        crow::request req_init;
        req_init.add_header("Authorization", "Bearer " + token);
        req_init.body = R"({"folder_id": )" + std::to_string(fake_folder_id)
                      + R"(, "encrypted_name": "base64_file_name", "name_hash": "file_hash_123", "encrypted_fdk": "mock_encrypted_fdk", "size_bytes": 1024, "total_chunks": 1})";

        crow::response res_init = router.handle_init_file_upload(req_init);

        REQUIRE(res_init.code == 201);

        auto init_body = crow::json::load(res_init.body);
        int file_id = init_body["file_id"].i();

        crow::request req_chunk1;
        req_chunk1.add_header("Authorization", "Bearer " + token);
        req_chunk1.add_header("X-Chunk-Index", "0");
        req_chunk1.body = std::string(1024, '\xAB'); 

        crow::response res_chunk1 = router.handle_upload_chunk(req_chunk1, file_id);

        REQUIRE(res_chunk1.code == 200);
        REQUIRE(res_chunk1.body.find("completed") != std::string::npos);
    }

    SECTION("Upload Interrompido - arquivo permanece incompleto no banco") {
        crow::request req_init_broken;
        req_init_broken.add_header("Authorization", "Bearer " + token);
        req_init_broken.body = R"({"folder_id": )" + std::to_string(fake_folder_id)
                             + R"(, "encrypted_name": "base64_broken_file", "name_hash": "file_hash_broken", "encrypted_fdk": "mock_encrypted_fdk", "size_bytes": 10485760, "total_chunks": 2})";

        crow::response res_init_broken = router.handle_init_file_upload(req_init_broken);
        REQUIRE(res_init_broken.code == 201);

        auto init_broken_body = crow::json::load(res_init_broken.body);
        int file_id_broken = init_broken_body["file_id"].i();

        crow::request req_chunk_broken;
        req_chunk_broken.add_header("Authorization", "Bearer " + token);
        req_chunk_broken.add_header("X-Chunk-Index", "0");
        req_chunk_broken.body = std::string(512, '\xFF');

        crow::response res_chunk_broken = router.handle_upload_chunk(req_chunk_broken, file_id_broken);
        REQUIRE(res_chunk_broken.code == 200);
        REQUIRE(res_chunk_broken.body.find("uploading") != std::string::npos);

        {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            auto result = txn.exec(
                "SELECT is_upload_complete FROM files WHERE id = $1",
                pqxx::params{file_id_broken}
            );
            txn.commit();

            REQUIRE(!result.empty());
            REQUIRE(result[0][0].as<bool>() == false);
        }

    }

    SECTION("Duplicidade de nome na mesma pasta retorna 409 Conflict") {
        crow::request req_init;
        req_init.add_header("Authorization", "Bearer " + token);
        req_init.body = R"({"folder_id": null, "encrypted_name": "arquivo_duplicado_enc", "name_hash": "hash_duplicado_123", "encrypted_fdk": "mock_encrypted_fdk", "size_bytes": 100, "total_chunks": 1})";

        crow::response res1 = router.handle_init_file_upload(req_init);
        REQUIRE(res1.code == 201);

        crow::response res2 = router.handle_init_file_upload(req_init);
        REQUIRE(res2.code == 409);
        REQUIRE(res2.body.find("Um arquivo com este nome ja existe nesta pasta") != std::string::npos);
        
        crow::request req_init_diff_folder;
        req_init_diff_folder.add_header("Authorization", "Bearer " + token);
        req_init_diff_folder.body = R"({"folder_id": )" + std::to_string(fake_folder_id) + R"(, "encrypted_name": "arquivo_duplicado_enc", "name_hash": "hash_duplicado_123", "encrypted_fdk": "mock_encrypted_fdk", "size_bytes": 100, "total_chunks": 1})";
        crow::response res3 = router.handle_init_file_upload(req_init_diff_folder);
        REQUIRE(res3.code == 201);
    }

    SECTION("Segurança: Bloquear chunk com índice fora dos limites (Sparse File Attack)") {
        crow::request req_init;
        req_init.add_header("Authorization", "Bearer " + token);
        req_init.body = R"({"folder_id": )" + std::to_string(fake_folder_id)
                      + R"(, "encrypted_name": "sparse_attack_file", "name_hash": "sparse_hash_999", "encrypted_fdk": "mock_encrypted_fdk", "size_bytes": 1024, "total_chunks": 1})";

        crow::response res_init = router.handle_init_file_upload(req_init);
        REQUIRE(res_init.code == 201);

        auto init_body = crow::json::load(res_init.body);
        int file_id = init_body["file_id"].i();

        crow::request req_chunk;
        req_chunk.add_header("Authorization", "Bearer " + token);
        req_chunk.add_header("X-Chunk-Index", "1000");
        req_chunk.body = std::string(512, '\xDE');

        crow::response res_chunk = router.handle_upload_chunk(req_chunk, file_id);

        REQUIRE(res_chunk.code == 400);

        int chunks_saved = file_mgr.count_uploaded_chunks(static_cast<uint64_t>(file_id));
        REQUIRE(chunks_saved == 0);
    }

    SECTION("Segurança: Imutabilidade - Bloquear envio de chunks em arquivo finalizado") {
        crow::request req_init;
        req_init.add_header("Authorization", "Bearer " + token);
        req_init.body = R"({"folder_id": )" + std::to_string(fake_folder_id)
                      + R"(, "encrypted_name": "immutable_attack_file", "name_hash": "immutable_hash_999", "encrypted_fdk": "mock_encrypted_fdk", "size_bytes": 1024, "total_chunks": 1})";

        crow::response res_init = router.handle_init_file_upload(req_init);
        REQUIRE(res_init.code == 201);

        auto init_body = crow::json::load(res_init.body);
        int file_id = init_body["file_id"].i();

        crow::request req_chunk;
        req_chunk.add_header("Authorization", "Bearer " + token);
        req_chunk.add_header("X-Chunk-Index", "0");
        req_chunk.body = std::string(1024, '\xDE');
        crow::response res_chunk = router.handle_upload_chunk(req_chunk, file_id);
        
        REQUIRE(res_chunk.code == 200);
        REQUIRE(res_chunk.body.find("completed") != std::string::npos);

        crow::request req_attack;
        req_attack.add_header("Authorization", "Bearer " + token);
        req_attack.add_header("X-Chunk-Index", "0");
        req_attack.body = std::string(1024, '\xFA');
        crow::response res_attack = router.handle_upload_chunk(req_attack, file_id);
        
        REQUIRE(res_attack.code == 400);
        REQUIRE(res_attack.body.find("Upload ja finalizado") != std::string::npos);
    }

    SECTION("Segurança: IDOR - Invasão Cruzada no Upload de Chunks") {
        crow::request req_init;
        req_init.add_header("Authorization", "Bearer " + token);
        req_init.body = R"({"folder_id": )" + std::to_string(fake_folder_id)
                      + R"(, "encrypted_name": "idor_file", "name_hash": "idor_hash_999", "encrypted_fdk": "mock_encrypted_fdk", "size_bytes": 1024, "total_chunks": 1})";

        crow::response res_init = router.handle_init_file_upload(req_init);
        REQUIRE(res_init.code == 201);

        auto init_body = crow::json::load(res_init.body);
        int file_id = init_body["file_id"].i();

        crow::request req_chunk;
        req_chunk.add_header("Authorization", "Bearer " + token_b);
        req_chunk.add_header("X-Chunk-Index", "0");
        req_chunk.body = std::string(1024, '\xDE');
        crow::response res_chunk = router.handle_upload_chunk(req_chunk, file_id);
        
        REQUIRE((res_chunk.code == 403 || res_chunk.code == 404));
    }

    SECTION("Segurança: IDOR Relacional - Iniciar upload na pasta de outro usuário") {
        crow::request req_folder;
        req_folder.add_header("Authorization", "Bearer " + token_b);
        std::string h = "hash_folder_b_" + std::to_string(rand());
        req_folder.body = R"({"encrypted_name": "folder_b", "name_hash": ")" + h + R"("})";
        crow::response res_folder = router.handle_create_folder(req_folder);
        REQUIRE(res_folder.code == 201);
        int folder_b_id = crow::json::load(res_folder.body)["id"].i();

        crow::request req_init;
        req_init.add_header("Authorization", "Bearer " + token);
        req_init.body = R"({"folder_id": )" + std::to_string(folder_b_id)
                      + R"(, "encrypted_name": "idor_file_a", "name_hash": "idor_hash_a", "encrypted_fdk": "mock_encrypted_fdk", "size_bytes": 1024, "total_chunks": 1})";
        
        crow::response res_init = router.handle_init_file_upload(req_init);
        REQUIRE((res_init.code == 403 || res_init.code == 404));
    }
    SECTION("Segurança: Bloquear valores negativos para size e chunks (Underflow)") {
        crow::request req_init;
        req_init.add_header("Authorization", "Bearer " + token);
        req_init.body = R"({"folder_id": null, "encrypted_name": "underflow_file", "name_hash": "under_hash", "encrypted_fdk": "mock_encrypted_fdk", "size_bytes": -1024, "total_chunks": -5})";

        crow::response res_init = router.handle_init_file_upload(req_init);
        REQUIRE(res_init.code == 400);
        REQUIRE(res_init.body.find("Valores numericos invalidos") != std::string::npos);
    }

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username IN ('" + test_username + "', '" + test_username_b + "')");
        txn.commit();
    }

    std::filesystem::remove_all(test_storage_dir);
}
