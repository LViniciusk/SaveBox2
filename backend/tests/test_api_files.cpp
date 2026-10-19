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
#include <string>




TEST_CASE("API de Arquivos - Upload em Chunks", "[api][files]") {
    const std::string test_storage_dir = "./test_api_files_storage/";
    std::filesystem::remove_all(test_storage_dir);
    std::filesystem::create_directories(test_storage_dir);

    std::string conn_str = get_secure_conn_string();
    DatabasePool pool(2, conn_str);
    MockEmailService mock_email;
    AuthService auth("A_noite_é_mais_escura_perto_do_amanhecer", "eu_trouxe_uma_primavera_pra_você", &mock_email);
    FolderManager folder_mgr(pool);
    FileManager file_mgr(pool);
    FileChunker file_chunker(test_storage_dir);

    ApiRouter router(pool, auth, folder_mgr, &file_mgr, &file_chunker);

    int fake_user_id = 0;
    int fake_folder_id = 0;

    std::string test_username = "file_upload_ghost_" + std::to_string(rand());
    std::string test_username_b = "file_upload_ghost_b_" + std::to_string(rand());
    int fake_user_id_b = 0;

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        auto user_res = txn.exec(
            "INSERT INTO users (username, email, password_hash, is_email_verified) VALUES ('" + test_username + "', '" + test_username + "@test.com', 'hash_fake', true) RETURNING id"
        );
        fake_user_id = user_res[0][0].as<int>();

        auto user_res_b = txn.exec(
            "INSERT INTO users (username, email, password_hash, is_email_verified) VALUES ('" + test_username_b + "', '" + test_username_b + "@test.com', 'hash_fake_b', true) RETURNING id"
        );
        fake_user_id_b = user_res_b[0][0].as<int>();

        auto folder_res = txn.exec(
            "INSERT INTO folders (user_id, encrypted_name, name_hash) VALUES ($1, 'enc_ghost_folder', 'ghost_folder_hash') RETURNING id",
            pqxx::params{fake_user_id}
        );
        fake_folder_id = folder_res[0][0].as<int>();
        txn.commit();
    }

    std::string token = auth.generate_token(static_cast<uint64_t>(fake_user_id));
    std::string token_b = auth.generate_token(static_cast<uint64_t>(fake_user_id_b));

    SECTION("Inicializar, enviar chunks e completar upload") {
        crow::request req_init;
        req_init.add_header("Authorization", "Bearer " + token);
        req_init.body = R"({"folder_id": )" + std::to_string(fake_folder_id)
                      + R"(, "encrypted_name": "base64_file_name", "name_hash": "file_hash_123", "encrypted_fdk": "mock_encrypted_fdk", "size_bytes": 1024, "total_chunks": 1})";

        crow::response res_init = router.handle_init_file_upload(req_init);

        REQUIRE(res_init.code == 201);

        auto init_body = crow::json::load(res_init.body);
        int file_id = init_body["file_id"].i();

        crow::request req_chunk1;
        req_chunk1.add_header("Authorization", "Bearer " + token);
        req_chunk1.add_header("X-Chunk-Index", "0");
        req_chunk1.body = std::string(1024, '\xAB'); 

        crow::response res_chunk1 = router.handle_upload_chunk(req_chunk1, file_id);

        REQUIRE(res_chunk1.code == 200);
        REQUIRE(res_chunk1.body.find("completed") != std::string::npos);
    }

    SECTION("Upload Interrompido - arquivo permanece incompleto no banco") {
        crow::request req_init_broken;
        req_init_broken.add_header("Authorization", "Bearer " + token);
        req_init_broken.body = R"({"folder_id": )" + std::to_string(fake_folder_id)
                             + R"(, "encrypted_name": "base64_broken_file", "name_hash": "file_hash_broken", "encrypted_fdk": "mock_encrypted_fdk", "size_bytes": 10485760, "total_chunks": 3})";

        crow::response res_init_broken = router.handle_init_file_upload(req_init_broken);
        REQUIRE(res_init_broken.code == 201);

        auto init_broken_body = crow::json::load(res_init_broken.body);
        int file_id_broken = init_broken_body["file_id"].i();

        crow::request req_chunk_broken;
        req_chunk_broken.add_header("Authorization", "Bearer " + token);
        req_chunk_broken.add_header("X-Chunk-Index", "0");
        req_chunk_broken.body = std::string(4 * 1024 * 1024, '\xFF');

        crow::response res_chunk_broken = router.handle_upload_chunk(req_chunk_broken, file_id_broken);
        REQUIRE(res_chunk_broken.code == 200);
        REQUIRE(res_chunk_broken.body.find("uploading") != std::string::npos);

        {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            auto result = txn.exec(
                "SELECT is_upload_complete FROM files WHERE id = $1",
                pqxx::params{file_id_broken}
            );
            txn.commit();

            REQUIRE(!result.empty());
            REQUIRE(result[0][0].as<bool>() == false);
        }

    }

    SECTION("Duplicidade de nome na mesma pasta retorna 409 Conflict") {
        crow::request req_init;
        req_init.add_header("Authorization", "Bearer " + token);
        req_init.body = R"({"folder_id": null, "encrypted_name": "arquivo_duplicado_enc", "name_hash": "hash_duplicado_123", "encrypted_fdk": "mock_encrypted_fdk", "size_bytes": 100, "total_chunks": 1})";

        crow::response res1 = router.handle_init_file_upload(req_init);
        REQUIRE(res1.code == 201);

        auto init_body = crow::json::load(res1.body);
        int file_id = init_body["file_id"].i();

        crow::request req_chunk;
        req_chunk.add_header("Authorization", "Bearer " + token);
        req_chunk.add_header("X-Chunk-Index", "0");
        req_chunk.body = std::string(100, '\xAB');

        crow::response res_chunk = router.handle_upload_chunk(req_chunk, file_id);
        REQUIRE(res_chunk.code == 200);
        REQUIRE(res_chunk.body.find("completed") != std::string::npos);

        crow::response res2 = router.handle_init_file_upload(req_init);
        REQUIRE(res2.code == 409);
        REQUIRE(res2.body.find("Um arquivo com este nome ja existe nesta pasta") != std::string::npos);
        
        crow::request req_init_diff_folder;
        req_init_diff_folder.add_header("Authorization", "Bearer " + token);
        req_init_diff_folder.body = R"({"folder_id": )" + std::to_string(fake_folder_id) + R"(, "encrypted_name": "arquivo_duplicado_enc", "name_hash": "hash_duplicado_123", "encrypted_fdk": "mock_encrypted_fdk", "size_bytes": 100, "total_chunks": 1})";
        crow::response res3 = router.handle_init_file_upload(req_init_diff_folder);
        REQUIRE(res3.code == 201);
    }

    SECTION("Segurança: Bloquear chunk com índice fora dos limites (Sparse File Attack)") {
        crow::request req_init;
        req_init.add_header("Authorization", "Bearer " + token);
        req_init.body = R"({"folder_id": )" + std::to_string(fake_folder_id)
                      + R"(, "encrypted_name": "sparse_attack_file", "name_hash": "sparse_hash_999", "encrypted_fdk": "mock_encrypted_fdk", "size_bytes": 1024, "total_chunks": 1})";

        crow::response res_init = router.handle_init_file_upload(req_init);
        REQUIRE(res_init.code == 201);

        auto init_body = crow::json::load(res_init.body);
        int file_id = init_body["file_id"].i();

        crow::request req_chunk;
        req_chunk.add_header("Authorization", "Bearer " + token);
        req_chunk.add_header("X-Chunk-Index", "1000");
        req_chunk.body = std::string(512, '\xDE');

        crow::response res_chunk = router.handle_upload_chunk(req_chunk, file_id);

        REQUIRE(res_chunk.code == 400);

        auto conn = pool.acquire_connection();
        pqxx::nontransaction txn(*conn);
        int chunks_saved = txn.exec(
            "SELECT COUNT(*) FROM file_chunks WHERE file_id = $1",
            pqxx::params{file_id})[0][0].as<int>();
        REQUIRE(chunks_saved == 0);
    }

    SECTION("Segurança: Imutabilidade - Bloquear envio de chunks em arquivo finalizado") {
        crow::request req_init;
        req_init.add_header("Authorization", "Bearer " + token);
        req_init.body = R"({"folder_id": )" + std::to_string(fake_folder_id)
                      + R"(, "encrypted_name": "immutable_attack_file", "name_hash": "immutable_hash_999", "encrypted_fdk": "mock_encrypted_fdk", "size_bytes": 1024, "total_chunks": 1})";

        crow::response res_init = router.handle_init_file_upload(req_init);
        REQUIRE(res_init.code == 201);

        auto init_body = crow::json::load(res_init.body);
        int file_id = init_body["file_id"].i();

        crow::request req_chunk;
        req_chunk.add_header("Authorization", "Bearer " + token);
        req_chunk.add_header("X-Chunk-Index", "0");
        req_chunk.body = std::string(1024, '\xDE');
        crow::response res_chunk = router.handle_upload_chunk(req_chunk, file_id);
        
        REQUIRE(res_chunk.code == 200);
        REQUIRE(res_chunk.body.find("completed") != std::string::npos);

        crow::request req_attack;
        req_attack.add_header("Authorization", "Bearer " + token);
        req_attack.add_header("X-Chunk-Index", "0");
        req_attack.body = std::string(1024, '\xFA');
        crow::response res_attack = router.handle_upload_chunk(req_attack, file_id);
        
        REQUIRE(res_attack.code == 400);
        REQUIRE(res_attack.body.find("Upload ja finalizado") != std::string::npos);
    }

    SECTION("Segurança: IDOR - Invasão Cruzada no Upload de Chunks") {
        crow::request req_init;
        req_init.add_header("Authorization", "Bearer " + token);
        req_init.body = R"({"folder_id": )" + std::to_string(fake_folder_id)
                      + R"(, "encrypted_name": "idor_file", "name_hash": "idor_hash_999", "encrypted_fdk": "mock_encrypted_fdk", "size_bytes": 1024, "total_chunks": 1})";

        crow::response res_init = router.handle_init_file_upload(req_init);
        REQUIRE(res_init.code == 201);

        auto init_body = crow::json::load(res_init.body);
        int file_id = init_body["file_id"].i();

        crow::request req_chunk;
        req_chunk.add_header("Authorization", "Bearer " + token_b);
        req_chunk.add_header("X-Chunk-Index", "0");
        req_chunk.body = std::string(1024, '\xDE');
        crow::response res_chunk = router.handle_upload_chunk(req_chunk, file_id);
        
        REQUIRE((res_chunk.code == 403 || res_chunk.code == 404));
    }

    SECTION("Segurança: IDOR Relacional - Iniciar upload na pasta de outro usuário") {
        crow::request req_folder;
        req_folder.add_header("Authorization", "Bearer " + token_b);
        std::string h = "hash_folder_b_" + std::to_string(rand());
        req_folder.body = R"({"encrypted_name": "folder_b", "name_hash": ")" + h + R"("})";
        crow::response res_folder = router.handle_create_folder(req_folder);
        REQUIRE(res_folder.code == 201);
        int folder_b_id = crow::json::load(res_folder.body)["id"].i();

        crow::request req_init;
        req_init.add_header("Authorization", "Bearer " + token);
        req_init.body = R"({"folder_id": )" + std::to_string(folder_b_id)
                      + R"(, "encrypted_name": "idor_file_a", "name_hash": "idor_hash_a", "encrypted_fdk": "mock_encrypted_fdk", "size_bytes": 1024, "total_chunks": 1})";
        
        crow::response res_init = router.handle_init_file_upload(req_init);
        REQUIRE((res_init.code == 403 || res_init.code == 404));
    }
    SECTION("Segurança: Bloquear valores negativos para size e chunks (Underflow)") {
        crow::request req_init;
        req_init.add_header("Authorization", "Bearer " + token);
        req_init.body = R"({"folder_id": null, "encrypted_name": "underflow_file", "name_hash": "under_hash", "encrypted_fdk": "mock_encrypted_fdk", "size_bytes": -1024, "total_chunks": -5})";

        crow::response res_init = router.handle_init_file_upload(req_init);
        REQUIRE(res_init.code == 400);
        REQUIRE(res_init.body.find("Valores numericos invalidos") != std::string::npos);
    }

    SECTION("Proteção contra Denial of Service (Payload JSON Malformado)") {
        crow::request req_init;
        req_init.add_header("Authorization", "Bearer " + token);
        
        // JSON quebrado propositadamente
        req_init.body = R"({"folder_id": null, "encrypted_name": "quebrado" "name_hash": "missing_comma")";

        crow::response res_init = router.handle_init_file_upload(req_init);
        REQUIRE(res_init.code == 400);

        // Tipos de dados errados
        req_init.body = R"({"folder_id": "string_em_vez_de_int", "encrypted_name": "x", "name_hash": "y", "encrypted_fdk": "z", "size_bytes": "nao_numero", "total_chunks": 1})";
        crow::response res_types = router.handle_init_file_upload(req_init);
        REQUIRE((res_types.code == 400 || res_types.code == 403 || res_types.code == 500));
    }

    SECTION("Proteção contra Stored XSS e Injection em Nomes de Ficheiros") {
        crow::request req_init;
        req_init.add_header("Authorization", "Bearer " + token);
        std::string malicious_xss = "<script>alert('XSS')</script>";
        req_init.body = R"({"folder_id": null, "encrypted_name": "<script>alert('XSS')</script>", "name_hash": "xss_hash", "encrypted_fdk": "mock", "size_bytes": 10, "total_chunks": 1})";

        crow::response res_init = router.handle_init_file_upload(req_init);
        REQUIRE(res_init.code == 201);

        crow::request req_tree;
        req_tree.add_header("Authorization", "Bearer " + token);
        crow::response res_tree = router.handle_get_pending_uploads(req_tree);
        REQUIRE(res_tree.code == 200);

        auto tree_json = crow::json::load(res_tree.body);
        bool xss_found = false;
        if (tree_json.has("pending_uploads")) {
            for (const auto& file : tree_json["pending_uploads"]) {
                if (file["encrypted_name"].s() == malicious_xss) {
                    xss_found = true;
                    break;
                }
            }
        }
        REQUIRE(xss_found == true);
    }

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username IN ('" + test_username + "', '" + test_username_b + "')");
        txn.commit();
    }

    std::filesystem::remove_all(test_storage_dir);
}

