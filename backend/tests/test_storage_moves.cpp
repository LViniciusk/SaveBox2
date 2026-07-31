#include <catch2/catch_test_macros.hpp>
#include "database/DatabasePool.hpp"
#include "database/FileManager.hpp"
#include "storage/FileChunker.hpp"
#include "test_helpers.hpp"
#include <filesystem>
#include <pqxx/pqxx>

TEST_CASE("Movimentacao de armazenamento preserva identidade e quota", "[database][storage-move][integration]") {
    DatabasePool pool(2, get_secure_conn_string());
    const std::string storage_dir = "./test_storage_moves/";
    std::filesystem::remove_all(storage_dir);
    FileChunker chunker(storage_dir);
    FileManager manager(pool);

    uint64_t user_id;
    uint64_t storage_id;
    uint64_t file_id;
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username='storage_move_test'");
        user_id = txn.exec(
            "INSERT INTO users(username,email,is_email_verified,max_storage_bytes,used_storage_bytes) "
            "VALUES('storage_move_test','storage_move_test@example.com',TRUE,100000,2048) RETURNING id")[0][0].as<uint64_t>();
        storage_id = txn.exec(
            "INSERT INTO user_external_storages(user_id,provider,account_email,refresh_token) "
            "VALUES($1,'google_drive','drive@example.com','refresh') RETURNING id",
            pqxx::params{user_id})[0][0].as<uint64_t>();
        file_id = txn.exec(
            "INSERT INTO files(user_id,encrypted_name,name_hash,encrypted_fdk,size_bytes,total_chunks,is_upload_complete,storage_provider,external_file_id,external_storage_id) "
            "VALUES($1,'cipher-name','hash-move','cipher-fdk',10,1,TRUE,'google_drive','google-source',$2) RETURNING id",
            pqxx::params{user_id,storage_id})[0][0].as<uint64_t>();
        txn.commit();
    }

    auto move = manager.start_storage_move(user_id,file_id,"local",std::nullopt,std::nullopt);
    auto move_json = crow::json::load(move.dump());
    REQUIRE(move_json);
    const uint64_t move_id = static_cast<uint64_t>(move_json["id"].i());
    const uint64_t item_id = static_cast<uint64_t>(move_json["items"][0]["id"].i());
    REQUIRE(move_json["file_id"].i() == static_cast<int64_t>(file_id));
    REQUIRE(move_json["total_bytes"].i() == 10);
    REQUIRE_THROWS(manager.start_storage_move(user_id,file_id,"local",std::nullopt,std::nullopt));

    REQUIRE(chunker.write_move_chunk(item_id,0,"ciphertext"));
    REQUIRE(manager.record_storage_move_chunk(user_id,move_id,item_id,0,10) == 10);
    manager.mark_storage_move_item_uploaded(user_id,move_id,item_id,std::nullopt);
    auto completed = manager.complete_storage_move(user_id,move_id,chunker);
    auto completed_json = crow::json::load(completed.dump());
    REQUIRE(completed_json["file_id"].i() == static_cast<int64_t>(file_id));
    REQUIRE(completed_json["status"].s() == "cleanup_pending");
    auto repeated = crow::json::load(manager.complete_storage_move(user_id,move_id,chunker).dump());
    REQUIRE(repeated["status"].s() == "cleanup_pending");

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        auto file = txn.exec(
            "SELECT id,storage_provider,external_storage_id,external_file_id,encrypted_name,name_hash,encrypted_fdk FROM files WHERE id=$1",
            pqxx::params{file_id});
        REQUIRE(file[0][0].as<uint64_t>() == file_id);
        REQUIRE(file[0][1].as<std::string>() == "local");
        REQUIRE(file[0][2].is_null());
        REQUIRE(file[0][3].is_null());
        REQUIRE(file[0][4].as<std::string>() == "cipher-name");
        REQUIRE(file[0][5].as<std::string>() == "hash-move");
        REQUIRE(file[0][6].as<std::string>() == "cipher-fdk");
        REQUIRE(txn.exec("SELECT used_storage_bytes FROM users WHERE id=$1",pqxx::params{user_id})[0][0].as<uint64_t>() == 10);
        REQUIRE(txn.exec("SELECT COUNT(*) FROM pending_external_deletions WHERE move_job_id=$1",pqxx::params{move_id})[0][0].as<int>() == 1);
        txn.exec("DELETE FROM users WHERE id=$1",pqxx::params{user_id});
        txn.commit();
    }
    std::filesystem::remove_all(storage_dir);
}

