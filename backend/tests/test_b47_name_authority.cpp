#include <catch2/catch_test_macros.hpp>

#include "database/DatabasePool.hpp"
#include "database/DatabaseMigration.hpp"
#include "database/FileManager.hpp"
#include "database/FolderManager.hpp"
#include "test_helpers.hpp"

#include <pqxx/pqxx>
#include <cstdint>
#include <functional>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

uint64_t create_user(DatabasePool& pool, const std::string& username) {
    auto conn = pool.acquire_connection();
    pqxx::work txn(*conn);
    txn.exec("DELETE FROM users WHERE username = $1", pqxx::params{username});
    const auto result = txn.exec(
        "INSERT INTO users (username, email, password_hash, is_email_verified) "
        "VALUES ($1, $2, 'b47-hash', TRUE) RETURNING id",
        pqxx::params{username, username + "@test.invalid"});
    txn.commit();
    return result[0][0].as<uint64_t>();
}

void delete_user(DatabasePool& pool, uint64_t user_id) {
    auto conn = pool.acquire_connection();
    pqxx::work txn(*conn);
    txn.exec("DELETE FROM users WHERE id = $1", pqxx::params{user_id});
    txn.commit();
}

uint64_t complete_file(DatabasePool& pool, FileManager& files, uint64_t user_id,
                       std::optional<uint64_t> folder_id,
                       const std::string& name_hash,
                       const std::string& encrypted_name) {
    const auto file_id = static_cast<uint64_t>(files.init_upload(
        user_id, folder_id, encrypted_name, name_hash, "b47-fdk", 1, 1));
    auto conn = pool.acquire_connection();
    pqxx::work txn(*conn);
    txn.exec(
        "UPDATE files SET is_upload_complete = TRUE WHERE id = $1 AND user_id = $2",
        pqxx::params{file_id, user_id});
    txn.commit();
    return file_id;
}

BatchInitItem batch_file(std::optional<uint64_t> folder_id,
                         const std::string& name_hash,
                         const std::string& encrypted_name) {
    BatchInitItem item;
    item.folder_id = folder_id;
    item.enc_name = encrypted_name;
    item.name_hash = name_hash;
    item.encrypted_fdk = "b47-fdk";
    item.size_bytes = 1;
    item.total_chunks = 1;
    item.storage_provider = "local";
    return item;
}

void require_error(const std::function<void()>& action, const std::string& expected) {
    try {
        action();
        FAIL("expected runtime_error: " + expected);
    } catch (const std::runtime_error& error) {
        REQUIRE(error.what() == expected);
    }
}

} // namespace

TEST_CASE("B.47 single-file name authority ignores root tombstones", "[b47][name][file][root]") {
    DatabasePool pool(2, get_secure_conn_string());
    FileManager files(pool);
    const auto user_id = create_user(pool, "b47_file_root");

    const auto old_id = complete_file(pool, files, user_id, std::nullopt, "b47-file-root-hash", "b47-old");
    REQUIRE_NOTHROW(files.delete_file(old_id, user_id));

    uint64_t new_id = 0;
    REQUIRE_NOTHROW(new_id = static_cast<uint64_t>(files.init_upload(
        user_id, std::nullopt, "b47-new", "b47-file-root-hash", "b47-fdk", 1, 1)));
    REQUIRE(new_id != old_id);
    require_error([&] { files.restore_file(old_id, user_id); }, "FILE_ALREADY_EXISTS");

    delete_user(pool, user_id);
}

TEST_CASE("B.47 single-file name authority ignores nested tombstones", "[b47][name][file][nested]") {
    DatabasePool pool(2, get_secure_conn_string());
    FileManager files(pool);
    FolderManager folders(pool);
    const auto user_id = create_user(pool, "b47_file_nested");
    const auto parent_id = folders.create_folder(user_id, std::nullopt, "b47-parent", "b47-file-parent");

    const auto old_id = complete_file(pool, files, user_id, parent_id, "b47-file-nested-hash", "b47-old");
    REQUIRE_NOTHROW(files.delete_file(old_id, user_id));

    uint64_t new_id = 0;
    REQUIRE_NOTHROW(new_id = static_cast<uint64_t>(files.init_upload(
        user_id, parent_id, "b47-new", "b47-file-nested-hash", "b47-fdk", 1, 1)));
    REQUIRE(new_id != old_id);
    require_error([&] { files.restore_file(old_id, user_id); }, "FILE_ALREADY_EXISTS");

    delete_user(pool, user_id);
}