TEST_CASE("B.49 - chunk local incompatível é rejeitado antes da materialização",
          "[api][files][b49][regression]") {
    const std::filesystem::path storage_dir = "./test_b49_local_chunks/";
    std::filesystem::remove_all(storage_dir);
    std::filesystem::create_directories(storage_dir);

    DatabasePool pool(2, get_secure_conn_string());
    MockEmailService mock_email;
    AuthService auth("b49-auth-secret", "b49-auth-salt", &mock_email);
    FolderManager folder_mgr(pool);
    FileManager file_mgr(pool);
    FileChunker file_chunker(storage_dir.string());
    ApiRouter router(pool, auth, folder_mgr, &file_mgr, &file_chunker);

    int user_id = 0;
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        user_id = txn.exec(
            "INSERT INTO users (username, email, password_hash, is_email_verified, max_storage_bytes) "
            "VALUES ('b49-local-user', 'b49-local@test.com', 'hash', true, 1000000) RETURNING id"
        )[0][0].as<int>();
        txn.commit();
    }

    struct Cleanup {
        DatabasePool& pool;
        int user_id;
        std::filesystem::path storage_dir;

        ~Cleanup() {
            try {
                auto conn = pool.acquire_connection();
                pqxx::work txn(*conn);
                txn.exec("DELETE FROM users WHERE id = $1", pqxx::params{user_id});
                txn.commit();
            } catch (...) {}
            std::filesystem::remove_all(storage_dir);
        }
    } cleanup{pool, user_id, storage_dir};

    const auto quota = [&] {
        auto conn = pool.acquire_connection();
        pqxx::nontransaction txn(*conn);
        return txn.exec("SELECT used_storage_bytes FROM users WHERE id = $1", pqxx::params{user_id})[0][0].as<uint64_t>();
    };
    const auto quota_before_init = quota();
    const auto token = auth.generate_token(static_cast<uint64_t>(user_id));

    crow::request init;
    init.add_header("Authorization", "Bearer " + token);
    init.body = R"({"folder_id":null,"encrypted_name":"b49-name","name_hash":"b49-hash","encrypted_fdk":"b49-fdk","size_bytes":1024,"total_chunks":1})";
    const auto init_response = router.handle_init_file_upload(init);
    REQUIRE(init_response.code == 201);
    const int file_id = crow::json::load(init_response.body)["file_id"].i();
    const auto quota_after_init = quota();
    REQUIRE(quota_after_init == quota_before_init + 1024);

    crow::request invalid_chunk;
    invalid_chunk.add_header("Authorization", "Bearer " + token);
    invalid_chunk.add_header("X-Chunk-Index", "0");
    invalid_chunk.body = std::string(512, '\xAB');
    const auto invalid_response = router.handle_upload_chunk(invalid_chunk, file_id);
    CHECK(invalid_response.code == 400);

    const auto physical_path = storage_dir / (std::to_string(file_id) + ".dat");
    const auto physical_size = std::filesystem::exists(physical_path)
        ? std::filesystem::file_size(physical_path)
        : 0;
    CHECK(physical_size == 0);
    {
        auto conn = pool.acquire_connection();
        pqxx::nontransaction txn(*conn);
        const auto row = txn.exec(
            "SELECT size_bytes, is_upload_complete, "
            "(SELECT COUNT(*) FROM file_chunks WHERE file_id = files.id) "
            "FROM files WHERE id = $1 AND user_id = $2",
            pqxx::params{file_id, user_id});
        REQUIRE(row.size() == 1);
        CHECK(row[0][0].as<uint64_t>() == 1024);
        CHECK_FALSE(row[0][1].as<bool>());
        CHECK(row[0][2].as<int>() == 0);
    }
    CHECK(quota() == quota_after_init);
}