TEST_CASE("Cancelamento de move preserva a origem", "[database][storage-move][integration]") {
    DatabasePool pool(2, get_secure_conn_string());
    FileManager manager(pool);
    uint64_t user_id;
    uint64_t storage_id;
    uint64_t file_id;
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username='storage_move_cancel_test'");
        user_id = txn.exec(
            "INSERT INTO users(username,email,is_email_verified,max_storage_bytes,used_storage_bytes) "
            "VALUES('storage_move_cancel_test','storage_move_cancel_test@example.com',TRUE,100000,10) RETURNING id")[0][0].as<uint64_t>();
        storage_id = txn.exec(
            "INSERT INTO user_external_storages(user_id,provider,account_email,refresh_token) "
            "VALUES($1,'google_drive','cancel-drive@example.com','refresh') RETURNING id",
            pqxx::params{user_id})[0][0].as<uint64_t>();
        file_id = txn.exec(
            "INSERT INTO files(user_id,encrypted_name,name_hash,encrypted_fdk,size_bytes,total_chunks,is_upload_complete,storage_provider,physical_path) "
            "VALUES($1,'cipher','hash-cancel','fdk',10,1,TRUE,'local','cancel-source.dat') RETURNING id",
            pqxx::params{user_id})[0][0].as<uint64_t>();
        txn.commit();
    }

    REQUIRE_THROWS(manager.start_storage_move(user_id,file_id,"google_drive",storage_id,5));
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec(
            "INSERT INTO shared_links(file_id,share_uuid,encrypted_name_fdk) VALUES($1,'mvshare','wrapped-name')",
            pqxx::params{file_id});
        txn.commit();
    }
    REQUIRE_THROWS(manager.start_storage_move(user_id,file_id,"google_drive",storage_id,1000));
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM shared_links WHERE file_id=$1",pqxx::params{file_id});
        txn.commit();
    }
    auto move = manager.start_storage_move(user_id,file_id,"google_drive",storage_id,1000);
    auto move_json = crow::json::load(move.dump());
    const uint64_t move_id = static_cast<uint64_t>(move_json["id"].i());
    const uint64_t item_id = static_cast<uint64_t>(move_json["items"][0]["id"].i());
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("UPDATE storage_move_items SET target_external_file_id='partial-target' WHERE id=$1",pqxx::params{item_id});
        txn.commit();
    }

    auto cancelled = crow::json::load(manager.cancel_storage_move(user_id,move_id).dump());
    REQUIRE(cancelled["status"].s() == "cancelled");
    auto repeated_cancel = crow::json::load(manager.cancel_storage_move(user_id,move_id).dump());
    REQUIRE(repeated_cancel["status"].s() == "cancelled");
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        auto file = txn.exec("SELECT storage_provider,physical_path FROM files WHERE id=$1",pqxx::params{file_id});
        REQUIRE(file[0][0].as<std::string>() == "local");
        REQUIRE(file[0][1].as<std::string>() == "cancel-source.dat");
        REQUIRE(txn.exec("SELECT reserved_bytes FROM storage_move_jobs WHERE id=$1",pqxx::params{move_id})[0][0].as<uint64_t>() == 0);
        REQUIRE(txn.exec(
            "SELECT COUNT(*) FROM pending_external_deletions WHERE external_file_id='partial-target' AND external_storage_id=$1",
            pqxx::params{storage_id})[0][0].as<int>() == 1);
        txn.exec("DELETE FROM users WHERE id=$1",pqxx::params{user_id});
        txn.commit();
    }
}

