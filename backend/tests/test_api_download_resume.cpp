#include <catch2/catch_test_macros.hpp>
#include "controllers/ApiRouter.hpp"
#include "database/DatabasePool.hpp"
#include "Services/AuthService.hpp"
#include "database/FolderManager.hpp"
#include "database/FileManager.hpp"
#include "storage/FileChunker.hpp"
#include "test_helpers.hpp"
#include "utils.hpp"
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


        auto file_res = txn.exec("INSERT INTO files (user_id, folder_id, encrypted_name, name_hash, encrypted_fdk, size_bytes, total_chunks, is_upload_complete) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id", 
            pqxx::params{user_id, folder_id, "file_resume", "fhash_resume", "mock_fdk", 10, 1, true});

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

    SECTION("Download Parcial - Sufixo Suffix-Byte-Range-Spec (Range: bytes=-3)") {
        crow::request req;
        req.url = "/files/" + std::to_string(file_id) + "/download";
        req.add_header("Authorization", "Bearer " + token);
        req.add_header("Range", "bytes=-3");

        crow::response res = router.handle_download_file(req, file_id);

        REQUIRE(res.code == 206);
        REQUIRE(res.body == "789");
        REQUIRE(res.get_header_value("Content-Range") == "bytes 7-9/10");
    }

    SECTION("Injeção de Headers de CORS para o Service Worker") {
        crow::request req;
        req.url = "/files/" + std::to_string(file_id) + "/download";
        req.add_header("Authorization", "Bearer " + token);

        crow::response res = router.handle_download_file(req, file_id);

        std::string expected_cors = Utils::get().get_var("CORS_ORIGIN", "http://localhost:3000");
        REQUIRE(res.get_header_value("Access-Control-Allow-Origin") == expected_cors);

        std::string expose_headers = res.get_header_value("Access-Control-Expose-Headers");
        REQUIRE(expose_headers.find("Content-Range") != std::string::npos);
        REQUIRE(expose_headers.find("Content-Length") != std::string::npos);
        REQUIRE(expose_headers.find("Accept-Ranges") != std::string::npos);
    }

    SECTION("Proteção Anti-OOM (Arquivos > 5MB sem Range)") {
        int file_big_id = 0;

        {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);

            auto folder_res = txn.exec(
                "SELECT id FROM folders WHERE user_id = $1 ORDER BY id LIMIT 1",
                pqxx::params{user_id}
            );
            REQUIRE(!folder_res.empty());
            int folder_id = folder_res[0][0].as<int>();

            auto big_file_res = txn.exec(
                "INSERT INTO files (user_id, folder_id, encrypted_name, name_hash, encrypted_fdk, size_bytes, total_chunks, is_upload_complete) "
                "VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id",
                pqxx::params{user_id, folder_id, "file_big_resume", "fhash_big_resume", "mock_fdk", 5 * 1024 * 1024 + 1, 1, true}
            );

            file_big_id = big_file_res[0][0].as<int>();
            txn.commit();
        }

        std::string big_file_path = test_dir + std::to_string(file_big_id) + ".dat";
        {
            std::ofstream out_big(big_file_path, std::ios::binary);
            REQUIRE(out_big.is_open());
            out_big.seekp(5 * 1024 * 1024);
            out_big.write("X", 1);
            out_big.close();
        }

        crow::request req_no_range;
        req_no_range.url = "/files/" + std::to_string(file_big_id) + "/download";
        req_no_range.add_header("Authorization", "Bearer " + token);

        crow::response res_no_range = router.handle_download_file(req_no_range, file_big_id);
        REQUIRE(res_no_range.code == 400);

        crow::request req_with_range;
        req_with_range.url = "/files/" + std::to_string(file_big_id) + "/download";
        req_with_range.add_header("Authorization", "Bearer " + token);
        req_with_range.add_header("Range", "bytes=0-100");

        crow::response res_with_range = router.handle_download_file(req_with_range, file_big_id);
        REQUIRE(res_with_range.code == 206);
    }

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username = 'download_resume_user'");
        txn.commit();
    }
    
    std::filesystem::remove_all(test_dir);
}

