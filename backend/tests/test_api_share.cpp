#include <catch2/catch_test_macros.hpp>
#include "controllers/ApiRouter.hpp"
#include "database/DatabasePool.hpp"
#include "Services/AuthService.hpp"
#include "database/FileManager.hpp"
#include "database/FolderManager.hpp"
#include "storage/FileChunker.hpp"
#include "test_helpers.hpp"
#include "utils.hpp"
#include "utils/utils.hpp"
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
    int file_a_2_id = 0;

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

        auto res_file2 = txn.exec(
            "INSERT INTO files (user_id, encrypted_name, name_hash, encrypted_fdk, size_bytes, total_chunks, is_upload_complete) "
            "VALUES ($1, 'file_share2', 'hash_share2', 'mock_fdk2', 15, 1, true) RETURNING id",
            pqxx::params{user_a_id}
        );
        file_a_2_id = res_file2[0][0].as<int>();

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
        std::string fixed_uuid = "abcdefg";
        
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
        std::string partial_uuid = "partial";

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
        std::string expected_cors = Utils::get().get_var("CORS_ORIGIN", "http://localhost:3000");
        REQUIRE(res.get_header_value("Access-Control-Allow-Origin") == expected_cors);

        std::string expose = res.get_header_value("Access-Control-Expose-Headers");
        REQUIRE(expose.find("Content-Range") != std::string::npos);
        REQUIRE(expose.find("X-Encrypted-Name") != std::string::npos);
    }

    SECTION("Proteção Anti-OOM via Link Público (Arquivo > 5MB sem Range)") {
        int file_big_id = 0;
        std::string oom_uuid = "oomgrda";

        {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);

            auto big_file_res = txn.exec(
                "INSERT INTO files (user_id, encrypted_name, name_hash, encrypted_fdk, size_bytes, total_chunks, is_upload_complete) "
                "VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
                pqxx::params{user_a_id, "file_share_big", "hash_share_big", "mock_fdk", 5 * 1024 * 1024 + 1, 1, true}
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
            out_big.seekp(5 * 1024 * 1024);
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

    SECTION("Teste de Colisão de Base62 (Partilha de Ficheiro)") {
        std::string token_user_a = auth.generate_token(user_a_id);

        // Mock token for first share (MUST be set AFTER auth token generation to avoid JTI eating it)
        Base62Generator::mock_next_token = "COLLIDE";

        crow::request req_share1;
        req_share1.url = "/api/files/share";
        req_share1.method = crow::HTTPMethod::Post;
        
        crow::json::wvalue req_body;
        req_body["file_id"] = file_a_1_id;
        req_share1.body = req_body.dump();

        req_share1.add_header("Authorization", "Bearer " + token_user_a);

        crow::response res1 = router.handle_share_file(req_share1, file_a_1_id);
        REQUIRE(res1.code == 200);

        auto json_res1 = crow::json::load(res1.body);
        std::string share_link1 = json_res1["share_uuid"].s();
        REQUIRE(share_link1.find("COLLIDE") != std::string::npos);

        // For the second share, set the mock token to "COLLIDE" again.
        // The first attempt will throw pqxx::unique_violation, the loop will catch it,
        // and the second attempt will generate a random Base62 token.
        Base62Generator::mock_next_token = "COLLIDE";
        
        crow::request req_share2;
        req_share2.url = "/api/files/share";
        req_share2.method = crow::HTTPMethod::Post;
        
        crow::json::wvalue req_body2;
        req_body2["file_id"] = file_a_2_id;
        req_share2.body = req_body2.dump();
        req_share2.add_header("Authorization", "Bearer " + token_user_a);

        crow::response res2 = router.handle_share_file(req_share2, file_a_2_id);
        REQUIRE(res2.code == 200);

        auto json_res2 = crow::json::load(res2.body);
        std::string share_link2 = json_res2["share_uuid"].s();
        REQUIRE(share_link2.find("COLLIDE") == std::string::npos); // Should have recovered
    }

    SECTION("Rate Limit de Alterações de Compartilhamento (10 por hora)") {
        crow::request req_limit;
        req_limit.url = "/api/files/share";
        req_limit.method = crow::HTTPMethod::Post;
        
        crow::json::wvalue req_limit_body;
        req_limit_body["file_id"] = file_a_1_id;
        req_limit.body = req_limit_body.dump();
        
        std::string token_user_a = auth.generate_token(user_a_id);
        req_limit.add_header("Authorization", "Bearer " + token_user_a);

        // Generate 10 links rapidly (the first one was generated in the previous test maybe? No, we are in a new SECTION?
        // Wait, Catch2 SECTIONS run from the top! So the DB is recreated for each SECTION.
        // So we just generate 10 links.
        for (int i = 0; i < 10; ++i) {
            crow::response res_loop = router.handle_share_file(req_limit, file_a_1_id);
            REQUIRE(res_loop.code == 200);
        }

        // The 11th should fail with 429
        crow::response res_blocked = router.handle_share_file(req_limit, file_a_1_id);
        REQUIRE(res_blocked.code == 429);
        REQUIRE(res_blocked.body.find("Muitas alteracoes") != std::string::npos);

        // Simulate 1 hour passing
        {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            txn.exec("UPDATE shared_links SET last_changed_at = NOW() - INTERVAL '1 hour' - INTERVAL '1 minute' WHERE file_id = $1", pqxx::params{file_a_1_id});
            txn.commit();
        }

        // Now it should work again
        crow::response res_recovered = router.handle_share_file(req_limit, file_a_1_id);
        REQUIRE(res_recovered.code == 200);
    }

    SECTION("Novos Endpoints: Listar, Revogar e Metadados") {
        std::string token_user_a = auth.generate_token(user_a_id);

        // 1. Criar link
        crow::request req_create;
        req_create.url = "/files/" + std::to_string(file_a_1_id) + "/share";
        req_create.method = crow::HTTPMethod::Post;
        req_create.add_header("Authorization", "Bearer " + token_user_a);
        crow::response res_create = router.handle_share_file(req_create, file_a_1_id);
        REQUIRE(res_create.code == 200);

        auto body_create = crow::json::load(res_create.body);
        std::string share_uuid = body_create["share_uuid"].s();

        // 2. Listar links
        crow::request req_list;
        req_list.url = "/files/" + std::to_string(file_a_1_id) + "/shares";
        req_list.method = crow::HTTPMethod::Get;
        req_list.add_header("Authorization", "Bearer " + token_user_a);
        crow::response res_list = router.handle_list_shares(req_list, file_a_1_id);
        REQUIRE(res_list.code == 200);
        auto body_list = crow::json::load(res_list.body);
        REQUIRE(body_list.size() == 1);
        REQUIRE(body_list[0]["share_id"].s() == share_uuid);

        // 3. Obter metadados publicos
        crow::request req_meta;
        req_meta.url = "/share/" + share_uuid + "/metadata";
        req_meta.method = crow::HTTPMethod::Get;
        crow::response res_meta = router.handle_get_share_metadata(req_meta, share_uuid);
        REQUIRE(res_meta.code == 200);
        auto body_meta = crow::json::load(res_meta.body);
        REQUIRE(body_meta["encrypted_name"].s() == "file_share");
        REQUIRE(body_meta["size_bytes"].i() == 15);

        // 4. Revogar link
        crow::request req_revoke;
        req_revoke.url = "/shares/" + share_uuid;
        req_revoke.method = crow::HTTPMethod::Delete;
        req_revoke.add_header("Authorization", "Bearer " + token_user_a);
        crow::response res_revoke = router.handle_revoke_share(req_revoke, share_uuid);
        REQUIRE(res_revoke.code == 200);

        // 5. Verificar que sumiu da lista
        crow::response res_list2 = router.handle_list_shares(req_list, file_a_1_id);
        REQUIRE(res_list2.code == 200);
        auto body_list2 = crow::json::load(res_list2.body);
        REQUIRE(body_list2.size() == 0);

        // 6. Verificar que metadados publicos retornam 404 agora
        crow::response res_meta2 = router.handle_get_share_metadata(req_meta, share_uuid);
        REQUIRE(res_meta2.code == 404);
    }

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username IN ('share_user_a', 'share_user_b')");
        txn.commit();
    }

    std::filesystem::remove_all(test_dir);
}
