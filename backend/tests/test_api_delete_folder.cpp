#include <catch2/catch_test_macros.hpp>
#include "controllers/ApiRouter.hpp"
#include "database/DatabasePool.hpp"
#include "services/AuthService.hpp"
#include "database/FolderManager.hpp"
#include "database/FileManager.hpp"
#include "storage/FileChunker.hpp"
#include "test_helpers.hpp"
#include <crow_all.h>
#include <filesystem>
#include <fstream>
#include <string>

TEST_CASE("API Delete Folder - Exclusao Recursiva de Arvore", "[api][delete][folders][recursive]") {
    std::string test_dir = "./test_delete_folders/";
    std::filesystem::create_directories(test_dir);

    std::string conn_str = get_secure_conn_string();
    DatabasePool pool(2, conn_str);
    MockEmailService mock_email;
    AuthService auth("Abissal_nosso_amor", "Sem_você_eu_sou_superficial", &mock_email);
    FolderManager folder_mgr(pool);
    FileManager file_mgr(pool);
    FileChunker chunker(test_dir);
    ApiRouter router(pool, auth, folder_mgr, &file_mgr, &chunker);

    int user_a_id = 0;
    int user_b_id = 0;

    int folder_a_root_id = 0;
    int folder_a_sub1_id = 0;
    int folder_a_sub2_id = 0;
    int folder_b_root_id = 0;

    int file_a_1_id = 0;
    int file_a_2_id = 0;
    int file_a_3_id = 0;
    int file_b_1_id = 0;

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);

        txn.exec("DELETE FROM users WHERE username IN ('delete_folder_user_a', 'delete_folder_user_b')");

        auto res_a = txn.exec("INSERT INTO users (username, email, password_hash, is_email_verified) VALUES ('delete_folder_user_a', 'delete_folder_user_a@test.com', 'hash_a', true) RETURNING id");

        user_a_id = res_a[0][0].as<int>();

        auto res_b = txn.exec("INSERT INTO users (username, email, password_hash, is_email_verified) VALUES ('delete_folder_user_b', 'delete_folder_user_b@test.com', 'hash_b', true) RETURNING id");

        user_b_id = res_b[0][0].as<int>();


        auto r_fa_root = txn.exec("INSERT INTO folders (user_id, encrypted_name, name_hash) VALUES ($1, $2, $3) RETURNING id", pqxx::params{user_a_id, "root_a", "hash"});

        folder_a_root_id = r_fa_root[0][0].as<int>();

        auto r_fi_a1 = txn.exec("INSERT INTO files (user_id, folder_id, encrypted_name, name_hash, size_bytes, total_chunks, is_upload_complete) VALUES ($1, $2, 'file_a_1', 'ha1', 10, 1, true) RETURNING id", pqxx::params{user_a_id, folder_a_root_id});

        file_a_1_id = r_fi_a1[0][0].as<int>();

        auto r_fa_sub1 = txn.exec("INSERT INTO folders (user_id, parent_id, encrypted_name, name_hash) VALUES ($1, $2, $3, $4) RETURNING id", pqxx::params{user_a_id, folder_a_root_id, "sub1_a", "hash"});

        folder_a_sub1_id = r_fa_sub1[0][0].as<int>();

        auto r_fi_a2 = txn.exec("INSERT INTO files (user_id, folder_id, encrypted_name, name_hash, size_bytes, total_chunks, is_upload_complete) VALUES ($1, $2, 'file_a_2', 'ha2', 10, 1, true) RETURNING id", pqxx::params{user_a_id, folder_a_sub1_id});

        file_a_2_id = r_fi_a2[0][0].as<int>();

        auto r_fa_sub2 = txn.exec("INSERT INTO folders (user_id, parent_id, encrypted_name, name_hash) VALUES ($1, $2, $3, $4) RETURNING id", pqxx::params{user_a_id, folder_a_sub1_id, "sub2_a", "hash"});

        folder_a_sub2_id = r_fa_sub2[0][0].as<int>();

        auto r_fi_a3 = txn.exec("INSERT INTO files (user_id, folder_id, encrypted_name, name_hash, size_bytes, total_chunks, is_upload_complete) VALUES ($1, $2, 'file_a_3', 'ha3', 10, 1, true) RETURNING id", pqxx::params{user_a_id, folder_a_sub2_id});

        file_a_3_id = r_fi_a3[0][0].as<int>();

        auto r_fb_root = txn.exec("INSERT INTO folders (user_id, encrypted_name, name_hash) VALUES ($1, $2, $3) RETURNING id", pqxx::params{user_b_id, "root_b", "hash"});

        folder_b_root_id = r_fb_root[0][0].as<int>();

        auto r_fi_b1 = txn.exec("INSERT INTO files (user_id, folder_id, encrypted_name, name_hash, size_bytes, total_chunks, is_upload_complete) VALUES ($1, $2, 'file_b_1', 'hb1', 10, 1, true) RETURNING id", pqxx::params{user_b_id, folder_b_root_id});

        file_b_1_id = r_fi_b1[0][0].as<int>();

        txn.commit();
    }


    auto create_dummy_file = [&](int f_id) {
        std::ofstream out(test_dir + std::to_string(f_id) + ".dat", std::ios::binary);
        out << "dummy data";
        out.close();
    };

    create_dummy_file(file_a_1_id);
    create_dummy_file(file_a_2_id);
    create_dummy_file(file_a_3_id);
    create_dummy_file(file_b_1_id);

    std::string token_a = auth.generate_token(static_cast<uint64_t>(user_a_id));
    std::string token_b = auth.generate_token(static_cast<uint64_t>(user_b_id));

    SECTION("Autenticacao: Sem Token") {
        crow::request req;
        req.url = "/folders/" + std::to_string(folder_a_root_id);
        req.method = crow::HTTPMethod::Delete;

        crow::response res = router.handle_delete_folder(req, folder_a_root_id);
        REQUIRE(res.code == 401);
    }

    SECTION("Not Found: Pasta Inexistente") {
        crow::request req;
        req.url = "/folders/999999";
        req.method = crow::HTTPMethod::Delete;
        req.add_header("Authorization", "Bearer " + token_a);

        crow::response res = router.handle_delete_folder(req, 999999);
        REQUIRE((res.code == 404 || res.code == 403));
    }

    SECTION("Seguranca IDOR: Tentar deletar pasta alheia") {
        crow::request req;
        req.url = "/folders/" + std::to_string(folder_b_root_id);
        req.method = crow::HTTPMethod::Delete;
        req.add_header("Authorization", "Bearer " + token_a);

        crow::response res = router.handle_delete_folder(req, folder_b_root_id);
        REQUIRE((res.code == 403 || res.code == 404));

        auto conn = pool.acquire_connection();
        pqxx::nontransaction txn(*conn);
        auto check = txn.exec("SELECT count(*) FROM folders WHERE id = " + std::to_string(folder_b_root_id));
        REQUIRE(check[0][0].as<int>() == 1);
        REQUIRE(std::filesystem::exists(test_dir + std::to_string(file_b_1_id) + ".dat") == true);
    }

    SECTION("A Bomba Atomica: Exclusao Recursiva de Arvore Profunda") {
        crow::request req;
        req.url = "/folders/" + std::to_string(folder_a_root_id);
        req.method = crow::HTTPMethod::Delete;
        req.add_header("Authorization", "Bearer " + token_a);

        crow::response res = router.handle_delete_folder(req, folder_a_root_id);
        REQUIRE((res.code == 200 || res.code == 204));

        auto conn = pool.acquire_connection();
        pqxx::nontransaction txn(*conn);


        auto check_fa = txn.exec("SELECT count(*) FROM folders WHERE user_id = " + std::to_string(user_a_id) + " AND deleted_at IS NOT NULL");
        REQUIRE(check_fa[0][0].as<int>() == 3);


        auto check_fi = txn.exec("SELECT count(*) FROM files WHERE user_id = " + std::to_string(user_a_id) + " AND deleted_at IS NOT NULL");
        REQUIRE(check_fi[0][0].as<int>() == 3);


        REQUIRE(std::filesystem::exists(test_dir + std::to_string(file_a_1_id) + ".dat") == true);
        REQUIRE(std::filesystem::exists(test_dir + std::to_string(file_a_2_id) + ".dat") == true);
        REQUIRE(std::filesystem::exists(test_dir + std::to_string(file_a_3_id) + ".dat") == true);


        auto check_fb = txn.exec("SELECT count(*) FROM folders WHERE user_id = " + std::to_string(user_b_id));
        REQUIRE(check_fb[0][0].as<int>() == 1);
        REQUIRE(std::filesystem::exists(test_dir + std::to_string(file_b_1_id) + ".dat") == true);
    }

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username IN ('delete_folder_user_a', 'delete_folder_user_b')");
        txn.commit();
    }
    
    std::filesystem::remove_all(test_dir);
}
