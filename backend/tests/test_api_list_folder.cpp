#include <catch2/catch_test_macros.hpp>
#include "controllers/ApiRouter.hpp"
#include "database/DatabasePool.hpp"
#include "Services/AuthService.hpp"
#include "database/FolderManager.hpp"
#include "database/FileManager.hpp"
#include "storage/FileChunker.hpp"
#include "test_helpers.hpp"
#include <crow_all.h>
#include <string>


TEST_CASE("API de Listagem de Diretórios", "[api][list_folder]") {
    std::string conn_str = get_secure_conn_string();
    DatabasePool pool(2, conn_str);
    MockEmailService mock_email;
    AuthService auth("Presentes_são_apenas_presentes", "quando_estão_presentes_sem_a_sua_presença", &mock_email);
    FolderManager folder_mgr(pool);
    FileManager file_mgr(pool);
    FileChunker file_chunker("./savebox_storage/");

    ApiRouter router(pool, auth, folder_mgr, &file_mgr, &file_chunker);

    int user_a_id = 0;
    int user_b_id = 0;
    int folder_1_id = 0;
    int folder_2_id = 0;
    int folder_3_id = 0;
    int file_complete_id = 0;
    int file_ghost_id = 0;

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);

        txn.exec("DELETE FROM users WHERE username IN ('list_user_A', 'list_user_B')");

        auto res_a = txn.exec(
            "INSERT INTO users (username, email, password_hash, is_email_verified) VALUES ('list_user_A', 'list_user_A@test.com', 'hash_fake_a', true) RETURNING id"
        );
        user_a_id = res_a[0][0].as<int>();

        auto res_b = txn.exec(
            "INSERT INTO users (username, email, password_hash, is_email_verified) VALUES ('list_user_B', 'list_user_B@test.com', 'hash_fake_b', true) RETURNING id"
        );
        user_b_id = res_b[0][0].as<int>();

        auto f1 = txn.exec(
            "INSERT INTO folders (user_id, encrypted_name, name_hash) "
            "VALUES ($1, 'enc_folder_1', 'hash_folder_1') RETURNING id",
            pqxx::params{user_a_id}
        );
        folder_1_id = f1[0][0].as<int>();

        auto f2 = txn.exec(
            "INSERT INTO folders (user_id, encrypted_name, name_hash, parent_id) "
            "VALUES ($1, 'enc_folder_2', 'hash_folder_2', $2) RETURNING id",
            pqxx::params{user_a_id, folder_1_id}
        );
        folder_2_id = f2[0][0].as<int>();

        auto f3 = txn.exec(
            "INSERT INTO folders (user_id, encrypted_name, name_hash) "
            "VALUES ($1, 'enc_folder_3', 'hash_folder_3') RETURNING id",
            pqxx::params{user_b_id}
        );
        folder_3_id = f3[0][0].as<int>();

        auto file1 = txn.exec(
            "INSERT INTO files (user_id, folder_id, encrypted_name, name_hash, encrypted_fdk, size_bytes, total_chunks, is_upload_complete) "
            "VALUES ($1, $2, 'enc_file_ok', 'hash_file_ok', 'mock_fdk', 1024, 1, true) RETURNING id",
            pqxx::params{user_a_id, folder_1_id}
        );
        file_complete_id = file1[0][0].as<int>();

        auto file2 = txn.exec(
            "INSERT INTO files (user_id, folder_id, encrypted_name, name_hash, encrypted_fdk, size_bytes, total_chunks, is_upload_complete) "
            "VALUES ($1, $2, 'enc_file_ghost', 'hash_file_ghost', 'mock_fdk', 2048, 3, false) RETURNING id",
            pqxx::params{user_a_id, folder_1_id}
        );
        file_ghost_id = file2[0][0].as<int>();

        txn.commit();
    }

    std::string token_a = auth.generate_token(static_cast<uint64_t>(user_a_id));
    std::string token_b = auth.generate_token(static_cast<uint64_t>(user_b_id));

    SECTION("Sem Token") {
        crow::request req;
        req.url = "/folders/" + std::to_string(folder_1_id) + "/contents";

        crow::response res = router.handle_list_folder_contents(req, folder_1_id);

        REQUIRE(res.code == 401);
    }

    SECTION("Pasta Inexistente") {
        crow::request req;
        req.add_header("Authorization", "Bearer " + token_a);
        req.url = "/folders/999999/contents";

        crow::response res = router.handle_list_folder_contents(req, 999999);

        REQUIRE(res.code == 404);
    }

    SECTION("Acesso Negado (Roubo de Pasta)") {
        crow::request req;
        req.add_header("Authorization", "Bearer " + token_b);
        req.url = "/folders/" + std::to_string(folder_1_id) + "/contents";

        crow::response res = router.handle_list_folder_contents(req, folder_1_id);

        REQUIRE((res.code == 403 || res.code == 404));
    }

    SECTION("Sucesso - Pasta Vazia") {
        crow::request req;
        req.add_header("Authorization", "Bearer " + token_a);
        req.url = "/folders/" + std::to_string(folder_2_id) + "/contents";

        crow::response res = router.handle_list_folder_contents(req, folder_2_id);

        REQUIRE(res.code == 200);

        auto body = crow::json::load(res.body);
        REQUIRE(body);
        REQUIRE(body["files"].size() == 0);
        REQUIRE(body["subfolders"].size() == 0);
    }

    SECTION("Sucesso - Pasta com Conteudo e Regra de Negocio") {
        crow::request req;
        req.add_header("Authorization", "Bearer " + token_a);
        req.url = "/folders/" + std::to_string(folder_1_id) + "/contents";

        crow::response res = router.handle_list_folder_contents(req, folder_1_id);

        REQUIRE(res.code == 200);

        auto body = crow::json::load(res.body);
        REQUIRE(body);

        REQUIRE(body["subfolders"].size() == 1);
        REQUIRE(body["subfolders"][0]["id"].i() == folder_2_id);

        REQUIRE(body["files"].size() == 1);
        REQUIRE(body["files"][0]["id"].i() == file_complete_id);

        bool ghost_found = false;
        for (size_t i = 0; i < body["files"].size(); ++i) {
            if (body["files"][i]["id"].i() == file_ghost_id) {
                ghost_found = true;
            }
        }
        REQUIRE_FALSE(ghost_found);
    }

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username IN ('list_user_A', 'list_user_B')");
        txn.commit();
    }
}
