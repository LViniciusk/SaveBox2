#include <catch2/catch_test_macros.hpp>
#include "controllers/ApiRouter.hpp"
#include "database/DatabasePool.hpp"
#include "Services/AuthService.hpp"
#include "database/FileManager.hpp"
#include "database/FolderManager.hpp"
#include "storage/FileChunker.hpp"
#include "test_helpers.hpp"
#include <crow_all.h>
#include <filesystem>
#include <fstream>
#include <string>

TEST_CASE("API Share - Compartilhamento de Links Publicos", "[api][share][public]") {
    std::string test_dir = "./test_share_links/";
    std::filesystem::create_directories(test_dir);

    std::string conn_str = get_secure_conn_string();
    DatabasePool pool(2, conn_str);
    MockEmailService mock_email;
    AuthService auth("O_tiro_te_acertou_e_você_nem_deu_conta", "A_espada_atravessou_e_você_sentiu_nada", &mock_email);
    FileManager file_mgr(pool);
    FolderManager folder_mgr(pool);
    FileChunker chunker(test_dir);
    
    ApiRouter router(pool, auth, folder_mgr, &file_mgr, &chunker);

    int user_a_id = 0;
    int user_b_id = 0;
    int file_a_1_id = 0;

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);

        txn.exec("DELETE FROM users WHERE username IN ('share_user_a', 'share_user_b')");

        auto res_a = txn.exec("INSERT INTO users (username, email, password_hash, is_email_verified) VALUES ('share_user_a', 'share_user_a@test.com', 'hash_a', true) RETURNING id");
        user_a_id = res_a[0][0].as<int>();

        auto res_b = txn.exec("INSERT INTO users (username, email, password_hash, is_email_verified) VALUES ('share_user_b', 'share_user_b@test.com', 'hash_b', true) RETURNING id");
        user_b_id = res_b[0][0].as<int>();

        auto res_file = txn.exec(
            "INSERT INTO files (user_id, encrypted_name, name_hash, encrypted_fdk, size_bytes, total_chunks, is_upload_complete) "
            "VALUES ($1, 'file_share', 'hash_share', 'mock_fdk', 15, 1, true) RETURNING id",
            pqxx::params{user_a_id}
        );
        file_a_1_id = res_file[0][0].as<int>();

        txn.commit();
    }

    std::string file_path = test_dir + std::to_string(file_a_1_id) + ".dat";
    std::ofstream out(file_path, std::ios::binary);
    out << "Conteudo Ultra Secreto Publico";
    out.close();

    std::string token_a = auth.generate_token(static_cast<uint64_t>(user_a_id));
    std::string token_b = auth.generate_token(static_cast<uint64_t>(user_b_id));

    SECTION("Gerar Link: Sucesso") {
        crow::request req;
        req.url = "/files/" + std::to_string(file_a_1_id) + "/share";
        req.method = crow::HTTPMethod::Post;
        req.add_header("Authorization", "Bearer " + token_a);

        crow::response res = router.handle_share_file(req, file_a_1_id);
        REQUIRE(res.code == 200);
        
        auto body = crow::json::load(res.body);
        REQUIRE(body);
        REQUIRE(body.has("share_uuid"));
        std::string generated_uuid = body["share_uuid"].s();
        REQUIRE(generated_uuid.length() > 0);

        auto conn = pool.acquire_connection();
        pqxx::nontransaction txn(*conn);
        auto check = txn.exec(
            "SELECT count(*) FROM shared_links WHERE share_uuid = " + txn.quote(generated_uuid) +
            " AND file_id = " + std::to_string(file_a_1_id)
        );
        REQUIRE(check[0][0].as<int>() == 1);
    }

    SECTION("Gerar Link: Segurança IDOR") {
        crow::request req;
        req.url = "/files/" + std::to_string(file_a_1_id) + "/share";
        req.method = crow::HTTPMethod::Post;
        req.add_header("Authorization", "Bearer " + token_b);

        crow::response res = router.handle_share_file(req, file_a_1_id);
        REQUIRE((res.code == 403 || res.code == 404));
    }

    SECTION("Acessar Link Público: Download com Sucesso") {
        std::string fixed_uuid = "test-uuid-1234-5678";
        
        {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            txn.exec("INSERT INTO shared_links (file_id, share_uuid) VALUES ($1, $2)",
                     pqxx::params{file_a_1_id, fixed_uuid});
            txn.commit();
        }

        crow::request req;
        req.url = "/share/" + fixed_uuid;
        req.method = crow::HTTPMethod::Get;

        crow::response res = router.handle_get_shared_file(req, fixed_uuid);
        REQUIRE(res.code == 200);
        REQUIRE(res.body == "Conteudo Ultra Secreto Publico");
        REQUIRE(res.get_header_value("Content-Type") == "application/octet-stream");
    }

    SECTION("Link compartilhado invalida apos soft delete") {
        crow::request req_share;
        req_share.url = "/files/" + std::to_string(file_a_1_id) + "/share";
        req_share.method = crow::HTTPMethod::Post;
        req_share.add_header("Authorization", "Bearer " + token_a);

        crow::response res_share = router.handle_share_file(req_share, file_a_1_id);
        REQUIRE(res_share.code == 200);

        auto body = crow::json::load(res_share.body);
        REQUIRE(body);
        REQUIRE(body.has("share_uuid"));
        std::string generated_uuid = body["share_uuid"].s();

        crow::request req_delete;
        req_delete.url = "/files/" + std::to_string(file_a_1_id);
        req_delete.method = crow::HTTPMethod::Delete;
        req_delete.add_header("Authorization", "Bearer " + token_a);

        crow::response res_delete = router.handle_delete_file(req_delete, file_a_1_id);
        REQUIRE(res_delete.code == 200);

        crow::request req_get;
        req_get.url = "/share/" + generated_uuid;
        req_get.method = crow::HTTPMethod::Get;

        crow::response res_get = router.handle_get_shared_file(req_get, generated_uuid);
        REQUIRE(res_get.code == 404);
    }

    SECTION("Acessar Link Público: UUID Invalido") {
        crow::request req;
        req.url = "/share/uuid-que-nao-existe-jamais";
        req.method = crow::HTTPMethod::Get;

        crow::response res = router.handle_get_shared_file(req, "uuid-que-nao-existe-jamais");
        REQUIRE(res.code == 404);
    }

    SECTION("Download Parcial via Link Público (Range: bytes=0-4)") {
        std::string partial_uuid = "test-uuid-partial-range";

        {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            txn.exec("INSERT INTO shared_links (file_id, share_uuid) VALUES ($1, $2)",
                     pqxx::params{file_a_1_id, partial_uuid});
            txn.commit();
        }

        crow::request req;
        req.url = "/share/" + partial_uuid;
        req.method = crow::HTTPMethod::Get;
        req.add_header("Range", "bytes=0-4");

        crow::response res = router.handle_get_shared_file(req, partial_uuid);
        REQUIRE(res.code == 206);
        REQUIRE(res.body.size() == 5);
        REQUIRE(res.body == "Conte");
        REQUIRE(res.get_header_value("Content-Range").find("bytes 0-4/") != std::string::npos);
        REQUIRE(res.get_header_value("Accept-Ranges") == "bytes");
        REQUIRE(res.get_header_value("Access-Control-Allow-Origin") == "http://localhost:3000");

        std::string expose = res.get_header_value("Access-Control-Expose-Headers");
        REQUIRE(expose.find("Content-Range") != std::string::npos);
        REQUIRE(expose.find("X-Encrypted-Name") != std::string::npos);
    }

    SECTION("Proteção Anti-OOM via Link Público (Arquivo > 5MB sem Range)") {
        int file_big_id = 0;
        std::string oom_uuid = "test-uuid-oom-guard";

        {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);

            auto big_file_res = txn.exec(
                "INSERT INTO files (user_id, encrypted_name, name_hash, encrypted_fdk, size_bytes, total_chunks, is_upload_complete) "
                "VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
                pqxx::params{user_a_id, "file_share_big", "hash_share_big", "mock_fdk", 6 * 1024 * 1024 + 1, 1, true}
            );
            file_big_id = big_file_res[0][0].as<int>();

            txn.exec("INSERT INTO shared_links (file_id, share_uuid) VALUES ($1, $2)",
                     pqxx::params{file_big_id, oom_uuid});
            txn.commit();
        }

        std::string big_file_path = test_dir + std::to_string(file_big_id) + ".dat";
        {
            std::ofstream out_big(big_file_path, std::ios::binary);
            REQUIRE(out_big.is_open());
            out_big.seekp(6 * 1024 * 1024);
            out_big.write("X", 1);
            out_big.close();
        }

        // Sem Range → deve bloquear com 400
        crow::request req_no_range;
        req_no_range.url = "/share/" + oom_uuid;
        req_no_range.method = crow::HTTPMethod::Get;

        crow::response res_no_range = router.handle_get_shared_file(req_no_range, oom_uuid);
        REQUIRE(res_no_range.code == 400);

        // Com Range → deve funcionar normalmente com 206
        crow::request req_with_range;
        req_with_range.url = "/share/" + oom_uuid;
        req_with_range.method = crow::HTTPMethod::Get;
        req_with_range.add_header("Range", "bytes=0-100");

        crow::response res_with_range = router.handle_get_shared_file(req_with_range, oom_uuid);
        REQUIRE(res_with_range.code == 206);
    }

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username IN ('share_user_a', 'share_user_b')");
        txn.commit();
    }

    std::filesystem::remove_all(test_dir);
}
