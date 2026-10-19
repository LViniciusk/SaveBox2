#include <catch2/catch_test_macros.hpp>
#include "controllers/ApiRouter.hpp"
#include "database/DatabaseMigration.hpp"
#include "database/DatabasePool.hpp"
#include "database/FileManager.hpp"
#include "database/FolderManager.hpp"
#include "Services/AuthService.hpp"
#include "storage/FileChunker.hpp"
#include "storage/GarbageCollector.hpp"
#include "test_helpers.hpp"
#include <crow_all.h>
#include <pqxx/pqxx>
#include <atomic>
#include <chrono>
#include <stdexcept>
#include <string>

namespace {

class B70SchemaFixture {
public:
    B70SchemaFixture()
        : schema_(next_schema()), pool_(1, get_secure_conn_string()) {
        pqxx::connection admin(get_secure_conn_string());
        pqxx::work create_schema(admin);
        create_schema.exec("CREATE SCHEMA " + schema_);
        create_schema.commit();

        {
            auto conn = pool_.acquire_connection();
            pqxx::work set_path(*conn);
            set_path.exec("SELECT set_config('search_path', $1, false)",
                          pqxx::params{schema_ + ", public"});
            set_path.commit();
        }
        if (!DatabaseMigration::run(pool_)) {
            throw std::runtime_error("B70 isolated schema setup failed");
        }
    }

    ~B70SchemaFixture() {
        try {
            pqxx::connection admin(get_secure_conn_string());
            pqxx::work drop_schema(admin);
            drop_schema.exec("DROP SCHEMA " + schema_ + " CASCADE");
            drop_schema.commit();
        } catch (...) {
        }
    }

    DatabasePool& pool() { return pool_; }
    const std::string& schema() const { return schema_; }

    void add_external(const std::string& id, int seconds) {
        auto conn = pool_.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec(
            "INSERT INTO pending_external_deletions "
            "(external_file_id, external_storage_id, next_retry_at) "
            "VALUES($1, 1, CURRENT_TIMESTAMP + ($2 * INTERVAL '1 second'))",
            pqxx::params{id, seconds});
        txn.commit();
    }

    uint64_t add_move() {
        auto conn = pool_.acquire_connection();
        pqxx::work txn(*conn);
        const auto user_id = txn.exec(
            "INSERT INTO users(username,email,password_hash,is_email_verified) "
            "VALUES($1,$2,'hash',TRUE) RETURNING id",
            pqxx::params{"b70-user-" + schema_, "b70-user-" + schema_ + "@test.invalid"})[0][0].as<uint64_t>();
        const auto file_id = txn.exec(
            "INSERT INTO files(user_id,encrypted_name,name_hash,encrypted_fdk) "
            "VALUES($1,'b70-file','b70-file-hash','b70-fdk') RETURNING id",
            pqxx::params{user_id})[0][0].as<uint64_t>();
        const auto storage_id = txn.exec(
            "INSERT INTO user_external_storages(user_id,account_email,refresh_token) "
            "VALUES($1,'b70@test.invalid','b70-token') RETURNING id",
            pqxx::params{user_id})[0][0].as<uint64_t>();
        const auto move_id = txn.exec(
            "INSERT INTO storage_move_jobs "
            "(user_id,file_id,source_provider,target_provider,total_bytes,target_external_storage_id) "
            "VALUES($1,$2,'local','google_drive',0,$3) RETURNING id",
            pqxx::params{user_id, file_id, storage_id})[0][0].as<uint64_t>();
        txn.commit();
        return move_id;
    }

    void add_local(uint64_t move_id, int seconds) {
        auto conn = pool_.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec(
            "INSERT INTO pending_local_deletions(move_job_id,next_retry_at) "
            "VALUES($1,CURRENT_TIMESTAMP + ($2 * INTERVAL '1 second'))",
            pqxx::params{move_id, seconds});
        txn.commit();
    }

