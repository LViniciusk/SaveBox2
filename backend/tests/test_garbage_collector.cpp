#include <catch2/catch_test_macros.hpp>
#include "database/DatabasePool.hpp"
#include "database/FileManager.hpp"
#include "storage/GarbageCollector.hpp"
#include "storage/FileChunker.hpp"
#include "test_helpers.hpp"
#include <filesystem>
#include <fstream>
#include <string>
#include <chrono>
#include <thread>

namespace {
bool wait_for_gc_delete_lock(DatabasePool& pool) {
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (std::chrono::steady_clock::now() < deadline) {
        auto conn = pool.acquire_connection();
        pqxx::read_transaction txn(*conn);
        const auto waiting = txn.exec(
            "SELECT 1 FROM pg_stat_activity "
            "WHERE state='active' AND wait_event_type='Lock' AND query ILIKE '%DELETE FROM files%' LIMIT 1");
        txn.commit();
        if (!waiting.empty()) return true;
        std::this_thread::yield();
    }
    return false;
}
}

TEST_CASE("B.93 GC defers move and cleanup artifacts created during its current run",
          "[gc][b93][b93-midrun]") {
    DatabasePool pool(5, get_secure_conn_string());
    const std::string vault = "./vault_gc_b93_midrun/";
    std::filesystem::remove_all(vault);
    FileChunker chunker(vault);
    GarbageCollector gc(pool, &chunker);
    uint64_t user_id;
    uint64_t expired_id;
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username='gc_b93_midrun'");
        user_id = txn.exec(
            "INSERT INTO users(username,email,password_hash,is_email_verified,max_storage_bytes,used_storage_bytes) "
            "VALUES('gc_b93_midrun','gc_b93_midrun@example.com','hash',TRUE,100000,0) RETURNING id")[0][0].as<uint64_t>();
        expired_id = txn.exec(
            "INSERT INTO files(user_id,encrypted_name,name_hash,encrypted_fdk,size_bytes,is_upload_complete,storage_provider,created_at) "
            "VALUES($1,'cipher','b93-expired','fdk',8,FALSE,'local',CURRENT_TIMESTAMP-INTERVAL '5 hours') RETURNING id",
            pqxx::params{user_id})[0][0].as<uint64_t>();
        txn.commit();
    }
    struct Cleanup {
        DatabasePool& pool;
        std::string vault;
        uint64_t user_id;
        ~Cleanup() {
            std::error_code error;
            std::filesystem::remove_all(vault, error);
            try {
                auto conn = pool.acquire_connection();
                pqxx::work txn(*conn);
                txn.exec("DELETE FROM users WHERE id=$1", pqxx::params{user_id});
                txn.commit();
            } catch (...) {}
        }
    } cleanup{pool, vault, user_id};
    const auto move_dir = std::filesystem::path(vault) / "storage-moves";
    std::filesystem::create_directories(move_dir);
    std::ofstream(move_dir / "item-939999997.part") << "existing-orphan";
    auto lock_conn = pool.acquire_connection();
    pqxx::work lock(*lock_conn);
    REQUIRE_FALSE(lock.exec("SELECT id FROM files WHERE id=$1 FOR UPDATE", pqxx::params{expired_id}).empty());
    std::thread worker([&] { gc.run_cleanup(); });
    struct UnlockAndJoin {
        pqxx::work& lock;
        std::thread& worker;
        ~UnlockAndJoin() { if (worker.joinable()) { lock.abort(); worker.join(); } }
    } joiner{lock, worker};
    const bool blocked = wait_for_gc_delete_lock(pool);
    std::ofstream(move_dir / "item-939999998.part") << "late-orphan";
    std::ofstream(move_dir / "cleanup-939999999.proxy.dat") << "late-orphan";
    lock.commit();
    worker.join();
    CHECK(blocked);
    CHECK_FALSE(std::filesystem::exists(move_dir / "item-939999997.part"));
    CHECK(std::filesystem::exists(move_dir / "item-939999998.part"));
    CHECK(std::filesystem::exists(move_dir / "cleanup-939999999.proxy.dat"));
    gc.run_cleanup();
    CHECK_FALSE(std::filesystem::exists(move_dir / "item-939999998.part"));
    CHECK_FALSE(std::filesystem::exists(move_dir / "cleanup-939999999.proxy.dat"));
}

TEST_CASE("B.93 pending local deletion survives bookkeeping rollback and converges idempotently",
          "[gc][b93][b93-pending]") {
    DatabasePool pool(2, get_secure_conn_string());
    const std::string vault = "./vault_gc_b93_pending/";
    std::filesystem::remove_all(vault);
    FileChunker chunker(vault);
    GarbageCollector gc(pool, &chunker);
    uint64_t user_id, move_id, unrelated_move_id;
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username='gc_b93_pending'");
        user_id = txn.exec(
            "INSERT INTO users(username,email,password_hash,is_email_verified,max_storage_bytes,used_storage_bytes) "
            "VALUES('gc_b93_pending','gc_b93_pending@example.com','hash',TRUE,100000,0) RETURNING id")[0][0].as<uint64_t>();
        const auto unrelated_file_id = txn.exec(
            "INSERT INTO files(user_id,encrypted_name,name_hash,encrypted_fdk,size_bytes,is_upload_complete,storage_provider) "
            "VALUES($1,'cipher','b93-unrelated','fdk',8,TRUE,'local') RETURNING id",
            pqxx::params{user_id})[0][0].as<uint64_t>();
        unrelated_move_id = txn.exec(
            "INSERT INTO storage_move_jobs(user_id,file_id,status,source_provider,target_provider,total_bytes) "
            "VALUES($1,$2,'cleanup_pending','local','google_drive',8) RETURNING id",
            pqxx::params{user_id,unrelated_file_id})[0][0].as<uint64_t>();
        txn.exec("INSERT INTO pending_local_deletions(move_job_id) VALUES($1)", pqxx::params{unrelated_move_id});
        const auto file_id = txn.exec(
            "INSERT INTO files(user_id,encrypted_name,name_hash,encrypted_fdk,size_bytes,is_upload_complete,storage_provider) "
            "VALUES($1,'cipher','b93-pending','fdk',8,TRUE,'local') RETURNING id",
            pqxx::params{user_id})[0][0].as<uint64_t>();
        move_id = txn.exec(
            "INSERT INTO storage_move_jobs(user_id,file_id,status,source_provider,target_provider,total_bytes) "
            "VALUES($1,$2,'cleanup_pending','local','google_drive',8) RETURNING id",
            pqxx::params{user_id,file_id})[0][0].as<uint64_t>();
        txn.exec("INSERT INTO pending_local_deletions(move_job_id) VALUES($1)", pqxx::params{move_id});
        txn.exec("CREATE FUNCTION b93_reject_pending_delete() RETURNS trigger LANGUAGE plpgsql AS $$ "
                 "BEGIN RAISE EXCEPTION 'B93_SYNTHETIC_BOOKKEEPING_FAILURE'; END $$");
        txn.exec("CREATE TRIGGER b93_pending_delete BEFORE DELETE ON pending_local_deletions "
                 "FOR EACH ROW WHEN (OLD.move_job_id=" + std::to_string(move_id) +
                 ") EXECUTE FUNCTION b93_reject_pending_delete()");
        txn.commit();
    }
    struct Cleanup {
        DatabasePool& pool;
        std::string vault;
        uint64_t user_id;
        ~Cleanup() {
            std::error_code error;
            std::filesystem::remove_all(vault, error);
            try {
                auto conn = pool.acquire_connection();
                pqxx::work txn(*conn);
                txn.exec("DROP TRIGGER IF EXISTS b93_pending_delete ON pending_local_deletions");
                txn.exec("DROP FUNCTION IF EXISTS b93_reject_pending_delete()");
                txn.exec("DELETE FROM users WHERE id=$1", pqxx::params{user_id});
                txn.commit();
            } catch (...) {}
        }
    } cleanup{pool, vault, user_id};
    const auto move_dir = std::filesystem::path(vault) / "storage-moves";
    std::filesystem::create_directories(move_dir);
    const auto artifact = move_dir / ("cleanup-" + std::to_string(move_id) + ".dat");
    std::ofstream(artifact) << "synthetic";
    gc.run_cleanup();
    CHECK_FALSE(std::filesystem::exists(artifact));
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        CHECK(txn.exec("SELECT COUNT(*) FROM pending_local_deletions WHERE move_job_id=$1", pqxx::params{move_id})[0][0].as<int>() == 1);
        CHECK(txn.exec("SELECT status FROM storage_move_jobs WHERE id=$1", pqxx::params{move_id})[0][0].as<std::string>() == "cleanup_pending");
        txn.exec("DROP TRIGGER b93_pending_delete ON pending_local_deletions");
        txn.exec("DROP FUNCTION b93_reject_pending_delete()");
        txn.commit();
    }
    gc.run_cleanup();
    auto conn = pool.acquire_connection();
    pqxx::read_transaction txn(*conn);
    CHECK(txn.exec("SELECT COUNT(*) FROM pending_local_deletions WHERE move_job_id=$1", pqxx::params{move_id})[0][0].as<int>() == 0);
    CHECK(txn.exec("SELECT status FROM storage_move_jobs WHERE id=$1", pqxx::params{move_id})[0][0].as<std::string>() == "completed");
    CHECK(txn.exec("SELECT COUNT(*) FROM pending_local_deletions WHERE move_job_id=$1", pqxx::params{unrelated_move_id})[0][0].as<int>() == 0);
    CHECK(txn.exec("SELECT status FROM storage_move_jobs WHERE id=$1", pqxx::params{unrelated_move_id})[0][0].as<std::string>() == "completed");
}

