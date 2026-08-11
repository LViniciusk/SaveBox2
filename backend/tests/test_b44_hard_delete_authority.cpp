#include <catch2/catch_test_macros.hpp>

#include "database/DatabasePool.hpp"
#include "database/FileManager.hpp"
#include "database/FolderManager.hpp"
#include "storage/FileChunker.hpp"
#include "test_helpers.hpp"

#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

namespace {

struct B44QuotaFailureGuard {
    DatabasePool& pool;
    const uint64_t user_id;
    const std::string function_name;
    const std::string trigger_name;

    B44QuotaFailureGuard(DatabasePool& pool_ref, uint64_t id)
        : pool(pool_ref),
          user_id(id),
          function_name("b44_fail_quota_" + std::to_string(id)),
          trigger_name("b44_quota_trigger_" + std::to_string(id)) {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DROP TRIGGER IF EXISTS " + trigger_name + " ON users");
        txn.exec("DROP FUNCTION IF EXISTS " + function_name + "()");
        txn.exec(
            "CREATE FUNCTION " + function_name + "() RETURNS trigger LANGUAGE plpgsql AS $$ "
            "BEGIN "
            "IF NEW.id = " + std::to_string(user_id) + " "
            "AND NEW.used_storage_bytes IS DISTINCT FROM OLD.used_storage_bytes THEN "
            "RAISE EXCEPTION 'B44_QUOTA_FAIL'; "
            "END IF; "
            "RETURN NEW; "
            "END; $$");
        txn.exec(
            "CREATE TRIGGER " + trigger_name +
            " BEFORE UPDATE OF used_storage_bytes ON users FOR EACH ROW EXECUTE FUNCTION " + function_name + "()");
        txn.commit();
    }

    ~B44QuotaFailureGuard() {
        try {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            txn.exec("DROP TRIGGER IF EXISTS " + trigger_name + " ON users");
            txn.exec("DROP FUNCTION IF EXISTS " + function_name + "()");
            txn.commit();
        } catch (...) {
        }
    }

    B44QuotaFailureGuard(const B44QuotaFailureGuard&) = delete;
    B44QuotaFailureGuard& operator=(const B44QuotaFailureGuard&) = delete;
};

struct B44Fixture {
    DatabasePool pool;
    FileManager files;
    FolderManager folders;
    std::filesystem::path root;
    FileChunker chunker;
    std::string username;
    uint64_t user_id = 0;

    explicit B44Fixture(std::string suffix)
        : pool(2, get_secure_conn_string()),
          files(pool),
          folders(pool),
          root("./test_storage_b44_" + suffix),
          chunker(root.string()),
          username("b44_" + std::move(suffix)) {
        std::filesystem::remove_all(root);
        std::filesystem::create_directories(root);

        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username=$1", pqxx::params{username});
        txn.exec("DELETE FROM pending_external_deletions WHERE external_file_id LIKE $1",
                 pqxx::params{username + "-%"});
        user_id = txn.exec(
            "INSERT INTO users(username,email,password_hash,is_email_verified,used_storage_bytes) "
            "VALUES($1,$2,'hash',TRUE,0) RETURNING id",
            pqxx::params{username, username + "@test.com"})[0][0].as<uint64_t>();
        txn.commit();
    }

    ~B44Fixture() {
        try {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            txn.exec("DELETE FROM pending_external_deletions WHERE external_file_id LIKE $1",
                     pqxx::params{username + "-%"});
            txn.exec("DELETE FROM users WHERE id=$1", pqxx::params{user_id});
            txn.commit();
        } catch (...) {
        }
        std::filesystem::remove_all(root);
    }

    long long count(const std::string& query) {
        auto conn = pool.acquire_connection();
        pqxx::nontransaction txn(*conn);
        return txn.exec(query)[0][0].as<long long>();
    }

    void set_quota(uint64_t bytes) {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("UPDATE users SET used_storage_bytes=$1 WHERE id=$2", pqxx::params{bytes, user_id});
        txn.commit();
    }

    uint64_t create_folder(const std::string& name, bool trashed = true, uint64_t parent_id = 0) {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        const auto id = txn.exec(
            "INSERT INTO folders(user_id,parent_id,encrypted_name,name_hash,deleted_at) "
            "VALUES($1,NULLIF($2::bigint,0),$3,$4,CASE WHEN $5 THEN CURRENT_TIMESTAMP ELSE NULL END) RETURNING id",
            pqxx::params{user_id, parent_id, "cipher-folder-" + name, "b44-" + username + "-" + name, trashed})[0][0].as<uint64_t>();
        txn.commit();
        return id;
    }

