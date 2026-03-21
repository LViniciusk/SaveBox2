#include <catch2/catch_test_macros.hpp>
#include "controllers/ApiRouter.hpp"
#include "database/DatabasePool.hpp"
#include "services/AuthService.hpp"
#include "database/FolderManager.hpp"
#include "database/FileManager.hpp"
#include "test_helpers.hpp"
#include <crow_all.h>

TEST_CASE("API Update - Mover e Renomear Itens", "[api][update][files][folders]") {
    std::string conn_str = get_secure_conn_string();
    DatabasePool pool(2, conn_str);
    MockEmailService mock_email;
    AuthService auth("João_quem_é_você", "é_o_kaneda", &mock_email);
    FolderManager folder_mgr(pool);
    FileManager file_mgr(pool);
    ApiRouter router(pool, auth, folder_mgr, &file_mgr);

    int user_a_id = 0;
    int user_b_id = 0;
    int folder_a_root_id = 0;
    int folder_a_sub_id = 0;
    int file_a_1_id = 0;
    int folder_b_root_id = 0;
    int file_b_1_id = 0;

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username IN ('update_user_a', 'update_user_b')");

        auto res_a = txn.exec("INSERT INTO users (username, email, password_hash, is_email_verified) VALUES ('update_user_a', 'update_user_a@test.com', 'hash_a', true) RETURNING id");
        user_a_id = res_a[0][0].as<int>();

        auto res_b = txn.exec("INSERT INTO users (username, email, password_hash, is_email_verified) VALUES ('update_user_b', 'update_user_b@test.com', 'hash_b', true) RETURNING id");
        user_b_id = res_b[0][0].as<int>();


        auto r_f_a = txn.exec("INSERT INTO folders (user_id, encrypted_name, name_hash) VALUES ($1, $2, $3) RETURNING id", pqxx::params{user_a_id, "enc_a_root", "hash_a_root"});

        folder_a_root_id = r_f_a[0][0].as<int>();


        auto r_s_a = txn.exec("INSERT INTO folders (user_id, parent_id, encrypted_name, name_hash) VALUES ($1, $2, $3, $4) RETURNING id", pqxx::params{user_a_id, folder_a_root_id, "enc_a_sub", "hash_a_sub"});

        folder_a_sub_id = r_s_a[0][0].as<int>();


        auto r_fi_a = txn.exec("INSERT INTO files (user_id, folder_id, encrypted_name, name_hash, size_bytes, total_chunks, is_upload_complete) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id", pqxx::params{user_a_id, folder_a_root_id, "file_a_1", "hash_fa1", 100, 1, true});

        file_a_1_id = r_fi_a[0][0].as<int>();


        auto r_f_b = txn.exec("INSERT INTO folders (user_id, encrypted_name, name_hash) VALUES ($1, $2, $3) RETURNING id", pqxx::params{user_b_id, "enc_b_root", "hash_b_root"});

        folder_b_root_id = r_f_b[0][0].as<int>();


        auto r_fi_b = txn.exec("INSERT INTO files (user_id, folder_id, encrypted_name, name_hash, size_bytes, total_chunks, is_upload_complete) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id", pqxx::params{user_b_id, folder_b_root_id, "file_b_1", "hash_fb1", 200, 1, true});

        file_b_1_id = r_fi_b[0][0].as<int>();


        txn.commit();
    }

    std::string token_a = auth.generate_token(static_cast<uint64_t>(user_a_id));
    std::string token_b = auth.generate_token(static_cast<uint64_t>(user_b_id));


    SECTION("Arquivos: Renomear com Sucesso") {
        crow::request req;
        req.url = "/files/" + std::to_string(file_a_1_id);
        req.method = crow::HTTPMethod::Put;
        req.add_header("Authorization", "Bearer " + token_a);
        
        crow::json::wvalue body;
        body["encrypted_name"] = "file_a_1_renomeado";
        body["name_hash"] = "hash_renomeado";
        req.body = body.dump();

        crow::response res = router.handle_update_file(req, file_a_1_id);
        REQUIRE(res.code == 200);

        auto conn = pool.acquire_connection();
        pqxx::nontransaction txn(*conn);
        auto result = txn.exec("SELECT encrypted_name, name_hash, folder_id FROM files WHERE id = " + std::to_string(file_a_1_id));
        REQUIRE(result[0][0].as<std::string>() == "file_a_1_renomeado");
        REQUIRE(result[0][1].as<std::string>() == "hash_renomeado");
        REQUIRE(result[0][2].as<int>() == folder_a_root_id);
    }

    SECTION("Arquivos: Mover com Sucesso") {
        crow::request req;
        req.url = "/files/" + std::to_string(file_a_1_id);
        req.method = crow::HTTPMethod::Put;
        req.add_header("Authorization", "Bearer " + token_a);
        
        crow::json::wvalue body;
        body["folder_id"] = folder_a_sub_id;
        req.body = body.dump();

        crow::response res = router.handle_update_file(req, file_a_1_id);
        REQUIRE(res.code == 200);

        auto conn = pool.acquire_connection();
        pqxx::nontransaction txn(*conn);
        auto result = txn.exec("SELECT folder_id FROM files WHERE id = " + std::to_string(file_a_1_id));
        REQUIRE(result[0][0].as<int>() == folder_a_sub_id);
    }

    SECTION("Arquivos: Segurança - Tentar modificar arquivo alheio") {
        crow::request req;
        req.url = "/files/" + std::to_string(file_b_1_id);
        req.method = crow::HTTPMethod::Put;
        req.add_header("Authorization", "Bearer " + token_a);
        
        crow::json::wvalue body;
        body["encrypted_name"] = "hacked_name";
        req.body = body.dump();

        crow::response res = router.handle_update_file(req, file_b_1_id);
        REQUIRE((res.code == 403 || res.code == 404));
    }

    SECTION("Arquivos: Segurança IDOR Destino - Mover para pasta de outro user") {
        crow::request req;
        req.url = "/files/" + std::to_string(file_a_1_id);
        req.method = crow::HTTPMethod::Put;
        req.add_header("Authorization", "Bearer " + token_a);
        
        crow::json::wvalue body;
        body["folder_id"] = folder_b_root_id; 
        req.body = body.dump();

        crow::response res = router.handle_update_file(req, file_a_1_id);
        REQUIRE(res.code == 403);
    }

    SECTION("Arquivos: Pasta de destino inexistente") {
        crow::request req;
        req.url = "/files/" + std::to_string(file_a_1_id);
        req.method = crow::HTTPMethod::Put;
        req.add_header("Authorization", "Bearer " + token_a);
        
        crow::json::wvalue body;
        body["folder_id"] = 999999;
        req.body = body.dump();

        crow::response res = router.handle_update_file(req, file_a_1_id);
        REQUIRE((res.code == 404 || res.code == 400 || res.code == 403));
    }

    SECTION("Pastas: Renomear com Sucesso") {
        crow::request req;
        req.url = "/folders/" + std::to_string(folder_a_sub_id);
        req.method = crow::HTTPMethod::Put;
        req.add_header("Authorization", "Bearer " + token_a);
        
        crow::json::wvalue body;
        body["encrypted_name"] = "folder_a_sub_renamed";
        body["name_hash"] = "new_sub_hash";
        req.body = body.dump();

        crow::response res = router.handle_update_folder(req, folder_a_sub_id);
        REQUIRE(res.code == 200);

        auto conn = pool.acquire_connection();
        pqxx::nontransaction txn(*conn);
        auto result = txn.exec("SELECT encrypted_name, name_hash FROM folders WHERE id = " + std::to_string(folder_a_sub_id));
        REQUIRE(result[0][0].as<std::string>() == "folder_a_sub_renamed");
        REQUIRE(result[0][1].as<std::string>() == "new_sub_hash");
    }

    SECTION("Pastas: Segurança IDOR Destino") {
        crow::request req;
        req.url = "/folders/" + std::to_string(folder_a_sub_id);
        req.method = crow::HTTPMethod::Put;
        req.add_header("Authorization", "Bearer " + token_a);
        
        crow::json::wvalue body;
        body["parent_id"] = folder_b_root_id;
        req.body = body.dump();

        crow::response res = router.handle_update_folder(req, folder_a_sub_id);
        REQUIRE(res.code == 403);
    }

    SECTION("Pastas: Loop Infinito (Mover para dentro de si mesma)") {
        crow::request req;
        req.url = "/folders/" + std::to_string(folder_a_sub_id);
        req.method = crow::HTTPMethod::Put;
        req.add_header("Authorization", "Bearer " + token_a);
        
        crow::json::wvalue body;
        body["parent_id"] = folder_a_sub_id;
        req.body = body.dump();

        crow::response res = router.handle_update_folder(req, folder_a_sub_id);
        REQUIRE(res.code == 400); 
    }

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username IN ('update_user_a', 'update_user_b')");
        txn.commit();
    }
}
