#include <catch2/catch_test_macros.hpp>
#include "database/DatabasePool.hpp"
#include "database/FileManager.hpp"
#include "storage/FileChunker.hpp"
#include "test_helpers.hpp"
#include <filesystem>
#include <fstream>
#include <pqxx/pqxx>
#include <vector>

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
    REQUIRE_NOTHROW(manager.mark_storage_move_item_uploaded(user_id,move_id,item_id,std::nullopt));
    auto completed = manager.complete_storage_move(user_id,move_id,chunker);
    auto completed_json = crow::json::load(completed.dump());
    REQUIRE(completed_json["file_id"].i() == static_cast<int64_t>(file_id));
    REQUIRE(completed_json["status"].s() == "cleanup_pending");
    REQUIRE_NOTHROW(manager.mark_storage_move_item_uploaded(user_id,move_id,item_id,std::nullopt));
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

TEST_CASE("Falhas de move persistem retry e bloqueiam limpeza prematura", "[database][storage-move][integration]") {
    DatabasePool pool(2, get_secure_conn_string());
    FileManager manager(pool);
    uint64_t user_id;
    uint64_t storage_id;
    uint64_t file_id;
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username='storage_move_failure_test'");
        user_id = txn.exec(
            "INSERT INTO users(username,email,is_email_verified,max_storage_bytes,used_storage_bytes) "
            "VALUES('storage_move_failure_test','storage_move_failure_test@example.com',TRUE,100000,0) RETURNING id")[0][0].as<uint64_t>();
        storage_id = txn.exec(
            "INSERT INTO user_external_storages(user_id,provider,account_email,refresh_token) "
            "VALUES($1,'google_drive','failure-drive@example.com','refresh') RETURNING id",
            pqxx::params{user_id})[0][0].as<uint64_t>();
        file_id = txn.exec(
            "INSERT INTO files(user_id,encrypted_name,name_hash,encrypted_fdk,size_bytes,total_chunks,is_upload_complete,storage_provider,physical_path) "
            "VALUES($1,'failure-cipher','failure-hash','failure-fdk',10,1,TRUE,'local','failure-source.dat') RETURNING id",
            pqxx::params{user_id})[0][0].as<uint64_t>();
        txn.commit();
    }

    auto move = crow::json::load(manager.start_storage_move(user_id,file_id,"google_drive",storage_id,10).dump());
    const uint64_t move_id = static_cast<uint64_t>(move["id"].i());
    manager.record_storage_move_failure(user_id,move_id,"SOURCE_READ_FAILED","source_read",true);
    auto paused = crow::json::load(manager.get_storage_move(user_id,move_id).dump());
    REQUIRE(paused["status"].s() == "paused");
    REQUIRE(paused["is_retryable"].b());
    REQUIRE(paused["failure_stage"].s() == "source_read");
    REQUIRE(paused["error_detail"].s() == "Falha recuperavel durante a transferencia");

    manager.set_storage_move_status(user_id,move_id,"resume");
    auto resumed = crow::json::load(manager.get_storage_move(user_id,move_id).dump());
    REQUIRE(resumed["status"].s() == "transferring");
    REQUIRE_FALSE(resumed["is_retryable"].b());
    REQUIRE_FALSE(resumed.has("error_code"));

    manager.record_storage_move_failure(user_id,move_id,"GOOGLE_TARGET_WRITE_FAILED","target_write",false);
    auto failed = crow::json::load(manager.get_storage_move(user_id,move_id).dump());
    REQUIRE(failed["status"].s() == "failed");
    REQUIRE_FALSE(failed["is_retryable"].b());
    REQUIRE(failed["error_code"].s() == "GOOGLE_TARGET_WRITE_FAILED");
    REQUIRE(failed["failure_stage"].s() == "target_write");
    REQUIRE_NOTHROW(manager.record_storage_move_failure(user_id,move_id,"GOOGLE_TARGET_WRITE_FAILED","target_write",false));

    REQUIRE_THROWS(manager.clear_storage_move(user_id,move_id));
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        REQUIRE(txn.exec("SELECT COUNT(*) FROM storage_move_jobs WHERE id=$1",pqxx::params{move_id})[0][0].as<int>() == 1);
        txn.exec("DELETE FROM pending_storage_move_reconciliations WHERE move_job_id=$1",pqxx::params{move_id});
        txn.commit();
    }
    manager.clear_storage_move(user_id,move_id);
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        REQUIRE(txn.exec("SELECT COUNT(*) FROM storage_move_jobs WHERE id=$1",pqxx::params{move_id})[0][0].as<int>() == 0);
        txn.exec("DELETE FROM users WHERE id=$1",pqxx::params{user_id});
        txn.commit();
    }
}