TEST_CASE("Garbage Collector - Regras de Negocio", "[gc][cleanup]") {
    DatabasePool pool(1, get_secure_conn_string());
    
    std::string temp_vault = "./vault_gc_test/";
    std::filesystem::remove_all(temp_vault);
    std::filesystem::create_directories(temp_vault);
    
    FileChunker chunker(temp_vault);
    GarbageCollector gc(pool, &chunker);

    uint64_t user_id = 0;
    uint64_t default_folder_id = 0;

    {
        auto conn = pool.acquire_connection();
        pqxx::work W(*conn);

        W.exec("DELETE FROM users WHERE username LIKE 'gc_tester%';");
        std::string gc_username = "gc_tester_" + std::to_string(rand());
        
        auto res_u = W.exec("INSERT INTO users (username, email, password_hash, is_email_verified) VALUES ('" + gc_username + "', '" + gc_username + "@test.com', 'hash', true) RETURNING id;");

        user_id = res_u[0][0].as<uint64_t>();

        auto res_f = W.exec("INSERT INTO folders (user_id, encrypted_name, name_hash) VALUES (" + std::to_string(user_id) + ", 'gc_folder', 'hash') RETURNING id;");

        default_folder_id = res_f[0][0].as<uint64_t>();

        W.commit();
    }

    auto create_file = [&](bool is_complete, bool is_in_trash=false, uint64_t custom_folder_id=0) -> uint64_t {
        auto conn = pool.acquire_connection();
        pqxx::work W(*conn);
        uint64_t f_id = custom_folder_id == 0 ? default_folder_id : custom_folder_id;

        std::string del_val = is_in_trash ? "NOW()" : "NULL";

        std::string query = "INSERT INTO files (user_id, folder_id, encrypted_name, name_hash, encrypted_fdk, physical_path, size_bytes, is_upload_complete, deleted_at) VALUES (" + std::to_string(user_id) + ", " + std::to_string(f_id) + ", 'name', 'hash_" + std::to_string(rand()) + "', 'mock_fdk', 'dummy_path_" + std::to_string(rand()) + "', 1024, " + (is_complete ? "TRUE" : "FALSE") + ", " + del_val + ") RETURNING id;";

        auto res = W.exec(query);

        W.commit();

        uint64_t id = res[0][0].as<uint64_t>();
        chunker.write_chunk(id, 0, "dummy_data");

        return id;
    };

    auto create_folder = [&](bool is_in_trash=false) -> uint64_t {
        auto conn = pool.acquire_connection();
        pqxx::work W(*conn);
        std::string del_val = is_in_trash ? "NOW()" : "NULL";

        auto res = W.exec("INSERT INTO folders (user_id, encrypted_name, name_hash, deleted_at) VALUES (" + std::to_string(user_id) + ", 'sub_folder', 'hash2_" + std::to_string(rand()) + "', " + del_val + ") RETURNING id;");

        W.commit();

        return res[0][0].as<uint64_t>();
    };

    auto set_created_at = [&](uint64_t file_id, const std::string& interval) {
        auto conn = pool.acquire_connection();
        pqxx::work W(*conn);

        W.exec("UPDATE files SET created_at = NOW() - INTERVAL '" + interval + "' WHERE id = " + std::to_string(file_id) + ";");

        W.commit();
    };

    auto set_deleted_at = [&](uint64_t file_id, const std::string& interval) {
        auto conn = pool.acquire_connection();
        pqxx::work W(*conn);

        W.exec("UPDATE files SET deleted_at = NOW() - INTERVAL '" + interval + "' WHERE id = " + std::to_string(file_id) + ";");

        W.commit();
    };

    auto set_folder_deleted_at = [&](uint64_t f_id, const std::string& interval) {
        auto conn = pool.acquire_connection();
        pqxx::work W(*conn);

        W.exec("UPDATE folders SET deleted_at = NOW() - INTERVAL '" + interval + "' WHERE id = " + std::to_string(f_id) + ";");

        W.commit();
    };

    auto file_exists_in_db = [&](uint64_t file_id) -> bool {
        auto conn = pool.acquire_connection();
        pqxx::work W(*conn);

        auto res = W.exec("SELECT count(*) FROM files WHERE id = " + std::to_string(file_id) + ";");

        return res[0][0].as<int>() > 0;
    };

    auto folder_exists_in_db = [&](uint64_t f_id) -> bool {
        auto conn = pool.acquire_connection();
        pqxx::work W(*conn);

        auto res = W.exec("SELECT count(*) FROM folders WHERE id = " + std::to_string(f_id) + ";");

        return res[0][0].as<int>() > 0;
    };

    auto file_exists_on_disk = [&](uint64_t file_id) -> bool {
        return std::filesystem::exists(std::filesystem::path(temp_vault) / (std::to_string(file_id) + ".dat"));
    };

    SECTION("1. Regra de 4 Horas (Uploads Incompletos)") {
        SECTION("Exaustao 1 (Recente): Upload incompleto com 3 horas. GC NAO deve apagar.") {
            uint64_t id = create_file(false);
            set_created_at(id, "3 hours");

            gc.run_cleanup();

            REQUIRE(file_exists_in_db(id) == true);
            REQUIRE(file_exists_on_disk(id) == true);
        }

        SECTION("Exaustao 2 (Expirado): Upload incompleto com 5 horas. GC DEVE apagar.") {
            uint64_t id = create_file(false);
            set_created_at(id, "5 hours");

            gc.run_cleanup();

            REQUIRE(file_exists_in_db(id) == false);
            REQUIRE(file_exists_on_disk(id) == false);
        }

        SECTION("Exaustao 3 (Completo e Antigo): Upload COMPLETO com 5 horas. GC NAO deve apagar.") {
            uint64_t id = create_file(true);
            set_created_at(id, "5 hours");

            gc.run_cleanup();

            REQUIRE(file_exists_in_db(id) == true);
            REQUIRE(file_exists_on_disk(id) == true);
        }
    }

    SECTION("2. Regra de 30 Dias (Lixeira)") {
        SECTION("Exaustao 4 (Lixeira Recente): Arquivo na lixeira ha 29 dias. GC NAO deve apagar.") {
            uint64_t id = create_file(true, true);
            set_deleted_at(id, "29 days");

            gc.run_cleanup();

            REQUIRE(file_exists_in_db(id) == true);
            REQUIRE(file_exists_on_disk(id) == true);
        }

        SECTION("Exaustao 5 (Lixeira Expirada): Arquivo na lixeira ha 31 dias. GC DEVE apagar.") {
            uint64_t id = create_file(true, true);
            set_deleted_at(id, "31 days");

            gc.run_cleanup();

            REQUIRE(file_exists_in_db(id) == false);
            REQUIRE(file_exists_on_disk(id) == false);
        }

        SECTION("Exaustao 6 (Ativo e Antigo): Arquivo ativo criado ha 60 dias. GC NAO deve apagar.") {
            uint64_t id = create_file(true, false);
            set_created_at(id, "60 days");

            gc.run_cleanup();

            REQUIRE(file_exists_in_db(id) == true);
            REQUIRE(file_exists_on_disk(id) == true);
        }
    }

    SECTION("3. Cascata e Pastas na Lixeira") {
        SECTION("Exaustao 7 (Pasta Expirada): Pasta na lixeira ha 31 dias contendo um arquivo vazio/ativo.") {
            uint64_t folder_id = create_folder(true);
            set_folder_deleted_at(folder_id, "31 days");

            uint64_t file_id = create_file(true, true, folder_id);
            set_deleted_at(file_id, "31 days"); 

            gc.run_cleanup();

            REQUIRE(file_exists_in_db(file_id) == false);
            REQUIRE(folder_exists_in_db(folder_id) == false);
            REQUIRE(file_exists_on_disk(file_id) == false);
        }
    }

    SECTION("4. Limpeza Hibrida e Volume") {
        SECTION("Exaustao 8 (Mix de Lixo): Inserir 10 itens validos e 10 itens expirados.") {
            std::vector<uint64_t> valid_ids;
            std::vector<uint64_t> expired_ids;

            for(int i=0; i<5; i++) {
                uint64_t id1 = create_file(false);
                set_created_at(id1, "3 hours");
                valid_ids.push_back(id1);


                uint64_t id2 = create_file(true, true);
                set_deleted_at(id2, "29 days");
                valid_ids.push_back(id2);
                

                uint64_t id3 = create_file(false);
                set_created_at(id3, "5 hours");
                expired_ids.push_back(id3);


                uint64_t id4 = create_file(true, true);
                set_deleted_at(id4, "31 days");
                expired_ids.push_back(id4);
            }

            gc.run_cleanup();

            for(auto id : valid_ids) {
                REQUIRE(file_exists_in_db(id) == true);
                REQUIRE(file_exists_on_disk(id) == true);
            }

            for(auto id : expired_ids) {
                REQUIRE(file_exists_in_db(id) == false);
                REQUIRE(file_exists_on_disk(id) == false);
            }
        }
    }

    SECTION("5. Resiliencia a Falhas Fisicas (Orphaned DB Records)") {
        SECTION("Exaustao 9 (Falta de Sincronia): Arquivo expirado no DB, chunk ausente no disco.") {
            uint64_t id = create_file(false);
            set_created_at(id, "5 hours");

            chunker.delete_file(id);
            REQUIRE(file_exists_on_disk(id) == false);

            REQUIRE_NOTHROW(gc.run_cleanup());

            REQUIRE(file_exists_in_db(id) == false);
        }
    }

    {
        auto conn = pool.acquire_connection();
        pqxx::work W(*conn);
        W.exec("DELETE FROM users WHERE id = " + std::to_string(user_id) + ";");
        W.commit();
    }

    std::filesystem::remove_all(temp_vault);
}