    void add_reconciliation(uint64_t move_id, int seconds) {
        auto conn = pool_.acquire_connection();
        pqxx::work txn(*conn);
        const auto storage_id = txn.exec(
            "SELECT target_external_storage_id FROM storage_move_jobs WHERE id=$1",
            pqxx::params{move_id})[0][0].as<uint64_t>();
        txn.exec(
            "INSERT INTO pending_storage_move_reconciliations "
            "(move_job_id,external_storage_id,expires_at,next_attempt_at) "
            "VALUES($1,$2,CURRENT_TIMESTAMP + INTERVAL '1 day', "
            "CURRENT_TIMESTAMP + ($3 * INTERVAL '1 second'))",
            pqxx::params{move_id, storage_id, seconds});
        txn.commit();
    }

    int pending_external_count() {
        auto conn = pool_.acquire_connection();
        pqxx::read_transaction txn(*conn);
        const auto count = txn.exec("SELECT COUNT(*) FROM pending_external_deletions")[0][0].as<int>();
        txn.commit();
        return count;
    }

    void make_external_due(const std::string& id) {
        auto conn = pool_.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("UPDATE pending_external_deletions SET next_retry_at=CURRENT_TIMESTAMP WHERE external_file_id=$1",
                 pqxx::params{id});
        txn.commit();
    }

private:
    static std::string next_schema() {
        static std::atomic<unsigned int> sequence{0};
        return "b70_" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()) +
               "_" + std::to_string(sequence.fetch_add(1, std::memory_order_relaxed));
    }

    std::string schema_;
    DatabasePool pool_;
};

constexpr auto one_second = std::chrono::seconds(1);

struct ReconciliationSeed {
    uint64_t user_id;
    uint64_t storage_id;
    uint64_t move_id;
};

ReconciliationSeed seed_reconciliation_move(B70SchemaFixture& fixture) {
    auto conn = fixture.pool().acquire_connection();
    pqxx::work txn(*conn);
    const auto tag = fixture.schema();
    const auto user_id = txn.exec(
        "INSERT INTO users(username,email,password_hash,is_email_verified) "
        "VALUES($1,$2,'hash',TRUE) RETURNING id",
        pqxx::params{"b70m-user-" + tag, "b70m-user-" + tag + "@test.invalid"})[0][0].as<uint64_t>();
    const auto storage_id = txn.exec(
        "INSERT INTO user_external_storages(user_id,provider,account_email,refresh_token) "
        "VALUES($1,'google_drive',$2,'b70m-token') RETURNING id",
        pqxx::params{user_id, "b70m-account-" + tag + "@test.invalid"})[0][0].as<uint64_t>();
    const auto file_id = txn.exec(
        "INSERT INTO files(user_id,encrypted_name,name_hash,encrypted_fdk,size_bytes,total_chunks,is_upload_complete,storage_provider) "
        "VALUES($1,'b70m-file','b70m-file-hash','b70m-fdk',42,1,TRUE,'local') RETURNING id",
        pqxx::params{user_id})[0][0].as<uint64_t>();
    const auto move_id = txn.exec(
        "INSERT INTO storage_move_jobs(user_id,file_id,status,source_provider,target_provider,total_bytes,target_external_storage_id) "
        "VALUES($1,$2,'transferring','local','google_drive',42,$3) RETURNING id",
        pqxx::params{user_id, file_id, storage_id})[0][0].as<uint64_t>();
    txn.exec(
        "INSERT INTO storage_move_items(move_job_id,file_id,role,total_bytes,status) "
        "VALUES($1,$2,'original',42,'transferring')",
        pqxx::params{move_id, file_id});
    txn.commit();
    return {user_id, storage_id, move_id};
}

} // namespace

TEST_CASE("B.70 GC idle mantém intervalo de 24 horas e filtra capabilities",
          "[b70][gc][scheduler]") {
    B70SchemaFixture fixture;
    GarbageCollector without_capabilities(fixture.pool(), nullptr, nullptr);
    REQUIRE(without_capabilities.next_wake_delay() == std::chrono::hours(24));

    fixture.add_external("b70-capability", 0);
    REQUIRE(without_capabilities.next_wake_delay() == std::chrono::hours(24));

    GoogleDriveService gdrive(fixture.pool());
    GarbageCollector with_google(fixture.pool(), nullptr, &gdrive);
    REQUIRE(with_google.next_wake_delay() < one_second);
}

