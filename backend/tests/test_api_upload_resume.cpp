#include <catch2/catch_test_macros.hpp>
#include "controllers/ApiRouter.hpp"
#include "database/DatabasePool.hpp"
#include "services/AuthService.hpp"
#include "database/FolderManager.hpp"
#include "database/FileManager.hpp"
#include "storage/FileChunker.hpp"
#include "test_helpers.hpp"
#include <crow_all.h>

TEST_CASE("API Upload Resume - Listagem de Chunks Enviados", "[api][upload][resume]") {
    std::string conn_str = get_secure_conn_string();
    DatabasePool pool(2, conn_str);
    AuthService auth("Secret_123", "Resume_Secret_JWT_987654321");
    FolderManager folder_mgr(pool);
    FileManager file_mgr(pool);
    FileChunker chunker("test_chunks_dir");
    
    ApiRouter router(pool, auth, folder_mgr, &file_mgr, &chunker);

    int user_a_id = 0;
    int user_b_id = 0;

    int file_complete_id = 0;
    int file_empty_id = 0;
    int file_partial_id = 0;

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);

        txn.exec("CREATE TABLE IF NOT EXISTS file_chunks (id SERIAL PRIMARY KEY, file_id INT REFERENCES files(id) ON DELETE CASCADE, chunk_index INT NOT NULL, UNIQUE(file_id, chunk_index));");

        txn.exec("DELETE FROM users WHERE username IN ('resume_user_A', 'resume_user_B')");
        
        auto res_a = txn.exec("INSERT INTO users (username, password_hash) VALUES ('resume_user_A', 'hash_a') RETURNING id");
        user_a_id = res_a[0][0].as<int>();

        auto res_b = txn.exec("INSERT INTO users (username, password_hash) VALUES ('resume_user_B', 'hash_b') RETURNING id");
        user_b_id = res_b[0][0].as<int>();
        

        auto res_folder = txn.exec("INSERT INTO folders (user_id, encrypted_name, name_hash) VALUES ($1, $2, $3) RETURNING id", pqxx::params{user_a_id, "resume_folder", "hash_folder"});
        
        int folder_a_id = res_folder[0][0].as<int>();


        auto res_file1 = txn.exec("INSERT INTO files (user_id, folder_id, encrypted_name, name_hash, size_bytes, total_chunks, is_upload_complete) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id", pqxx::params{user_a_id, folder_a_id, "file_comp", "fc", 1000, 5, true});

        file_complete_id = res_file1[0][0].as<int>();


        auto res_file2 = txn.exec("INSERT INTO files (user_id, folder_id, encrypted_name, name_hash, size_bytes, total_chunks, is_upload_complete) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id", pqxx::params{user_a_id, folder_a_id, "file_empty", "fe", 1000, 5, false});

        file_empty_id = res_file2[0][0].as<int>();


        auto res_file3 = txn.exec("INSERT INTO files (user_id, folder_id, encrypted_name, name_hash, size_bytes, total_chunks, is_upload_complete) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id", pqxx::params{user_a_id, folder_a_id, "file_part", "fp", 1000, 5, false});

        file_partial_id = res_file3[0][0].as<int>();


        txn.exec("INSERT INTO file_chunks (file_id, chunk_index) VALUES ($1, $2), ($1, $3), ($1, $4)", pqxx::params{file_partial_id, 0, 1, 3});

        txn.commit();
    }

    std::string token_a = auth.generate_token(static_cast<uint64_t>(user_a_id));
    std::string token_b = auth.generate_token(static_cast<uint64_t>(user_b_id));

    SECTION("Sem Token") {
        crow::request req;
        req.url = "/files/" + std::to_string(file_partial_id) + "/uploaded-chunks";
        
        crow::response res = router.handle_get_uploaded_chunks(req, file_partial_id);
        
        REQUIRE(res.code == 401);
    }

    SECTION("Arquivo Inexistente") {
        crow::request req;
        req.url = "/files/999999/uploaded-chunks";
        req.add_header("Authorization", "Bearer " + token_a);
        
        crow::response res = router.handle_get_uploaded_chunks(req, 999999);
        
        REQUIRE(res.code == 404);
    }

    SECTION("Acesso Negado (Roubo de Arquivo)") {
        crow::request req;
        req.url = "/files/" + std::to_string(file_partial_id) + "/uploaded-chunks";
        req.add_header("Authorization", "Bearer " + token_b); 
        
        crow::response res = router.handle_get_uploaded_chunks(req, file_partial_id);
        
        bool is_forbidden_or_not_found = (res.code == 403 || res.code == 404);
        REQUIRE(is_forbidden_or_not_found == true);
    }

    SECTION("Arquivo Ja Finalizado") {
        crow::request req;
        req.url = "/files/" + std::to_string(file_complete_id) + "/uploaded-chunks";
        req.add_header("Authorization", "Bearer " + token_a);
        
        crow::response res = router.handle_get_uploaded_chunks(req, file_complete_id);
        
        REQUIRE(res.code == 400);
    }

    SECTION("Sucesso - Nenhum Chunk Enviado") {
        crow::request req;
        req.url = "/files/" + std::to_string(file_empty_id) + "/uploaded-chunks";
        req.add_header("Authorization", "Bearer " + token_a);
        
        crow::response res = router.handle_get_uploaded_chunks(req, file_empty_id);
        
        REQUIRE(res.code == 200);
        auto body = crow::json::load(res.body);
        REQUIRE(body.has("uploaded_chunks"));
        auto chunks_list = body["uploaded_chunks"].lo();
        REQUIRE(chunks_list.size() == 0); 
    }

    SECTION("Sucesso - Upload Parcial (Resume)") {
        crow::request req;
        req.url = "/files/" + std::to_string(file_partial_id) + "/uploaded-chunks";
        req.add_header("Authorization", "Bearer " + token_a);
        
        crow::response res = router.handle_get_uploaded_chunks(req, file_partial_id);
        
        REQUIRE(res.code == 200);
        auto body = crow::json::load(res.body);
        REQUIRE(body.has("uploaded_chunks"));
        auto chunks_list = body["uploaded_chunks"].lo();
        
        REQUIRE(chunks_list.size() == 3);

        std::vector<int> found_chunks;
        for (const auto& c : chunks_list) {
            found_chunks.push_back(c.i());
        }

        REQUIRE(std::find(found_chunks.begin(), found_chunks.end(), 0) != found_chunks.end());
        REQUIRE(std::find(found_chunks.begin(), found_chunks.end(), 1) != found_chunks.end());
        REQUIRE(std::find(found_chunks.begin(), found_chunks.end(), 3) != found_chunks.end());
    }


    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username IN ('resume_user_A', 'resume_user_B')");
        txn.commit();
    }
}