TEST_CASE("GC reconcilia target Google criado depois do cancelamento", "[gc][storage-move][reconcile]") {
    DatabasePool pool(2, get_secure_conn_string());
    const std::string temp_vault = "./vault_gc_reconcile_test/";
    std::filesystem::remove_all(temp_vault);
    FileChunker chunker(temp_vault);
    MockGoogleDriveService gdrive(pool);
    gdrive.override_reconciliation = true;
    gdrive.reconciliation_targets = {"late-target"};
    FileManager manager(pool);

    uint64_t user_id;
    uint64_t storage_id;
    uint64_t move_id;
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username='gc_reconcile_test'");
        user_id = txn.exec(
            "INSERT INTO users(username,email,is_email_verified,max_storage_bytes,used_storage_bytes) "
            "VALUES('gc_reconcile_test','gc_reconcile_test@example.com',TRUE,100000,0) RETURNING id")[0][0].as<uint64_t>();
        storage_id = txn.exec(
            "INSERT INTO user_external_storages(user_id,provider,account_email,refresh_token,root_folder_id) "
            "VALUES($1,'google_drive','gc-reconcile@example.com','refresh','root') RETURNING id",
            pqxx::params{user_id})[0][0].as<uint64_t>();
        const auto file_id = txn.exec(
            "INSERT INTO files(user_id,encrypted_name,name_hash,encrypted_fdk,size_bytes,is_upload_complete,storage_provider,physical_path) "
            "VALUES($1,'cipher','gc-reconcile-file','fdk',10,TRUE,'local','gc-reconcile.dat') RETURNING id",
            pqxx::params{user_id})[0][0].as<uint64_t>();
        txn.commit();

        const auto move = crow::json::load(manager.start_storage_move(user_id, file_id, "google_drive", storage_id, 1000).dump());
        move_id = static_cast<uint64_t>(move["id"].i());
    }

    manager.cancel_storage_move(user_id, move_id);
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        REQUIRE(txn.exec("SELECT COUNT(*) FROM pending_storage_move_reconciliations WHERE move_job_id=$1", pqxx::params{move_id})[0][0].as<int>() == 1);
        txn.commit();
    }
    REQUIRE_THROWS(gdrive.unlink_account(user_id, storage_id));

    GarbageCollector gc(pool, &chunker, &gdrive);
    int attempts_before;
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("UPDATE pending_storage_move_reconciliations SET expires_at=CURRENT_TIMESTAMP,next_attempt_at=CURRENT_TIMESTAMP WHERE move_job_id=$1", pqxx::params{move_id});
        attempts_before = txn.exec("SELECT attempts FROM pending_storage_move_reconciliations WHERE move_job_id=$1", pqxx::params{move_id})[0][0].as<int>();
        txn.commit();
    }
    gdrive.reconciliation_fails = true;
    gdrive.reconciliation_targets.clear();
    gc.run_cleanup();
    REQUIRE(gdrive.reconciliation_requests > 0);
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        const auto reconciliation = txn.exec("SELECT attempts,last_error FROM pending_storage_move_reconciliations WHERE move_job_id=$1", pqxx::params{move_id});
        REQUIRE(reconciliation.size() == 1);
        REQUIRE(reconciliation[0][0].as<int>() > attempts_before);
        REQUIRE(reconciliation[0][1].as<std::string>() == "GOOGLE_RECONCILE_FAILED");
        REQUIRE(txn.exec("SELECT next_attempt_at > CURRENT_TIMESTAMP FROM pending_storage_move_reconciliations WHERE move_job_id=$1", pqxx::params{move_id})[0][0].as<bool>());
        REQUIRE(txn.exec("SELECT COUNT(*) FROM pending_external_deletions WHERE move_job_id=$1", pqxx::params{move_id})[0][0].as<int>() == 0);
        REQUIRE(txn.exec("SELECT COUNT(*) FROM storage_move_jobs WHERE id=$1", pqxx::params{move_id})[0][0].as<int>() == 1);
        REQUIRE(txn.exec("SELECT storage_provider FROM files WHERE id=(SELECT file_id FROM storage_move_jobs WHERE id=$1)", pqxx::params{move_id})[0][0].as<std::string>() == "local");
        txn.commit();
    }
    REQUIRE_THROWS(manager.clear_storage_move(user_id, move_id));
    REQUIRE_THROWS(gdrive.unlink_account(user_id, storage_id));

    gdrive.reconciliation_fails = false;
    gdrive.reconciliation_targets = {"late-target"};
    gdrive.deletion_status = 503;
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("UPDATE pending_storage_move_reconciliations SET next_attempt_at=CURRENT_TIMESTAMP WHERE move_job_id=$1", pqxx::params{move_id});
        txn.commit();
    }

    gc.run_cleanup();
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        REQUIRE(txn.exec("SELECT COUNT(*) FROM pending_storage_move_reconciliations WHERE move_job_id=$1", pqxx::params{move_id})[0][0].as<int>() == 0);
        REQUIRE(txn.exec("SELECT COUNT(*) FROM pending_external_deletions WHERE move_job_id=$1", pqxx::params{move_id})[0][0].as<int>() == 1);
        REQUIRE(txn.exec("SELECT external_file_id FROM pending_external_deletions WHERE move_job_id=$1", pqxx::params{move_id})[0][0].as<std::string>() == "late-target");
        REQUIRE_THROWS(manager.clear_storage_move(user_id, move_id));
        txn.commit();
    }

    gdrive.deletion_status = 204;
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("UPDATE pending_external_deletions SET next_retry_at=CURRENT_TIMESTAMP WHERE move_job_id=$1", pqxx::params{move_id});
        txn.commit();
    }
    gc.run_cleanup();
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        REQUIRE(txn.exec("SELECT COUNT(*) FROM pending_external_deletions WHERE move_job_id=$1", pqxx::params{move_id})[0][0].as<int>() == 0);
        txn.commit();
    }
    REQUIRE_NOTHROW(manager.clear_storage_move(user_id, move_id));

    uint64_t empty_move_id;
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        const auto empty_file_id = txn.exec(
            "INSERT INTO files(user_id,encrypted_name,name_hash,encrypted_fdk,size_bytes,is_upload_complete,storage_provider,physical_path) "
            "VALUES($1,'cipher-empty','gc-reconcile-empty','fdk',10,TRUE,'local','gc-reconcile-empty.dat') RETURNING id",
            pqxx::params{user_id})[0][0].as<uint64_t>();
        txn.commit();
        const auto empty_move = crow::json::load(manager.start_storage_move(user_id, empty_file_id, "google_drive", storage_id, 1000).dump());
        empty_move_id = static_cast<uint64_t>(empty_move["id"].i());
    }
    manager.cancel_storage_move(user_id, empty_move_id);
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("UPDATE pending_storage_move_reconciliations SET expires_at=CURRENT_TIMESTAMP,next_attempt_at=CURRENT_TIMESTAMP WHERE move_job_id=$1", pqxx::params{empty_move_id});
        txn.commit();
    }
    gdrive.reconciliation_targets.clear();
    gc.run_cleanup();
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        REQUIRE(txn.exec("SELECT COUNT(*) FROM pending_storage_move_reconciliations WHERE move_job_id=$1", pqxx::params{empty_move_id})[0][0].as<int>() == 0);
        REQUIRE(txn.exec("SELECT COUNT(*) FROM pending_external_deletions WHERE move_job_id=$1", pqxx::params{empty_move_id})[0][0].as<int>() == 0);
        txn.commit();
    }
    REQUIRE_NOTHROW(manager.clear_storage_move(user_id, empty_move_id));
    REQUIRE_NOTHROW(gdrive.unlink_account(user_id, storage_id));

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE id=$1", pqxx::params{user_id});
        txn.commit();
    }
    std::filesystem::remove_all(temp_vault);
}

