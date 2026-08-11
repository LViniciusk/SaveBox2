#include <catch2/catch_test_macros.hpp>
#include "database/DatabaseMigration.hpp"
#include "database/DatabasePool.hpp"
#include "test_helpers.hpp"
#include <pqxx/pqxx>
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cctype>
#include <cstdint>
#include <string>

namespace {

class IsolatedSchema {
public:
    IsolatedSchema() : name_(next_name()) {
        pqxx::connection admin(get_secure_conn_string());
        pqxx::work txn(admin);
        txn.exec("CREATE SCHEMA " + name_);
        txn.commit();
    }

    ~IsolatedSchema() {
        try {
            pqxx::connection admin(get_secure_conn_string());
            pqxx::work txn(admin);
            txn.exec("DROP SCHEMA " + name_ + " CASCADE");
            txn.commit();
        } catch (...) {
        }
    }

    const std::string& name() const { return name_; }

private:
    static std::string next_name() {
        static std::atomic<unsigned int> sequence{0};
        const auto ticks = std::chrono::steady_clock::now().time_since_epoch().count();
        return "b69m_" + std::to_string(ticks) + "_" +
               std::to_string(sequence.fetch_add(1, std::memory_order_relaxed));
    }

    std::string name_;
};

struct FreshSchemaFixture {
    IsolatedSchema schema;
    DatabasePool pool;

    FreshSchemaFixture() : schema(), pool(1, get_secure_conn_string()) {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("SELECT set_config('search_path', $1, false)",
                 pqxx::params{schema.name() + ", public"});
        txn.commit();
    }
};

bool table_exists(DatabasePool& pool, const char* table) {
    auto conn = pool.acquire_connection();
    pqxx::read_transaction txn(*conn);
    const auto result = txn.exec(
        "SELECT 1 FROM information_schema.tables "
        "WHERE table_schema = current_schema() AND table_name = $1",
        pqxx::params{table});
    txn.commit();
    return !result.empty();
}

std::string index_definition(DatabasePool& pool, const char* index) {
    auto conn = pool.acquire_connection();
    pqxx::read_transaction txn(*conn);
    const auto result = txn.exec(
        "SELECT indexdef FROM pg_indexes "
        "WHERE schemaname = current_schema() AND indexname = $1",
        pqxx::params{index});
    const std::string definition = result.empty() ? std::string{} : result[0][0].as<std::string>();
    txn.commit();
    return definition;
}

std::string constraint_definition(DatabasePool& pool, const char* table, const char* constraint) {
    auto conn = pool.acquire_connection();
    pqxx::read_transaction txn(*conn);
    const auto result = txn.exec(
        "SELECT pg_get_constraintdef(c.oid) "
        "FROM pg_constraint c "
        "JOIN pg_class t ON t.oid = c.conrelid "
        "JOIN pg_namespace n ON n.oid = t.relnamespace "
        "WHERE n.nspname = current_schema() AND t.relname = $1 AND c.conname = $2",
        pqxx::params{table, constraint});
    const std::string definition = result.empty() ? std::string{} : result[0][0].as<std::string>();
    txn.commit();
    return definition;
}

std::string compact_lower(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char character) {
        return static_cast<char>(std::tolower(character));
    });
    value.erase(std::remove_if(value.begin(), value.end(), [](unsigned char character) {
        return std::isspace(character) != 0 || character == '"';
    }), value.end());
    return value;
}

int named_object_count(DatabasePool& pool, const char* name) {
    auto conn = pool.acquire_connection();
    pqxx::read_transaction txn(*conn);
    const auto result = txn.exec(
        "SELECT COUNT(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
        "WHERE n.nspname = current_schema() AND c.relname = $1",
        pqxx::params{name});
    const int count = result[0][0].as<int>();
    txn.commit();
    return count;
}

} // namespace