TEST_CASE("API Upload Recovery - Prefixo local limitado e isolado", "[api][upload][recovery]") {
    const std::string test_dir = "./test_pending_recovery_prefix/";
    std::filesystem::remove_all(test_dir);
    std::filesystem::create_directories(test_dir);

    DatabasePool pool(2, get_secure_conn_string());
    MockEmailService mock_email;
    AuthService auth("PendingRecoverySecret", "pending_recovery_salt", &mock_email);
    FolderManager folder_mgr(pool);
    FileManager file_mgr(pool);
    FileChunker chunker(test_dir);
    ApiRouter router(pool, auth, folder_mgr, &file_mgr, &chunker);

    const std::string user_a_name = "pending_recovery_owner";
    const std::string user_b_name = "pending_recovery_other";
    int user_a = 0;
    int user_b = 0;
    int pending_id = 0;
    int missing_chunk_id = 0;
    int missing_disk_id = 0;
    int complete_id = 0;
    int google_id = 0;
    int deleted_id = 0;

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username IN ($1, $2)", pqxx::params{user_a_name, user_b_name});
        user_a = txn.exec(
            "INSERT INTO users (username, email, password_hash, is_email_verified) "
            "VALUES ($1, $2, 'hash', true) RETURNING id",
            pqxx::params{user_a_name, user_a_name + "@test.com"})[0][0].as<int>();
        user_b = txn.exec(
            "INSERT INTO users (username, email, password_hash, is_email_verified) "
            "VALUES ($1, $2, 'hash', true) RETURNING id",
            pqxx::params{user_b_name, user_b_name + "@test.com"})[0][0].as<int>();

        const auto insert_file = [&](int owner, const std::string& name, bool complete,
                                     const std::string& provider, bool deleted = false) {
            return txn.exec(
                "INSERT INTO files (user_id, encrypted_name, name_hash, encrypted_fdk, size_bytes, total_chunks, "
                "is_upload_complete, storage_provider, deleted_at) "
                "VALUES ($1, $2, $3, 'fdk', 128, 1, $4, $5, "
                "CASE WHEN $6 THEN CURRENT_TIMESTAMP ELSE NULL END) RETURNING id",
                pqxx::params{owner, name, name + "_hash", complete, provider, deleted})[0][0].as<int>();
        };

        pending_id = insert_file(user_a, "pending", false, "local");
        missing_chunk_id = insert_file(user_a, "missing_chunk", false, "local");
        missing_disk_id = insert_file(user_a, "missing_disk", false, "local");
        complete_id = insert_file(user_a, "complete", true, "local");
        google_id = insert_file(user_a, "google", false, "google_drive");
        deleted_id = insert_file(user_a, "deleted", false, "local", true);

        txn.commit();
    }

    const std::string ciphertext =
        "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_.!@";
    REQUIRE(ciphertext.size() > 32);
    REQUIRE(chunker.write_chunk(static_cast<uint64_t>(pending_id), 0, ciphertext));
    REQUIRE(chunker.write_chunk(static_cast<uint64_t>(missing_disk_id), 0, ciphertext));

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("INSERT INTO file_chunks (file_id, chunk_index) VALUES ($1, 0), ($2, 0), ($3, 0), ($4, 0)",
                 pqxx::params{pending_id, missing_disk_id, complete_id, google_id});
        txn.commit();
    }
    chunker.delete_file(static_cast<uint64_t>(missing_disk_id));

    const std::string owner_token = auth.generate_token(static_cast<uint64_t>(user_a));
    const std::string other_token = auth.generate_token(static_cast<uint64_t>(user_b));
    const auto request = [&](int file_id, const std::string& token, const std::string& range = "") {
        crow::request req;
        req.url = "/files/" + std::to_string(file_id) + "/pending-upload-recovery-prefix";
        if (!token.empty()) req.add_header("Authorization", "Bearer " + token);
        if (!range.empty()) req.add_header("Range", range);
        return router.handle_get_pending_upload_recovery_prefix(req, file_id);
    };

    SECTION("retorna somente o prefixo solicitado e nao altera o upload") {
        const auto before = [&] {
            auto conn = pool.acquire_connection();
            pqxx::read_transaction txn(*conn);
            return txn.exec("SELECT is_upload_complete, (SELECT COUNT(*) FROM file_chunks WHERE file_id = $1) FROM files WHERE id = $1",
                            pqxx::params{pending_id})[0];
        }();

        auto response = request(pending_id, owner_token, "bytes=0-31");
        REQUIRE(response.code == 206);
        REQUIRE(response.body == ciphertext.substr(0, 32));
        REQUIRE(response.get_header_value("Content-Type") == "application/octet-stream");
        REQUIRE(response.get_header_value("Accept-Ranges") == "bytes");
        REQUIRE(response.get_header_value("Content-Length") == "32");
        REQUIRE(response.get_header_value("Content-Range") == "bytes 0-31/" + std::to_string(ciphertext.size()));
        REQUIRE(response.get_header_value("Cache-Control") == "no-store");
        REQUIRE(response.get_header_value("Pragma") == "no-cache");
        REQUIRE(response.get_header_value("Content-Disposition").empty());

        auto conn = pool.acquire_connection();
        pqxx::read_transaction txn(*conn);
        const auto after = txn.exec("SELECT is_upload_complete, (SELECT COUNT(*) FROM file_chunks WHERE file_id = $1) FROM files WHERE id = $1",
                                    pqxx::params{pending_id})[0];
        REQUIRE(after[0].as<bool>() == before[0].as<bool>());
        REQUIRE(after[1].as<int>() == before[1].as<int>());
    }

    SECTION("mantem o download normal bloqueado para upload incompleto") {
        crow::request req;
        req.url = "/files/" + std::to_string(pending_id) + "/download";
        req.add_header("Authorization", "Bearer " + owner_token);
        req.add_header("Range", "bytes=0-31");
        const auto response = router.handle_download_file(req, pending_id);
        REQUIRE(response.code == 400);
        REQUIRE(response.body.find("Upload incompleto") != std::string::npos);
    }

    SECTION("isola ownership, estado e provider") {
        REQUIRE(request(pending_id, other_token, "bytes=0-31").code == 404);
        REQUIRE(request(complete_id, owner_token, "bytes=0-31").code == 409);
        REQUIRE(request(google_id, owner_token, "bytes=0-31").code == 400);
        REQUIRE(request(deleted_id, owner_token, "bytes=0-31").code == 404);
        REQUIRE(request(missing_chunk_id, owner_token, "bytes=0-31").code == 409);
        REQUIRE(request(missing_disk_id, owner_token, "bytes=0-31").code == 409);
        REQUIRE(request(pending_id, "", "bytes=0-31").code == 401);
    }

    SECTION("aceita somente Range prefixo estrito e limitado") {
        REQUIRE(request(pending_id, owner_token).code == 400);
        const std::vector<std::string> invalid_ranges{
            "bytes=1-10", "bytes=-10", "bytes=0-", "bytes=0-10,20-30", "garbage",
            "bytes=a-b", "bytes=10-0", "bytes=0-18446744073709551615", "bytes=0-4194304"
        };
        for (const auto& range : invalid_ranges) {
            const auto response = request(pending_id, owner_token, range);
            REQUIRE(response.code == 416);
        }
        REQUIRE(request(pending_id, owner_token, "bytes=0-4194303").code == 206);
    }

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username IN ($1, $2)", pqxx::params{user_a_name, user_b_name});
        txn.commit();
    }
    std::filesystem::remove_all(test_dir);
}