TEST_CASE("GC preserva quarantine recuperavel Local para Google apos restart", "[gc][storage-move][recovery]") {
    DatabasePool pool(2, get_secure_conn_string());
    const std::string temp_vault = "./vault_gc_storage_move_recovery/";
    std::filesystem::remove_all(temp_vault);
    FileChunker chunker(temp_vault);
    FileManager manager(pool);
    GarbageCollector gc(pool, &chunker);
    uint64_t user_id;
    uint64_t storage_id;
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username='gc_storage_move_recovery_test'");
        user_id = txn.exec(
            "INSERT INTO users(username,email,is_email_verified,max_storage_bytes,used_storage_bytes) "
            "VALUES('gc_storage_move_recovery_test','gc_storage_move_recovery@test.com',TRUE,1000000,0) RETURNING id")[0][0].as<uint64_t>();
        storage_id = txn.exec(
            "INSERT INTO user_external_storages(user_id,provider,account_email,refresh_token) "
            "VALUES($1,'google_drive','gc-recovery@example.com','refresh') RETURNING id",
            pqxx::params{user_id})[0][0].as<uint64_t>();
        txn.commit();
    }

    auto create_file = [&](const std::string& suffix, bool with_proxy) {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        const auto file_id = txn.exec(
            "INSERT INTO files(user_id,encrypted_name,name_hash,encrypted_fdk,size_bytes,proxy_size_bytes,total_chunks,"
            "is_upload_complete,storage_provider,physical_path,proxy_physical_path) "
            "VALUES($1,$2,$3,'fdk',10,$4,1,TRUE,'local',$5,$6) RETURNING id",
            pqxx::params{user_id,"gc-cipher-" + suffix,"gc-hash-" + suffix,
                         with_proxy ? std::optional<uint64_t>(5) : std::nullopt,
                         "source-" + suffix + ".dat",
                         with_proxy ? std::optional<std::string>("source-" + suffix + ".proxy.dat") : std::nullopt})[0][0].as<uint64_t>();
        txn.commit();
        REQUIRE(chunker.write_chunk(file_id, 0, "0123456789"));
        if (with_proxy) {
            std::ofstream proxy(std::filesystem::path(temp_vault) / (std::to_string(file_id) + ".proxy.dat"), std::ios::binary);
            proxy << "proxy";
        }
        return file_id;
    };

    auto prepare_move = [&](uint64_t file_id, const std::string& suffix) {
        const auto move = crow::json::load(manager.start_storage_move(user_id, file_id, "google_drive", storage_id, 100000).dump());
        const uint64_t move_id = static_cast<uint64_t>(move["id"].i());
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        const auto items = txn.exec("SELECT id,role FROM storage_move_items WHERE move_job_id=$1", pqxx::params{move_id});
        txn.commit();
        for (const auto& item : items) {
            manager.mark_storage_move_item_uploaded(
                user_id, move_id, item[0].as<uint64_t>(),
                "gc-target-" + suffix + "-" + item[1].as<std::string>());
        }
        return move_id;
    };

    auto pending_count = [&](uint64_t move_id) {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        const auto count = txn.exec("SELECT COUNT(*) FROM pending_local_deletions WHERE move_job_id=$1", pqxx::params{move_id})[0][0].as<int>();
        txn.commit();
        return count;
    };

    const auto target_uploaded_file = create_file("target-uploaded", false);
    const auto target_uploaded_move = prepare_move(target_uploaded_file, "target-uploaded");
    chunker.quarantine_file(target_uploaded_file, target_uploaded_move);
    REQUIRE_FALSE(chunker.try_get_file_size(target_uploaded_file).has_value());
    REQUIRE(chunker.try_get_quarantined_file_size(target_uploaded_move) == std::optional<uint64_t>(10));
    REQUIRE(pending_count(target_uploaded_move) == 0);
    gc.run_cleanup();
    REQUIRE(chunker.try_get_quarantined_file_size(target_uploaded_move) == std::optional<uint64_t>(10));
    REQUIRE(crow::json::load(manager.complete_storage_move(user_id, target_uploaded_move, chunker).dump())["status"].s() == "cleanup_pending");
    REQUIRE(pending_count(target_uploaded_move) == 1);
    gc.run_cleanup();
    REQUIRE_FALSE(chunker.try_get_quarantined_file_size(target_uploaded_move).has_value());
    REQUIRE(crow::json::load(manager.get_storage_move(user_id, target_uploaded_move).dump())["status"].s() == "completed");

    const auto paused_file = create_file("paused", false);
    const auto paused_move = prepare_move(paused_file, "paused");
    chunker.quarantine_file(paused_file, paused_move);
    manager.record_storage_move_failure(user_id, paused_move, "STORAGE_MOVE_TARGET_INCOMPLETE", "commit", true, {}, &chunker);
    REQUIRE(crow::json::load(manager.get_storage_move(user_id, paused_move).dump())["status"].s() == "paused");
    gc.run_cleanup();
    REQUIRE(chunker.try_get_quarantined_file_size(paused_move) == std::optional<uint64_t>(10));
    manager.set_storage_move_status(user_id, paused_move, "resume");
    REQUIRE(crow::json::load(manager.get_storage_move(user_id, paused_move).dump())["status"].s() == "target_uploaded");
    REQUIRE(crow::json::load(manager.complete_storage_move(user_id, paused_move, chunker).dump())["status"].s() == "cleanup_pending");

    const auto bundle_file = create_file("bundle", true);
    const auto bundle_move = prepare_move(bundle_file, "bundle");
    chunker.quarantine_file(bundle_file, bundle_move);
    chunker.quarantine_proxy(bundle_file, bundle_move);
    gc.run_cleanup();
    REQUIRE(chunker.try_get_quarantined_file_size(bundle_move) == std::optional<uint64_t>(10));
    REQUIRE(chunker.try_get_quarantined_proxy_size(bundle_move) == std::optional<uint64_t>(5));
    REQUIRE(crow::json::load(manager.complete_storage_move(user_id, bundle_move, chunker).dump())["status"].s() == "cleanup_pending");

    const auto orphan_dir = std::filesystem::path(temp_vault) / "storage-moves";
    std::ofstream(orphan_dir / "cleanup-999999999.dat") << "orphan";
    std::ofstream(orphan_dir / "cleanup-999999999.proxy.dat") << "orphan";
    std::ofstream(orphan_dir / "item-999999999.part") << "orphan";
    std::ofstream(orphan_dir / "cleanup-42evil.dat") << "keep";
    std::ofstream(orphan_dir / "item-31garbage.part") << "keep";
    gc.run_cleanup();
    REQUIRE_FALSE(std::filesystem::exists(orphan_dir / "cleanup-999999999.dat"));
    REQUIRE_FALSE(std::filesystem::exists(orphan_dir / "cleanup-999999999.proxy.dat"));
    REQUIRE_FALSE(std::filesystem::exists(orphan_dir / "item-999999999.part"));
    REQUIRE(std::filesystem::exists(orphan_dir / "cleanup-42evil.dat"));
    REQUIRE(std::filesystem::exists(orphan_dir / "item-31garbage.part"));

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE id=$1", pqxx::params{user_id});
        txn.commit();
    }
    std::filesystem::remove_all(temp_vault);
}

