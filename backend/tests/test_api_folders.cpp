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
    AuthService auth("I_dont_here_to_talk", "Tive_receio_de_ser_eu");
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

    std::string valid_token = auth.generate_token(static_cast<uint64_t>(fake_user_id));

    SECTION("Criar Pasta Raiz") {
        crow::request req;
        req.add_header("Authorization", "Bearer " + valid_token);
        req.body = R"({"encrypted_name": "base64_fake_text_1", "name_hash": "hash_fake_1"})";

        crow::response res = router.handle_create_folder(req);

        REQUIRE(res.code == 201);
        REQUIRE(res.body.find("folder_id") != std::string::npos);
    }

    SECTION("Criar Subpasta") {
        crow::request req;
        req.add_header("Authorization", "Bearer " + valid_token);
        req.body = R"({"encrypted_name": "base64_fake_text_1", "name_hash": "hash_fake_2"})";
        crow::response res_pai = router.handle_create_folder(req);
        REQUIRE(res_pai.code == 201);

        auto pai_body = crow::json::load(res_pai.body);
        int parent_id = pai_body["folder_id"].i();

        crow::request req2;
        req2.add_header("Authorization", "Bearer " + valid_token);
        req2.body = R"({"encrypted_name": "base64_fake_text_2", "name_hash": "hash_fake_3", "parent_id": )"
                  + std::to_string(parent_id) + "}";

        crow::response res2 = router.handle_create_folder(req2);

        REQUIRE(res2.code == 201);
    }

    SECTION("Conflito - Pasta Duplicada") {
        crow::request req;
        req.add_header("Authorization", "Bearer " + valid_token);
        req.body = R"({"encrypted_name": "base64_fake_text_3", "name_hash": "hash_fake_conflict"})";

        crow::response res1 = router.handle_create_folder(req);
        REQUIRE(res1.code == 201);

        crow::response res2 = router.handle_create_folder(req);
        REQUIRE(res2.code == 409);
        REQUIRE(res2.body.find("error") != std::string::npos);
    }

    SECTION("Sem Token - Deve retornar 401") {
        crow::request req;
        req.body = R"({"encrypted_name": "base64_fake_text_4", "name_hash": "hash_fake_4"})";

        crow::response res = router.handle_create_folder(req);

        REQUIRE(res.code == 401);
        REQUIRE(res.body.find("error") != std::string::npos);
    }

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username = 'folder_test_ghost'");
        txn.commit();
    }

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
}
