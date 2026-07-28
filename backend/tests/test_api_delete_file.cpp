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
#include <fstream>
#include <string>

TEST_CASE("API Delete - Exclusao de Arquivos", "[api][delete][file]") {
    std::string test_dir = "./test_delete_files/";
    std::filesystem::create_directories(test_dir);

    std::string conn_str = get_secure_conn_string();
    DatabasePool pool(2, conn_str);
    MockEmailService mock_email;
    AuthService auth("Eu_me_acho_um_condenado_por_não_saber", "o_que_fazer_pra_te_esquecer", &mock_email);
    FolderManager folder_mgr(pool);
    FileManager file_mgr(pool);
    FileChunker chunker(test_dir);
    
    ApiRouter router(pool, auth, folder_mgr, &file_mgr, &chunker);

    int user_a_id = 0;
    int user_b_id = 0;
    int file_1_ok_id = 0;
    int file_2_incompleto_id = 0;
    int file_3_orfao_id = 0;
    int file_4_alheio_id = 0;

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username IN ('delete_user_a', 'delete_user_b')");
        
        auto res_a = txn.exec("INSERT INTO users (username, email, password_hash, is_email_verified) VALUES ('delete_user_a', 'delete_user_a@test.com', 'hash_a', true) RETURNING id");
        user_a_id = res_a[0][0].as<int>();

        auto res_b = txn.exec("INSERT INTO users (username, email, password_hash, is_email_verified) VALUES ('delete_user_b', 'delete_user_b@test.com', 'hash_b', true) RETURNING id");
        user_b_id = res_b[0][0].as<int>();

        auto f1 = txn.exec("INSERT INTO folders (user_id, encrypted_name, name_hash) VALUES ($1, $2, $3) RETURNING id", pqxx::params{user_a_id, "folder_a", "fhash_a"});
        int folder_a_id = f1[0][0].as<int>();

        auto f2 = txn.exec("INSERT INTO folders (user_id, encrypted_name, name_hash) VALUES ($1, $2, $3) RETURNING id", pqxx::params{user_b_id, "folder_b", "fhash_b"});
        int folder_b_id = f2[0][0].as<int>();


        auto res_f1 = txn.exec(
            "INSERT INTO files (user_id, folder_id, encrypted_name, name_hash, encrypted_fdk, size_bytes, total_chunks, is_upload_complete) "
            "VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id", 
            pqxx::params{user_a_id, folder_a_id, "file_1_ok", "hash1", "mock_fdk", 100, 1, true});

        file_1_ok_id = res_f1[0][0].as<int>();


        auto res_f2 = txn.exec(
            "INSERT INTO files (user_id, folder_id, encrypted_name, name_hash, encrypted_fdk, size_bytes, total_chunks, is_upload_complete) "
            "VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id", 
            pqxx::params{user_a_id, folder_a_id, "file_2_inc", "hash2", "mock_fdk", 200, 2, false});

        file_2_incompleto_id = res_f2[0][0].as<int>();


        auto res_f3 = txn.exec(
            "INSERT INTO files (user_id, folder_id, encrypted_name, name_hash, encrypted_fdk, size_bytes, total_chunks, is_upload_complete) "
            "VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id", 
            pqxx::params{user_a_id, folder_a_id, "file_3_orfao", "hash3", "mock_fdk", 300, 1, true});

        file_3_orfao_id = res_f3[0][0].as<int>();


        auto res_f4 = txn.exec(
            "INSERT INTO files (user_id, folder_id, encrypted_name, name_hash, encrypted_fdk, size_bytes, total_chunks, is_upload_complete) "
            "VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id", 
            pqxx::params{user_b_id, folder_b_id, "file_4_alheio", "hash4", "mock_fdk", 400, 1, true});

        file_4_alheio_id = res_f4[0][0].as<int>();

        txn.commit();
    }

    auto create_file = [&](int f_id) {
        std::string file_path = test_dir + std::to_string(f_id) + ".dat";
        std::ofstream out(file_path, std::ios::binary);
        out.write("1234567890", 10);
        out.close();
    };

    create_file(file_1_ok_id);
    create_file(file_2_incompleto_id);
    create_file(file_4_alheio_id);

    std::string token_a = auth.generate_token(static_cast<uint64_t>(user_a_id));
    std::string token_b = auth.generate_token(static_cast<uint64_t>(user_b_id));

    SECTION("Batch Delete: Sucesso") {
        crow::request req;
        req.url = "/api/files/batch-delete";
        req.method = crow::HTTPMethod::Delete;
        req.add_header("Authorization", "Bearer " + token_a);
        
        crow::json::wvalue req_body;
        std::vector<int> ids = {file_1_ok_id, file_2_incompleto_id};
        req_body["file_ids"] = ids;
        req.body = req_body.dump();

        crow::response res = router.handle_batch_delete(req);
        REQUIRE(res.code == 200);
        
        auto body = crow::json::load(res.body);
        REQUIRE(body);
        REQUIRE(body.has("deleted_count"));
        REQUIRE(body["deleted_count"].i() == 2);

        // Verify in DB
        auto conn = pool.acquire_connection();
        pqxx::nontransaction txn(*conn);
        auto check = txn.exec(
            "SELECT count(*) FROM files WHERE deleted_at IS NOT NULL AND id IN (" + 
            std::to_string(file_1_ok_id) + ", " + std::to_string(file_2_incompleto_id) + ")"
        );
        REQUIRE(check[0][0].as<int>() == 2);
    }

    SECTION("Batch Delete: Acesso Negado IDOR") {
        // user_a tries to delete user_b's file
        crow::request req;
        req.url = "/api/files/batch-delete";
        req.method = crow::HTTPMethod::Delete;
        req.add_header("Authorization", "Bearer " + token_a);
        
        crow::json::wvalue req_body;
        std::vector<int> ids = {file_4_alheio_id};
        req_body["file_ids"] = ids;
        req.body = req_body.dump();

        crow::response res = router.handle_batch_delete(req);
        REQUIRE(res.code == 200); // the request succeeds but updates 0 rows
        
        auto body = crow::json::load(res.body);
        REQUIRE(body.has("deleted_count"));
        REQUIRE(body["deleted_count"].i() == 0); // User A does not own file_4_alheio_id
    }

    SECTION("Batch Delete: Anti-DoS (Limite de Payload)") {
        crow::request req;
        req.url = "/api/files/batch-delete";
        req.method = crow::HTTPMethod::Delete;
        req.add_header("Authorization", "Bearer " + token_a);
        
        crow::json::wvalue req_body;
        std::vector<int> ids(150, 1); // 150 IDs
        req_body["file_ids"] = ids;
        req.body = req_body.dump();

        crow::response res = router.handle_batch_delete(req);
        REQUIRE(res.code == 400); 
    }

    SECTION("Batch Delete: Payload Vazio ou Malformado") {
        crow::request req;
        req.url = "/api/files/batch-delete";
        req.method = crow::HTTPMethod::Delete;
        req.add_header("Authorization", "Bearer " + token_a);
        
        // Vazio
        crow::json::wvalue req_body_empty;
        req_body_empty["file_ids"] = std::vector<int>{};
        req.body = req_body_empty.dump();
        crow::response res1 = router.handle_batch_delete(req);
        REQUIRE(res1.code == 400);

        // Malformado (sem file_ids)
        crow::json::wvalue req_body_malformed;
        req_body_malformed["wrong_key"] = std::vector<int>{1, 2};
        req.body = req_body_malformed.dump();
        crow::response res2 = router.handle_batch_delete(req);
        REQUIRE(res2.code == 400);
    }

    SECTION("Batch Delete: Resiliência a Fantasmas") {
        crow::request req;
        req.url = "/api/files/batch-delete";
        req.method = crow::HTTPMethod::Delete;
        req.add_header("Authorization", "Bearer " + token_a);
        
        crow::json::wvalue req_body;
        std::vector<int> ids = {9999991, 9999992}; // Fantasmas
        req_body["file_ids"] = ids;
        req.body = req_body.dump();

        crow::response res = router.handle_batch_delete(req);
        REQUIRE(res.code == 200); 
        
        auto body = crow::json::load(res.body);
        REQUIRE(body.has("deleted_count"));
        REQUIRE(body["deleted_count"].i() == 0); 
    }


    SECTION("Autenticacao: Sem Token") {
        crow::request req;
        req.url = "/files/" + std::to_string(file_1_ok_id);
        
        crow::response res = router.handle_delete_file(req, file_1_ok_id);
        
        REQUIRE(res.code == 401);
    }

    SECTION("Not Found: Arquivo Inexistente") {
        crow::request req;
        req.url = "/files/999999";
        req.add_header("Authorization", "Bearer " + token_a);
        
        crow::response res = router.handle_delete_file(req, 999999);
        
        REQUIRE(res.code == 404);
    }

    SECTION("Seguranca IDOR: Tentar deletar arquivo de outro usuario") {
        crow::request req;
        req.url = "/files/" + std::to_string(file_4_alheio_id);
        req.add_header("Authorization", "Bearer " + token_a);
        
        crow::response res = router.handle_delete_file(req, file_4_alheio_id);
        
        REQUIRE((res.code == 403 || res.code == 404));

        auto conn = pool.acquire_connection();
        pqxx::nontransaction txn(*conn);
        auto check = txn.exec("SELECT count(*) FROM files WHERE id = " + std::to_string(file_4_alheio_id));
        
        REQUIRE(check[0][0].as<int>() == 1);
        
        REQUIRE(std::filesystem::exists(test_dir + std::to_string(file_4_alheio_id) + ".dat") == true);
    }

    SECTION("Edge Case: Deletar arquivo com upload incompleto") {
        crow::request req;
        req.url = "/files/" + std::to_string(file_2_incompleto_id);
        req.add_header("Authorization", "Bearer " + token_a);
        
        crow::response res = router.handle_delete_file(req, file_2_incompleto_id);
        
        REQUIRE((res.code == 200 || res.code == 204));

        auto conn = pool.acquire_connection();
        pqxx::nontransaction txn(*conn);
        auto check = txn.exec("SELECT count(*) FROM files WHERE id = " + std::to_string(file_2_incompleto_id) + " AND deleted_at IS NOT NULL");

        REQUIRE(check[0][0].as<int>() == 1);
        
        REQUIRE(std::filesystem::exists(test_dir + std::to_string(file_2_incompleto_id) + ".dat") == true);
    }

    SECTION("Edge Case: Deletar arquivo orfao (DB existe, HD nao)") {
        crow::request req;
        req.url = "/files/" + std::to_string(file_3_orfao_id);
        req.add_header("Authorization", "Bearer " + token_a);
        
        crow::response res = router.handle_delete_file(req, file_3_orfao_id);
        
        REQUIRE((res.code == 200 || res.code == 204));

        auto conn = pool.acquire_connection();
        pqxx::nontransaction txn(*conn);
        auto check = txn.exec("SELECT count(*) FROM files WHERE id = " + std::to_string(file_3_orfao_id) + " AND deleted_at IS NOT NULL");

        REQUIRE(check[0][0].as<int>() == 1);
    }

    SECTION("Caminho Feliz: Exclusao Perfeita") {
        crow::request req;
        req.url = "/files/" + std::to_string(file_1_ok_id);
        req.add_header("Authorization", "Bearer " + token_a);
        
        crow::response res = router.handle_delete_file(req, file_1_ok_id);
        
        REQUIRE((res.code == 200 || res.code == 204));

        auto conn = pool.acquire_connection();
        pqxx::nontransaction txn(*conn);
        auto check = txn.exec("SELECT count(*) FROM files WHERE id = " + std::to_string(file_1_ok_id) + " AND deleted_at IS NOT NULL");

        REQUIRE(check[0][0].as<int>() == 1);
        
        REQUIRE(std::filesystem::exists(test_dir + std::to_string(file_1_ok_id) + ".dat") == true);
    }

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username IN ('delete_user_a', 'delete_user_b')");
        txn.commit();
    }
    
    std::filesystem::remove_all(test_dir);
}