TEST_CASE("B.31 GC nao destrói arquivo restaurado durante a coleta", "[gc][b31]") {
    DatabasePool pool(4, get_secure_conn_string());
    const std::string temp_vault = "./vault_gc_b31_restore/";
    std::filesystem::remove_all(temp_vault);
    FileChunker chunker(temp_vault);
    GarbageCollector gc(pool, &chunker);

    uint64_t user_id;
    uint64_t file_id;
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username='gc_b31_restore'");
        user_id = txn.exec(
            "INSERT INTO users(username,email,password_hash,is_email_verified,max_storage_bytes,used_storage_bytes) "
            "VALUES('gc_b31_restore','gc_b31_restore@example.com','hash',TRUE,100000,1024) RETURNING id")[0][0].as<uint64_t>();
        file_id = txn.exec(
            "INSERT INTO files(user_id,encrypted_name,name_hash,encrypted_fdk,size_bytes,is_upload_complete,storage_provider,deleted_at) "
            "VALUES($1,'cipher','gc-b31-restore','fdk',1024,TRUE,'local',CURRENT_TIMESTAMP-INTERVAL '31 days') RETURNING id",
            pqxx::params{user_id})[0][0].as<uint64_t>();
        txn.commit();
    }
    REQUIRE(chunker.write_chunk(file_id, 0, "restore-me"));
    const auto path = std::filesystem::path(temp_vault) / (std::to_string(file_id) + ".dat");

    auto lock_conn = pool.acquire_connection();
    pqxx::work lock_txn(*lock_conn);
    REQUIRE_FALSE(lock_txn.exec("SELECT id FROM files WHERE id=$1 FOR UPDATE", pqxx::params{file_id}).empty());

    std::thread worker([&] { gc.run_cleanup(); });
    const bool gc_blocked = wait_for_gc_delete_lock(pool);

    lock_txn.exec("UPDATE files SET deleted_at=NULL WHERE id=$1", pqxx::params{file_id});
    lock_txn.commit();
    worker.join();
    REQUIRE(gc_blocked);

    auto verify_conn = pool.acquire_connection();
    pqxx::work verify_txn(*verify_conn);
    REQUIRE(verify_txn.exec("SELECT COUNT(*) FROM files WHERE id=$1", pqxx::params{file_id})[0][0].as<int>() == 1);
    REQUIRE(verify_txn.exec("SELECT used_storage_bytes FROM users WHERE id=$1", pqxx::params{user_id})[0][0].as<uint64_t>() == 1024);
    verify_txn.commit();

    REQUIRE(std::filesystem::exists(path));

    auto cleanup_conn = pool.acquire_connection();
    pqxx::work cleanup_txn(*cleanup_conn);
    cleanup_txn.exec("DELETE FROM users WHERE id=$1", pqxx::params{user_id});
    cleanup_txn.commit();
    std::filesystem::remove_all(temp_vault);
}