TEST_CASE("Migração cria o schema canônico em banco vazio isolado",
          "[database][migration][fresh][b69]") {
    FreshSchemaFixture fixture;
    constexpr std::array<const char*, 16> tables{
        "users", "user_sessions", "folders", "pinned_folders",
        "user_external_storages", "files", "shared_links", "file_chunks",
        "storage_move_jobs", "storage_move_items", "storage_move_chunks",
        "banned_ips", "pending_external_deletions", "pending_local_deletions",
        "pending_storage_move_reconciliations", "google_link_claims"};

    for (const char* table : tables) REQUIRE_FALSE(table_exists(fixture.pool, table));
    REQUIRE(DatabaseMigration::run(fixture.pool));
    for (const char* table : tables) REQUIRE(table_exists(fixture.pool, table));

    {
        auto conn = fixture.pool.acquire_connection();
        pqxx::read_transaction txn(*conn);
        const auto columns = txn.exec(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_schema = current_schema() AND table_name = 'google_link_claims' "
            "ORDER BY ordinal_position");
        REQUIRE(columns.size() == 5);
        constexpr std::array<const char*, 5> expected{
            "user_id", "account_email", "claim_id", "expires_at", "created_at"};
        for (std::size_t i = 0; i < expected.size(); ++i) {
            CHECK(columns[i][0].as<std::string>() == expected[i]);
        }
        txn.commit();
    }
    const auto claim_pk = compact_lower(
        constraint_definition(fixture.pool, "google_link_claims", "google_link_claims_pkey"));
    REQUIRE(claim_pk.find("primarykey(user_id,account_email)") != std::string::npos);

    {
        auto conn = fixture.pool.acquire_connection();
        pqxx::read_transaction txn(*conn);
        const auto columns = txn.exec(
            "SELECT column_name, data_type, column_default, is_nullable "
            "FROM information_schema.columns "
            "WHERE table_schema = current_schema() AND table_name = 'files' "
            "AND column_name IN ('total_chunks', 'uploaded_chunks_count', 'is_upload_complete') "
            "ORDER BY column_name");
        REQUIRE(columns.size() == 3);
        REQUIRE(columns[0][0].as<std::string>() == "is_upload_complete");
        REQUIRE(columns[0][1].as<std::string>() == "boolean");
        REQUIRE(columns[0][2].as<std::string>().find("false") != std::string::npos);
        REQUIRE(columns[0][3].as<std::string>() == "NO");
        REQUIRE(columns[1][0].as<std::string>() == "total_chunks");
        REQUIRE(columns[1][1].as<std::string>() == "integer");
        REQUIRE(columns[1][2].as<std::string>().find("1") != std::string::npos);
        REQUIRE(columns[1][3].as<std::string>() == "NO");
        REQUIRE(columns[2][0].as<std::string>() == "uploaded_chunks_count");
        REQUIRE(columns[2][1].as<std::string>() == "integer");
        REQUIRE(columns[2][2].as<std::string>().find("0") != std::string::npos);
        REQUIRE(columns[2][3].as<std::string>() == "NO");
        txn.commit();
    }

    const auto counter_constraint = compact_lower(
        constraint_definition(fixture.pool, "files", "chk_files_uploaded_chunks_count"));
    REQUIRE(counter_constraint.find("uploaded_chunks_count>=0") != std::string::npos);
    REQUIRE(counter_constraint.find("uploaded_chunks_count<=total_chunks") != std::string::npos);

    const auto chunks_unique = compact_lower(index_definition(fixture.pool, "file_chunks_file_id_chunk_index_key"));
    REQUIRE(chunks_unique.find("uniqueindex") != std::string::npos);
    REQUIRE(chunks_unique.find("(file_id,chunk_index)") != std::string::npos);

    struct IndexContract {
        const char* name;
        const char* required_text;
        bool unique;
    };
    constexpr std::array<IndexContract, 13> indexes{{
        {"idx_pinned_folders_user_position", "(user_id,position)", false},
        {"idx_unique_folder_root_active", "(user_id,name_hash)", true},
        {"idx_unique_folder_sub_active", "(user_id,parent_id,name_hash)", true},
        {"idx_unique_file_root_active", "(user_id,name_hash)", true},
        {"idx_unique_file_sub_active", "(user_id,folder_id,name_hash)", true},
        {"idx_folders_user_parent", "(user_id,parent_id)", false},
        {"idx_files_folder", "(folder_id)", false},
        {"idx_files_storage_projection", "(user_id,storage_provider,external_storage_id,folder_id,id)", false},
        {"idx_external_storage_one_active_account", "(user_id,provider,account_email)", true},
        {"idx_storage_move_one_active_file", "(file_id)", true},
        {"idx_storage_move_active_user", "(user_id,updated_at)", false},
        {"idx_storage_move_target_account", "(target_external_storage_id,status)", false},
        {"idx_storage_move_reconcile_due", "(external_storage_id,next_attempt_at)", false},
    }};
    for (const auto& index : indexes) {
        const auto definition = compact_lower(index_definition(fixture.pool, index.name));
        REQUIRE_FALSE(definition.empty());
        REQUIRE(definition.find(index.required_text) != std::string::npos);
        if (index.unique) REQUIRE(definition.find("uniqueindex") != std::string::npos);
    }

    const auto root_folder = compact_lower(index_definition(fixture.pool, "idx_unique_folder_root_active"));
    const auto sub_folder = compact_lower(index_definition(fixture.pool, "idx_unique_folder_sub_active"));
    const auto root_file = compact_lower(index_definition(fixture.pool, "idx_unique_file_root_active"));
    const auto sub_file = compact_lower(index_definition(fixture.pool, "idx_unique_file_sub_active"));
    REQUIRE(root_folder.find("parent_idisnull") != std::string::npos);
    REQUIRE(sub_folder.find("parent_idisnotnull") != std::string::npos);
    REQUIRE(root_file.find("folder_idisnull") != std::string::npos);
    REQUIRE(sub_file.find("folder_idisnotnull") != std::string::npos);
    REQUIRE(root_folder.find("deleted_atisnull") != std::string::npos);
    REQUIRE(sub_folder.find("deleted_atisnull") != std::string::npos);
    REQUIRE(root_file.find("deleted_atisnull") != std::string::npos);
    REQUIRE(sub_file.find("deleted_atisnull") != std::string::npos);

    const auto google_index = compact_lower(
        index_definition(fixture.pool, "idx_external_storage_one_active_account"));
    REQUIRE(google_index.find("uniqueindex") != std::string::npos);
    REQUIRE(google_index.find("is_unlinking=false") != std::string::npos);
    REQUIRE(google_index.find("account_emailisnotnull") != std::string::npos);

    const auto move_index = compact_lower(
        index_definition(fixture.pool, "idx_storage_move_one_active_file"));
    for (const char* state : {"prepared", "transferring", "paused", "target_uploaded", "committing", "cleanup_pending"}) {
        REQUIRE(move_index.find(state) != std::string::npos);
    }

    uint64_t file_id = 0;
    {
        auto conn = fixture.pool.acquire_connection();
        pqxx::work txn(*conn);
        const auto user_id = txn.exec(
            "INSERT INTO users(username, email, password_hash, is_email_verified) "
            "VALUES('b69m-fresh-user', 'b69m-fresh@test.invalid', 'hash', TRUE) RETURNING id")[0][0].as<uint64_t>();
        file_id = txn.exec(
            "INSERT INTO files(user_id, encrypted_name, name_hash, encrypted_fdk, total_chunks) "
            "VALUES($1, 'name', 'hash', 'fdk', 2) RETURNING id",
            pqxx::params{user_id})[0][0].as<uint64_t>();
        txn.commit();
    }
    {
        auto conn = fixture.pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("INSERT INTO file_chunks(file_id, chunk_index) VALUES($1, 0)",
                 pqxx::params{file_id});
        txn.commit();
    }
    {
        auto conn = fixture.pool.acquire_connection();
        pqxx::work txn(*conn);
        REQUIRE_THROWS_AS(
            txn.exec("INSERT INTO file_chunks(file_id, chunk_index) VALUES($1, 0)",
                     pqxx::params{file_id}),
            pqxx::unique_violation);
    }
    {
        auto invalid_counter = fixture.pool.acquire_connection();
        pqxx::work invalid_counter_txn(*invalid_counter);
        REQUIRE_THROWS(invalid_counter_txn.exec(
            "UPDATE files SET uploaded_chunks_count = -1 WHERE id = $1",
            pqxx::params{file_id}));
    }

    {
        auto conn = fixture.pool.acquire_connection();
        pqxx::work txn(*conn);
        REQUIRE_THROWS(txn.exec(
            "UPDATE files SET uploaded_chunks_count = total_chunks + 1 "
            "WHERE encrypted_name = 'name'"));
    }
}

