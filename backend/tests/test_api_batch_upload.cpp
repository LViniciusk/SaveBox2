#include <catch2/catch_test_macros.hpp>
#include "controllers/ApiRouter.hpp"
#include "database/DatabasePool.hpp"
#include "Services/AuthService.hpp"
#include "database/FolderManager.hpp"
#include "database/FileManager.hpp"
#include "storage/FileChunker.hpp"
#include "test_helpers.hpp"
#include <crow_all.h>

TEST_CASE("API Batch Upload Init", "[api][upload][batch]") {
    std::string conn_str = get_secure_conn_string();
    DatabasePool pool(2, conn_str);
    MockEmailService mock_email;
    AuthService auth("BatchUploadSecret", "batch_upload_salt", &mock_email);
    FolderManager folder_mgr(pool);
    FileManager file_mgr(pool);
    FileChunker chunker("test_batch_chunks_dir");
    
    ApiRouter router(pool, auth, folder_mgr, &file_mgr, &chunker);

    int user_a_id = 0;
    int folder_a_id = 0;

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);

        txn.exec("DELETE FROM users WHERE username = 'batch_user_A'");
        
        auto res_a = txn.exec("INSERT INTO users (username, email, password_hash, is_email_verified, max_storage_bytes) VALUES ('batch_user_A', 'batch_A@test.com', 'hash_a', true, 100000000) RETURNING id");
        user_a_id = res_a[0][0].as<int>();

        auto res_folder = txn.exec("INSERT INTO folders (user_id, encrypted_name, name_hash) VALUES ($1, $2, $3) RETURNING id", pqxx::params{user_a_id, "batch_folder", "b_hash_folder"});
        folder_a_id = res_folder[0][0].as<int>();

        txn.commit();
    }

    std::string token_a = auth.generate_token(static_cast<uint64_t>(user_a_id));

    SECTION("Sucesso - Multiplos Arquivos Locais") {
        crow::request req;
        req.url = "/api/files/batch-init";
        req.method = crow::HTTPMethod::Post;
        req.add_header("Authorization", "Bearer " + token_a);
        
        crow::json::wvalue file1;
        file1["client_ref"] = "batch-local-1";
        file1["encrypted_name"] = "enc1";
        file1["name_hash"] = "hash1";
        file1["encrypted_fdk"] = "fdk1";
        file1["size_bytes"] = 4000000; // 4MB -> 1 chunk
        file1["total_chunks"] = 1;
        file1["folder_id"] = folder_a_id;

        crow::json::wvalue file2;
        file2["client_ref"] = "batch-local-2";
        file2["encrypted_name"] = "enc2";
        file2["name_hash"] = "hash2";
        file2["encrypted_fdk"] = "fdk2";
        file2["size_bytes"] = 5000000; // 5MB -> 2 chunks
        file2["total_chunks"] = 2;
        file2["folder_id"] = folder_a_id;

        std::vector<crow::json::wvalue> files_list;
        files_list.push_back(std::move(file1));
        files_list.push_back(std::move(file2));

        crow::json::wvalue req_body;
        req_body["files"] = std::move(files_list);
        req.body = req_body.dump();

        crow::response res = router.handle_batch_init_uploads(req);
        REQUIRE(res.code == 201);
        
        auto body = crow::json::load(res.body);
        REQUIRE(body);
        REQUIRE(body.has("files"));
        auto files_node = body["files"];
        auto result_files = files_node.lo();
        REQUIRE(result_files.size() == 2);

        bool found_hash1 = false;
        bool found_hash2 = false;

        for (const auto& item : result_files) {
            REQUIRE(item.has("file_id"));
            REQUIRE(item["storage_provider"].s() == "local");
            if (item["name_hash"].s() == "hash1") found_hash1 = true;
            if (item["name_hash"].s() == "hash2") found_hash2 = true;
        }
        REQUIRE(found_hash1);
        REQUIRE(found_hash2);

        // Verify Quota Update
        auto conn = pool.acquire_connection();
        pqxx::nontransaction txn(*conn);
        auto check_quota = txn.exec("SELECT used_storage_bytes FROM users WHERE id = " + std::to_string(user_a_id));
        REQUIRE(check_quota[0][0].as<uint64_t>() == 9000000);
    }

    SECTION("Mesmo name_hash pode existir em pastas diferentes e preserva client_ref") {
        crow::request req;
        req.url = "/api/files/batch-init";
        req.method = crow::HTTPMethod::Post;
        req.add_header("Authorization", "Bearer " + token_a);

        crow::json::wvalue root_file;
        root_file["client_ref"] = "opaque-root-ref";
        root_file["encrypted_name"] = "root-name";
        root_file["name_hash"] = "same-hash-different-folder";
        root_file["encrypted_fdk"] = "root-fdk";
        root_file["size_bytes"] = 10;
        root_file["total_chunks"] = 1;

        crow::json::wvalue nested_file;
        nested_file["client_ref"] = "opaque-nested-ref";
        nested_file["encrypted_name"] = "nested-name";
        nested_file["name_hash"] = "same-hash-different-folder";
        nested_file["encrypted_fdk"] = "nested-fdk";
        nested_file["size_bytes"] = 10;
        nested_file["total_chunks"] = 1;
        nested_file["folder_id"] = folder_a_id;

        std::vector<crow::json::wvalue> files_list;
        files_list.push_back(std::move(root_file));
        files_list.push_back(std::move(nested_file));
        crow::json::wvalue req_body;
        req_body["files"] = std::move(files_list);
        req.body = req_body.dump();

        const auto res = router.handle_batch_init_uploads(req);
        REQUIRE(res.code == 201);
        auto body = crow::json::load(res.body);
        REQUIRE(body);
        REQUIRE(body.has("files"));
        auto files_node = body["files"];
        const auto result_files = files_node.lo();
        REQUIRE(result_files.size() == 2);
        for (const auto& item : result_files) REQUIRE(item.has("client_ref"));
    }

    SECTION("Erro - Cota Excedida") {
        crow::request req;
        req.url = "/api/files/batch-init";
        req.method = crow::HTTPMethod::Post;
        req.add_header("Authorization", "Bearer " + token_a);
        
        crow::json::wvalue file1;
        file1["client_ref"] = "batch-quota";
        file1["encrypted_name"] = "enc3";
        file1["name_hash"] = "hash3";
        file1["encrypted_fdk"] = "fdk3";
        file1["size_bytes"] = 2000000000; // 2GB
        file1["total_chunks"] = 477; // 2000000000 / 4194304 = 476.8 -> 477

        std::vector<crow::json::wvalue> files_list;
        files_list.push_back(std::move(file1));

        crow::json::wvalue req_body;
        req_body["files"] = std::move(files_list);
        req.body = req_body.dump();

        crow::response res = router.handle_batch_init_uploads(req);
        REQUIRE(res.code == 402); // Payment Required - Quota Exceeded
    }

    SECTION("Erro - JSON Invalido (Sem files array)") {
        crow::request req;
        req.url = "/api/files/batch-init";
        req.method = crow::HTTPMethod::Post;
        req.add_header("Authorization", "Bearer " + token_a);
        
        crow::json::wvalue req_body;
        req_body["something_else"] = 123;
        req.body = req_body.dump();

        crow::response res = router.handle_batch_init_uploads(req);
        REQUIRE(res.code == 400); 
    }

    SECTION("client_ref transitório exige tamanho entre 1 e 128") {
        crow::request req;
        req.url = "/api/files/batch-init";
        req.method = crow::HTTPMethod::Post;
        req.add_header("Authorization", "Bearer " + token_a);

        crow::json::wvalue missing_ref;
        missing_ref["encrypted_name"] = "enc-ref";
        missing_ref["name_hash"] = "hash-ref";
        missing_ref["encrypted_fdk"] = "fdk-ref";
        missing_ref["size_bytes"] = 1;
        missing_ref["total_chunks"] = 1;
        std::vector<crow::json::wvalue> missing_items;
        missing_items.push_back(std::move(missing_ref));
        crow::json::wvalue missing_body;
        missing_body["files"] = std::move(missing_items);
        req.body = missing_body.dump();
        REQUIRE(router.handle_batch_init_uploads(req).code == 400);

        crow::json::wvalue long_ref;
        long_ref["client_ref"] = std::string(129, 'r');
        long_ref["encrypted_name"] = "enc-ref-long";
        long_ref["name_hash"] = "hash-ref-long";
        long_ref["encrypted_fdk"] = "fdk-ref-long";
        long_ref["size_bytes"] = 1;
        long_ref["total_chunks"] = 1;
        std::vector<crow::json::wvalue> long_items;
        long_items.push_back(std::move(long_ref));
        crow::json::wvalue long_body;
        long_body["files"] = std::move(long_items);
        req.body = long_body.dump();
        REQUIRE(router.handle_batch_init_uploads(req).code == 400);

        auto duplicate_ref_file = [](const char* hash) {
            crow::json::wvalue file;
            file["client_ref"] = "same-ref";
            file["encrypted_name"] = hash;
            file["name_hash"] = hash;
            file["encrypted_fdk"] = "fdk";
            file["size_bytes"] = 1;
            file["total_chunks"] = 1;
            return file;
        };
        crow::json::wvalue duplicate_body;
        std::vector<crow::json::wvalue> duplicate_items;
        duplicate_items.push_back(duplicate_ref_file("hash-ref-a"));
        duplicate_items.push_back(duplicate_ref_file("hash-ref-b"));
        duplicate_body["files"] = std::move(duplicate_items);
        req.body = duplicate_body.dump();
        REQUIRE(router.handle_batch_init_uploads(req).code == 409);
    }

    SECTION("Anti-Abuso - Lote maior que 100 arquivos") {
        crow::request req;
        req.url = "/api/files/batch-init";
        req.method = crow::HTTPMethod::Post;
        req.add_header("Authorization", "Bearer " + token_a);
        
        std::vector<crow::json::wvalue> files_list;
        for (int i = 0; i < 101; ++i) {
            crow::json::wvalue file;
            file["encrypted_name"] = "enc";
            file["name_hash"] = "hash";
            file["encrypted_fdk"] = "fdk";
            file["size_bytes"] = 100;
            file["total_chunks"] = 1;
            files_list.push_back(std::move(file));
        }

        crow::json::wvalue req_body;
        req_body["files"] = std::move(files_list);
        req.body = req_body.dump();

        crow::response res = router.handle_batch_init_uploads(req);
        REQUIRE(res.code == 400);
    }

    SECTION("IDOR - Tentar salvar em pasta de outro usuario") {
        int other_folder_id = 0;
        {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            txn.exec("DELETE FROM users WHERE username = 'batch_user_B'");
            auto res_b = txn.exec("INSERT INTO users (username, email, password_hash, is_email_verified) VALUES ('batch_user_B', 'batch_B@test.com', 'hash_b', true) RETURNING id");
            int user_b_id = res_b[0][0].as<int>();
            auto res_f = txn.exec("INSERT INTO folders (user_id, encrypted_name, name_hash) VALUES ($1, 'other_folder', 'ohash') RETURNING id", pqxx::params{user_b_id});
            other_folder_id = res_f[0][0].as<int>();
            txn.commit();
        }

        crow::request req;
        req.url = "/api/files/batch-init";
        req.method = crow::HTTPMethod::Post;
        req.add_header("Authorization", "Bearer " + token_a);
        
        crow::json::wvalue file1;
        file1["client_ref"] = "batch-idor";
        file1["encrypted_name"] = "enc_idor";
        file1["name_hash"] = "hash_idor";
        file1["encrypted_fdk"] = "fdk_idor";
        file1["size_bytes"] = 100;
        file1["total_chunks"] = 1;
        file1["folder_id"] = other_folder_id;

        std::vector<crow::json::wvalue> files_list;
        files_list.push_back(std::move(file1));

        crow::json::wvalue req_body;
        req_body["files"] = std::move(files_list);
        req.body = req_body.dump();

        crow::response res = router.handle_batch_init_uploads(req);
        REQUIRE(res.code == 403);
    }

    SECTION("Manipulacao Matematica - Quantidade de Chunks errada") {
        crow::request req;
        req.url = "/api/files/batch-init";
        req.method = crow::HTTPMethod::Post;
        req.add_header("Authorization", "Bearer " + token_a);
        
        crow::json::wvalue file1;
        file1["client_ref"] = "batch-math";
        file1["encrypted_name"] = "enc_math";
        file1["name_hash"] = "hash_math";
        file1["encrypted_fdk"] = "fdk_math";
        file1["size_bytes"] = 5000000;
        file1["total_chunks"] = 1;

        std::vector<crow::json::wvalue> files_list;
        files_list.push_back(std::move(file1));

        crow::json::wvalue req_body;
        req_body["files"] = std::move(files_list);
        req.body = req_body.dump();

        crow::response res = router.handle_batch_init_uploads(req);
        REQUIRE(res.code == 400);
    }

    SECTION("Colisao - Arquivo com mesmo nome") {
        crow::request req;
        req.url = "/api/files/batch-init";
        req.method = crow::HTTPMethod::Post;
        req.add_header("Authorization", "Bearer " + token_a);
        
        crow::json::wvalue file1;
        file1["client_ref"] = "batch-collision";
        file1["encrypted_name"] = "enc_col";
        file1["name_hash"] = "hash_col";
        file1["encrypted_fdk"] = "fdk_col";
        file1["size_bytes"] = 100;
        file1["total_chunks"] = 1;

        std::vector<crow::json::wvalue> files_list;
        files_list.push_back(std::move(file1));

        crow::json::wvalue req_body;
        req_body["files"] = std::move(files_list);
        req.body = req_body.dump();

        crow::response res = router.handle_batch_init_uploads(req);
        REQUIRE(res.code == 201);

        crow::response res2 = router.handle_batch_init_uploads(req);
        REQUIRE(res2.code == 409);
    }

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username = 'batch_user_A'");
        txn.commit();
    }
}