TEST_CASE("Pausa manual de storage move pode ser retomada sem marcar falha recuperavel", "[database][storage-move][resume]") {
    DatabasePool pool(2, get_secure_conn_string());
    FileManager manager(pool);
    uint64_t user_id;
    uint64_t storage_id;
    uint64_t file_id;
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username='storage_move_manual_pause_test'");
        user_id = txn.exec(
            "INSERT INTO users(username,email,is_email_verified,max_storage_bytes,used_storage_bytes) "
            "VALUES('storage_move_manual_pause_test','storage_move_manual_pause@test.com',TRUE,100000,0) RETURNING id")[0][0].as<uint64_t>();
        storage_id = txn.exec(
            "INSERT INTO user_external_storages(user_id,provider,account_email,refresh_token) "
            "VALUES($1,'google_drive','manual-pause@example.com','refresh') RETURNING id", pqxx::params{user_id})[0][0].as<uint64_t>();
        file_id = txn.exec(
            "INSERT INTO files(user_id,encrypted_name,name_hash,encrypted_fdk,size_bytes,total_chunks,is_upload_complete,storage_provider,external_file_id,external_storage_id) "
            "VALUES($1,'manual-pause-file','manual-pause-hash','fdk',10,1,TRUE,'google_drive','manual-pause-source',$2) RETURNING id",
            pqxx::params{user_id, storage_id})[0][0].as<uint64_t>();
        txn.commit();
    }

    const auto started = crow::json::load(manager.start_storage_move(user_id, file_id, "local", std::nullopt, std::nullopt).dump());
    const uint64_t move_id = static_cast<uint64_t>(started["id"].i());

    manager.set_storage_move_status(user_id, move_id, "paused");
    const auto paused = crow::json::load(manager.get_storage_move(user_id, move_id).dump());
    REQUIRE(paused["status"].s() == "paused");
    REQUIRE_FALSE(paused["is_retryable"].b());
    REQUIRE_FALSE(paused.has("error_code"));
    REQUIRE_FALSE(paused.has("error_detail"));
    REQUIRE_FALSE(paused.has("failure_stage"));

    REQUIRE_NOTHROW(manager.set_storage_move_status(user_id, move_id, "resume"));
    const auto resumed = crow::json::load(manager.get_storage_move(user_id, move_id).dump());
    REQUIRE(resumed["status"].s() == "transferring");
    REQUIRE_FALSE(resumed["is_retryable"].b());
    REQUIRE_FALSE(resumed.has("error_code"));
    REQUIRE_FALSE(resumed.has("error_detail"));
    REQUIRE_FALSE(resumed.has("failure_stage"));

    auto conn = pool.acquire_connection();
    pqxx::work txn(*conn);
    txn.exec("DELETE FROM users WHERE id=$1", pqxx::params{user_id});
    txn.commit();
}