TEST_CASE("B.70 GC escolhe o menor deadline persistido por provider",
          "[b70][gc][deadline]") {
    B70SchemaFixture fixture;
    const auto move_id = fixture.add_move();
    fixture.add_external("b70-earliest-external", 8);
    fixture.add_local(move_id, 5);
    fixture.add_reconciliation(move_id, 3);

    FileChunker chunker("./vault_b70_deadline");
    GoogleDriveService gdrive(fixture.pool());
    GarbageCollector all_capabilities(fixture.pool(), &chunker, &gdrive);
    const auto all_delay = all_capabilities.next_wake_delay();
    REQUIRE(all_delay > one_second);
    REQUIRE(all_delay <= std::chrono::seconds(3));

    {
        auto conn = fixture.pool().acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM pending_storage_move_reconciliations");
        txn.commit();
    }
    GarbageCollector google_only(fixture.pool(), nullptr, &gdrive);
    const auto google_delay = google_only.next_wake_delay();
    REQUIRE(google_delay > std::chrono::seconds(5));
    REQUIRE(google_delay <= std::chrono::seconds(8));

    GarbageCollector local_only(fixture.pool(), &chunker, nullptr);
    const auto local_delay = local_only.next_wake_delay();
    REQUIRE(local_delay > std::chrono::seconds(2));
    REQUIRE(local_delay <= std::chrono::seconds(5));
}

TEST_CASE("B.70 GC trata overdue como imediato e limita deadline futuro ao ciclo diário",
          "[b70][gc][deadline]") {
    B70SchemaFixture fixture;
    GoogleDriveService gdrive(fixture.pool());
    GarbageCollector gc(fixture.pool(), nullptr, &gdrive);

    fixture.add_external("b70-overdue", -1);
    REQUIRE(gc.next_wake_delay() == std::chrono::milliseconds(0));

    {
        auto conn = fixture.pool().acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM pending_external_deletions");
        txn.commit();
    }

    fixture.add_external("b70-daily-cap", 3 * 24 * 60 * 60);
    REQUIRE(gc.next_wake_delay() == std::chrono::hours(24));
}

TEST_CASE("B.70 GC não processa retry futuro antes do not-before persistido",
          "[b70][gc][retry]") {
    B70SchemaFixture fixture;
    MockGoogleDriveService gdrive(fixture.pool());
    fixture.add_external("b70-future", 3);
    GarbageCollector gc(fixture.pool(), nullptr, &gdrive);

    gc.run_cleanup();

    REQUIRE(gdrive.deletion_requests == 0);
    REQUIRE(fixture.pending_external_count() == 1);
    REQUIRE(gc.next_wake_delay() > one_second);
}

TEST_CASE("B.70 GC preserva backoff de falha e remove deadline após sucesso",
          "[b70][gc][retry]") {
    B70SchemaFixture fixture;
    MockGoogleDriveService gdrive(fixture.pool());
    gdrive.deletion_status = 500;
    fixture.add_external("b70-failure", 0);
    GarbageCollector gc(fixture.pool(), nullptr, &gdrive);

    gc.run_cleanup();

    REQUIRE(gdrive.deletion_requests == 1);
    REQUIRE(fixture.pending_external_count() == 1);
    REQUIRE(gc.next_wake_delay() > std::chrono::seconds(50));
    REQUIRE(gc.next_wake_delay() <= std::chrono::seconds(60));

    gdrive.deletion_status = 204;
    fixture.make_external_due("b70-failure");
    gc.run_cleanup();

    REQUIRE(gdrive.deletion_requests == 2);
    REQUIRE(fixture.pending_external_count() == 0);
    REQUIRE(gc.next_wake_delay() == std::chrono::hours(24));
}

