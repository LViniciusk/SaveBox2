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

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username IN ('" + test_username_1 + "', '" + test_username_2 + "')");
        txn.commit();
    }
}