TEST_CASE("Resume deriva a fase dos itens persistidos", "[database][storage-move][resume]") {
    DatabasePool pool(2, get_secure_conn_string());
    FileManager manager(pool);
    uint64_t user_id;
    uint64_t storage_id;
    uint64_t complete_move_id;
    uint64_t partial_move_id;
    uint64_t bundle_move_id;
    uint64_t file_id;
    uint64_t partial_file_id;
    uint64_t bundle_file_id;
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username='storage_move_resume_test'");
        user_id = txn.exec(
            "INSERT INTO users(username,email,is_email_verified,max_storage_bytes,used_storage_bytes) "
            "VALUES('storage_move_resume_test','storage_move_resume@test.com',TRUE,100000,0) RETURNING id")[0][0].as<uint64_t>();
        storage_id = txn.exec(
            "INSERT INTO user_external_storages(user_id,provider,account_email,refresh_token) "
            "VALUES($1,'google_drive','resume@example.com','refresh') RETURNING id", pqxx::params{user_id})[0][0].as<uint64_t>();
        file_id = txn.exec(
            "INSERT INTO files(user_id,encrypted_name,name_hash,encrypted_fdk,size_bytes,total_chunks,is_upload_complete,storage_provider,external_file_id,external_storage_id) "
            "VALUES($1,'resume-file','resume-file-hash','fdk',10,1,TRUE,'google_drive','source-resume',$2) RETURNING id",
            pqxx::params{user_id,storage_id})[0][0].as<uint64_t>();
        partial_file_id = txn.exec(
            "INSERT INTO files(user_id,encrypted_name,name_hash,encrypted_fdk,size_bytes,total_chunks,is_upload_complete,storage_provider,external_file_id,external_storage_id) "
            "VALUES($1,'partial-file','partial-file-hash','fdk',10,1,TRUE,'google_drive','source-partial',$2) RETURNING id",
            pqxx::params{user_id,storage_id})[0][0].as<uint64_t>();
        bundle_file_id = txn.exec(
            "INSERT INTO files(user_id,encrypted_name,name_hash,encrypted_fdk,size_bytes,proxy_size_bytes,total_chunks,is_upload_complete,storage_provider,external_file_id,proxy_external_file_id,external_storage_id) "
            "VALUES($1,'bundle-file','bundle-file-hash','fdk',10,5,1,TRUE,'google_drive','source-bundle','source-bundle-proxy',$2) RETURNING id",
            pqxx::params{user_id,storage_id})[0][0].as<uint64_t>();
        txn.commit();
    }
        complete_move_id = static_cast<uint64_t>(crow::json::load(
            manager.start_storage_move(user_id,file_id,"local",std::nullopt,std::nullopt).dump())["id"].i());
        partial_move_id = static_cast<uint64_t>(crow::json::load(
            manager.start_storage_move(user_id,partial_file_id,"local",std::nullopt,std::nullopt).dump())["id"].i());
        bundle_move_id = static_cast<uint64_t>(crow::json::load(
            manager.start_storage_move(user_id,bundle_file_id,"local",std::nullopt,std::nullopt).dump())["id"].i());
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec(
            "UPDATE storage_move_items SET status='target_uploaded',transferred_bytes=total_bytes "
            "WHERE move_job_id IN ($1,$2) AND move_job_id<>$3",
            pqxx::params{complete_move_id,bundle_move_id,partial_move_id});
        txn.exec("UPDATE storage_move_jobs SET status='target_uploaded',transferred_bytes=total_bytes WHERE id IN ($1,$2)",
                 pqxx::params{complete_move_id,bundle_move_id});
        txn.commit();
    }

    manager.record_storage_move_failure(user_id,complete_move_id,"STORAGE_MOVE_NETWORK_FAILED","commit",true);
    manager.set_storage_move_status(user_id,complete_move_id,"resume");
    REQUIRE(crow::json::load(manager.get_storage_move(user_id,complete_move_id).dump())["status"].s() == "target_uploaded");

    manager.record_storage_move_failure(user_id,partial_move_id,"STORAGE_MOVE_NETWORK_FAILED","commit",true);
    manager.set_storage_move_status(user_id,partial_move_id,"resume");
    REQUIRE(crow::json::load(manager.get_storage_move(user_id,partial_move_id).dump())["status"].s() == "transferring");

    manager.record_storage_move_failure(user_id,bundle_move_id,"STORAGE_MOVE_NETWORK_FAILED","commit",true);
    manager.set_storage_move_status(user_id,bundle_move_id,"resume");
    REQUIRE(crow::json::load(manager.get_storage_move(user_id,bundle_move_id).dump())["status"].s() == "target_uploaded");

    auto conn = pool.acquire_connection();
    pqxx::work txn(*conn);
    txn.exec("DELETE FROM users WHERE id=$1",pqxx::params{user_id});
    txn.commit();
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
        txn.commit();
    }

    manager.mark_storage_move_item_uploaded(user_id,move_id,item_id,"partial-target");
    REQUIRE_NOTHROW(manager.mark_storage_move_item_uploaded(user_id,move_id,item_id,"partial-target"));
    REQUIRE_THROWS(manager.mark_storage_move_item_uploaded(user_id,move_id,item_id,"different-target"));

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