    uint64_t create_local_file(const std::string& name, uint64_t size, bool trashed = true, uint64_t folder_id = 0) {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        const auto id = txn.exec(
            "INSERT INTO files(user_id,folder_id,encrypted_name,name_hash,encrypted_fdk,size_bytes,total_chunks,"
            "is_upload_complete,storage_provider,deleted_at) "
            "VALUES($1,NULLIF($2::bigint,0),$3,$4,'fdk',$5,1,TRUE,'local',"
            "CASE WHEN $6 THEN CURRENT_TIMESTAMP ELSE NULL END) RETURNING id",
            pqxx::params{user_id, folder_id, "cipher-file-" + name, "b44-" + username + "-" + name, size, trashed})[0][0].as<uint64_t>();
        txn.commit();
        std::ofstream output(root / (std::to_string(id) + ".dat"), std::ios::binary);
        output << std::string(size, 'x');
        return id;
    }

    uint64_t create_google_storage() {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        const auto id = txn.exec(
            "INSERT INTO user_external_storages(user_id,provider,account_email,refresh_token,root_folder_id) "
            "VALUES($1,'google_drive',$2,'refresh','root') RETURNING id",
            pqxx::params{user_id, username + "@google.test"})[0][0].as<uint64_t>();
        txn.commit();
        return id;
    }

    uint64_t create_google_file(uint64_t storage_id, const std::string& name, uint64_t folder_id = 0) {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        const auto id = txn.exec(
            "INSERT INTO files(user_id,folder_id,encrypted_name,name_hash,encrypted_fdk,size_bytes,total_chunks,"
            "is_upload_complete,storage_provider,external_file_id,external_storage_id,deleted_at) "
            "VALUES($1,NULLIF($2::bigint,0),$3,$4,'fdk',2048,1,TRUE,'google_drive',$5,$6,CURRENT_TIMESTAMP) RETURNING id",
            pqxx::params{user_id, folder_id, "cipher-google-" + name, "b44-" + username + "-" + name,
                         username + "-external-" + name, storage_id})[0][0].as<uint64_t>();
        txn.commit();
        return id;
    }
};

void require_local_file(const B44Fixture& fixture, uint64_t file_id, bool expected) {
    CHECK(std::filesystem::exists(fixture.root / (std::to_string(file_id) + ".dat")) == expected);
}

} // namespace

TEST_CASE("B.44 single local hard-delete preserves ciphertext on quota rollback", "[b44][files][rollback]") {
    B44Fixture fixture("single");
    const auto file_id = fixture.create_local_file("single", 64);
    fixture.set_quota(64);

    {
        B44QuotaFailureGuard failure(fixture.pool, fixture.user_id);
        CHECK_THROWS(fixture.files.hard_delete_file(file_id, fixture.user_id, &fixture.chunker));
    }

    CHECK(fixture.count("SELECT COUNT(*) FROM files WHERE id=" + std::to_string(file_id)) == 1);
    CHECK(fixture.count("SELECT used_storage_bytes FROM users WHERE id=" + std::to_string(fixture.user_id)) == 64);
    require_local_file(fixture, file_id, true);
}

TEST_CASE("B.44 batch local hard-delete preserves every ciphertext on quota rollback", "[b44][files][rollback]") {
    B44Fixture fixture("batch-files");
    const auto first = fixture.create_local_file("first", 32);
    const auto second = fixture.create_local_file("second", 48);
    fixture.set_quota(80);

    {
        B44QuotaFailureGuard failure(fixture.pool, fixture.user_id);
        CHECK_THROWS(fixture.files.batch_hard_delete_files(
            fixture.user_id, {static_cast<int>(first), static_cast<int>(second)}, &fixture.chunker));
    }

    CHECK(fixture.count("SELECT COUNT(*) FROM files WHERE id IN (" + std::to_string(first) + "," + std::to_string(second) + ")") == 2);
    CHECK(fixture.count("SELECT used_storage_bytes FROM users WHERE id=" + std::to_string(fixture.user_id)) == 80);
    require_local_file(fixture, first, true);
    require_local_file(fixture, second, true);
}