TEST_CASE("Projecao de armazenamento isola contas e oculta pastas vazias", "[database][storage-tree][integration]") {
    DatabasePool pool(2, get_secure_conn_string());
    FileManager manager(pool);
    uint64_t user_id;
    uint64_t storage_a;
    uint64_t storage_b;
    uint64_t root_folder;
    uint64_t child_folder;
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username='storage_tree_test'");
        user_id = txn.exec(
            "INSERT INTO users(username,email,is_email_verified) VALUES('storage_tree_test','storage_tree_test@example.com',TRUE) RETURNING id")[0][0].as<uint64_t>();
        storage_a = txn.exec(
            "INSERT INTO user_external_storages(user_id,account_email,refresh_token) VALUES($1,'a@example.com','a') RETURNING id",
            pqxx::params{user_id})[0][0].as<uint64_t>();
        storage_b = txn.exec(
            "INSERT INTO user_external_storages(user_id,account_email,refresh_token) VALUES($1,'b@example.com','b') RETURNING id",
            pqxx::params{user_id})[0][0].as<uint64_t>();
        root_folder = txn.exec(
            "INSERT INTO folders(user_id,encrypted_name,name_hash) VALUES($1,'root-cipher','root-hash') RETURNING id",
            pqxx::params{user_id})[0][0].as<uint64_t>();
        child_folder = txn.exec(
            "INSERT INTO folders(user_id,parent_id,encrypted_name,name_hash) VALUES($1,$2,'child-cipher','child-hash') RETURNING id",
            pqxx::params{user_id,root_folder})[0][0].as<uint64_t>();
        txn.exec(
            "INSERT INTO folders(user_id,encrypted_name,name_hash) VALUES($1,'empty-cipher','empty-hash')",
            pqxx::params{user_id});
        txn.exec(
            "INSERT INTO files(user_id,folder_id,encrypted_name,name_hash,encrypted_fdk,size_bytes,is_upload_complete,storage_provider,external_file_id,external_storage_id) "
            "VALUES($1,$2,'a-file','a-file-hash','fdk',10,TRUE,'google_drive','a-file-id',$3)",
            pqxx::params{user_id,child_folder,storage_a});
        txn.exec(
            "INSERT INTO files(user_id,encrypted_name,name_hash,encrypted_fdk,size_bytes,is_upload_complete,storage_provider,external_file_id,external_storage_id) "
            "VALUES($1,'b-file','b-file-hash','fdk',20,TRUE,'google_drive','b-file-id',$2)",
            pqxx::params{user_id,storage_b});
        txn.exec(
            "INSERT INTO files(user_id,encrypted_name,name_hash,encrypted_fdk,size_bytes,is_upload_complete,is_hidden,storage_provider,external_file_id,external_storage_id) "
            "VALUES($1,'hidden','hidden-hash','fdk',30,TRUE,TRUE,'google_drive','hidden-id',$2)",
            pqxx::params{user_id,storage_a});
        txn.commit();
    }

    auto root_a = manager.get_storage_tree(user_id,"google_drive",storage_a,std::nullopt,50,0);
    auto root_a_json = crow::json::load(root_a.dump());
    REQUIRE(root_a_json["folders"].size() == 1);
    REQUIRE(root_a_json["folders"][0]["id"].i() == static_cast<int64_t>(root_folder));
    REQUIRE(root_a_json["files"].size() == 0);

    auto child_a = manager.get_storage_tree(user_id,"google_drive",storage_a,child_folder,50,0);
    auto child_a_json = crow::json::load(child_a.dump());
    REQUIRE(child_a_json["files"].size() == 1);
    REQUIRE(child_a_json["files"][0]["external_storage_id"].i() == static_cast<int64_t>(storage_a));
    REQUIRE(child_a_json["files"][0]["encrypted_name"].s() == "a-file");

    auto root_b = manager.get_storage_tree(user_id,"google_drive",storage_b,std::nullopt,1,0);
    auto root_b_json = crow::json::load(root_b.dump());
    REQUIRE(root_b_json["folders"].size() == 0);
    REQUIRE(root_b_json["files"].size() == 1);
    REQUIRE(root_b_json["files"][0]["encrypted_name"].s() == "b-file");
    REQUIRE(root_b_json["has_more"].b() == false);

    auto conn = pool.acquire_connection();
    pqxx::work txn(*conn);
    txn.exec("DELETE FROM users WHERE id=$1",pqxx::params{user_id});
    txn.commit();
}
