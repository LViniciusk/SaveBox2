#include <catch2/catch_test_macros.hpp>
#include "controllers/ApiRouter.hpp"
#include "database/DatabasePool.hpp"
#include "services/AuthService.hpp"
#include "database/FolderManager.hpp"
#include "database/FileManager.hpp"
#include "storage/FileChunker.hpp"
#include "test_helpers.hpp"
#include <crow_all.h>
#include <string>




TEST_CASE("API de Arquivos - Upload em Chunks", "[api][files]") {
    std::string conn_str = get_secure_conn_string();
    DatabasePool pool(2, conn_str);
    AuthService auth("A_noite_é_mais_escura_perto_do_amanhecer", "eu_trouxe_uma_primavera_pra_você");
    FolderManager folder_mgr(pool);
    FileManager file_mgr(pool);
    FileChunker file_chunker("./savebox_storage/");

    ApiRouter router(pool, auth, folder_mgr, &file_mgr, &file_chunker);

    int fake_user_id = 0;
    int fake_folder_id = 0;

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username = 'file_upload_ghost'");
        auto user_res = txn.exec(
            "INSERT INTO users (username, password_hash) VALUES ('file_upload_ghost', 'hash_fake') RETURNING id"
        );
        fake_user_id = user_res[0][0].as<int>();

        auto folder_res = txn.exec(
            "INSERT INTO folders (user_id, encrypted_name, name_hash) VALUES ($1, 'enc_ghost_folder', 'ghost_folder_hash') RETURNING id",
            pqxx::params{fake_user_id}
        );
        fake_folder_id = folder_res[0][0].as<int>();
        txn.commit();
    }

    std::string token = auth.generate_token(static_cast<uint64_t>(fake_user_id));

    SECTION("Inicializar, enviar chunks e completar upload") {
        crow::request req_init;
        req_init.add_header("Authorization", "Bearer " + token);
        req_init.body = R"({"folder_id": )" + std::to_string(fake_folder_id)
                      + R"(, "encrypted_name": "base64_file_name", "name_hash": "file_hash_123", "size_bytes": 1024, "total_chunks": 2})";

        crow::response res_init = router.handle_init_file_upload(req_init);

        REQUIRE(res_init.code == 201);

        auto init_body = crow::json::load(res_init.body);
        int file_id = init_body["file_id"].i();

        crow::request req_chunk1;
        req_chunk1.add_header("Authorization", "Bearer " + token);
        req_chunk1.add_header("X-Chunk-Index", "0");
        req_chunk1.body = std::string(512, '\xAB'); 

        crow::response res_chunk1 = router.handle_upload_chunk(req_chunk1, file_id);

        REQUIRE(res_chunk1.code == 200);

        crow::request req_chunk2;
        req_chunk2.add_header("Authorization", "Bearer " + token);
        req_chunk2.add_header("X-Chunk-Index", "1");
        req_chunk2.body = std::string(512, '\xCD');

        crow::response res_chunk2 = router.handle_upload_chunk(req_chunk2, file_id);

        REQUIRE(res_chunk2.code == 200);
        REQUIRE(res_chunk2.body.find("completed") != std::string::npos);
    }

    SECTION("Upload Interrompido - arquivo permanece incompleto no banco") {
        crow::request req_init_broken;
        req_init_broken.add_header("Authorization", "Bearer " + token);
        req_init_broken.body = R"({"folder_id": )" + std::to_string(fake_folder_id)
                             + R"(, "encrypted_name": "base64_broken_file", "name_hash": "file_hash_broken", "size_bytes": 1536, "total_chunks": 3})";

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

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username = 'file_upload_ghost'");
        txn.commit();
    }
}
