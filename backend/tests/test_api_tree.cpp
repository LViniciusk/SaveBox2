#include <catch2/catch_test_macros.hpp>
#include "controllers/ApiRouter.hpp"
#include "database/DatabasePool.hpp"
#include "Services/AuthService.hpp"
#include "database/FolderManager.hpp"
#include "database/FileManager.hpp"
#include "test_helpers.hpp"
#include <crow_all.h>

TEST_CASE("API Tree - Sincronização do Cofre", "[api][tree]") {
    std::string conn_str = get_secure_conn_string();
    DatabasePool pool(2, conn_str);
    MockEmailService mock_email;
    AuthService auth("Confeso_que_hoje_eu_te_amo_muito_mais_que_ontem", "carai_a_dois_meses_atras_eu_nem_usava_emoji", &mock_email);
    FolderManager folder_mgr(pool);
    FileManager file_mgr(pool);
    
    ApiRouter router(pool, auth, folder_mgr, &file_mgr);

    int user_a_id = 0;
    int user_b_id = 0;

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username IN ('tree_user_A', 'tree_user_B')");
        
        auto res_a = txn.exec("INSERT INTO users (username, email, password_hash, is_email_verified) VALUES ('tree_user_A', 'tree_user_A@test.com', 'hash_a', true) RETURNING id");
        user_a_id = res_a[0][0].as<int>();

        auto res_b = txn.exec("INSERT INTO users (username, email, password_hash, is_email_verified) VALUES ('tree_user_B', 'tree_user_B@test.com', 'hash_b', true) RETURNING id");
        user_b_id = res_b[0][0].as<int>();
        

        auto f1_a = txn.exec("INSERT INTO folders (user_id, encrypted_name, name_hash) VALUES ($1, $2, $3) RETURNING id", pqxx::params{user_a_id, "root1_enc", "hash1"});
        int f1_a_id = f1_a[0][0].as<int>();
        
        auto f2_a = txn.exec("INSERT INTO folders (user_id, encrypted_name, name_hash, parent_id) VALUES ($1, $2, $3, $4) RETURNING id", pqxx::params{user_a_id, "sub1_enc", "hash2", f1_a_id});
        int f2_a_id = f2_a[0][0].as<int>();

        auto f3_a = txn.exec("INSERT INTO folders (user_id, encrypted_name, name_hash) VALUES ($1, $2, $3) RETURNING id", pqxx::params{user_a_id, "root2_enc", "hash3"});
        int f3_a_id = f3_a[0][0].as<int>();


        auto f1_b = txn.exec("INSERT INTO folders (user_id, encrypted_name, name_hash) VALUES ($1, $2, $3) RETURNING id", pqxx::params{user_b_id, "b_root_enc", "hashb"});
        int f1_b_id = f1_b[0][0].as<int>();


        txn.exec("INSERT INTO files (user_id, folder_id, encrypted_name, name_hash, encrypted_fdk, size_bytes, total_chunks, is_upload_complete) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", pqxx::params{user_a_id, f1_a_id, "file1_a", "fhash1", "mock_fdk", 100, 1, true});
        txn.exec("INSERT INTO files (user_id, folder_id, encrypted_name, name_hash, encrypted_fdk, size_bytes, total_chunks, is_upload_complete) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", pqxx::params{user_a_id, f2_a_id, "file2_a", "fhash2", "mock_fdk", 200, 1, true});
        txn.exec("INSERT INTO files (user_id, folder_id, encrypted_name, name_hash, encrypted_fdk, size_bytes, total_chunks, is_upload_complete) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", pqxx::params{user_a_id, f3_a_id, "file3_a", "fhash3", "mock_fdk", 300, 1, true});


        txn.exec("INSERT INTO files (user_id, folder_id, encrypted_name, name_hash, encrypted_fdk, size_bytes, total_chunks, is_upload_complete) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", pqxx::params{
            user_a_id, f1_a_id, "ghost_a", "fhash_ghost", "mock_fdk", 400, 1, false});


        txn.exec("INSERT INTO files (user_id, folder_id, encrypted_name, name_hash, encrypted_fdk, size_bytes, total_chunks, is_upload_complete) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", pqxx::params{
            user_b_id, f1_b_id, "file1_b", "fhash_b1", "mock_fdk", 100, 1, true});
        txn.exec("INSERT INTO files (user_id, folder_id, encrypted_name, name_hash, encrypted_fdk, size_bytes, total_chunks, is_upload_complete) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", pqxx::params{
            user_b_id, f1_b_id, "file2_b", "fhash_b2", "mock_fdk", 200, 1, true});

        txn.commit();
    }

    std::string token_a = auth.generate_token(static_cast<uint64_t>(user_a_id));
    std::string token_b = auth.generate_token(static_cast<uint64_t>(user_b_id));

    SECTION("Sem Token") {
        crow::request req;
        req.url = "/tree";
        
        crow::response res = router.handle_get_tree(req);
        
        REQUIRE(res.code == 401);
    }

    SECTION("Sem Parametros de Paginacao") {
        crow::request req;
        req.url = "/tree";
        req.add_header("Authorization", "Bearer " + token_a);
        
        crow::response res = router.handle_get_tree(req);
        

        REQUIRE(res.code == 200);
    }

    SECTION("Sucesso - Paginacao Pagina 1") {
        crow::request req;
        req.url = "/tree?file_limit=2&file_offset=0";

        req.url_params = crow::query_string(req.url.substr(req.url.find('?')));
        req.add_header("Authorization", "Bearer " + token_a);
        
        crow::response res = router.handle_get_tree(req);
        
        REQUIRE(res.code == 200);
        auto body = crow::json::load(res.body);
        REQUIRE(body.has("folders"));
        REQUIRE(body.has("files"));
        
        REQUIRE(body["folders"].size() == 3);
        
        REQUIRE(body["files"].size() == 2);
    }

    SECTION("Sucesso - Paginacao Pagina 2") {
        crow::request req;
        req.url = "/tree?file_limit=2&file_offset=2";
        req.url_params = crow::query_string(req.url.substr(req.url.find('?')));
        req.add_header("Authorization", "Bearer " + token_a);
        
        crow::response res = router.handle_get_tree(req);
        
        REQUIRE(res.code == 200);
        auto body = crow::json::load(res.body);
        REQUIRE(body.has("folders"));
        REQUIRE(body.has("files"));
        
        REQUIRE(body["folders"].size() == 3);
        
        REQUIRE(body["files"].size() == 1);
    }

    SECTION("Clamp de paginacao em limite elevado") {
        {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);

            for (int i = 0; i < 120; ++i) {
                std::string enc_name = "file_extra_" + std::to_string(i);
                std::string name_hash = "hash_extra_" + std::to_string(i);

                txn.exec(
                    "INSERT INTO files (user_id, folder_id, encrypted_name, name_hash, encrypted_fdk, size_bytes, total_chunks, is_upload_complete) "
                    "VALUES ($1, NULL, $2, $3, $4, $5, $6, $7)",
                    pqxx::params{user_a_id, enc_name, name_hash, "mock_fdk", 10, 1, true}
                );
            }

            txn.commit();
        }

        crow::request req;
        req.url = "/tree?file_limit=9999999&file_offset=0";
        req.url_params = crow::query_string(req.url.substr(req.url.find('?')));
        req.add_header("Authorization", "Bearer " + token_a);

        crow::response res = router.handle_get_tree(req);
        REQUIRE(res.code == 200);

        auto body = crow::json::load(res.body);
        REQUIRE(body.has("files"));
        REQUIRE(body["files"].size() <= 100);
    }

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username IN ('tree_user_A', 'tree_user_B')");
        txn.commit();
    }
}
