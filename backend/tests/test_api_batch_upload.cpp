#include <catch2/catch_test_macros.hpp>
#include "controllers/ApiRouter.hpp"
#include "database/DatabasePool.hpp"
#include "Services/AuthService.hpp"
#include "database/FolderManager.hpp"
#include "database/FileManager.hpp"
#include "storage/FileChunker.hpp"
#include "test_helpers.hpp"
#include <crow_all.h>

TEST_CASE("API Batch Upload Init", "[api][upload][batch]") {
    std::string conn_str = get_secure_conn_string();
    DatabasePool pool(2, conn_str);
    MockEmailService mock_email;
    AuthService auth("BatchUploadSecret", "batch_upload_salt", &mock_email);
    FolderManager folder_mgr(pool);
    FileManager file_mgr(pool);
    FileChunker chunker("test_batch_chunks_dir");
    
    ApiRouter router(pool, auth, folder_mgr, &file_mgr, &chunker);

    int user_a_id = 0;
    int folder_a_id = 0;

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);

        txn.exec("DELETE FROM users WHERE username = 'batch_user_A'");
        
        auto res_a = txn.exec("INSERT INTO users (username, email, password_hash, is_email_verified, max_storage_bytes) VALUES ('batch_user_A', 'batch_A@test.com', 'hash_a', true, 100000000) RETURNING id");
        user_a_id = res_a[0][0].as<int>();

        auto res_folder = txn.exec("INSERT INTO folders (user_id, encrypted_name, name_hash) VALUES ($1, $2, $3) RETURNING id", pqxx::params{user_a_id, "batch_folder", "b_hash_folder"});
        folder_a_id = res_folder[0][0].as<int>();

        txn.commit();
    }

    std::string token_a = auth.generate_token(static_cast<uint64_t>(user_a_id));

    SECTION("Sucesso - Multiplos Arquivos Locais") {
        crow::request req;
        req.url = "/api/files/batch-init";
        req.method = crow::HTTPMethod::Post;
        req.add_header("Authorization", "Bearer " + token_a);
        
        crow::json::wvalue file1;
        file1["encrypted_name"] = "enc1";
        file1["name_hash"] = "hash1";
        file1["encrypted_fdk"] = "fdk1";
        file1["size_bytes"] = 4000000; // 4MB -> 1 chunk
        file1["total_chunks"] = 1;
        file1["folder_id"] = folder_a_id;

        crow::json::wvalue file2;
        file2["encrypted_name"] = "enc2";
        file2["name_hash"] = "hash2";
        file2["encrypted_fdk"] = "fdk2";
        file2["size_bytes"] = 5000000; // 5MB -> 2 chunks
        file2["total_chunks"] = 2;
        file2["folder_id"] = folder_a_id;

        std::vector<crow::json::wvalue> files_list;
        files_list.push_back(std::move(file1));
        files_list.push_back(std::move(file2));

        crow::json::wvalue req_body;
        req_body["files"] = std::move(files_list);
        req.body = req_body.dump();

        crow::response res = router.handle_batch_init_uploads(req);
        REQUIRE(res.code == 201);
        
        auto body = crow::json::load(res.body);
        REQUIRE(body);
        REQUIRE(body.has("files"));
        auto files_node = body["files"];
        auto result_files = files_node.lo();
        REQUIRE(result_files.size() == 2);

        bool found_hash1 = false;
        bool found_hash2 = false;

        for (const auto& item : result_files) {
            REQUIRE(item.has("file_id"));
            REQUIRE(item["storage_provider"].s() == "local");
            if (item["name_hash"].s() == "hash1") found_hash1 = true;
            if (item["name_hash"].s() == "hash2") found_hash2 = true;
        }
        REQUIRE(found_hash1);
        REQUIRE(found_hash2);

        // Verify Quota Update
        auto conn = pool.acquire_connection();
        pqxx::nontransaction txn(*conn);
        auto check_quota = txn.exec("SELECT used_storage_bytes FROM users WHERE id = " + std::to_string(user_a_id));
        REQUIRE(check_quota[0][0].as<uint64_t>() == 9000000);
    }

    SECTION("Erro - Cota Excedida") {
        crow::request req;
        req.url = "/api/files/batch-init";
        req.method = crow::HTTPMethod::Post;
        req.add_header("Authorization", "Bearer " + token_a);
        
        crow::json::wvalue file1;
        file1["encrypted_name"] = "enc3";
        file1["name_hash"] = "hash3";
        file1["encrypted_fdk"] = "fdk3";
        file1["size_bytes"] = 2000000000; // 2GB
        file1["total_chunks"] = 477; // 2000000000 / 4194304 = 476.8 -> 477

        std::vector<crow::json::wvalue> files_list;
        files_list.push_back(std::move(file1));

        crow::json::wvalue req_body;
        req_body["files"] = std::move(files_list);
        req.body = req_body.dump();

        crow::response res = router.handle_batch_init_uploads(req);
        REQUIRE(res.code == 402); // Payment Required - Quota Exceeded
    }

    SECTION("Erro - JSON Invalido (Sem files array)") {
        crow::request req;
        req.url = "/api/files/batch-init";
        req.method = crow::HTTPMethod::Post;
        req.add_header("Authorization", "Bearer " + token_a);
        
        crow::json::wvalue req_body;
        req_body["something_else"] = 123;
        req.body = req_body.dump();

        crow::response res = router.handle_batch_init_uploads(req);
        REQUIRE(res.code == 400); 
    }

    SECTION("Anti-Abuso - Lote maior que 100 arquivos") {
        crow::request req;
        req.url = "/api/files/batch-init";
        req.method = crow::HTTPMethod::Post;
        req.add_header("Authorization", "Bearer " + token_a);
        
        std::vector<crow::json::wvalue> files_list;
        for (int i = 0; i < 101; ++i) {
            crow::json::wvalue file;
            file["encrypted_name"] = "enc";
            file["name_hash"] = "hash";
            file["encrypted_fdk"] = "fdk";
            file["size_bytes"] = 100;
            file["total_chunks"] = 1;
            files_list.push_back(std::move(file));
        }

        crow::json::wvalue req_body;
        req_body["files"] = std::move(files_list);
        req.body = req_body.dump();

        crow::response res = router.handle_batch_init_uploads(req);
        REQUIRE(res.code == 400);
    }

    SECTION("IDOR - Tentar salvar em pasta de outro usuario") {
        int other_folder_id = 0;
        {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            txn.exec("DELETE FROM users WHERE username = 'batch_user_B'");
            auto res_b = txn.exec("INSERT INTO users (username, email, password_hash, is_email_verified) VALUES ('batch_user_B', 'batch_B@test.com', 'hash_b', true) RETURNING id");
            int user_b_id = res_b[0][0].as<int>();
            auto res_f = txn.exec("INSERT INTO folders (user_id, encrypted_name, name_hash) VALUES ($1, 'other_folder', 'ohash') RETURNING id", pqxx::params{user_b_id});
            other_folder_id = res_f[0][0].as<int>();
            txn.commit();
        }

        crow::request req;
        req.url = "/api/files/batch-init";
        req.method = crow::HTTPMethod::Post;
        req.add_header("Authorization", "Bearer " + token_a);
        
        crow::json::wvalue file1;
        file1["encrypted_name"] = "enc_idor";
        file1["name_hash"] = "hash_idor";
        file1["encrypted_fdk"] = "fdk_idor";
        file1["size_bytes"] = 100;
        file1["total_chunks"] = 1;
        file1["folder_id"] = other_folder_id;

        std::vector<crow::json::wvalue> files_list;
        files_list.push_back(std::move(file1));

        crow::json::wvalue req_body;
        req_body["files"] = std::move(files_list);
        req.body = req_body.dump();

        crow::response res = router.handle_batch_init_uploads(req);
        REQUIRE(res.code == 403);
    }

    SECTION("Manipulacao Matematica - Quantidade de Chunks errada") {
        crow::request req;
        req.url = "/api/files/batch-init";
        req.method = crow::HTTPMethod::Post;
        req.add_header("Authorization", "Bearer " + token_a);
        
        crow::json::wvalue file1;
        file1["encrypted_name"] = "enc_math";
        file1["name_hash"] = "hash_math";
        file1["encrypted_fdk"] = "fdk_math";
        file1["size_bytes"] = 5000000;
        file1["total_chunks"] = 1;

        std::vector<crow::json::wvalue> files_list;
        files_list.push_back(std::move(file1));

        crow::json::wvalue req_body;
        req_body["files"] = std::move(files_list);
        req.body = req_body.dump();

        crow::response res = router.handle_batch_init_uploads(req);
        REQUIRE(res.code == 400);
    }

    SECTION("Colisao - Arquivo com mesmo nome") {
        crow::request req;
        req.url = "/api/files/batch-init";
        req.method = crow::HTTPMethod::Post;
        req.add_header("Authorization", "Bearer " + token_a);
        
        crow::json::wvalue file1;
        file1["encrypted_name"] = "enc_col";
        file1["name_hash"] = "hash_col";
        file1["encrypted_fdk"] = "fdk_col";
        file1["size_bytes"] = 100;
        file1["total_chunks"] = 1;

        std::vector<crow::json::wvalue> files_list;
        files_list.push_back(std::move(file1));

        crow::json::wvalue req_body;
        req_body["files"] = std::move(files_list);
        req.body = req_body.dump();

        crow::response res = router.handle_batch_init_uploads(req);
        REQUIRE(res.code == 201);

        crow::response res2 = router.handle_batch_init_uploads(req);
        REQUIRE(res2.code == 409);
    }

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username = 'batch_user_A'");
        txn.commit();
    }
}
