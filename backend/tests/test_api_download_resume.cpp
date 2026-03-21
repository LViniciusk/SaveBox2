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

TEST_CASE("API Download - Resumable Downloads (Range)", "[api][download][resume]") {
    std::string test_dir = "./test_resume_downloads/";
    std::filesystem::create_directories(test_dir);

    std::string conn_str = get_secure_conn_string();
    DatabasePool pool(2, conn_str);
    MockEmailService mock_email;
    AuthService auth("Minha_flor_serviu_pra_que_você_achasse_alguem", "um_outro_alguem_que_me_tomou_o_seu_amor", &mock_email);
    FolderManager folder_mgr(pool);
    FileManager file_mgr(pool);
    FileChunker chunker(test_dir);
    
    ApiRouter router(pool, auth, folder_mgr, &file_mgr, &chunker);

    int user_id = 0;
    int file_id = 0;

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username = 'download_resume_user'");
        
        auto res_u = txn.exec("INSERT INTO users (username, email, password_hash, is_email_verified) VALUES ('download_resume_user', 'download_resume_user@test.com', 'hash_resume', true) RETURNING id");

        user_id = res_u[0][0].as<int>();


        auto f1 = txn.exec("INSERT INTO folders (user_id, encrypted_name, name_hash) VALUES ($1, $2, $3) RETURNING id", pqxx::params{user_id, "root_enc", "hash1"});

        int folder_id = f1[0][0].as<int>();


        auto file_res = txn.exec("INSERT INTO files (user_id, folder_id, encrypted_name, name_hash, size_bytes, total_chunks, is_upload_complete) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id", 
            pqxx::params{user_id, folder_id, "file_resume", "fhash_resume", 10, 1, true});

        file_id = file_res[0][0].as<int>();
        

        txn.commit();
    }

    std::string file_path = test_dir + std::to_string(file_id) + ".dat";
    std::ofstream out(file_path, std::ios::binary);
    out.write("0123456789", 10);
    out.close();

    std::string token = auth.generate_token(static_cast<uint64_t>(user_id));

    SECTION("Download Completo (Sem Header Range)") {
        crow::request req;
        req.url = "/files/" + std::to_string(file_id) + "/download";
        req.add_header("Authorization", "Bearer " + token);
        
        crow::response res = router.handle_download_file(req, file_id);
        
        REQUIRE(res.code == 200);
        REQUIRE(res.body == "0123456789");
    }

    SECTION("Download Parcial - Inicio (Range: bytes=0-4)") {
        crow::request req;
        req.url = "/files/" + std::to_string(file_id) + "/download";
        req.add_header("Authorization", "Bearer " + token);
        req.add_header("Range", "bytes=0-4");
        
        crow::response res = router.handle_download_file(req, file_id);
        
        REQUIRE(res.code == 206);
        REQUIRE(res.body == "01234");
        REQUIRE(res.get_header_value("Content-Range") == "bytes 0-4/10");
    }

    SECTION("Download Parcial - Fim (Range: bytes=5-9)") {
        crow::request req;
        req.url = "/files/" + std::to_string(file_id) + "/download";
        req.add_header("Authorization", "Bearer " + token);
        req.add_header("Range", "bytes=5-9");
        
        crow::response res = router.handle_download_file(req, file_id);
        
        REQUIRE(res.code == 206);
        REQUIRE(res.body == "56789");
        REQUIRE(res.get_header_value("Content-Range") == "bytes 5-9/10");
    }

    SECTION("Download Parcial - Sem Fim Especificado (Range: bytes=3-)") {
        crow::request req;
        req.url = "/files/" + std::to_string(file_id) + "/download";
        req.add_header("Authorization", "Bearer " + token);
        req.add_header("Range", "bytes=3-");
        
        crow::response res = router.handle_download_file(req, file_id);
        
        REQUIRE(res.code == 206);
        REQUIRE(res.body == "3456789");
        REQUIRE(res.get_header_value("Content-Range") == "bytes 3-9/10");
    }

    SECTION("Range Fora dos Limites (Range: bytes=20-30)") {
        crow::request req;
        req.url = "/files/" + std::to_string(file_id) + "/download";
        req.add_header("Authorization", "Bearer " + token);
        req.add_header("Range", "bytes=20-30");
        
        crow::response res = router.handle_download_file(req, file_id);
        
        REQUIRE(res.code == 416);
    }

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username = 'download_resume_user'");
        txn.commit();
    }
    
    std::filesystem::remove_all(test_dir);
}