TEST_CASE("Migração do schema canônico é idempotente no mesmo schema",
          "[database][migration][fresh][idempotence]") {
    FreshSchemaFixture fixture;
    REQUIRE(DatabaseMigration::run(fixture.pool));
    REQUIRE(DatabaseMigration::run(fixture.pool));
    REQUIRE(named_object_count(fixture.pool, "idx_unique_folder_root_active") == 1);
    REQUIRE(named_object_count(fixture.pool, "idx_storage_move_one_active_file") == 1);
    REQUIRE(named_object_count(fixture.pool, "files") == 1);
    REQUIRE(constraint_definition(fixture.pool, "files", "chk_files_uploaded_chunks_count").empty() == false);
}

TEST_CASE("B.71.E.3.M.1 tombstone constraint rejects invalid ownership shapes",
          "[database][migration][fresh][b71e3m1][tombstone]") {
    FreshSchemaFixture fixture;
    REQUIRE(DatabaseMigration::run(fixture.pool));

    uint64_t user_id = 0;
    uint64_t storage_id = 0;
    uint64_t folder_id = 0;
    {
        auto conn = fixture.pool.acquire_connection();
        pqxx::work txn(*conn);
        user_id = txn.exec(
            "INSERT INTO users(username,email,password_hash,is_email_verified) "
            "VALUES('b71e3m1-constraint','b71e3m1-constraint@test.invalid','hash',TRUE) RETURNING id")[0][0].as<uint64_t>();
        storage_id = txn.exec(
            "INSERT INTO user_external_storages(user_id,provider,account_email,refresh_token) "
            "VALUES($1,'google_drive','b71e3m1-constraint@google.test','refresh') RETURNING id",
            pqxx::params{user_id})[0][0].as<uint64_t>();
        folder_id = txn.exec(
            "INSERT INTO folders(user_id,encrypted_name,name_hash) "
            "VALUES($1,'folder','b71e3m1-constraint-folder') RETURNING id",
            pqxx::params{user_id})[0][0].as<uint64_t>();
        txn.commit();
    }

    const auto expect_invalid = [&](const char* label,
                                    const char* provider,
                                    bool complete,
                                    bool deleted,
                                    bool external_file,
                                    bool storage,
                                    bool folder) {
        INFO(label);
        const std::string storage_value = storage ? std::to_string(storage_id) : "NULL";
        const std::string folder_value = folder ? std::to_string(folder_id) : "NULL";
        const std::string external_value = external_file ? "'remote-id'" : "NULL";
        const std::string deleted_value = deleted ? "CURRENT_TIMESTAMP" : "NULL";
        auto conn = fixture.pool.acquire_connection();
        pqxx::work txn(*conn);
        REQUIRE_THROWS(txn.exec(
            "INSERT INTO files(user_id,encrypted_name,name_hash,encrypted_fdk,total_chunks,"
            "is_upload_complete,storage_provider,external_file_id,external_storage_id,deleted_at,"
            "is_external_cleanup_pending,folder_id) VALUES($1,'cipher','b71e3m1-constraint-file','fdk',1," +
            std::string(complete ? "TRUE" : "FALSE") + ",'" + provider + "'," + external_value + "," +
            storage_value + "," + deleted_value + ",TRUE," + folder_value + ")",
            pqxx::params{user_id}));
    };

    expect_invalid("provider local", "local", false, true, false, true, false);
    expect_invalid("upload complete", "google_drive", true, true, false, true, false);
    expect_invalid("not deleted", "google_drive", false, false, false, true, false);
    expect_invalid("external id present", "google_drive", false, true, true, true, false);
    expect_invalid("external storage absent", "google_drive", false, true, false, false, false);
    expect_invalid("folder still attached", "google_drive", false, true, false, true, true);
}

