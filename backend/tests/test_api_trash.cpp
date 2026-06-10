#include <catch2/catch_test_macros.hpp>
#include "controllers/ApiRouter.hpp"
#include "database/DatabasePool.hpp"
#include "Services/AuthService.hpp"
#include "database/FolderManager.hpp"
#include "database/FileManager.hpp"
#include "test_helpers.hpp"
#include <crow_all.h>




TEST_CASE("API de Lixeira (Soft Delete)", "[api][trash]") {
    std::string conn_str = get_secure_conn_string();
    DatabasePool pool(2, conn_str);
    MockEmailService mock_email;
    AuthService auth("Tô_aqui_pra_te_mandar_a_primeira_mensagem_de_hoje", "coincidencia_foi_pra_ti_a_ultima_de_ontem", &mock_email);
    FolderManager folder_mgr(pool);
    FileManager file_mgr(pool);

    ApiRouter router(pool, auth, folder_mgr, &file_mgr);

    std::string test_username_1 = "trash_user_1_" + std::to_string(rand());
    std::string test_username_2 = "trash_user_2_" + std::to_string(rand());
    int fake_user_id = 0;
    int other_user_id = 0;
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        
        txn.exec("DELETE FROM users WHERE username LIKE 'trash_user_%'");

        auto res1 = txn.exec(
            "INSERT INTO users (username, email, password_hash, is_email_verified) VALUES ('" + test_username_1 + "', '" + test_username_1 + "@test.com', 'hash_1', true) RETURNING id"
        );
        fake_user_id = res1[0][0].as<int>();

        auto res2 = txn.exec(
            "INSERT INTO users (username, email, password_hash, is_email_verified) VALUES ('" + test_username_2 + "', '" + test_username_2 + "@test.com', 'hash_2', true) RETURNING id"
        );
        other_user_id = res2[0][0].as<int>();
        
        txn.commit();
    }

    std::string valid_token = auth.generate_token(static_cast<uint64_t>(fake_user_id));
    std::string other_token = auth.generate_token(static_cast<uint64_t>(other_user_id));

    auto create_test_folder = [&](int user_id, const std::string& token, int parent_id = -1) -> int {
        crow::request req;
        req.add_header("Authorization", "Bearer " + token);
        std::string unique_hash = "hash_x_" + std::to_string(rand());
        if (parent_id == -1) {
            req.body = R"({"encrypted_name": "folder_x", "name_hash": ")" + unique_hash + R"("})";
        } else {
            req.body = R"({"encrypted_name": "folder_x", "name_hash": ")" + unique_hash + R"(", "parent_id": )" + std::to_string(parent_id) + "}";
        }
        crow::response res = router.handle_create_folder(req);
        if (res.code == 201) {
            auto body = crow::json::load(res.body);
            return body["id"].i();
        }
        return -1;
    };

    SECTION("1. Basic Soft Delete (Files & Folders)") {
        int folder_id = create_test_folder(fake_user_id, valid_token);
        REQUIRE(folder_id != -1);

        crow::request trash_req;
        trash_req.add_header("Authorization", "Bearer " + valid_token);
        
        crow::response trash_res = router.handle_trash_folder(trash_req, folder_id);
        REQUIRE(trash_res.code == 200);

        crow::request list_req;
        list_req.add_header("Authorization", "Bearer " + valid_token);
        crow::response list_res = router.handle_get_tree(list_req);
        REQUIRE(list_res.code == 200);
        REQUIRE(list_res.body.find(std::to_string(folder_id)) == std::string::npos);
    }

    SECTION("2. State Isolation (Trash Security)") {
        int folder_id = create_test_folder(fake_user_id, valid_token);
        
        crow::request trash_req;
        trash_req.add_header("Authorization", "Bearer " + valid_token);
        router.handle_trash_folder(trash_req, folder_id);

        crow::request trash_list_req;
        trash_list_req.add_header("Authorization", "Bearer " + valid_token);
        crow::response list_res = router.handle_get_trash(trash_list_req);


        REQUIRE(list_res.code == 200);
        REQUIRE(list_res.body.find(std::to_string(folder_id)) != std::string::npos);
    }

    SECTION("3. Restoration (Restore)") {
        int folder_id = create_test_folder(fake_user_id, valid_token);
        
        crow::request trash_req;
        trash_req.add_header("Authorization", "Bearer " + valid_token);
        router.handle_trash_folder(trash_req, folder_id);

        crow::request restore_req;
        restore_req.add_header("Authorization", "Bearer " + valid_token);
        crow::response restore_res = router.handle_restore_folder(restore_req, folder_id);
        REQUIRE(restore_res.code == 200);


        crow::request list_req;
        list_req.add_header("Authorization", "Bearer " + valid_token);
        crow::response list_res = router.handle_get_tree(list_req);
        REQUIRE(list_res.body.find(std::to_string(folder_id)) != std::string::npos);
    }

    SECTION("4. Cascaded Soft Delete") {
        int parent_id = create_test_folder(fake_user_id, valid_token);
        int child_id = create_test_folder(fake_user_id, valid_token, parent_id);

        crow::request trash_req;
        trash_req.add_header("Authorization", "Bearer " + valid_token);
        crow::response trash_res = router.handle_trash_folder(trash_req, parent_id);
        REQUIRE(trash_res.code == 200);


        crow::request trash_list_req;
        trash_list_req.add_header("Authorization", "Bearer " + valid_token);
        crow::response list_res = router.handle_get_trash(trash_list_req);
        REQUIRE(list_res.body.find(std::to_string(parent_id)) != std::string::npos);
    }

    SECTION("5. Hard Delete (Empty Trash)") {
        int folder_id = create_test_folder(fake_user_id, valid_token);
        
        crow::request trash_req;
        trash_req.add_header("Authorization", "Bearer " + valid_token);
        router.handle_trash_folder(trash_req, folder_id);


        crow::request empty_req;
        empty_req.add_header("Authorization", "Bearer " + valid_token);
        crow::response empty_res = router.handle_empty_trash(empty_req);
        REQUIRE(empty_res.code == 200);


        crow::request get_trash_req;
        get_trash_req.add_header("Authorization", "Bearer " + valid_token);
        crow::response trash_res = router.handle_get_trash(get_trash_req);
        REQUIRE(trash_res.body.find(std::to_string(folder_id)) == std::string::npos);
    }

    SECTION("6. Security and IDOR in Trash") {
        int folder_id = create_test_folder(fake_user_id, valid_token);
        

        crow::request bad_trash_req;
        bad_trash_req.add_header("Authorization", "Bearer " + other_token);
        crow::response trash_res = router.handle_trash_folder(bad_trash_req, folder_id);
        REQUIRE((trash_res.code == 403 || trash_res.code == 404));


        crow::request trash_req;
        trash_req.add_header("Authorization", "Bearer " + valid_token);
        router.handle_trash_folder(trash_req, folder_id);


        crow::request bad_restore_req;
        bad_restore_req.add_header("Authorization", "Bearer " + other_token);
        crow::response restore_res = router.handle_restore_folder(bad_restore_req, folder_id);
        REQUIRE((restore_res.code == 403 || restore_res.code == 404));
    }

    SECTION("7. Edge Case - Restored Item Collision") {
        crow::request req_create_a;
        req_create_a.add_header("Authorization", "Bearer " + valid_token);
        req_create_a.body = R"({"folder_id": null, "encrypted_name": "enc_file_a", "name_hash": "hash_a", "encrypted_fdk": "mock_encrypted_fdk", "size_bytes": 100, "total_chunks": 1})";
        crow::response res_create_a = router.handle_init_file_upload(req_create_a);
        REQUIRE(res_create_a.code == 201);
        int file_a_id = crow::json::load(res_create_a.body)["file_id"].i();

        crow::request req_trash_a;
        req_trash_a.add_header("Authorization", "Bearer " + valid_token);
        crow::response res_trash_a = router.handle_trash_file(req_trash_a, file_a_id);
        REQUIRE(res_trash_a.code == 200);

        crow::response res_create_a2 = router.handle_init_file_upload(req_create_a);
        REQUIRE(res_create_a2.code == 201);
        
        crow::request req_restore_a;
        req_restore_a.add_header("Authorization", "Bearer " + valid_token);
        crow::response res_restore_a = router.handle_restore_file(req_restore_a, file_a_id);
        REQUIRE(res_restore_a.code == 409);
        REQUIRE(res_restore_a.body.find("Item ja existe no destino") != std::string::npos);

        crow::request req_create_folder_a;
        req_create_folder_a.add_header("Authorization", "Bearer " + valid_token);
        req_create_folder_a.body = R"({"parent_id": null, "encrypted_name": "enc_folder_a", "name_hash": "folder_hash_a"})";
        crow::response res_create_folder_a = router.handle_create_folder(req_create_folder_a);
        REQUIRE(res_create_folder_a.code == 201);
        int folder_a_id = crow::json::load(res_create_folder_a.body)["id"].i();

        crow::request req_trash_folder_a;
        req_trash_folder_a.add_header("Authorization", "Bearer " + valid_token);
        crow::response res_trash_folder_a = router.handle_trash_folder(req_trash_folder_a, folder_a_id);
        REQUIRE(res_trash_folder_a.code == 200);

        crow::response res_create_folder_a2 = router.handle_create_folder(req_create_folder_a);
        REQUIRE(res_create_folder_a2.code == 201);

        crow::request req_restore_folder_a;
        req_restore_folder_a.add_header("Authorization", "Bearer " + valid_token);
        crow::response res_restore_folder_a = router.handle_restore_folder(req_restore_folder_a, folder_a_id);
        REQUIRE(res_restore_folder_a.code == 409);
        REQUIRE(res_restore_folder_a.body.find("Item ja existe no destino") != std::string::npos);
    }

    SECTION("8. Restore Limbo Prevention - Ficheiro cuja pasta-mãe foi apagada volta à raiz") {
        int folder_id = create_test_folder(fake_user_id, valid_token);
        REQUIRE(folder_id != -1);

        int file_id = 0;
        {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            auto res = txn.exec(
                "INSERT INTO files (user_id, folder_id, encrypted_name, name_hash, encrypted_fdk, size_bytes, total_chunks, is_upload_complete) "
                "VALUES ($1, $2, 'enc_file_b', 'hash_b', 'mock_encrypted_fdk', 100, 1, true) RETURNING id",
                pqxx::params{fake_user_id, folder_id}
            );
            file_id = res[0][0].as<int>();
            txn.commit();
        }

        crow::request req_trash_folder;
        req_trash_folder.add_header("Authorization", "Bearer " + valid_token);
        crow::response res_trash_folder = router.handle_trash_folder(req_trash_folder, folder_id);
        REQUIRE(res_trash_folder.code == 200);

        crow::request req_restore_file;
        req_restore_file.add_header("Authorization", "Bearer " + valid_token);
        crow::response res_restore_file = router.handle_restore_file(req_restore_file, file_id);
        REQUIRE(res_restore_file.code == 200);

        crow::request req_tree;
        req_tree.add_header("Authorization", "Bearer " + valid_token);
        crow::response res_tree = router.handle_get_tree(req_tree);
        REQUIRE(res_tree.code == 200);
        
        auto tree_body = crow::json::load(res_tree.body);
        bool found_in_root = false;
        for (const auto& file : tree_body["files"]) {
            if (file["id"].i() == file_id && file["folder_id"].t() == crow::json::type::Null) {
                found_in_root = true;
                break;
            }
        }
        REQUIRE(found_in_root == true);
    }

    SECTION("9. IDOR e JWT Signature Tampering") {
        int folder_id = create_test_folder(fake_user_id, valid_token);

        std::string tampered_token = valid_token;
        size_t dot_pos = tampered_token.find('.');
        if (dot_pos != std::string::npos && dot_pos + 5 < tampered_token.length()) {
            tampered_token[dot_pos + 5] = tampered_token[dot_pos + 5] == 'A' ? 'B' : 'A';
        }
        
        crow::request req_tampered;
        req_tampered.add_header("Authorization", "Bearer " + tampered_token);
        crow::response res_tampered = router.handle_trash_folder(req_tampered, folder_id);
        REQUIRE(res_tampered.code == 401);

        std::string other_token = auth.generate_token(static_cast<uint64_t>(other_user_id));
        crow::request req_idor;
        req_idor.add_header("Authorization", "Bearer " + other_token);
        crow::response res_idor = router.handle_trash_folder(req_idor, folder_id);
        REQUIRE(res_idor.code == 404); 

        crow::request req_legit;
        req_legit.add_header("Authorization", "Bearer " + valid_token);
        crow::response res_legit = router.handle_trash_folder(req_legit, folder_id);
        REQUIRE(res_legit.code == 200);

        crow::request req_idor_restore;
        req_idor_restore.add_header("Authorization", "Bearer " + other_token);
        crow::response res_idor_restore = router.handle_restore_folder(req_idor_restore, folder_id);
        REQUIRE(res_idor_restore.code == 404);
    }

    SECTION("10. Batch Hard Delete") {
        int file1_id = 0, file2_id = 0, file3_id = 0;
        {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            auto res1 = txn.exec(
                "INSERT INTO files (user_id, folder_id, encrypted_name, name_hash, encrypted_fdk, size_bytes, total_chunks, is_upload_complete, deleted_at) "
                "VALUES ($1, NULL, 'enc_file_b1', 'hash_b1', 'mock_encrypted_fdk', 100, 1, true, NOW()) RETURNING id",
                pqxx::params{fake_user_id}
            );
            file1_id = res1[0][0].as<int>();

            auto res2 = txn.exec(
                "INSERT INTO files (user_id, folder_id, encrypted_name, name_hash, encrypted_fdk, size_bytes, total_chunks, is_upload_complete, deleted_at) "
                "VALUES ($1, NULL, 'enc_file_b2', 'hash_b2', 'mock_encrypted_fdk', 200, 1, true, NOW()) RETURNING id",
                pqxx::params{fake_user_id}
            );
            file2_id = res2[0][0].as<int>();
            
            auto res3 = txn.exec(
                "INSERT INTO files (user_id, folder_id, encrypted_name, name_hash, encrypted_fdk, size_bytes, total_chunks, is_upload_complete, deleted_at) "
                "VALUES ($1, NULL, 'enc_file_b3', 'hash_b3', 'mock_encrypted_fdk', 300, 1, true, NULL) RETURNING id",
                pqxx::params{fake_user_id}
            );
            file3_id = res3[0][0].as<int>();

            txn.commit();
        }

        // Test normal batch hard delete
        crow::request req;
        req.url = "/trash/files/batch-delete";
        req.method = crow::HTTPMethod::Delete;
        req.add_header("Authorization", "Bearer " + valid_token);
        
        crow::json::wvalue req_body;
        req_body["file_ids"] = std::vector<int>{file1_id, file2_id, file3_id};
        req.body = req_body.dump();
        
        crow::response res = router.handle_batch_hard_delete(req);
        REQUIRE(res.code == 200);
        auto body = crow::json::load(res.body);
        REQUIRE(body["deleted_count"].i() == 2); // Only file1 and file2 are in trash

        // Verification
        {
            auto conn = pool.acquire_connection();
            pqxx::nontransaction txn(*conn);
            auto count = txn.exec("SELECT COUNT(*) FROM files WHERE id IN (" + std::to_string(file1_id) + "," + std::to_string(file2_id) + ")");
            REQUIRE(count[0][0].as<int>() == 0); // Both hard deleted

            auto count3 = txn.exec("SELECT COUNT(*) FROM files WHERE id = " + std::to_string(file3_id));
            REQUIRE(count3[0][0].as<int>() == 1); // Not deleted because not in trash
        }
        
        // Anti-DoS Limits
        std::vector<int> massive_ids;
        for(int i = 0; i < 101; i++) massive_ids.push_back(i);
        
        crow::json::wvalue req_dos_body;
        req_dos_body["file_ids"] = massive_ids;
        req.body = req_dos_body.dump();
        crow::response res_dos = router.handle_batch_hard_delete(req);
        REQUIRE(res_dos.code == 400);
        
        // IDOR Test
        crow::request req_idor;
        req_idor.url = "/trash/files/batch-delete";
        req_idor.method = crow::HTTPMethod::Delete;
        req_idor.add_header("Authorization", "Bearer " + other_token);
        
        crow::json::wvalue req_idor_body;
        req_idor_body["file_ids"] = std::vector<int>{file3_id};
        req_idor.body = req_idor_body.dump();
        
        crow::response res_idor = router.handle_batch_hard_delete(req_idor);
        REQUIRE(res_idor.code == 200);
        REQUIRE(crow::json::load(res_idor.body)["deleted_count"].i() == 0); // Should delete 0 since file3 belongs to fake_user_id
    }

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username IN ('" + test_username_1 + "', '" + test_username_2 + "')");
        txn.commit();
    }
}