TEST_CASE("Commit de move usa role e nao a ordem dos itens", "[database][storage-move][role]") {
    DatabasePool pool(2, get_secure_conn_string());
    const std::string storage_dir = "./test_storage_move_roles/";
    std::filesystem::remove_all(storage_dir);
    FileChunker chunker(storage_dir);
    FileManager manager(pool);
    uint64_t user_id;
    uint64_t storage_id;
    uint64_t file_id;
    uint64_t move_id;
    uint64_t proxy_item_id;
    uint64_t original_item_id;
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username='storage_move_role_test'");
        user_id = txn.exec(
            "INSERT INTO users(username,email,is_email_verified,max_storage_bytes,used_storage_bytes) "
            "VALUES('storage_move_role_test','storage_move_role_test@example.com',TRUE,100000,2048) RETURNING id")[0][0].as<uint64_t>();
        storage_id = txn.exec(
            "INSERT INTO user_external_storages(user_id,provider,account_email,refresh_token,root_folder_id) "
            "VALUES($1,'google_drive','role@example.com','refresh','root') RETURNING id",
            pqxx::params{user_id})[0][0].as<uint64_t>();
        file_id = txn.exec(
            "INSERT INTO files(user_id,encrypted_name,name_hash,encrypted_fdk,size_bytes,proxy_size_bytes,is_upload_complete,storage_provider,external_file_id,external_storage_id,proxy_external_file_id) "
            "VALUES($1,'cipher-name','role-file','cipher-fdk',4,3,TRUE,'google_drive','source-original',$2,'source-proxy') RETURNING id",
            pqxx::params{user_id,storage_id})[0][0].as<uint64_t>();
        move_id = txn.exec(
            "INSERT INTO storage_move_jobs(user_id,file_id,status,source_provider,source_external_storage_id,target_provider,total_bytes,reserved_bytes) "
            "VALUES($1,$2,'target_uploaded','google_drive',$3,'local',7,7) RETURNING id",
            pqxx::params{user_id,file_id,storage_id})[0][0].as<uint64_t>();
        proxy_item_id = txn.exec(
            "INSERT INTO storage_move_items(move_job_id,file_id,role,source_external_file_id,target_external_file_id,total_bytes,transferred_bytes,status) "
            "VALUES($1,$2,'proxy','source-proxy',NULL,3,3,'target_uploaded') RETURNING id",
            pqxx::params{move_id,file_id})[0][0].as<uint64_t>();
        original_item_id = txn.exec(
            "INSERT INTO storage_move_items(move_job_id,file_id,role,source_external_file_id,target_external_file_id,total_bytes,transferred_bytes,status) "
            "VALUES($1,$2,'original','source-original',NULL,4,4,'target_uploaded') RETURNING id",
            pqxx::params{move_id,file_id})[0][0].as<uint64_t>();
        txn.commit();
    }

    REQUIRE(chunker.write_move_chunk(proxy_item_id, 0, "prx"));
    REQUIRE(chunker.write_move_chunk(original_item_id, 0, "orig"));
    const auto result = crow::json::load(manager.complete_storage_move(user_id, move_id, chunker).dump());
    REQUIRE(result["status"].s() == "cleanup_pending");
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        const auto file = txn.exec(
            "SELECT storage_provider,external_file_id,proxy_external_file_id,physical_path,proxy_physical_path,encrypted_name,encrypted_fdk "
            "FROM files WHERE id=$1", pqxx::params{file_id});
        REQUIRE(file[0][0].as<std::string>() == "local");
        REQUIRE(file[0][1].is_null());
        REQUIRE(file[0][2].is_null());
        REQUIRE(file[0][3].as<std::string>() == std::to_string(file_id) + ".dat");
        REQUIRE(file[0][4].as<std::string>() == std::to_string(file_id) + ".proxy.dat");
        REQUIRE(file[0][5].as<std::string>() == "cipher-name");
        REQUIRE(file[0][6].as<std::string>() == "cipher-fdk");
        txn.exec("DELETE FROM users WHERE id=$1", pqxx::params{user_id});
        txn.commit();
    }
    std::filesystem::remove_all(storage_dir);
}

