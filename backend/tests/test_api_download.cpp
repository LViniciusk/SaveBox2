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
#include <fstream>
#include <filesystem>


TEST_CASE("API de Download de Arquivos", "[api][download]") {
    const std::string test_storage_dir = "./test_api_download_storage/";
    std::filesystem::remove_all(test_storage_dir);
    std::filesystem::create_directories(test_storage_dir);

    std::string conn_str = get_secure_conn_string();
    DatabasePool pool(2, conn_str);
    MockEmailService mock_email;
    AuthService auth("Mas_quando_a_saudade_apertar_lembrar", "que_a_gente_ja_foi_amor", &mock_email);
    FolderManager folder_mgr(pool);
    FileManager file_mgr(pool);
    FileChunker file_chunker(test_storage_dir);

    ApiRouter router(pool, auth, folder_mgr, &file_mgr, &file_chunker);

    int user_a_id = 0;
    int user_b_id = 0;
    int fake_folder_id = 0;
    int file_complete_id = 0;
    int file_incomplete_id = 0;

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);

        txn.exec("DELETE FROM users WHERE username IN ('download_user_A', 'download_user_B')");

        auto res_a = txn.exec(
            "INSERT INTO users (username, email, password_hash, is_email_verified) VALUES ('download_user_A', 'download_user_A@test.com', 'hash_fake_a', true) RETURNING id"
        );
        user_a_id = res_a[0][0].as<int>();

        auto res_b = txn.exec(
            "INSERT INTO users (username, email, password_hash, is_email_verified) VALUES ('download_user_B', 'download_user_B@test.com', 'hash_fake_b', true) RETURNING id"
        );
        user_b_id = res_b[0][0].as<int>();

        auto folder_res = txn.exec(
            "INSERT INTO folders (user_id, encrypted_name, name_hash) VALUES ($1, 'enc_dl_folder', 'dl_folder_hash') RETURNING id",
            pqxx::params{user_a_id}
        );
        fake_folder_id = folder_res[0][0].as<int>();

        auto file1_res = txn.exec(
            "INSERT INTO files (user_id, folder_id, encrypted_name, name_hash, encrypted_fdk, size_bytes, total_chunks, is_upload_complete) "
            "VALUES ($1, $2, 'enc_file_complete', 'hash_file_complete', 'mock_fdk', 1024, 1, true) RETURNING id",
            pqxx::params{user_a_id, fake_folder_id}
        );
        file_complete_id = file1_res[0][0].as<int>();

        auto file2_res = txn.exec(
            "INSERT INTO files (user_id, folder_id, encrypted_name, name_hash, encrypted_fdk, size_bytes, total_chunks, is_upload_complete) "
            "VALUES ($1, $2, 'enc_file_incomplete', 'hash_file_incomplete', 'mock_fdk', 2048, 2, false) RETURNING id",
            pqxx::params{user_a_id, fake_folder_id}
        );
        file_incomplete_id = file2_res[0][0].as<int>();

        txn.commit();
    }


    std::string storage_path = test_storage_dir + std::to_string(file_complete_id) + ".dat";
    {
        std::ofstream ofs(storage_path, std::ios::binary);
        ofs << "CONTEUDO_FAKE_BINARIO";
        ofs.close();
    }

    std::string token_a = auth.generate_token(static_cast<uint64_t>(user_a_id));
    std::string token_b = auth.generate_token(static_cast<uint64_t>(user_b_id));


    SECTION("Sem Token") {
        crow::request req;
        req.url = "/files/" + std::to_string(file_complete_id) + "/download";

        crow::response res = router.handle_download_file(req, file_complete_id);

        REQUIRE(res.code == 401);
    }

    SECTION("Arquivo Inexistente") {
        crow::request req;
        req.add_header("Authorization", "Bearer " + token_a);
        req.url = "/files/999999/download";

        crow::response res = router.handle_download_file(req, 999999);

        REQUIRE(res.code == 404);
    }

    SECTION("Acesso Negado (Roubo)") {
        crow::request req;
        req.add_header("Authorization", "Bearer " + token_b);
        req.url = "/files/" + std::to_string(file_complete_id) + "/download";

        crow::response res = router.handle_download_file(req, file_complete_id);

        REQUIRE((res.code == 403 || res.code == 404));
    }

    SECTION("Arquivo Incompleto") {
        crow::request req;
        req.add_header("Authorization", "Bearer " + token_a);
        req.url = "/files/" + std::to_string(file_incomplete_id) + "/download";

        crow::response res = router.handle_download_file(req, file_incomplete_id);

        REQUIRE(res.code == 400);
    }

    SECTION("Sucesso") {
        crow::request req;
        req.add_header("Authorization", "Bearer " + token_a);
        req.url = "/files/" + std::to_string(file_complete_id) + "/download";

        crow::response res = router.handle_download_file(req, file_complete_id);

        REQUIRE(res.code == 200);
        REQUIRE(res.body == "CONTEUDO_FAKE_BINARIO");
    }


    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username IN ('download_user_A', 'download_user_B')");
        txn.commit();
    }

    std::filesystem::remove_all(test_storage_dir);
}