TEST_CASE("B.31 GC preserva upload que se torna completo durante a coleta", "[gc][b31]") {
    DatabasePool pool(4, get_secure_conn_string());
    const std::string temp_vault = "./vault_gc_b31_complete/";
    std::filesystem::remove_all(temp_vault);
    FileChunker chunker(temp_vault);
    GarbageCollector gc(pool, &chunker);

    uint64_t user_id;
    uint64_t file_id;
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username='gc_b31_complete'");
        user_id = txn.exec(
            "INSERT INTO users(username,email,password_hash,is_email_verified,max_storage_bytes,used_storage_bytes) "
            "VALUES('gc_b31_complete','gc_b31_complete@example.com','hash',TRUE,100000,1024) RETURNING id")[0][0].as<uint64_t>();
        file_id = txn.exec(
            "INSERT INTO files(user_id,encrypted_name,name_hash,encrypted_fdk,size_bytes,is_upload_complete,storage_provider,created_at) "
            "VALUES($1,'cipher','gc-b31-complete','fdk',1024,FALSE,'local',CURRENT_TIMESTAMP-INTERVAL '5 hours') RETURNING id",
            pqxx::params{user_id})[0][0].as<uint64_t>();
        txn.commit();
    }
    REQUIRE(chunker.write_chunk(file_id, 0, "complete-me"));
    const auto path = std::filesystem::path(temp_vault) / (std::to_string(file_id) + ".dat");

    auto lock_conn = pool.acquire_connection();
    pqxx::work lock_txn(*lock_conn);
    REQUIRE_FALSE(lock_txn.exec("SELECT id FROM files WHERE id=$1 FOR UPDATE", pqxx::params{file_id}).empty());

    std::thread worker([&] { gc.run_cleanup(); });
    const bool gc_blocked = wait_for_gc_delete_lock(pool);

    lock_txn.exec("UPDATE files SET is_upload_complete=TRUE WHERE id=$1", pqxx::params{file_id});
    lock_txn.commit();
    worker.join();
    REQUIRE(gc_blocked);

    auto verify_conn = pool.acquire_connection();
    pqxx::work verify_txn(*verify_conn);
    REQUIRE(verify_txn.exec("SELECT COUNT(*) FROM files WHERE id=$1", pqxx::params{file_id})[0][0].as<int>() == 1);
    REQUIRE(verify_txn.exec("SELECT used_storage_bytes FROM users WHERE id=$1", pqxx::params{user_id})[0][0].as<uint64_t>() == 1024);
    verify_txn.commit();

    REQUIRE(std::filesystem::exists(path));

    auto cleanup_conn = pool.acquire_connection();
    pqxx::work cleanup_txn(*cleanup_conn);
    cleanup_txn.exec("DELETE FROM users WHERE id=$1", pqxx::params{user_id});
    cleanup_txn.commit();
    std::filesystem::remove_all(temp_vault);
}

TEST_CASE("B.31 GC nao usa refund de quota para candidato stale", "[gc][b31]") {
    DatabasePool pool(4, get_secure_conn_string());
    const std::string temp_vault = "./vault_gc_b31_quota/";
    std::filesystem::remove_all(temp_vault);
    FileChunker chunker(temp_vault);
    GarbageCollector gc(pool, &chunker);

    uint64_t user_id;
    uint64_t file_id;
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username='gc_b31_quota'");
        user_id = txn.exec(
            "INSERT INTO users(username,email,password_hash,is_email_verified,max_storage_bytes,used_storage_bytes) "
            "VALUES('gc_b31_quota','gc_b31_quota@example.com','hash',TRUE,100000,1024) RETURNING id")[0][0].as<uint64_t>();
        file_id = txn.exec(
            "INSERT INTO files(user_id,encrypted_name,name_hash,encrypted_fdk,size_bytes,is_upload_complete,storage_provider,deleted_at) "
            "VALUES($1,'cipher','gc-b31-quota','fdk',1024,TRUE,'local',CURRENT_TIMESTAMP-INTERVAL '31 days') RETURNING id",
            pqxx::params{user_id})[0][0].as<uint64_t>();
        txn.commit();
    }
    REQUIRE(chunker.write_chunk(file_id, 0, "quota-me"));
    const auto path = std::filesystem::path(temp_vault) / (std::to_string(file_id) + ".dat");

    auto lock_conn = pool.acquire_connection();
    pqxx::work lock_txn(*lock_conn);
    REQUIRE_FALSE(lock_txn.exec("SELECT id FROM files WHERE id=$1 FOR UPDATE", pqxx::params{file_id}).empty());

    std::thread worker([&] { gc.run_cleanup(); });
    const bool gc_blocked = wait_for_gc_delete_lock(pool);

    lock_txn.exec("UPDATE files SET deleted_at=NULL WHERE id=$1", pqxx::params{file_id});
    lock_txn.commit();
    worker.join();
    REQUIRE(gc_blocked);

    auto verify_conn = pool.acquire_connection();
    pqxx::work verify_txn(*verify_conn);
    REQUIRE(verify_txn.exec("SELECT used_storage_bytes FROM users WHERE id=$1", pqxx::params{user_id})[0][0].as<uint64_t>() == 1024);
    verify_txn.commit();

    REQUIRE(std::filesystem::exists(path));

    auto cleanup_conn = pool.acquire_connection();
    pqxx::work cleanup_txn(*cleanup_conn);
    cleanup_txn.exec("DELETE FROM users WHERE id=$1", pqxx::params{user_id});
    cleanup_txn.commit();
    std::filesystem::remove_all(temp_vault);
}