TEST_CASE("Commit Google para Local recupera artifacts e falha fechado", "[database][storage-move][commit][recovery]") {
    DatabasePool pool(2, get_secure_conn_string());
    const std::string storage_dir = "./test_storage_move_recovery/";
    std::filesystem::remove_all(storage_dir);
    FileChunker chunker(storage_dir);
    FileManager manager(pool);
    uint64_t user_id;
    uint64_t storage_id;
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username='storage_move_recovery_test'");
        user_id = txn.exec(
            "INSERT INTO users(username,email,is_email_verified,max_storage_bytes,used_storage_bytes) "
            "VALUES('storage_move_recovery_test','storage_move_recovery@test.com',TRUE,1000000,0) RETURNING id")[0][0].as<uint64_t>();
        storage_id = txn.exec(
            "INSERT INTO user_external_storages(user_id,provider,account_email,refresh_token) "
            "VALUES($1,'google_drive','recovery@example.com','refresh') RETURNING id",pqxx::params{user_id})[0][0].as<uint64_t>();
        txn.commit();
    }

    auto create_file = [&](const std::string& name, const std::string& hash) {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        const auto id = txn.exec(
            "INSERT INTO files(user_id,encrypted_name,name_hash,encrypted_fdk,size_bytes,total_chunks,is_upload_complete,storage_provider,external_file_id,external_storage_id) "
            "VALUES($1,$2,$3,'fdk',10,1,TRUE,'google_drive',$4,$5) RETURNING id",
            pqxx::params{user_id,name,hash,"source-" + hash,storage_id})[0][0].as<uint64_t>();
        txn.commit();
        return id;
    };
    auto start_move = [&](uint64_t file_id) {
        const auto move = crow::json::load(manager.start_storage_move(user_id,file_id,"local",std::nullopt,std::nullopt).dump());
        return std::pair<uint64_t,uint64_t>(static_cast<uint64_t>(move["id"].i()), static_cast<uint64_t>(move["items"][0]["id"].i()));
    };
    auto mark_uploaded = [&](uint64_t move_id) {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("UPDATE storage_move_items SET status='target_uploaded',transferred_bytes=total_bytes WHERE move_job_id=$1",pqxx::params{move_id});
        txn.exec("UPDATE storage_move_jobs SET status='target_uploaded',transferred_bytes=total_bytes WHERE id=$1",pqxx::params{move_id});
        txn.commit();
    };

    const auto promoted_file = create_file("promoted","promoted-hash");
    const auto [promoted_move, promoted_item] = start_move(promoted_file);
    REQUIRE(chunker.write_move_chunk(promoted_item,0,"ciphertext"));
    mark_uploaded(promoted_move);
    chunker.promote_move_file(promoted_item,promoted_file);
    const auto recovered = crow::json::load(manager.complete_storage_move(user_id,promoted_move,chunker).dump());
    REQUIRE(recovered["status"].s() == "cleanup_pending");
    REQUIRE_FALSE(chunker.try_get_move_file_size(promoted_item).has_value());
    REQUIRE(chunker.try_get_file_size(promoted_file) == std::optional<uint64_t>(10));

    const auto conflict_file = create_file("conflict","conflict-hash");
    const auto [conflict_move, conflict_item] = start_move(conflict_file);
    mark_uploaded(conflict_move);
    REQUIRE(chunker.write_move_chunk(conflict_item,0,"ciphertext"));
    REQUIRE(chunker.write_chunk(conflict_file,0,"ciphertext"));
    REQUIRE_THROWS(manager.complete_storage_move(user_id,conflict_move,chunker));
    REQUIRE(chunker.try_get_move_file_size(conflict_item) == std::optional<uint64_t>(10));

    const auto wrong_file = create_file("wrong","wrong-hash");
    const auto [wrong_move, wrong_item] = start_move(wrong_file);
    mark_uploaded(wrong_move);
    REQUIRE(chunker.write_chunk(wrong_file,0,"bad"));
    REQUIRE_THROWS(manager.complete_storage_move(user_id,wrong_move,chunker));

    const auto empty_file = create_file("empty","empty-hash");
    const auto [empty_move, empty_item] = start_move(empty_file);
    (void)empty_item;
    mark_uploaded(empty_move);
    REQUIRE_THROWS(manager.complete_storage_move(user_id,empty_move,chunker));

    const auto cancel_file = create_file("cancel","cancel-hash");
    const auto [cancel_move, cancel_item] = start_move(cancel_file);
    mark_uploaded(cancel_move);
    REQUIRE(chunker.write_chunk(cancel_file,0,"ciphertext"));
    manager.cancel_storage_move(user_id,cancel_move,{},&chunker);
    REQUIRE_FALSE(chunker.try_get_file_size(cancel_file).has_value());

    const auto failure_file = create_file("failure","failure-hash");
    const auto [failure_move, failure_item] = start_move(failure_file);
    mark_uploaded(failure_move);
    REQUIRE(chunker.write_chunk(failure_file,0,"ciphertext"));
    manager.record_storage_move_failure(user_id,failure_move,"STORAGE_MOVE_TARGET_INCOMPLETE","commit",false,{},&chunker);
    REQUIRE_FALSE(chunker.try_get_file_size(failure_file).has_value());

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        REQUIRE(txn.exec("SELECT storage_provider FROM files WHERE id=$1",pqxx::params{promoted_file})[0][0].as<std::string>() == "local");
        txn.exec("DELETE FROM users WHERE id=$1",pqxx::params{user_id});
        txn.commit();
    }
    std::filesystem::remove_all(storage_dir);
}

