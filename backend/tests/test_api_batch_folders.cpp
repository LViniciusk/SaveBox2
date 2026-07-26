#include <catch2/catch_test_macros.hpp>
#include "controllers/ApiRouter.hpp"
#include "database/DatabasePool.hpp"
#include "Services/AuthService.hpp"
#include "database/FolderManager.hpp"
#include "test_helpers.hpp"
#include <pqxx/pqxx>
#include <string>

namespace {

crow::response send_batch(ApiRouter& router, const std::string& token, const std::string& body) {
    crow::request request;
    request.url = "/folders/batch-create";
    request.method = crow::HTTPMethod::Post;
    request.add_header("Authorization", "Bearer " + token);
    request.body = body;
    return router.handle_batch_create_folders(request);
}

}

TEST_CASE("API de pastas em lote - hierarquia e merge", "[api][folders][batch]") {
    DatabasePool pool(2, get_secure_conn_string());
    MockEmailService email;
    AuthService auth("BatchFoldersSecret", "BatchFoldersSalt", &email);
    FolderManager folders(pool);
    ApiRouter router(pool, auth, folders);

    const auto suffix = std::to_string(rand());
    const auto username = "batch_folders_" + suffix;
    const auto email_address = username + "@test.com";
    uint64_t user_id = 0;
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        user_id = txn.exec(
            "INSERT INTO users (username, email, password_hash, is_email_verified) VALUES ($1, $2, 'hash', true) RETURNING id",
            pqxx::params{username, email_address}
        )[0][0].as<uint64_t>();
        txn.commit();
    }
    const auto token = auth.generate_token(user_id);

    SECTION("aceita filho antes do pai e devolve referencias opacas") {
        const auto response = send_batch(router, token, R"({
          "root_parent_id": null,
          "folders": [
            {"client_ref":"child-1","parent_client_ref":"parent-1","encrypted_name":"child-cipher","name_hash":"child-hash"},
            {"client_ref":"parent-1","parent_client_ref":null,"encrypted_name":"parent-cipher","name_hash":"parent-hash"}
          ]
        })");

        REQUIRE(response.code == 200);
        const auto body = crow::json::load(response.body);
        REQUIRE(body["folders"].size() == 2);
        REQUIRE(body["folders"][0]["client_ref"].s() == "child-1");
        REQUIRE(body["folders"][1]["client_ref"].s() == "parent-1");
        REQUIRE(body["folders"][0]["created"].b());
        REQUIRE(body["folders"][1]["created"].b());

        auto conn = pool.acquire_connection();
        pqxx::nontransaction query(*conn);
        const auto row = query.exec(
            "SELECT child.id, child.parent_id FROM folders child JOIN folders parent ON parent.id = child.parent_id "
            "WHERE child.user_id = $1 AND child.name_hash = 'child-hash' AND parent.name_hash = 'parent-hash'",
            pqxx::params{user_id}
        );
        REQUIRE(row.size() == 1);
        REQUIRE(row[0][0].as<uint64_t>() > 0);
        REQUIRE(row[0][1].as<uint64_t>() > 0);
    }

    SECTION("reutiliza pasta ativa sem alterar ciphertext") {
        const auto first = send_batch(router, token, R"({
          "root_parent_id":null,
          "folders":[{"client_ref":"first","parent_client_ref":null,"encrypted_name":"original-cipher","name_hash":"merge-hash"}]
        })");
        REQUIRE(first.code == 200);
        const auto first_id = crow::json::load(first.body)["folders"][0]["folder_id"].i();

        const auto second = send_batch(router, token, R"({
          "root_parent_id":null,
          "folders":[{"client_ref":"different-ref","parent_client_ref":null,"encrypted_name":"new-cipher","name_hash":"merge-hash"}]
        })");
        REQUIRE(second.code == 200);
        const auto item = crow::json::load(second.body)["folders"][0];
        REQUIRE(item["folder_id"].i() == first_id);
        REQUIRE_FALSE(item["created"].b());

        auto conn = pool.acquire_connection();
        pqxx::nontransaction query(*conn);
        const auto row = query.exec("SELECT encrypted_name FROM folders WHERE id = $1", pqxx::params{first_id});
        REQUIRE(row[0][0].as<std::string>() == "original-cipher");
    }

    SECTION("rejeita colisao logica, referencia desconhecida, ciclo e caminho") {
        REQUIRE(send_batch(router, token, R"({
          "root_parent_id":null,
          "folders":[
            {"client_ref":"same-a","parent_client_ref":null,"encrypted_name":"a","name_hash":"same-hash"},
            {"client_ref":"same-b","parent_client_ref":null,"encrypted_name":"b","name_hash":"same-hash"}
          ]
        })").code == 400);

        REQUIRE(send_batch(router, token, R"({
          "root_parent_id":null,
          "folders":[{"client_ref":"child","parent_client_ref":"missing","encrypted_name":"c","name_hash":"c-hash"}]
        })").code == 400);

        REQUIRE(send_batch(router, token, R"({
          "root_parent_id":null,
          "folders":[
            {"client_ref":"a","parent_client_ref":"b","encrypted_name":"a","name_hash":"a-hash"},
            {"client_ref":"b","parent_client_ref":"a","encrypted_name":"b","name_hash":"b-hash"}
          ]
        })").code == 400);

        REQUIRE(send_batch(router, token, R"({
          "root_parent_id":null,
          "folders":[{"client_ref":"Projeto/docs","parent_client_ref":null,"encrypted_name":"c","name_hash":"path-hash"}]
        })").code == 400);
    }

    SECTION("valida pai raiz, IDOR e soft delete") {
        const auto other_username = username + "_other";
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        const auto other_id = txn.exec(
            "INSERT INTO users (username, email, password_hash, is_email_verified) VALUES ($1, $2, 'hash', true) RETURNING id",
            pqxx::params{other_username, other_username + "@test.com"}
        )[0][0].as<uint64_t>();
        const auto other_folder = txn.exec(
            "INSERT INTO folders (user_id, encrypted_name, name_hash) VALUES ($1, 'other-cipher', 'other-hash') RETURNING id",
            pqxx::params{other_id}
        )[0][0].as<uint64_t>();
        const auto deleted_folder = txn.exec(
            "INSERT INTO folders (user_id, encrypted_name, name_hash, deleted_at) VALUES ($1, 'deleted-cipher', 'deleted-hash', CURRENT_TIMESTAMP) RETURNING id",
            pqxx::params{user_id}
        )[0][0].as<uint64_t>();
        txn.commit();

        const auto body = R"({"root_parent_id":)" + std::to_string(other_folder) + R"(,"folders":[{"client_ref":"child","parent_client_ref":null,"encrypted_name":"c","name_hash":"c-hash"}]})";
        REQUIRE(send_batch(router, token, body).code == 403);

        const auto deleted_body = R"({"root_parent_id":)" + std::to_string(deleted_folder) + R"(,"folders":[{"client_ref":"child","parent_client_ref":null,"encrypted_name":"c","name_hash":"c-hash-2"}]})";
        REQUIRE(send_batch(router, token, deleted_body).code == 404);
        REQUIRE(send_batch(router, token, R"({"root_parent_id":null,"folders":[{"client_ref":"deleted-conflict","parent_client_ref":null,"encrypted_name":"new-cipher","name_hash":"deleted-hash"}]})").code == 409);
        REQUIRE(send_batch(router, token, R"({"root_parent_id":999999999,"folders":[{"client_ref":"child","parent_client_ref":null,"encrypted_name":"c","name_hash":"c-hash-3"}]})").code == 404);
    }

    SECTION("rejeita payload acima do limite antes da transacao") {
        crow::json::wvalue body;
        body["root_parent_id"] = nullptr;
        std::vector<crow::json::wvalue> items;
        for (int i = 0; i < 1001; ++i) {
            crow::json::wvalue item;
            item["client_ref"] = "ref-" + std::to_string(i);
            item["parent_client_ref"] = nullptr;
            item["encrypted_name"] = "cipher-" + std::to_string(i);
            item["name_hash"] = "limit-hash-" + std::to_string(i);
            items.push_back(std::move(item));
        }
        body["folders"] = std::move(items);
        REQUIRE(send_batch(router, token, body.dump()).code == 400);
    }

    {
        auto cleanup = pool.acquire_connection();
        pqxx::work txn(*cleanup);
        txn.exec("DELETE FROM users WHERE username = $1 OR username = $2", pqxx::params{username, username + "_other"});
        txn.commit();
    }
}