TEST_CASE("B.31 GC nao remove arquivo valido criado depois do snapshot de orphans", "[gc][b31]") {
    DatabasePool pool(5, get_secure_conn_string());
    const std::string temp_vault = "./vault_gc_b31_orphan_snapshot/";
    std::filesystem::remove_all(temp_vault);
    FileChunker chunker(temp_vault);
    GarbageCollector gc(pool, &chunker);

    uint64_t user_id;
    uint64_t candidate_id;
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username='gc_b31_orphan'");
        user_id = txn.exec(
            "INSERT INTO users(username,email,password_hash,is_email_verified,max_storage_bytes,used_storage_bytes) "
            "VALUES('gc_b31_orphan','gc_b31_orphan@example.com','hash',TRUE,100000,0) RETURNING id")[0][0].as<uint64_t>();
        candidate_id = txn.exec(
            "INSERT INTO files(user_id,encrypted_name,name_hash,encrypted_fdk,size_bytes,is_upload_complete,storage_provider,created_at) "
            "VALUES($1,'cipher','gc-b31-orphan-candidate','fdk',8,FALSE,'local',CURRENT_TIMESTAMP-INTERVAL '5 hours') RETURNING id",
            pqxx::params{user_id})[0][0].as<uint64_t>();
        txn.commit();
    }
    REQUIRE(chunker.write_chunk(candidate_id, 0, "candidate"));
    const auto candidate_path = std::filesystem::path(temp_vault) / (std::to_string(candidate_id) + ".dat");

    auto lock_conn = pool.acquire_connection();
    pqxx::work lock_txn(*lock_conn);
    REQUIRE_FALSE(lock_txn.exec("SELECT id FROM files WHERE id=$1 FOR UPDATE", pqxx::params{candidate_id}).empty());

    std::thread worker([&] { gc.run_cleanup(); });
    const bool gc_blocked = wait_for_gc_delete_lock(pool);

    uint64_t new_file_id;
    {
        auto create_conn = pool.acquire_connection();
        pqxx::work create_txn(*create_conn);
        new_file_id = create_txn.exec(
            "INSERT INTO files(user_id,encrypted_name,name_hash,encrypted_fdk,size_bytes,is_upload_complete,storage_provider) "
            "VALUES($1,'cipher','gc-b31-orphan-new','fdk',8,TRUE,'local') RETURNING id",
            pqxx::params{user_id})[0][0].as<uint64_t>();
        create_txn.commit();
    }
    REQUIRE(chunker.write_chunk(new_file_id, 0, "new-file"));
    const auto new_path = std::filesystem::path(temp_vault) / (std::to_string(new_file_id) + ".dat");
    REQUIRE(std::filesystem::exists(new_path));

    lock_txn.commit();
    worker.join();
    REQUIRE(gc_blocked);

    auto verify_conn = pool.acquire_connection();
    pqxx::work verify_txn(*verify_conn);
    REQUIRE(verify_txn.exec("SELECT COUNT(*) FROM files WHERE id=$1", pqxx::params{new_file_id})[0][0].as<int>() == 1);
    verify_txn.commit();
    REQUIRE(std::filesystem::exists(new_path));

    auto cleanup_conn = pool.acquire_connection();
    pqxx::work cleanup_txn(*cleanup_conn);
    cleanup_txn.exec("DELETE FROM users WHERE id=$1", pqxx::params{user_id});
    cleanup_txn.commit();
    std::filesystem::remove_all(temp_vault);
}

TEST_CASE("B.31 micro freeze - GC defers a canonical file created during its run", "[gc][b31-micro]") {
    DatabasePool pool(5, get_secure_conn_string());
    const std::string temp_vault = "./vault_gc_b31_created_during_run/";
    std::filesystem::remove_all(temp_vault);
    FileChunker chunker(temp_vault);
    GarbageCollector gc(pool, &chunker);

    uint64_t user_id;
    uint64_t expired_file_id;
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username='gc_b31_created_during_run'");
        user_id = txn.exec(
            "INSERT INTO users(username,email,password_hash,is_email_verified,max_storage_bytes,used_storage_bytes) "
            "VALUES('gc_b31_created_during_run','gc_b31_created_during_run@example.com','hash',TRUE,100000,0) RETURNING id"
        )[0][0].as<uint64_t>();
        expired_file_id = txn.exec(
            "INSERT INTO files(user_id,encrypted_name,name_hash,encrypted_fdk,size_bytes,is_upload_complete,storage_provider,created_at) "
            "VALUES($1,'cipher','gc-b31-created-during-run','fdk',8,FALSE,'local',CURRENT_TIMESTAMP-INTERVAL '5 hours') RETURNING id",
            pqxx::params{user_id})[0][0].as<uint64_t>();
        txn.commit();
    }

    auto lock_conn = pool.acquire_connection();
    pqxx::work lock_txn(*lock_conn);
    REQUIRE_FALSE(lock_txn.exec("SELECT id FROM files WHERE id=$1 FOR UPDATE", pqxx::params{expired_file_id}).empty());

    std::thread worker([&] { gc.run_cleanup(); });
    const bool gc_blocked = wait_for_gc_delete_lock(pool);

    uint64_t created_during_gc;
    {
        auto create_conn = pool.acquire_connection();
        pqxx::read_transaction create_txn(*create_conn);
        created_during_gc = create_txn.exec("SELECT COALESCE(MAX(id),0)+1 FROM files")[0][0].as<uint64_t>();
        create_txn.commit();
    }
    REQUIRE(chunker.write_chunk(created_during_gc, 0, "created-during-gc"));
    const auto created_path = std::filesystem::path(temp_vault) / (std::to_string(created_during_gc) + ".dat");
    REQUIRE(std::filesystem::exists(created_path));

    lock_txn.commit();
    worker.join();
    REQUIRE(gc_blocked);
    REQUIRE(std::filesystem::exists(created_path));

    gc.run_cleanup();
    REQUIRE_FALSE(std::filesystem::exists(created_path));

    auto cleanup_conn = pool.acquire_connection();
    pqxx::work cleanup_txn(*cleanup_conn);
    cleanup_txn.exec("DELETE FROM users WHERE id=$1", pqxx::params{user_id});
    cleanup_txn.commit();
    std::filesystem::remove_all(temp_vault);
}