TEST_CASE("Commit Google para Local cobre recovery de bundle", "[database][storage-move][bundle][recovery]") {
    DatabasePool pool(2, get_secure_conn_string());
    const std::string storage_dir = "./test_storage_move_google_bundle/";
    std::filesystem::remove_all(storage_dir);
    FileChunker chunker(storage_dir);
    FileManager manager(pool);
    uint64_t user_id;
    uint64_t storage_id;
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username='storage_move_google_bundle_test'");
        user_id = txn.exec(
            "INSERT INTO users(username,email,is_email_verified,max_storage_bytes,used_storage_bytes) "
            "VALUES('storage_move_google_bundle_test','storage_move_google_bundle@test.com',TRUE,1000000,0) RETURNING id")[0][0].as<uint64_t>();
        storage_id = txn.exec(
            "INSERT INTO user_external_storages(user_id,provider,account_email,refresh_token) "
            "VALUES($1,'google_drive','google-bundle@example.com','refresh') RETURNING id",
            pqxx::params{user_id})[0][0].as<uint64_t>();
        txn.commit();
    }

    struct BundleCase {
        const char* name;
        bool original_staging;
        bool original_final;
        bool proxy_staging;
        bool proxy_final;
        const char* expected_error;
    };
    const std::vector<BundleCase> cases{
        {"staging-staging", true, false, true, false, nullptr},
        {"final-final", false, true, false, true, nullptr},
        {"final-staging", false, true, true, false, nullptr},
        {"staging-final", true, false, false, true, nullptr},
        {"original-conflict", true, true, false, true, "STORAGE_MOVE_TARGET_CONFLICT"},
        {"proxy-conflict", false, true, true, true, "STORAGE_MOVE_TARGET_CONFLICT"},
        {"original-wrong-size", false, false, false, true, "STORAGE_MOVE_TARGET_INCOMPLETE"},
        {"proxy-wrong-size", false, true, false, false, "STORAGE_MOVE_TARGET_INCOMPLETE"},
        {"original-missing", false, false, false, true, "STORAGE_MOVE_TARGET_INCOMPLETE"},
        {"proxy-missing", true, false, false, false, "STORAGE_MOVE_TARGET_INCOMPLETE"},
    };

    for (size_t index = 0; index < cases.size(); ++index) {
        const auto& test_case = cases[index];
        INFO(test_case.name);
        const std::string suffix = std::string(test_case.name) + "-" + std::to_string(index);
        uint64_t file_id;
        {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            file_id = txn.exec(
                "INSERT INTO files(user_id,encrypted_name,name_hash,encrypted_fdk,size_bytes,proxy_size_bytes,total_chunks,"
                "is_upload_complete,storage_provider,external_file_id,external_storage_id,proxy_external_file_id) "
                "VALUES($1,$2,$3,'fdk',4,3,1,TRUE,'google_drive',$4,$5,$6) RETURNING id",
                pqxx::params{user_id,"google-bundle-" + suffix,"google-bundle-hash-" + suffix,
                             "source-original-" + suffix,storage_id,"source-proxy-" + suffix})[0][0].as<uint64_t>();
            txn.commit();
        }

        const auto move = crow::json::load(manager.start_storage_move(user_id, file_id, "local", std::nullopt, std::nullopt).dump());
        const uint64_t move_id = static_cast<uint64_t>(move["id"].i());
        uint64_t original_item = 0;
        uint64_t proxy_item = 0;
        {
            auto conn = pool.acquire_connection();
            pqxx::work item_txn(*conn);
            for (const auto& item : item_txn.exec("SELECT id,role FROM storage_move_items WHERE move_job_id=$1", pqxx::params{move_id})) {
                if (item[1].as<std::string>() == "original") original_item = item[0].as<uint64_t>();
                else proxy_item = item[0].as<uint64_t>();
            }
            item_txn.exec("UPDATE storage_move_items SET status='target_uploaded',transferred_bytes=total_bytes WHERE move_job_id=$1", pqxx::params{move_id});
            item_txn.exec("UPDATE storage_move_jobs SET status='target_uploaded',transferred_bytes=total_bytes WHERE id=$1", pqxx::params{move_id});
            item_txn.commit();
        }

        if (test_case.original_staging || test_case.original_final) {
            REQUIRE(chunker.write_move_chunk(original_item, 0, "orig"));
            if (test_case.original_final) chunker.promote_move_file(original_item, file_id);
        }
        if (test_case.proxy_staging || test_case.proxy_final) {
            REQUIRE(chunker.write_move_chunk(proxy_item, 0, "prx"));
            if (test_case.proxy_final) chunker.promote_move_proxy(proxy_item, file_id);
        }
        if (std::string(test_case.name) == "original-conflict") {
            REQUIRE(chunker.write_move_chunk(original_item, 0, "orig"));
        }
        if (std::string(test_case.name) == "proxy-conflict") {
            REQUIRE(chunker.write_move_chunk(proxy_item, 0, "prx"));
        }
        if (std::string(test_case.name) == "original-wrong-size") {
            REQUIRE(chunker.write_chunk(file_id, 0, "bad"));
        }
        if (std::string(test_case.name) == "proxy-wrong-size") {
            std::ofstream proxy(std::filesystem::path(storage_dir) / (std::to_string(file_id) + ".proxy.dat"), std::ios::binary);
            proxy << "bad!";
        }

        if (test_case.expected_error) {
            std::string error;
            try {
                manager.complete_storage_move(user_id, move_id, chunker);
            } catch (const std::exception& exception) {
                error = exception.what();
            }
            REQUIRE(error == test_case.expected_error);
            continue;
        }

        const auto completed = crow::json::load(manager.complete_storage_move(user_id, move_id, chunker).dump());
        REQUIRE(completed["status"].s() == "cleanup_pending");
        REQUIRE(chunker.try_get_file_size(file_id) == std::optional<uint64_t>(4));
        REQUIRE(chunker.try_get_proxy_file_size(file_id) == std::optional<uint64_t>(3));
        REQUIRE_FALSE(chunker.try_get_move_file_size(original_item).has_value());
        REQUIRE_FALSE(chunker.try_get_move_file_size(proxy_item).has_value());
        if (std::string(test_case.name) == "final-final") {
            const auto repeated = crow::json::load(manager.complete_storage_move(user_id, move_id, chunker).dump());
            REQUIRE(repeated["status"].s() == "cleanup_pending");
            {
                auto conn = pool.acquire_connection();
                pqxx::work repeated_txn(*conn);
                REQUIRE(repeated_txn.exec("SELECT COUNT(*) FROM pending_external_deletions WHERE move_job_id=$1", pqxx::params{move_id})[0][0].as<int>() == 2);
                repeated_txn.commit();
            }
        }
    }

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE id=$1", pqxx::params{user_id});
        txn.commit();
    }
    std::filesystem::remove_all(storage_dir);
}