TEST_CASE("API Batch Upload Google Drive lifecycle", "[api][upload][batch][googledrive]") {
    set_test_environment("GOOGLE_CLIENT_ID", "mock_client_id");
    set_test_environment("GOOGLE_CLIENT_SECRET", "mock_client_secret");

    std::string conn_str = get_secure_conn_string();
    DatabasePool pool(2, conn_str);
    MockEmailService mock_email;
    AuthService auth("BatchGoogleSecret", "batch_google_salt", &mock_email);
    FolderManager folder_mgr(pool);
    FileManager file_mgr(pool);
    FileChunker chunker("test_batch_google_chunks_dir");
    MockGoogleDriveService gdrive(pool);
    ApiRouter router(pool, auth, folder_mgr, &file_mgr, &chunker, &gdrive);

    const uint64_t user_id = 9996;
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM files WHERE user_id = $1", pqxx::params{user_id});
        txn.exec("DELETE FROM user_external_storages WHERE user_id = $1", pqxx::params{user_id});
        txn.exec("DELETE FROM users WHERE id = $1", pqxx::params{user_id});
        txn.exec("INSERT INTO users (id, username, email, password_hash, is_email_verified, max_storage_bytes) "
                 "VALUES ($1, 'batch_google_user', 'batch_google@test.com', 'hash', true, 100000000)",
                 pqxx::params{user_id});
        txn.commit();
    }

    struct Cleanup {
        DatabasePool& pool;
        uint64_t user_id;
        ~Cleanup() {
            try {
                auto conn = pool.acquire_connection();
                pqxx::work txn(*conn);
                txn.exec("DELETE FROM files WHERE user_id = $1", pqxx::params{user_id});
                txn.exec("DELETE FROM user_external_storages WHERE user_id = $1", pqxx::params{user_id});
                txn.exec("DELETE FROM users WHERE id = $1", pqxx::params{user_id});
                txn.commit();
            } catch (...) {}
        }
    } cleanup{pool, user_id};

    gdrive.link_account(user_id, "valid_code", gdrive.generate_test_state(user_id));
    const auto token = auth.generate_token(user_id);

    crow::request req;
    req.url = "/files/batch-init";
    req.method = crow::HTTPMethod::Post;
    req.add_header("Authorization", "Bearer " + token);
    crow::json::wvalue item;
    item["client_ref"] = "google-batch-ref";
    item["encrypted_name"] = "encrypted-name";
    item["name_hash"] = "google-batch-hash";
    item["encrypted_fdk"] = "encrypted-fdk";
    item["size_bytes"] = 1024;
    item["storage_provider"] = "google_drive";
    std::vector<crow::json::wvalue> items;
    items.push_back(std::move(item));
    crow::json::wvalue body;
    body["files"] = std::move(items);
    req.body = body.dump();

    auto init = router.handle_batch_init_uploads(req);
    REQUIRE(init.code == 201);
    REQUIRE(init.get_header_value("Cache-Control").find("no-store") != std::string::npos);
    REQUIRE(init.get_header_value("Pragma") == "no-cache");
    const auto init_json = crow::json::load(init.body);
    REQUIRE(init_json["files"].size() == 1);
    REQUIRE(init_json["files"][0]["name_hash"].s() == "google-batch-hash");
    REQUIRE(init_json["files"][0]["storage_provider"].s() == "google_drive");
    REQUIRE_FALSE(init_json["files"][0].has("access_token"));
    REQUIRE_FALSE(init_json["files"][0].has("root_folder_id"));

    const int file_id = init_json["files"][0]["file_id"].i();
    {
        auto conn = pool.acquire_connection();
        pqxx::nontransaction txn(*conn);
        const auto state = txn.exec("SELECT is_upload_complete, external_file_id FROM files WHERE id = $1", pqxx::params{file_id});
        REQUIRE(state[0][0].as<bool>() == false);
        REQUIRE(state[0][1].is_null());
        const auto quota = txn.exec("SELECT used_storage_bytes FROM users WHERE id = $1", pqxx::params{user_id});
        REQUIRE(quota[0][0].as<uint64_t>() == 2048);
    }

    crow::request finalize;
    finalize.url = "/files/" + std::to_string(file_id) + "/finalize-external";
    finalize.add_header("Authorization", "Bearer " + token);
    finalize.body = R"({"external_file_id":"external-google-id"})";
    REQUIRE(router.handle_finalize_external_upload(finalize, file_id).code == 200);

    crow::request download;
    download.url = "/files/" + std::to_string(file_id) + "/download";
    download.add_header("Authorization", "Bearer " + token);
    const auto metadata = router.handle_download_file(download, file_id);
    REQUIRE(metadata.code == 200);
    const auto metadata_json = crow::json::load(metadata.body);
    REQUIRE(metadata_json["external_file_id"].s() == "external-google-id");

    REQUIRE(router.handle_finalize_external_upload(finalize, file_id).code == 409);
}