TEST_CASE("B.47 single-folder name authority ignores root tombstones", "[b47][name][folder][root]") {
    DatabasePool pool(2, get_secure_conn_string());
    FolderManager folders(pool);
    const auto user_id = create_user(pool, "b47_folder_root");

    const auto old_id = folders.create_folder(user_id, std::nullopt, "b47-old", "b47-folder-root-hash");
    REQUIRE_NOTHROW(folders.delete_folder(old_id, user_id));

    uint64_t new_id = 0;
    REQUIRE_NOTHROW(new_id = folders.create_folder(user_id, std::nullopt, "b47-new", "b47-folder-root-hash"));
    REQUIRE(new_id != old_id);
    require_error([&] { folders.restore_folder(old_id, user_id); }, "FOLDER_ALREADY_EXISTS");

    delete_user(pool, user_id);
}

TEST_CASE("B.47 single-folder name authority ignores nested tombstones", "[b47][name][folder][nested]") {
    DatabasePool pool(2, get_secure_conn_string());
    FolderManager folders(pool);
    const auto user_id = create_user(pool, "b47_folder_nested");
    const auto parent_id = folders.create_folder(user_id, std::nullopt, "b47-parent", "b47-folder-parent");

    const auto old_id = folders.create_folder(user_id, parent_id, "b47-old", "b47-folder-nested-hash");
    REQUIRE_NOTHROW(folders.delete_folder(old_id, user_id));

    uint64_t new_id = 0;
    REQUIRE_NOTHROW(new_id = folders.create_folder(user_id, parent_id, "b47-new", "b47-folder-nested-hash"));
    REQUIRE(new_id != old_id);
    require_error([&] { folders.restore_folder(old_id, user_id); }, "FOLDER_ALREADY_EXISTS");

    delete_user(pool, user_id);
}

TEST_CASE("B.47 batch folder creation ignores root tombstones and reuses active folders", "[b47][name][folder][batch][root]") {
    DatabasePool pool(2, get_secure_conn_string());
    FolderManager folders(pool);
    const auto user_id = create_user(pool, "b47_batch_folder_root");

    const auto old_id = folders.create_folder(user_id, std::nullopt, "b47-old", "b47-batch-folder-root-hash");
    REQUIRE_NOTHROW(folders.delete_folder(old_id, user_id));

    const auto created = folders.batch_create_folders(user_id, std::nullopt, {
        {"new-root", std::nullopt, "b47-new", "b47-batch-folder-root-hash"}
    });
    REQUIRE(created.size() == 1);
    REQUIRE(created[0].created);
    REQUIRE(created[0].folder_id != old_id);

    const auto reused = folders.batch_create_folders(user_id, std::nullopt, {
        {"active-root", std::nullopt, "different-cipher", "b47-batch-folder-root-hash"}
    });
    REQUIRE(reused.size() == 1);
    REQUIRE_FALSE(reused[0].created);
    REQUIRE(reused[0].folder_id == created[0].folder_id);

    delete_user(pool, user_id);
}

TEST_CASE("B.47 batch folder creation ignores nested tombstones", "[b47][name][folder][batch][nested]") {
    DatabasePool pool(2, get_secure_conn_string());
    FolderManager folders(pool);
    const auto user_id = create_user(pool, "b47_batch_folder_nested");
    const auto parent_id = folders.create_folder(user_id, std::nullopt, "b47-parent", "b47-batch-folder-parent");
    const auto old_id = folders.create_folder(user_id, parent_id, "b47-old", "b47-batch-folder-nested-hash");
    REQUIRE_NOTHROW(folders.delete_folder(old_id, user_id));

    const auto created = folders.batch_create_folders(user_id, parent_id, {
        {"new-nested", std::nullopt, "b47-new", "b47-batch-folder-nested-hash"}
    });
    REQUIRE(created.size() == 1);
    REQUIRE(created[0].created);
    REQUIRE(created[0].folder_id != old_id);

    delete_user(pool, user_id);
}

TEST_CASE("B.47 batch-file name authority ignores root tombstones", "[b47][name][file][batch][root]") {
    DatabasePool pool(2, get_secure_conn_string());
    FileManager files(pool);
    const auto user_id = create_user(pool, "b47_batch_file_root");

    const auto root_old = complete_file(pool, files, user_id, std::nullopt, "b47-batch-file-root-hash", "b47-root-old");
    REQUIRE_NOTHROW(files.delete_file(root_old, user_id));

    const auto created = files.batch_init_uploads(user_id, {
        batch_file(std::nullopt, "b47-batch-file-root-hash", "b47-root-new"),
    });
    REQUIRE(created.size() == 1);
    REQUIRE(created[0].file_id != root_old);

    delete_user(pool, user_id);
}