TEST_CASE("B.70.M reconcile storage move acorda GC apos commit do cleanup duplicado",
          "[b70m][gc][storage-move][api]") {
    B70SchemaFixture fixture;
    const auto seed = seed_reconciliation_move(fixture);
    MockEmailService email;
    AuthService auth("b70m-auth-secret", "b70m-auth-pepper", &email);
    FolderManager folders(fixture.pool());
    FileManager files(fixture.pool());
    MockGoogleDriveService gdrive(fixture.pool());
    gdrive.override_reconciliation = true;
    gdrive.reconciliation_targets = {"b70m-primary", "b70m-duplicate"};

    pqxx::connection observer_connection(get_secure_conn_string());
    {
        pqxx::work observer_setup(observer_connection);
        observer_setup.exec("SELECT set_config('search_path', $1, false)",
                            pqxx::params{fixture.schema() + ", public"});
        observer_setup.commit();
    }

    int cleanup_trigger_calls = 0;
    bool duplicate_visible_at_trigger = false;
    ApiRouter router(fixture.pool(), auth, folders, &files, nullptr, &gdrive, [&] {
        ++cleanup_trigger_calls;
        pqxx::read_transaction observer(observer_connection);
        duplicate_visible_at_trigger = observer.exec(
            "SELECT COUNT(*) FROM pending_external_deletions "
            "WHERE external_file_id='b70m-duplicate' AND external_storage_id=$1 AND move_job_id=$2",
            pqxx::params{seed.storage_id, seed.move_id})[0][0].as<int>() == 1;
        observer.commit();
    });

    crow::request request;
    request.url = "/storage-moves/" + std::to_string(seed.move_id) + "/reconcile";
    request.add_header("Authorization", "Bearer " + auth.generate_token(seed.user_id));
    const auto response = router.handle_reconcile_storage_move(request, static_cast<int>(seed.move_id));

    REQUIRE(response.code == 200);
    REQUIRE(gdrive.reconciliation_requests == 1);
    REQUIRE(cleanup_trigger_calls == 1);
    REQUIRE(duplicate_visible_at_trigger);

    pqxx::read_transaction observer(observer_connection);
    REQUIRE(observer.exec(
        "SELECT COUNT(*) FROM pending_external_deletions "
        "WHERE external_file_id='b70m-duplicate' AND external_storage_id=$1 AND move_job_id=$2",
        pqxx::params{seed.storage_id, seed.move_id})[0][0].as<int>() == 1);
    REQUIRE(observer.exec(
        "SELECT target_external_file_id FROM storage_move_items WHERE move_job_id=$1",
        pqxx::params{seed.move_id})[0][0].as<std::string>() == "b70m-primary");
    observer.commit();
}

TEST_CASE("B.70.M reconcile sem duplicata nao acorda GC",
          "[b70m][gc][storage-move][api]") {
    B70SchemaFixture fixture;
    const auto seed = seed_reconciliation_move(fixture);
    MockEmailService email;
    AuthService auth("b70m-no-duplicate-secret", "b70m-no-duplicate-pepper", &email);
    FolderManager folders(fixture.pool());
    FileManager files(fixture.pool());
    MockGoogleDriveService gdrive(fixture.pool());
    gdrive.override_reconciliation = true;
    gdrive.reconciliation_targets = {"b70m-primary-only"};
    int cleanup_trigger_calls = 0;
    ApiRouter router(fixture.pool(), auth, folders, &files, nullptr, &gdrive,
                     [&] { ++cleanup_trigger_calls; });

    crow::request request;
    request.url = "/storage-moves/" + std::to_string(seed.move_id) + "/reconcile";
    request.add_header("Authorization", "Bearer " + auth.generate_token(seed.user_id));
    const auto response = router.handle_reconcile_storage_move(request, static_cast<int>(seed.move_id));

    REQUIRE(response.code == 200);
    REQUIRE(gdrive.reconciliation_requests == 1);
    REQUIRE(cleanup_trigger_calls == 0);
    auto conn = fixture.pool().acquire_connection();
    pqxx::read_transaction txn(*conn);
    REQUIRE(txn.exec("SELECT COUNT(*) FROM pending_external_deletions WHERE move_job_id=$1",
                     pqxx::params{seed.move_id})[0][0].as<int>() == 0);
    REQUIRE(txn.exec(
        "SELECT target_external_file_id FROM storage_move_items WHERE move_job_id=$1",
        pqxx::params{seed.move_id})[0][0].as<std::string>() == "b70m-primary-only");
    txn.commit();
}