TEST_CASE("B.48 Google batch allocation is request-local and capacity-aware",
          "[api][upload][batch][googledrive][b48]") {
    set_test_environment("GOOGLE_CLIENT_ID", "mock_client_id");
    set_test_environment("GOOGLE_CLIENT_SECRET", "mock_client_secret");

    DatabasePool pool(2, get_secure_conn_string());
    MockEmailService mock_email;
    AuthService auth("B48BatchSecret", "b48_batch_salt", &mock_email);
    FolderManager folder_mgr(pool);
    FileManager file_mgr(pool);
    FileChunker chunker("test_b48_batch_chunks_dir");
    MockGoogleDriveService gdrive(pool);
    gdrive.numbered_folder_ids = true;

    const uint64_t user_id = 9848;
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM files WHERE user_id=$1", pqxx::params{user_id});
        txn.exec("DELETE FROM folders WHERE user_id=$1", pqxx::params{user_id});
        txn.exec("DELETE FROM user_external_storages WHERE user_id=$1", pqxx::params{user_id});
        txn.exec("DELETE FROM users WHERE id=$1", pqxx::params{user_id});
        txn.exec("INSERT INTO users(id,username,email,password_hash,is_email_verified,max_storage_bytes) "
                 "VALUES($1,'b48-batch-user','b48-batch@test.com','hash',TRUE,100000000)",
                 pqxx::params{user_id});
        txn.commit();
    }

    struct Cleanup {
        DatabasePool& pool;
        uint64_t user_id;
        ~Cleanup() {
            try {
                auto conn = pool.acquire_connection();
                pqxx::work txn(*conn);
                txn.exec("DELETE FROM files WHERE user_id=$1", pqxx::params{user_id});
                txn.exec("DELETE FROM folders WHERE user_id=$1", pqxx::params{user_id});
                txn.exec("DELETE FROM user_external_storages WHERE user_id=$1", pqxx::params{user_id});
                txn.exec("DELETE FROM users WHERE id=$1", pqxx::params{user_id});
                txn.commit();
            } catch (...) {}
        }
    } cleanup{pool, user_id};

    gdrive.mock_account_email = "b48-first@test.com";
    REQUIRE_NOTHROW(gdrive.link_account(user_id, "code-first", gdrive.generate_test_state(user_id)));
    gdrive.mock_account_email = "b48-second@test.com";
    REQUIRE_NOTHROW(gdrive.link_account(user_id, "code-second", gdrive.generate_test_state(user_id)));
    const auto accounts = gdrive.get_linked_accounts(user_id);
    REQUIRE(accounts.size() == 2);

    ApiRouter router(pool, auth, folder_mgr, &file_mgr, &chunker, &gdrive);
    const auto token = auth.generate_token(user_id);
    const auto quota = [](uint64_t free_bytes) {
        return std::string(R"({"storageQuota":{"limit":")")
            + std::to_string(free_bytes) + R"(","usage":"0"}})";
    };
    const auto request = [&](std::vector<crow::json::wvalue> items) {
        crow::request req;
        req.url = "/files/batch-init";
        req.method = crow::HTTPMethod::Post;
        req.add_header("Authorization", "Bearer " + token);
        crow::json::wvalue body;
        body["files"] = std::move(items);
        req.body = body.dump();
        return router.handle_batch_init_uploads(req);
    };

    gdrive.set_quota_response_sequence({{200, quota(4)}, {200, quota(4)}});
    crow::json::wvalue too_large;
    too_large["client_ref"] = "too-large";
    too_large["encrypted_name"] = "too-large-name";
    too_large["name_hash"] = "too-large-hash";
    too_large["encrypted_fdk"] = "too-large-fdk";
    too_large["size_bytes"] = 6;
    too_large["storage_provider"] = "google_drive";
    const auto rejected = request({std::move(too_large)});
    REQUIRE(rejected.code == 507);
    {
        auto conn = pool.acquire_connection();
        pqxx::nontransaction txn(*conn);
        REQUIRE(txn.exec("SELECT count(*) FROM files WHERE user_id=$1", pqxx::params{user_id})[0][0].as<int>() == 0);
    }

    uint64_t folder_a = 0;
    uint64_t folder_b = 0;
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        folder_a = txn.exec("INSERT INTO folders(user_id,encrypted_name,name_hash) VALUES($1,'folder-a','folder-a-hash') RETURNING id",
                            pqxx::params{user_id})[0][0].as<uint64_t>();
        folder_b = txn.exec("INSERT INTO folders(user_id,encrypted_name,name_hash) VALUES($1,'folder-b','folder-b-hash') RETURNING id",
                            pqxx::params{user_id})[0][0].as<uint64_t>();
        txn.commit();
    }

    gdrive.set_quota_response_sequence({{200, quota(4)}, {200, quota(4)}});
    auto make_file = [](const std::string& client_ref, uint64_t folder_id) {
        crow::json::wvalue file;
        file["client_ref"] = client_ref;
        file["folder_id"] = folder_id;
        file["encrypted_name"] = client_ref + "-name";
        file["name_hash"] = "same-google-hash";
        file["encrypted_fdk"] = client_ref + "-fdk";
        file["size_bytes"] = 4;
        file["storage_provider"] = "google_drive";
        return file;
    };
    const auto accepted = request({make_file("google-a", folder_a), make_file("google-b", folder_b)});
    REQUIRE(accepted.code == 201);
    auto accepted_json = crow::json::load(accepted.body);
    REQUIRE(accepted_json);
    auto accepted_files = accepted_json["files"];
    const auto accepted_items = accepted_files.lo();
    REQUIRE(accepted_items.size() == 2);
    std::map<std::string, uint64_t> file_ids_by_ref;
    for (const auto& item : accepted_items) {
        REQUIRE(item.has("client_ref"));
        const auto ref = item["client_ref"].s();
        file_ids_by_ref[ref] = item["file_id"].i();
    }
    for (const auto& item : accepted_items) {
        REQUIRE_FALSE(item.has("access_token"));
        REQUIRE_FALSE(item.has("root_folder_id"));
    }
    REQUIRE(gdrive.quota_requests.load() == 2);
    {
        auto conn = pool.acquire_connection();
        pqxx::nontransaction txn(*conn);
        for (const auto& [ref, expected_storage] : std::map<std::string, uint64_t>{
                 {"google-a", accounts[0].id}, {"google-b", accounts[1].id}}) {
            const auto row = txn.exec(
                "SELECT external_storage_id FROM files WHERE id=$1 AND user_id=$2 AND name_hash='same-google-hash'",
                pqxx::params{file_ids_by_ref[ref], user_id});
            REQUIRE(row.size() == 1);
            REQUIRE(row[0][0].as<uint64_t>() == expected_storage);
        }
    }

    gdrive.set_quota_response_sequence({{500, "{}"}, {200, quota(4)}});
    auto fallback = make_file("provider-fallback", folder_a);
    fallback["name_hash"] = "fallback-hash";
    const auto fallback_response = request({std::move(fallback)});
    REQUIRE(fallback_response.code == 201);
    auto fallback_json = crow::json::load(fallback_response.body);
    REQUIRE_FALSE(fallback_json["files"][0].has("access_token"));
    REQUIRE_FALSE(fallback_json["files"][0].has("root_folder_id"));
    {
        auto conn = pool.acquire_connection();
        pqxx::nontransaction txn(*conn);
        const auto storage = txn.exec(
            "SELECT external_storage_id FROM files WHERE user_id=$1 AND name_hash='fallback-hash'",
            pqxx::params{user_id});
        REQUIRE(storage.size() == 1);
        REQUIRE(storage[0][0].as<uint64_t>() == accounts[1].id);
    }

    gdrive.set_quota_response_sequence({{200, quota(0)}, {200, quota(0)}});
    auto zero_capacity = make_file("zero-capacity", folder_a);
    zero_capacity["name_hash"] = "zero-capacity-hash";
    const auto zero_response = request({std::move(zero_capacity)});
    REQUIRE(zero_response.code == 507);
    {
        auto conn = pool.acquire_connection();
        pqxx::nontransaction txn(*conn);
        REQUIRE(txn.exec("SELECT count(*) FROM files WHERE user_id=$1 AND name_hash='zero-capacity-hash'",
                         pqxx::params{user_id})[0][0].as<int>() == 0);
    }

    const auto used_before_cumulative = [&] {
        auto conn = pool.acquire_connection();
        pqxx::nontransaction txn(*conn);
        return txn.exec("SELECT used_storage_bytes FROM users WHERE id=$1", pqxx::params{user_id})[0][0].as<uint64_t>();
    }();
    gdrive.set_quota_response_sequence({{200, quota(6)}, {200, quota(0)}});
    auto cumulative_a = make_file("cumulative-a", folder_a);
    cumulative_a["name_hash"] = "cumulative-a-hash";
    auto cumulative_b = make_file("cumulative-b", folder_b);
    cumulative_b["name_hash"] = "cumulative-b-hash";
    const auto cumulative_rejected = request({std::move(cumulative_a), std::move(cumulative_b)});
    REQUIRE(cumulative_rejected.code == 507);
    {
        auto conn = pool.acquire_connection();
        pqxx::nontransaction txn(*conn);
        REQUIRE(txn.exec(
                    "SELECT count(*) FROM files WHERE user_id=$1 AND name_hash IN ('cumulative-a-hash','cumulative-b-hash')",
                    pqxx::params{user_id})[0][0].as<int>() == 0);
        REQUIRE(txn.exec("SELECT used_storage_bytes FROM users WHERE id=$1", pqxx::params{user_id})[0][0].as<uint64_t>() == used_before_cumulative);
    }
    REQUIRE(gdrive.quota_requests.load() == 2);
}