TEST_CASE("B.47 batch-file name authority ignores nested tombstones", "[b47][name][file][batch][nested]") {
    DatabasePool pool(2, get_secure_conn_string());
    FileManager files(pool);
    FolderManager folders(pool);
    const auto user_id = create_user(pool, "b47_batch_file_nested");
    const auto parent_id = folders.create_folder(user_id, std::nullopt, "b47-parent", "b47-batch-file-parent");
    const auto nested_old = complete_file(pool, files, user_id, parent_id, "b47-batch-file-nested-hash", "b47-nested-old");
    REQUIRE_NOTHROW(files.delete_file(nested_old, user_id));

    const auto created = files.batch_init_uploads(user_id, {
        batch_file(parent_id, "b47-batch-file-nested-hash", "b47-nested-new"),
    });
    REQUIRE(created.size() == 1);
    REQUIRE(created[0].file_id != nested_old);

    delete_user(pool, user_id);
}

TEST_CASE("B.47 active file and folder names remain exclusive", "[b47][name][active]") {
    DatabasePool pool(2, get_secure_conn_string());
    FileManager files(pool);
    FolderManager folders(pool);
    const auto user_id = create_user(pool, "b47_active_conflicts");
    const auto parent_id = folders.create_folder(user_id, std::nullopt, "b47-parent", "b47-active-parent");

    const auto root_folder = folders.create_folder(user_id, std::nullopt, "b47-root", "b47-active-folder-root");
    require_error([&] {
        folders.create_folder(user_id, std::nullopt, "b47-root-copy", "b47-active-folder-root");
    }, "FOLDER_ALREADY_EXISTS");
    const auto nested_folder = folders.create_folder(user_id, parent_id, "b47-nested", "b47-active-folder-nested");
    require_error([&] {
        folders.create_folder(user_id, parent_id, "b47-nested-copy", "b47-active-folder-nested");
    }, "FOLDER_ALREADY_EXISTS");

    const auto root_file = complete_file(pool, files, user_id, std::nullopt, "b47-active-file-root", "b47-root-file");
    require_error([&] {
        files.init_upload(user_id, std::nullopt, "b47-root-file-copy", "b47-active-file-root", "b47-fdk", 1, 1);
    }, "FILE_ALREADY_EXISTS");
    const auto nested_file = complete_file(pool, files, user_id, parent_id, "b47-active-file-nested", "b47-nested-file");
    require_error([&] {
        files.init_upload(user_id, parent_id, "b47-nested-file-copy", "b47-active-file-nested", "b47-fdk", 1, 1);
    }, "FILE_ALREADY_EXISTS");

    REQUIRE(root_folder > 0);
    REQUIRE(nested_folder > 0);
    REQUIRE(root_file > 0);
    REQUIRE(nested_file > 0);
    delete_user(pool, user_id);
}

TEST_CASE("B.47 canonical schema has only active-name authorities", "[b47][database][migration]") {
    DatabasePool pool(2, get_secure_conn_string());
    REQUIRE(DatabaseMigration::run(pool));

    auto conn = pool.acquire_connection();
    pqxx::nontransaction query(*conn);
    const auto legacy = query.exec(
        "SELECT conname FROM pg_constraint WHERE conname IN ('unique_folder_name', 'unique_file_name')");
    REQUIRE(legacy.empty());

    const auto cleanup_column = query.exec(
        "SELECT data_type, is_nullable, column_default "
        "FROM information_schema.columns "
        "WHERE table_schema = current_schema() AND table_name = 'files' "
        "AND column_name = 'is_external_cleanup_pending'");
    REQUIRE(cleanup_column.size() == 1);
    CHECK(cleanup_column[0][0].as<std::string>() == "boolean");
    CHECK(cleanup_column[0][1].as<std::string>() == "NO");
    CHECK(cleanup_column[0][2].as<std::string>().find("false") != std::string::npos);

    const auto cleanup_constraint = query.exec(
        "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
        "WHERE conrelid = 'files'::regclass AND conname = 'chk_files_external_cleanup_pending'");
    REQUIRE(cleanup_constraint.size() == 1);
    CHECK(cleanup_constraint[0][0].as<std::string>().find("folder_id IS NULL") != std::string::npos);

    for (const auto* index : {
        "idx_unique_folder_root_active", "idx_unique_folder_sub_active",
        "idx_unique_file_root_active", "idx_unique_file_sub_active"
    }) {
        const auto result = query.exec(
            "SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = $1",
            pqxx::params{index});
        REQUIRE(result.size() == 1);
        const auto definition = result[0][0].as<std::string>();
        REQUIRE(definition.find("UNIQUE") != std::string::npos);
        REQUIRE(definition.find("deleted_at IS NULL") != std::string::npos);
    }
}
