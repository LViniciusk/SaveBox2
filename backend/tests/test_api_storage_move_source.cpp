#include <catch2/catch_test_macros.hpp>

#include "controllers/ApiRouter.hpp"
#include "database/DatabasePool.hpp"
#include "database/FileManager.hpp"
#include "database/FolderManager.hpp"
#include "Services/AuthService.hpp"
#include "storage/FileChunker.hpp"
#include "test_helpers.hpp"

#include <crow_all.h>
#include <filesystem>
#include <fstream>
#include <string>

TEST_CASE("API source local de storage move limita e valida Range", "[api][storage-move][range]") {
    const std::filesystem::path storage_dir = "./test_api_storage_move_source";
    std::filesystem::remove_all(storage_dir);
    std::filesystem::create_directories(storage_dir);

    DatabasePool pool(2, get_secure_conn_string());
    MockEmailService email;
    AuthService auth("storage-move-source-secret", "storage-move-source-pepper", &email);
    FolderManager folders(pool);
    FileManager files(pool);
    FileChunker chunker(storage_dir.string());
    ApiRouter router(pool, auth, folders, &files, &chunker);

    uint64_t user_id = 0;
    uint64_t attacker_id = 0;
    uint64_t storage_id = 0;
    uint64_t file_id = 0;
    uint64_t move_id = 0;
    uint64_t original_item_id = 0;
    uint64_t proxy_item_id = 0;
    const uint64_t total = FileChunker::MAX_CHUNK_SIZE + 1024;

    struct Cleanup {
        DatabasePool& pool;
        uint64_t user_id;
        uint64_t attacker_id;
        std::filesystem::path storage_dir;
        ~Cleanup() {
            try {
                auto conn = pool.acquire_connection();
                pqxx::work txn(*conn);
                txn.exec("DELETE FROM users WHERE id=$1 OR id=$2", pqxx::params{user_id, attacker_id});
                txn.commit();
            } catch (...) {
            }
            std::filesystem::remove_all(storage_dir);
        }
    } cleanup{pool, 0, 0, storage_dir};

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username IN ('storage_move_source_range_test', 'storage_move_source_attacker')");
        user_id = txn.exec(
            "INSERT INTO users(username,email,is_email_verified,max_storage_bytes,used_storage_bytes) "
            "VALUES('storage_move_source_range_test','storage_move_source_range@test.com',TRUE,100000000,0) RETURNING id")[0][0].as<uint64_t>();
        attacker_id = txn.exec(
            "INSERT INTO users(username,email,is_email_verified) "
            "VALUES('storage_move_source_attacker','storage_move_source_attacker@test.com',TRUE) RETURNING id")[0][0].as<uint64_t>();
        storage_id = txn.exec(
            "INSERT INTO user_external_storages(user_id,provider,account_email,refresh_token) "
            "VALUES($1,'google_drive','storage-move-source@test.com','test-refresh') RETURNING id",
            pqxx::params{user_id})[0][0].as<uint64_t>();
        file_id = txn.exec(
            "INSERT INTO files(user_id,encrypted_name,name_hash,encrypted_fdk,size_bytes,total_chunks,is_upload_complete,"
            "storage_provider,proxy_physical_path,proxy_size_bytes,proxy_encrypted_fdk) "
            "VALUES($1,'cipher-name','source-range-hash','cipher-fdk',$2,2,TRUE,'local','proxy.dat',8,'proxy-fdk') RETURNING id",
            pqxx::params{user_id, total})[0][0].as<uint64_t>();
        txn.commit();
    }
    cleanup.user_id = user_id;
    cleanup.attacker_id = attacker_id;

    REQUIRE(chunker.write_chunk(file_id, 0, std::string(FileChunker::MAX_CHUNK_SIZE, 'A')));
    REQUIRE(chunker.write_chunk(file_id, 1, std::string(1024, 'B')));
    {
        std::ofstream proxy(storage_dir / (std::to_string(file_id) + ".proxy.dat"), std::ios::binary);
        proxy << "proxydata";
    }

    auto move = crow::json::load(files.start_storage_move(user_id, file_id, "google_drive", storage_id, total + 8).dump());
    move_id = static_cast<uint64_t>(move["id"].i());
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        const auto items = txn.exec("SELECT id,role FROM storage_move_items WHERE move_job_id=$1", pqxx::params{move_id});
        for (const auto& item : items) {
            if (item[1].as<std::string>() == "original") original_item_id = item[0].as<uint64_t>();
            if (item[1].as<std::string>() == "proxy") proxy_item_id = item[0].as<uint64_t>();
        }
        txn.commit();
    }
    REQUIRE(original_item_id != 0);
    REQUIRE(proxy_item_id != 0);

    const auto token = auth.generate_token(user_id);
    const auto attacker_token = auth.generate_token(attacker_id);
    auto request = [&](uint64_t item_id, const std::string& range, const std::string& authorization) {
        crow::request req;
        req.url = "/storage-moves/" + std::to_string(move_id) + "/items/" + std::to_string(item_id) + "/source";
        req.add_header("Authorization", "Bearer " + authorization);
        if (!range.empty()) req.add_header("Range", range);
        return router.handle_get_storage_move_source(req, static_cast<int>(move_id), static_cast<int>(item_id));
    };

    SECTION("aceita exatamente 4 MiB") {
        auto response = request(original_item_id, "bytes=0-4194303", token);
        REQUIRE(response.code == 206);
        REQUIRE(response.body.size() == FileChunker::MAX_CHUNK_SIZE);
        REQUIRE(response.get_header_value("Content-Length") == std::to_string(FileChunker::MAX_CHUNK_SIZE));
        REQUIRE(response.get_header_value("Content-Range") == "bytes 0-4194303/4195328");
    }

    SECTION("rejeita 4 MiB mais um byte sem ler o arquivo") {
        auto response = request(original_item_id, "bytes=0-4194304", token);
        REQUIRE(response.code == 416);
        REQUIRE(response.body.empty());
        REQUIRE(response.get_header_value("Content-Range") == "bytes */4195328");
    }

    SECTION("aceita Range pequeno e limita start/end") {
        auto response = request(original_item_id, "bytes=0-1023", token);
        REQUIRE(response.code == 206);
        REQUIRE(response.body.size() == 1024);
        REQUIRE(response.get_header_value("Content-Range") == "bytes 0-1023/4195328");
    }

    SECTION("rejeita limites, texto, múltiplos ranges e números absurdos") {
        for (const auto& range : {"bytes=4195328-4195330", "bytes=9-8", "bytes=abc-999", "bytes=0-abc", "bytes=-", "bytes=0-1,2-3", "bytes=0-184467440737095516160", "garbage"}) {
            auto response = request(original_item_id, range, token);
            REQUIRE(response.code == 416);
            REQUIRE(response.get_header_value("Content-Range") == "bytes */4195328");
        }
        REQUIRE(request(original_item_id, "", token).code == 400);
    }

    SECTION("lê o item proxy com o mesmo contrato") {
        auto response = request(proxy_item_id, "bytes=0-3", token);
        REQUIRE(response.code == 206);
        REQUIRE(response.body == "prox");
        REQUIRE(response.get_header_value("Content-Range") == "bytes 0-3/8");
    }

    SECTION("rejeita acesso de outro usuário") {
        auto response = request(original_item_id, "bytes=0-10", attacker_token);
        REQUIRE(response.code == 404);
    }
}