TEST_CASE("B.44 empty trash preserves file and folder ciphertext on quota rollback", "[b44][trash][rollback]") {
    B44Fixture fixture("empty-trash");
    const auto folder_id = fixture.create_folder("trash-root");
    const auto file_id = fixture.create_local_file("trash-file", 40, true, folder_id);
    fixture.set_quota(40);

    {
        B44QuotaFailureGuard failure(fixture.pool, fixture.user_id);
        CHECK_THROWS(fixture.files.empty_trash(fixture.user_id, &fixture.chunker));
    }

    CHECK(fixture.count("SELECT COUNT(*) FROM files WHERE id=" + std::to_string(file_id)) == 1);
    CHECK(fixture.count("SELECT COUNT(*) FROM folders WHERE id=" + std::to_string(folder_id)) == 1);
    CHECK(fixture.count("SELECT used_storage_bytes FROM users WHERE id=" + std::to_string(fixture.user_id)) == 40);
    require_local_file(fixture, file_id, true);
}

TEST_CASE("B.44 recursive folder hard-delete preserves ciphertext on quota rollback", "[b44][folders][rollback]") {
    B44Fixture fixture("single-folder");
    const auto root = fixture.create_folder("root");
    const auto child = fixture.create_folder("child", true, root);
    const auto file_id = fixture.create_local_file("nested", 56, true, child);
    fixture.set_quota(56);

    {
        B44QuotaFailureGuard failure(fixture.pool, fixture.user_id);
        CHECK_THROWS(fixture.folders.hard_delete_folder(root, fixture.user_id, &fixture.chunker));
    }

    CHECK(fixture.count("SELECT COUNT(*) FROM folders WHERE id IN (" + std::to_string(root) + "," + std::to_string(child) + ")") == 2);
    CHECK(fixture.count("SELECT COUNT(*) FROM files WHERE id=" + std::to_string(file_id)) == 1);
    CHECK(fixture.count("SELECT used_storage_bytes FROM users WHERE id=" + std::to_string(fixture.user_id)) == 56);
    require_local_file(fixture, file_id, true);
}

TEST_CASE("B.44 batch recursive folder hard-delete preserves ciphertext on quota rollback", "[b44][folders][rollback]") {
    B44Fixture fixture("batch-folders");
    const auto root_a = fixture.create_folder("root-a");
    const auto root_b = fixture.create_folder("root-b");
    const auto child_b = fixture.create_folder("child-b", true, root_b);
    const auto file_a = fixture.create_local_file("file-a", 24, true, root_a);
    const auto file_b = fixture.create_local_file("file-b", 36, true, child_b);
    fixture.set_quota(60);

    {
        B44QuotaFailureGuard failure(fixture.pool, fixture.user_id);
        CHECK_THROWS(fixture.folders.batch_hard_delete_folders(
            fixture.user_id, {static_cast<int>(root_a), static_cast<int>(root_b)}, &fixture.chunker));
    }

    CHECK(fixture.count("SELECT COUNT(*) FROM folders WHERE id IN (" + std::to_string(root_a) + "," + std::to_string(root_b) + "," + std::to_string(child_b) + ")") == 3);
    CHECK(fixture.count("SELECT COUNT(*) FROM files WHERE id IN (" + std::to_string(file_a) + "," + std::to_string(file_b) + ")") == 2);
    CHECK(fixture.count("SELECT used_storage_bytes FROM users WHERE id=" + std::to_string(fixture.user_id)) == 60);
    require_local_file(fixture, file_a, true);
    require_local_file(fixture, file_b, true);
}

TEST_CASE("B.44 successful single local hard-delete still removes ciphertext", "[b44][files][success]") {
    B44Fixture fixture("success-single");
    const auto file_id = fixture.create_local_file("single", 20);
    fixture.set_quota(20);

    REQUIRE_NOTHROW(fixture.files.hard_delete_file(file_id, fixture.user_id, &fixture.chunker));

    CHECK(fixture.count("SELECT COUNT(*) FROM files WHERE id=" + std::to_string(file_id)) == 0);
    CHECK(fixture.count("SELECT used_storage_bytes FROM users WHERE id=" + std::to_string(fixture.user_id)) == 0);
    require_local_file(fixture, file_id, false);
}