TEST_CASE("B.37 schema possui uma unica authority externa ativa", "[database][migration][b37]") {
    DatabasePool pool(2, get_secure_conn_string());
    REQUIRE(DatabaseMigration::run(pool));
    const uint64_t first_user_id = 9934;
    const uint64_t second_user_id = 9935;
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE id IN ($1,$2) OR username IN ('migration_b37_first','migration_b37_second')",
                 pqxx::params{first_user_id, second_user_id});
        txn.exec(
            "INSERT INTO users(id,username,email,password_hash,is_email_verified) VALUES "
            "($1,'migration_b37_first','migration_b37_first@test.com','hash',TRUE),"
            "($2,'migration_b37_second','migration_b37_second@test.com','hash',TRUE)",
            pqxx::params{first_user_id, second_user_id});
        txn.exec(
            "INSERT INTO user_external_storages(user_id,provider,account_email,refresh_token,is_unlinking) "
            "VALUES($1,'google_drive','same-b37@test.com','token-a',FALSE)",
            pqxx::params{first_user_id});
        txn.commit();
    }
    struct Cleanup {
        DatabasePool& pool;
        uint64_t first;
        uint64_t second;
        ~Cleanup() {
            try {
                auto conn = pool.acquire_connection();
                pqxx::work txn(*conn);
                txn.exec("DELETE FROM users WHERE id IN ($1,$2)", pqxx::params{first, second});
                txn.commit();
            } catch (...) {}
        }
    } cleanup{pool, first_user_id, second_user_id};

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        REQUIRE_THROWS_AS(
            txn.exec(
                "INSERT INTO user_external_storages(user_id,provider,account_email,refresh_token,is_unlinking) "
                "VALUES($1,'google_drive','same-b37@test.com','token-b',FALSE)",
                pqxx::params{first_user_id}),
            pqxx::unique_violation);
    }
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        REQUIRE_NOTHROW(txn.exec(
            "INSERT INTO user_external_storages(user_id,provider,account_email,refresh_token,is_unlinking) "
            "VALUES($1,'google_drive','same-b37@test.com','old-token',TRUE)",
            pqxx::params{first_user_id}));
        REQUIRE_NOTHROW(txn.exec(
            "INSERT INTO user_external_storages(user_id,provider,account_email,refresh_token,is_unlinking) "
            "VALUES($1,'google_drive','same-b37@test.com','other-user-token',FALSE)",
            pqxx::params{second_user_id}));
        REQUIRE_NOTHROW(txn.exec(
            "INSERT INTO user_external_storages(user_id,provider,account_email,refresh_token,is_unlinking) "
            "VALUES($1,'google_drive','other-b37@test.com','other-email-token',FALSE)",
            pqxx::params{first_user_id}));
        txn.commit();
    }
}