TEST_CASE("Commit Local para Google recupera quarantine e evita duplicacao", "[database][storage-move][quarantine][recovery]") {
    DatabasePool pool(2, get_secure_conn_string());
    const std::string storage_dir = "./test_storage_move_quarantine/";
    std::filesystem::remove_all(storage_dir);
    FileChunker chunker(storage_dir);
    FileManager manager(pool);
    uint64_t user_id;
    uint64_t storage_id;
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username='storage_move_quarantine_test'");
        user_id = txn.exec(
            "INSERT INTO users(username,email,is_email_verified,max_storage_bytes,used_storage_bytes) "
            "VALUES('storage_move_quarantine_test','storage_move_quarantine@test.com',TRUE,1000000,0) RETURNING id")[0][0].as<uint64_t>();
        storage_id = txn.exec(
            "INSERT INTO user_external_storages(user_id,provider,account_email,refresh_token) "
            "VALUES($1,'google_drive','quarantine@example.com','refresh') RETURNING id",
            pqxx::params{user_id})[0][0].as<uint64_t>();
        txn.commit();
    }

    auto create_bundle = [&](const std::string& suffix) {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        const auto file_id = txn.exec(
            "INSERT INTO files(user_id,encrypted_name,name_hash,encrypted_fdk,size_bytes,proxy_size_bytes,total_chunks,"
            "is_upload_complete,storage_provider,physical_path,proxy_physical_path) "
            "VALUES($1,$2,$3,'fdk',10,5,1,TRUE,'local',$4,$5) RETURNING id",
            pqxx::params{user_id,"cipher-" + suffix,"hash-" + suffix,
                         "source-" + suffix + ".dat","source-" + suffix + ".proxy.dat"})[0][0].as<uint64_t>();
        txn.commit();
        REQUIRE(chunker.write_chunk(file_id, 0, "0123456789"));
        std::ofstream proxy(std::filesystem::path(storage_dir) / (std::to_string(file_id) + ".proxy.dat"), std::ios::binary);
        proxy << "proxy";
        return file_id;
    };

    auto prepare = [&](uint64_t file_id, const std::string& suffix) {
        const auto move = crow::json::load(manager.start_storage_move(user_id, file_id, "google_drive", storage_id, 100000).dump());
        const uint64_t move_id = static_cast<uint64_t>(move["id"].i());
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        const auto items = txn.exec("SELECT id,role FROM storage_move_items WHERE move_job_id=$1 ORDER BY role", pqxx::params{move_id});
        txn.commit();
        for (const auto& item : items) {
            manager.mark_storage_move_item_uploaded(
                user_id, move_id, item[0].as<uint64_t>(),
                "target-" + suffix + "-" + item[1].as<std::string>());
        }
        return move_id;
    };

    auto used_bytes = [&]() {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        const auto value = txn.exec("SELECT used_storage_bytes FROM users WHERE id=$1", pqxx::params{user_id})[0][0].as<uint64_t>();
        txn.commit();
        return value;
    };

    auto assert_google_bundle = [&](uint64_t file_id, uint64_t move_id, uint64_t used_before) {
        const auto first = crow::json::load(manager.complete_storage_move(user_id, move_id, chunker).dump());
        REQUIRE(first["status"].s() == "cleanup_pending");
        REQUIRE(used_bytes() >= used_before);
        REQUIRE_FALSE(chunker.try_get_file_size(file_id).has_value());
        REQUIRE_FALSE(chunker.try_get_proxy_file_size(file_id).has_value());
        REQUIRE(chunker.try_get_quarantined_file_size(move_id) == std::optional<uint64_t>(10));
        REQUIRE(chunker.try_get_quarantined_proxy_size(move_id) == std::optional<uint64_t>(5));
        const auto used_after_first = used_bytes();
        const auto second = crow::json::load(manager.complete_storage_move(user_id, move_id, chunker).dump());
        REQUIRE(second["status"].s() == "cleanup_pending");
        REQUIRE(used_bytes() == used_after_first);
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        REQUIRE(txn.exec("SELECT storage_provider,external_storage_id,external_file_id,physical_path,proxy_physical_path FROM files WHERE id=$1", pqxx::params{file_id})[0][0].as<std::string>() == "google_drive");
        REQUIRE(txn.exec("SELECT COUNT(*) FROM pending_local_deletions WHERE move_job_id=$1", pqxx::params{move_id})[0][0].as<int>() == 1);
        txn.commit();
    };

    struct ArtifactState { const char* name; bool quarantine_original; bool quarantine_proxy; };
    for (const auto& state : {ArtifactState{"canonical-canonical", false, false},
                              ArtifactState{"quarantine-canonical", true, false},
                              ArtifactState{"canonical-quarantine", false, true},
                              ArtifactState{"quarantine-quarantine", true, true}}) {
        const auto file_id = create_bundle(state.name);
        const auto move_id = prepare(file_id, state.name);
        if (state.quarantine_original) chunker.quarantine_file(file_id, move_id);
        if (state.quarantine_proxy) chunker.quarantine_proxy(file_id, move_id);
        assert_google_bundle(file_id, move_id, used_bytes());
    }

    {
        const auto file_id = create_bundle("cancel");
        const auto move_id = prepare(file_id, "cancel");
        chunker.quarantine_file(file_id, move_id);
        chunker.quarantine_proxy(file_id, move_id);
        const auto cancelled = crow::json::load(manager.cancel_storage_move(user_id, move_id, {}, &chunker).dump());
        REQUIRE(cancelled["status"].s() == "cancelled");
        REQUIRE(chunker.try_get_file_size(file_id) == std::optional<uint64_t>(10));
        REQUIRE(chunker.try_get_proxy_file_size(file_id) == std::optional<uint64_t>(5));
        REQUIRE_FALSE(chunker.try_get_quarantined_file_size(move_id).has_value());
        REQUIRE_FALSE(chunker.try_get_quarantined_proxy_size(move_id).has_value());
    }

    {
        const auto file_id = create_bundle("failure");
        const auto move_id = prepare(file_id, "failure");
        chunker.quarantine_file(file_id, move_id);
        chunker.quarantine_proxy(file_id, move_id);
        manager.record_storage_move_failure(user_id, move_id, "STORAGE_MOVE_TARGET_INCOMPLETE", "commit", false, {}, &chunker);
        REQUIRE(chunker.try_get_file_size(file_id) == std::optional<uint64_t>(10));
        REQUIRE(chunker.try_get_proxy_file_size(file_id) == std::optional<uint64_t>(5));
    }

    {
        const auto file_id = create_bundle("retryable");
        const auto move_id = prepare(file_id, "retryable");
        chunker.quarantine_file(file_id, move_id);
        chunker.quarantine_proxy(file_id, move_id);
        manager.record_storage_move_failure(user_id, move_id, "STORAGE_MOVE_TARGET_INCOMPLETE", "commit", true, {}, &chunker);
        REQUIRE(chunker.try_get_quarantined_file_size(move_id) == std::optional<uint64_t>(10));
        manager.set_storage_move_status(user_id, move_id, "resume");
        const auto completed = crow::json::load(manager.complete_storage_move(user_id, move_id, chunker).dump());
        REQUIRE(completed["status"].s() == "cleanup_pending");
    }

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE id=$1", pqxx::params{user_id});
        txn.commit();
    }
    std::filesystem::remove_all(storage_dir);
}