TEST_CASE("API complete trata final promovido e erro interno com status seguro", "[api][storage-move][complete]") {
    const std::filesystem::path storage_dir = "./test_api_storage_move_complete";
    std::filesystem::remove_all(storage_dir);
    DatabasePool pool(2, get_secure_conn_string());
    MockEmailService email;
    AuthService auth("storage-move-complete-secret", "storage-move-complete-pepper", &email);
    FolderManager folders(pool);
    FileManager files(pool);
    FileChunker chunker(storage_dir.string());
    int cleanup_requests = 0;
    ApiRouter router(pool, auth, folders, &files, &chunker, nullptr, [&]() { ++cleanup_requests; });

    uint64_t user_id;
    uint64_t storage_id;
    uint64_t valid_file_id;
    uint64_t error_file_id;
    uint64_t valid_move_id;
    uint64_t error_move_id;
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username='storage_move_complete_test'");
        user_id = txn.exec(
            "INSERT INTO users(username,email,is_email_verified,max_storage_bytes,used_storage_bytes) "
            "VALUES('storage_move_complete_test','storage_move_complete@test.com',TRUE,1000000,0) RETURNING id")[0][0].as<uint64_t>();
        storage_id = txn.exec(
            "INSERT INTO user_external_storages(user_id,provider,account_email,refresh_token) "
            "VALUES($1,'google_drive','complete@example.com','refresh') RETURNING id",pqxx::params{user_id})[0][0].as<uint64_t>();
        valid_file_id = txn.exec(
            "INSERT INTO files(user_id,encrypted_name,name_hash,encrypted_fdk,size_bytes,total_chunks,is_upload_complete,storage_provider,external_file_id,external_storage_id) "
            "VALUES($1,'valid','complete-valid','fdk',10,1,TRUE,'google_drive','source-valid',$2) RETURNING id",
            pqxx::params{user_id,storage_id})[0][0].as<uint64_t>();
        error_file_id = txn.exec(
            "INSERT INTO files(user_id,encrypted_name,name_hash,encrypted_fdk,size_bytes,total_chunks,is_upload_complete,storage_provider,external_file_id,external_storage_id) "
            "VALUES($1,'error','complete-error','fdk',10,1,TRUE,'google_drive','source-error',$2) RETURNING id",
            pqxx::params{user_id,storage_id})[0][0].as<uint64_t>();
        txn.commit();
    }
    valid_move_id = static_cast<uint64_t>(crow::json::load(files.start_storage_move(user_id,valid_file_id,"local",std::nullopt,std::nullopt).dump())["id"].i());
    error_move_id = static_cast<uint64_t>(crow::json::load(files.start_storage_move(user_id,error_file_id,"local",std::nullopt,std::nullopt).dump())["id"].i());
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("UPDATE storage_move_items SET status='target_uploaded',transferred_bytes=total_bytes WHERE move_job_id IN ($1,$2)",pqxx::params{valid_move_id,error_move_id});
        txn.exec("UPDATE storage_move_jobs SET status='target_uploaded',transferred_bytes=total_bytes WHERE id IN ($1,$2)",pqxx::params{valid_move_id,error_move_id});
        txn.commit();
    }
    REQUIRE(chunker.write_chunk(valid_file_id,0,"ciphertext"));
    std::filesystem::create_directory(storage_dir / (std::to_string(error_file_id) + ".dat"));
    const auto token = auth.generate_token(user_id);
    auto request = [&](uint64_t move_id) {
        crow::request req;
        req.url = "/storage-moves/" + std::to_string(move_id) + "/complete";
        req.add_header("Authorization", "Bearer " + token);
        return router.handle_complete_storage_move(req, static_cast<int>(move_id));
    };

    SECTION("aceita final valido sem staging") {
        const auto response = request(valid_move_id);
        REQUIRE(response.code == 200);
        REQUIRE(cleanup_requests == 1);
    }

    SECTION("mapeia erro interno para 500 sem expor detalhe") {
        const auto response = request(error_move_id);
        REQUIRE(response.code == 500);
        REQUIRE(response.body.find("STORAGE_MOVE_OPERATION_FAILED") != std::string::npos);
        REQUIRE(response.body.find("test_api_storage_move_complete") == std::string::npos);
    }

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE id=$1",pqxx::params{user_id});
        txn.commit();
    }
    std::filesystem::remove_all(storage_dir);
}