TEST_CASE("B.31 GC removes expired canonical and proxy files", "[gc][b31-micro]") {
    DatabasePool pool(2, get_secure_conn_string());
    const std::string temp_vault = "./vault_gc_b31_proxy_cleanup/";
    std::filesystem::remove_all(temp_vault);
    FileChunker chunker(temp_vault);
    GarbageCollector gc(pool, &chunker);

    uint64_t user_id;
    uint64_t file_id;
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username='gc_b31_proxy_cleanup'");
        user_id = txn.exec(
            "INSERT INTO users(username,email,password_hash,is_email_verified,max_storage_bytes,used_storage_bytes) "
            "VALUES('gc_b31_proxy_cleanup','gc_b31_proxy_cleanup@example.com','hash',TRUE,100000,1024) RETURNING id"
        )[0][0].as<uint64_t>();
        file_id = txn.exec(
            "INSERT INTO files(user_id,encrypted_name,name_hash,encrypted_fdk,size_bytes,proxy_size_bytes,"
            "is_upload_complete,storage_provider,deleted_at,physical_path,proxy_physical_path) "
            "VALUES($1,'cipher','gc-b31-proxy','fdk',9,5,TRUE,'local',CURRENT_TIMESTAMP-INTERVAL '31 days',"
            "'source.dat','source.proxy.dat') RETURNING id",
            pqxx::params{user_id})[0][0].as<uint64_t>();
        txn.commit();
    }
    REQUIRE(chunker.write_chunk(file_id, 0, "live-data"));
    const auto proxy_path = std::filesystem::path(temp_vault) / (std::to_string(file_id) + ".proxy.dat");
    std::ofstream(proxy_path, std::ios::binary) << "proxy";

    gc.run_cleanup();

    REQUIRE_FALSE(std::filesystem::exists(std::filesystem::path(temp_vault) / (std::to_string(file_id) + ".dat")));
    REQUIRE_FALSE(std::filesystem::exists(proxy_path));

    auto cleanup_conn = pool.acquire_connection();
    pqxx::work cleanup_txn(*cleanup_conn);
    cleanup_txn.exec("DELETE FROM users WHERE id=$1", pqxx::params{user_id});
    cleanup_txn.commit();
    std::filesystem::remove_all(temp_vault);
}

TEST_CASE("B.71.E.3.M GC owns cancelled Google upload reconciliation", "[gc][googledrive][b71e3m]") {
    DatabasePool pool(2, get_secure_conn_string());
    MockGoogleDriveService gdrive(pool);
    GarbageCollector gc(pool, nullptr, &gdrive);
    constexpr uint64_t user_id = 9713001;

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE id=$1", pqxx::params{user_id});
        txn.exec(
            "INSERT INTO users(id,username,email,password_hash,is_email_verified,max_storage_bytes,used_storage_bytes) "
            "VALUES($1,'b71e3m-gc','b71e3m-gc@example.com','hash',TRUE,100000,10240)",
            pqxx::params{user_id});
        txn.commit();
    }

    const auto storage_id = [&] {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        const auto id = txn.exec(
            "INSERT INTO user_external_storages(user_id,provider,account_email,refresh_token,root_folder_id) "
            "VALUES($1,'google_drive','b71e3m@example.com','refresh','root') RETURNING id",
            pqxx::params{user_id})[0][0].as<uint64_t>();
        txn.commit();
        return id;
    }();

    const auto create_tombstone = [&](const std::string& name, const std::string& age) {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        const auto id = txn.exec(
            "INSERT INTO files(user_id,encrypted_name,name_hash,encrypted_fdk,size_bytes,total_chunks,"
            "is_upload_complete,storage_provider,external_storage_id,deleted_at,is_external_cleanup_pending) "
            "VALUES($1,$2,$3,'fdk',2048,1,FALSE,'google_drive',$4,CURRENT_TIMESTAMP-($5::interval),TRUE) RETURNING id",
            pqxx::params{user_id, name, name + "-hash", storage_id, age})[0][0].as<uint64_t>();
        txn.commit();
        return id;
    };

    gdrive.override_upload_reconciliation = true;

    const auto recent_id = create_tombstone("recent", "1 day");
    gdrive.upload_reconciliation_targets_by_file[recent_id] = {};
    gdrive.upload_reconciliation_targets.clear();
    gc.run_cleanup();
    {
        auto conn = pool.acquire_connection();
        pqxx::read_transaction txn(*conn);
        REQUIRE(txn.exec("SELECT count(*) FROM files WHERE id=$1", pqxx::params{recent_id})[0][0].as<int>() == 1);
        REQUIRE(txn.exec("SELECT used_storage_bytes FROM users WHERE id=$1", pqxx::params{user_id})[0][0].as<uint64_t>() == 10240);
    }

    const auto expired_id = create_tombstone("expired", "9 days");
    gdrive.upload_reconciliation_targets_by_file[expired_id] = {};
    gc.run_cleanup();
    {
        auto conn = pool.acquire_connection();
        pqxx::read_transaction txn(*conn);
        REQUIRE(txn.exec("SELECT count(*) FROM files WHERE id=$1", pqxx::params{expired_id})[0][0].as<int>() == 0);
        REQUIRE(txn.exec("SELECT used_storage_bytes FROM users WHERE id=$1", pqxx::params{user_id})[0][0].as<uint64_t>() == 8192);
    }

    const auto failed_id = create_tombstone("provider-failed", "9 days");
    gdrive.upload_reconciliation_targets_by_file[failed_id] = {};
    gdrive.upload_reconciliation_fails = true;
    gc.run_cleanup();
    gdrive.upload_reconciliation_fails = false;
    {
        auto conn = pool.acquire_connection();
        pqxx::read_transaction txn(*conn);
        REQUIRE(txn.exec("SELECT count(*) FROM files WHERE id=$1", pqxx::params{failed_id})[0][0].as<int>() == 1);
    }

    const auto matched_id = create_tombstone("matched", "1 day");
    gdrive.upload_reconciliation_targets_by_file[matched_id] = {"b71e3m-external"};
    gdrive.deletion_status = 500;
    gc.run_cleanup();
    {
        auto conn = pool.acquire_connection();
        pqxx::read_transaction txn(*conn);
        REQUIRE(txn.exec("SELECT count(*) FROM files WHERE id=$1", pqxx::params{matched_id})[0][0].as<int>() == 0);
        REQUIRE(txn.exec(
            "SELECT count(*) FROM pending_external_deletions WHERE external_file_id='b71e3m-external' AND external_storage_id=$1",
            pqxx::params{storage_id})[0][0].as<int>() == 1);
        REQUIRE(txn.exec("SELECT used_storage_bytes FROM users WHERE id=$1", pqxx::params{user_id})[0][0].as<uint64_t>() == 4096);
    }

    const auto ambiguous_id = create_tombstone("ambiguous", "9 days");
    gdrive.upload_reconciliation_targets_by_file[ambiguous_id] = {"b71e3m-a", "b71e3m-b"};
    gc.run_cleanup();
    {
        auto conn = pool.acquire_connection();
        pqxx::read_transaction txn(*conn);
        REQUIRE(txn.exec("SELECT count(*) FROM files WHERE id=$1", pqxx::params{ambiguous_id})[0][0].as<int>() == 1);
        REQUIRE(txn.exec("SELECT used_storage_bytes FROM users WHERE id=$1", pqxx::params{user_id})[0][0].as<uint64_t>() == 4096);
    }

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM pending_external_deletions WHERE external_storage_id=$1", pqxx::params{storage_id});
        txn.exec("DELETE FROM users WHERE id=$1", pqxx::params{user_id});
        txn.commit();
    }
}