TEST_CASE("B.44 successful mixed batch keeps Google bookkeeping transactional", "[b44][files][success]") {
    B44Fixture fixture("success-mixed");
    const auto local_id = fixture.create_local_file("local", 20);
    const auto storage_id = fixture.create_google_storage();
    const auto google_id = fixture.create_google_file(storage_id, "google");
    fixture.set_quota(2068);

    const auto result = fixture.files.batch_hard_delete_files(
        fixture.user_id, {static_cast<int>(local_id), static_cast<int>(google_id)}, &fixture.chunker);

    CHECK(result.deleted_count == 2);
    REQUIRE(result.external_files.size() == 1);
    CHECK(result.external_files[0] == fixture.username + "-external-google");
    CHECK(fixture.count("SELECT COUNT(*) FROM files WHERE id IN (" + std::to_string(local_id) + "," + std::to_string(google_id) + ")") == 0);
    CHECK(fixture.count("SELECT COUNT(*) FROM pending_external_deletions WHERE external_file_id='" + fixture.username + "-external-google'") == 1);
    CHECK(fixture.count("SELECT used_storage_bytes FROM users WHERE id=" + std::to_string(fixture.user_id)) == 0);
    require_local_file(fixture, local_id, false);
}

TEST_CASE("B.44 successful recursive folder hard-delete preserves provider semantics", "[b44][folders][success]") {
    B44Fixture fixture("success-folder");
    const auto root = fixture.create_folder("root");
    const auto child = fixture.create_folder("child", true, root);
    const auto local_id = fixture.create_local_file("local", 20, true, child);
    const auto storage_id = fixture.create_google_storage();
    const auto google_id = fixture.create_google_file(storage_id, "google", child);
    fixture.set_quota(2068);

    const auto external_files = fixture.folders.hard_delete_folder(root, fixture.user_id, &fixture.chunker);

    REQUIRE(external_files.size() == 1);
    CHECK(external_files[0] == fixture.username + "-external-google");
    CHECK(fixture.count("SELECT COUNT(*) FROM folders WHERE id IN (" + std::to_string(root) + "," + std::to_string(child) + ")") == 0);
    CHECK(fixture.count("SELECT COUNT(*) FROM files WHERE id IN (" + std::to_string(local_id) + "," + std::to_string(google_id) + ")") == 0);
    CHECK(fixture.count("SELECT COUNT(*) FROM pending_external_deletions WHERE external_file_id='" + fixture.username + "-external-google'") == 1);
    CHECK(fixture.count("SELECT used_storage_bytes FROM users WHERE id=" + std::to_string(fixture.user_id)) == 0);
    require_local_file(fixture, local_id, false);
}

TEST_CASE("B.44 failed single delete can naturally succeed on a later request", "[b44][files][rollback]") {
    B44Fixture fixture("retry");
    const auto file_id = fixture.create_local_file("retry", 12);
    fixture.set_quota(12);

    {
        B44QuotaFailureGuard failure(fixture.pool, fixture.user_id);
        CHECK_THROWS(fixture.files.hard_delete_file(file_id, fixture.user_id, &fixture.chunker));
    }
    CHECK(fixture.count("SELECT COUNT(*) FROM files WHERE id=" + std::to_string(file_id)) == 1);
    require_local_file(fixture, file_id, true);

    REQUIRE_NOTHROW(fixture.files.hard_delete_file(file_id, fixture.user_id, &fixture.chunker));
    CHECK(fixture.count("SELECT COUNT(*) FROM files WHERE id=" + std::to_string(file_id)) == 0);
    require_local_file(fixture, file_id, false);
}

TEST_CASE("B.44 unauthorized and active files never reach physical deletion", "[b44][files][idor]") {
    B44Fixture fixture("authority");
    const auto victim = fixture.create_local_file("victim", 16);
    const auto active = fixture.create_local_file("active", 16, false);

    DatabasePool other_pool(2, get_secure_conn_string());
    const auto other_name = std::string("b44_other_authority");
    uint64_t other_user_id = 0;
    {
        auto conn = other_pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username=$1", pqxx::params{other_name});
        other_user_id = txn.exec(
            "INSERT INTO users(username,email,password_hash,is_email_verified) VALUES($1,$2,'hash',TRUE) RETURNING id",
            pqxx::params{other_name, other_name + "@test.com"})[0][0].as<uint64_t>();
        txn.commit();
    }

    CHECK_THROWS(fixture.files.hard_delete_file(victim, other_user_id, &fixture.chunker));
    CHECK_THROWS(fixture.files.hard_delete_file(active, fixture.user_id, &fixture.chunker));
    require_local_file(fixture, victim, true);
    require_local_file(fixture, active, true);
}
