#include <catch2/catch_test_macros.hpp>
#include "controllers/ApiRouter.hpp"
#include "database/DatabasePool.hpp"
#include "services/AuthService.hpp"
#include "database/FolderManager.hpp"
#include "test_helpers.hpp"
#include <crow_all.h>




TEST_CASE("API de Autenticação - Registro e Login", "[api][auth]") {
    std::string conn_str = get_secure_conn_string();
    DatabasePool pool(2, conn_str);
    AuthService auth("Lords_do_Underground", "A_flor");
    FolderManager folder_mgr(pool);
    ApiRouter router(pool, auth, folder_mgr);

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username = 'api_test_user'");
        txn.commit();
    }

    SECTION("Registro de Usuário - handle_register") {
        crow::request req;
        req.body = R"({"username": "api_test_user", "password": "super_senha"})";

        crow::response res = router.handle_register(req);

        REQUIRE(res.code == 201);
        REQUIRE(res.body.find("Usuario criado") != std::string::npos);
    }

    SECTION("Tratamento de Conflito - Usuário Duplicado") {
        crow::request req;
        req.body = R"({"username": "api_test_user", "password": "super_senha"})";

        router.handle_register(req);

        crow::response res = router.handle_register(req);

        REQUIRE(res.code == 409);
    }

    SECTION("Login com Sucesso - handle_login") {
        crow::request req;
        req.body = R"({"username": "api_test_user", "password": "super_senha"})";

        router.handle_register(req);

        crow::response res = router.handle_login(req);

        REQUIRE(res.code == 200);
        REQUIRE(res.body.find("Login efetuado") != std::string::npos);
        REQUIRE(res.body.find("token") != std::string::npos);
    }

    SECTION("Login com Senha Errada") {
        crow::request req;
        req.body = R"({"username": "api_test_user", "password": "super_senha"})";

        router.handle_register(req);

        req.body = R"({"username": "api_test_user", "password": "senha_errada"})";
        crow::response res = router.handle_login(req);

        REQUIRE(res.code == 401);
    }

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username = 'api_test_user'");
        txn.commit();
    }
}