TEST_CASE("B.49 - chunks locais respeitam tamanho reservado e bytes físicos",
          "[api][files][b49]") {
    const std::filesystem::path storage_dir = "./test_b49_local_boundaries/";
    std::filesystem::remove_all(storage_dir);
    std::filesystem::create_directories(storage_dir);

    DatabasePool pool(2, get_secure_conn_string());
    MockEmailService mock_email;
    AuthService auth("b49-boundary-secret", "b49-boundary-salt", &mock_email);
    FolderManager folder_mgr(pool);
    FileManager file_mgr(pool);
    FileChunker file_chunker(storage_dir.string());
    ApiRouter router(pool, auth, folder_mgr, &file_mgr, &file_chunker);

    int user_id = 0;
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        user_id = txn.exec(
            "INSERT INTO users (username, email, password_hash, is_email_verified, max_storage_bytes) "
            "VALUES ('b49-boundary-user', 'b49-boundary@test.com', 'hash', true, 100000000) RETURNING id"
        )[0][0].as<int>();
        txn.commit();
    }

    struct Cleanup {
        DatabasePool& pool;
        int user_id;
        std::filesystem::path storage_dir;

        ~Cleanup() {
            try {
                auto conn = pool.acquire_connection();
                pqxx::work txn(*conn);
                txn.exec("DELETE FROM users WHERE id = $1", pqxx::params{user_id});
                txn.commit();
            } catch (...) {}
            std::filesystem::remove_all(storage_dir);
        }
    } cleanup{pool, user_id, storage_dir};

    const auto token = auth.generate_token(static_cast<uint64_t>(user_id));
    const auto quota = [&] {
        auto conn = pool.acquire_connection();
        pqxx::nontransaction txn(*conn);
        return txn.exec(
            "SELECT used_storage_bytes FROM users WHERE id = $1",
            pqxx::params{user_id}
        )[0][0].as<uint64_t>();
    };

    struct FileState {
        uint64_t size_bytes;
        bool complete;
        int uploaded_chunks;
    };
    const auto state = [&](int file_id) {
        auto conn = pool.acquire_connection();
        pqxx::nontransaction txn(*conn);
        const auto row = txn.exec(
            "SELECT size_bytes, is_upload_complete, "
            "(SELECT COUNT(*) FROM file_chunks WHERE file_id = files.id) "
            "FROM files WHERE id = $1 AND user_id = $2",
            pqxx::params{file_id, user_id}
        );
        REQUIRE(row.size() == 1);
        return FileState{
            row[0][0].as<uint64_t>(),
            row[0][1].as<bool>(),
            row[0][2].as<int>()
        };
    };

    const auto init_file = [&](uint64_t size_bytes, int total_chunks, const std::string& suffix) {
        crow::request req;
        req.add_header("Authorization", "Bearer " + token);
        req.body = R"({"folder_id":null,"encrypted_name":")" + suffix
                 + R"(","name_hash":")" + suffix
                 + R"(-hash","encrypted_fdk":")" + suffix
                 + R"(-fdk","size_bytes":)" + std::to_string(size_bytes)
                 + R"(,"total_chunks":)" + std::to_string(total_chunks) + "}";
        const auto response = router.handle_init_file_upload(req);
        REQUIRE(response.code == 201);
        return crow::json::load(response.body)["file_id"].i();
    };

    const auto send_chunk = [&](int file_id, int chunk_index, const std::string& body) {
        crow::request req;
        req.add_header("Authorization", "Bearer " + token);
        req.add_header("X-Chunk-Index", std::to_string(chunk_index));
        req.body = body;
        return router.handle_upload_chunk(req, file_id);
    };

    const std::string full_chunk(FileChunker::MAX_CHUNK_SIZE, '\xCD');

    SECTION("single chunk rejeita body maior que o tamanho declarado antes da escrita") {
        constexpr uint64_t size_bytes = 1024;
        const auto quota_before = quota();
        const int file_id = init_file(size_bytes, 1, "b49-single-oversized");
        REQUIRE(quota() == quota_before + size_bytes);

        CHECK(send_chunk(file_id, 0, std::string(size_bytes + 1, '\xCD')).code == 400);
        const auto rejected_state = state(file_id);
        CHECK(rejected_state.size_bytes == size_bytes);
        CHECK_FALSE(rejected_state.complete);
        CHECK(rejected_state.uploaded_chunks == 0);
        CHECK_FALSE(std::filesystem::exists(storage_dir / (std::to_string(file_id) + ".dat")));
        CHECK(quota() == quota_before + size_bytes);
    }

    SECTION("múltiplo exato aceita ordem diferente e retry válido sem duplicar chunk") {
        constexpr uint64_t size_bytes = 2ULL * FileChunker::MAX_CHUNK_SIZE;
        const auto quota_before = quota();
        const int file_id = init_file(size_bytes, 2, "b49-exact");
        REQUIRE(quota() == quota_before + size_bytes);

        REQUIRE(send_chunk(file_id, 1, full_chunk).code == 200);
        REQUIRE(state(file_id).uploaded_chunks == 1);
        const auto second_chunk = file_chunker.read_file_portion(
            file_id, FileChunker::MAX_CHUNK_SIZE, FileChunker::MAX_CHUNK_SIZE);
        REQUIRE(second_chunk == full_chunk);

        CHECK(send_chunk(file_id, 1, full_chunk).code == 200);
        CHECK(state(file_id).uploaded_chunks == 1);
        CHECK(file_chunker.read_file_portion(
            file_id, FileChunker::MAX_CHUNK_SIZE, FileChunker::MAX_CHUNK_SIZE) == second_chunk);

        CHECK(send_chunk(file_id, 1, std::string(1, '\xEE')).code == 400);
        CHECK(state(file_id).uploaded_chunks == 1);
        CHECK(file_chunker.read_file_portion(
            file_id, FileChunker::MAX_CHUNK_SIZE, FileChunker::MAX_CHUNK_SIZE) == second_chunk);

        REQUIRE(send_chunk(file_id, 0, full_chunk).code == 200);
        const auto final_state = state(file_id);
        CHECK(final_state.size_bytes == size_bytes);
        CHECK(final_state.complete);
        CHECK(final_state.uploaded_chunks == 2);
        CHECK(file_chunker.get_file_size(file_id) == size_bytes);
        CHECK(quota() == quota_before + size_bytes);
    }

    SECTION("resto final exige exatamente os bytes restantes") {
        constexpr uint64_t size_bytes = FileChunker::MAX_CHUNK_SIZE + 2;
        const auto quota_before = quota();
        const int file_id = init_file(size_bytes, 2, "b49-remainder");
        REQUIRE(quota() == quota_before + size_bytes);

        CHECK(send_chunk(file_id, 0, std::string(FileChunker::MAX_CHUNK_SIZE - 1, '\xCD')).code == 400);
        CHECK(send_chunk(file_id, 0, std::string(FileChunker::MAX_CHUNK_SIZE + 1, '\xCD')).code == 400);
        CHECK(state(file_id).uploaded_chunks == 0);
        CHECK_FALSE(std::filesystem::exists(storage_dir / (std::to_string(file_id) + ".dat")));

        REQUIRE(send_chunk(file_id, 0, full_chunk).code == 200);
        CHECK(state(file_id).uploaded_chunks == 1);
        CHECK(send_chunk(file_id, 1, std::string(1, '\xCD')).code == 400);
        CHECK(send_chunk(file_id, 1, std::string(3, '\xCD')).code == 400);
        CHECK(state(file_id).uploaded_chunks == 1);

        REQUIRE(send_chunk(file_id, 1, std::string(2, '\xCD')).code == 200);
        const auto final_state = state(file_id);
        CHECK(final_state.size_bytes == size_bytes);
        CHECK(final_state.complete);
        CHECK(final_state.uploaded_chunks == 2);
        CHECK(file_chunker.get_file_size(file_id) == size_bytes);
        CHECK(quota() == quota_before + size_bytes);
    }

    SECTION("arquivo vazio materializa zero bytes e conclui com chunk vazio") {
        const auto quota_before = quota();
        const int file_id = init_file(0, 1, "b49-empty");
        REQUIRE(quota() == quota_before);

        REQUIRE(send_chunk(file_id, 0, {}).code == 200);
        const auto final_state = state(file_id);
        CHECK(final_state.size_bytes == 0);
        CHECK(final_state.complete);
        CHECK(final_state.uploaded_chunks == 1);
        CHECK(file_chunker.get_file_size(file_id) == 0);
        CHECK(quota() == quota_before);
    }

    SECTION("batch local usa a mesma regra de tamanho e quota") {
        constexpr uint64_t size_bytes = FileChunker::MAX_CHUNK_SIZE + 2;
        const auto quota_before = quota();

        crow::json::wvalue item;
        item["client_ref"] = "b49-batch-ref";
        item["encrypted_name"] = "b49-batch-name";
        item["name_hash"] = "b49-batch-hash";
        item["encrypted_fdk"] = "b49-batch-fdk";
        item["size_bytes"] = size_bytes;
        item["total_chunks"] = 2;

        std::vector<crow::json::wvalue> items;
        items.push_back(std::move(item));
        crow::json::wvalue body;
        body["files"] = std::move(items);

        crow::request req;
        req.add_header("Authorization", "Bearer " + token);
        req.body = body.dump();
        const auto response = router.handle_batch_init_uploads(req);
        REQUIRE(response.code == 201);

        auto response_body = crow::json::load(response.body);
        auto files_node = response_body["files"];
        const auto result = files_node.lo();
        REQUIRE(result.size() == 1);
        const int file_id = result[0]["file_id"].i();
        REQUIRE(quota() == quota_before + size_bytes);

        REQUIRE(send_chunk(file_id, 0, full_chunk).code == 200);
        CHECK(state(file_id).uploaded_chunks == 1);
        REQUIRE(send_chunk(file_id, 1, std::string(2, '\xCD')).code == 200);

        const auto final_state = state(file_id);
        CHECK(final_state.size_bytes == size_bytes);
        CHECK(final_state.complete);
        CHECK(final_state.uploaded_chunks == 2);
        CHECK(file_chunker.get_file_size(file_id) == size_bytes);
        CHECK(quota() == quota_before + size_bytes);
    }
}
