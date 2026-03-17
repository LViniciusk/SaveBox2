#include <catch2/catch_test_macros.hpp>
#include "controllers/ApiRouter.hpp"
#include "database/DatabasePool.hpp"
#include "services/AuthService.hpp"
#include "database/FolderManager.hpp"
#include "test_helpers.hpp"
#include <crow_all.h>

TEST_CASE("API de Pastas - Criação", "[api][folders]") {
    std::string conn_str = get_secure_conn_string();
    DatabasePool pool(2, conn_str);
    AuthService auth("uma_pimenta_secreta_muito_longa_e_aleatoria_aqui");
    FolderManager folder_mgr(pool);

    ApiRouter router(pool, auth, folder_mgr);

    int fake_user_id = 0;
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username = 'folder_test_ghost'");
        auto result = txn.exec(
            "INSERT INTO users (username, password_hash) VALUES ('folder_test_ghost', 'hash_fake') RETURNING id"
        );
        fake_user_id = result[0][0].as<int>();
        txn.commit();
    }

    SECTION("Criar Pasta Raiz") {
        crow::request req;
        req.body = R"({"user_id": )" + std::to_string(fake_user_id)
                 + R"(, "encrypted_name": "base64_fake_text_1", "name_hash": "hash_fake_1"})";

        crow::response res = router.handle_create_folder(req);

        REQUIRE(res.code == 201);
        REQUIRE(res.body.find("folder_id") != std::string::npos);
    }

    SECTION("Criar Subpasta") {
        crow::request req;
        req.body = R"({"user_id": )" + std::to_string(fake_user_id)
                 + R"(, "encrypted_name": "base64_fake_text_1", "name_hash": "hash_fake_2"})";
        crow::response res_pai = router.handle_create_folder(req);
        REQUIRE(res_pai.code == 201);

        auto pai_body = crow::json::load(res_pai.body);
        int parent_id = pai_body["folder_id"].i();

        crow::request req2;
        req2.body = R"({"user_id": )" + std::to_string(fake_user_id)
                  + R"(, "encrypted_name": "base64_fake_text_2", "name_hash": "hash_fake_3", "parent_id": )"
                  + std::to_string(parent_id) + "}";

        crow::response res2 = router.handle_create_folder(req2);

        REQUIRE(res2.code == 201);
    }
    SECTION("Conflito - Pasta Duplicada") {
        crow::request req;
        req.body = R"({"user_id": )" + std::to_string(fake_user_id)
                 + R"(, "encrypted_name": "base64_fake_text_3", "name_hash": "hash_fake_conflict"})";
        
        crow::response res1 = router.handle_create_folder(req);
        REQUIRE(res1.code == 201);

        crow::response res2 = router.handle_create_folder(req);
        REQUIRE(res2.code == 409);
        REQUIRE(res2.body.find("error") != std::string::npos);
    }

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username = 'folder_test_ghost'");
        txn.commit();
    }
}
