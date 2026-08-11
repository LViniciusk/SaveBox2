#include <catch2/catch_test_macros.hpp>

#include "controllers/ApiRouter.hpp"
#include "database/FileManager.hpp"
#include "database/FolderManager.hpp"
#include "database/DatabasePool.hpp"
#include "Services/AuthService.hpp"
#include "Services/GoogleDriveService.hpp"
#include "test_helpers.hpp"

#include <cstdint>
#include <optional>
#include <string>

namespace {

struct Fixture {
    DatabasePool pool{2, get_secure_conn_string()};
    FileManager files{pool};
    FolderManager folders{pool};
    MockEmailService email;
    GoogleDriveService google{pool};
    AuthService auth{
        "b71e3m1-auth-secret",
        "b71e3m1-refresh-secret",
        &email};
    ApiRouter router{pool, auth, folders, &files, nullptr, &google};
    std::string username;
    uint64_t user_id = 0;
    uint64_t storage_id = 0;

    explicit Fixture(std::string suffix)
        : username("b71e3m1_" + std::move(suffix)) {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username=$1", pqxx::params{username});
        user_id = txn.exec(
            "INSERT INTO users(username,email,password_hash,is_email_verified,max_storage_bytes,used_storage_bytes) "
            "VALUES($1,$2,'hash',TRUE,100000,0) RETURNING id",
            pqxx::params{username, username + "@test.com"})[0][0].as<uint64_t>();
        storage_id = txn.exec(
            "INSERT INTO user_external_storages(user_id,provider,account_email,refresh_token,root_folder_id) "
            "VALUES($1,'google_drive',$2,'refresh','root') RETURNING id",
            pqxx::params{user_id, username + "@google.test"})[0][0].as<uint64_t>();
        txn.commit();
    }

    ~Fixture() {
        try {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            txn.exec("DELETE FROM users WHERE id=$1", pqxx::params{user_id});
            txn.commit();
        } catch (...) {
        }
    }

    uint64_t create_folder(const std::string& suffix) {
        return folders.create_folder(
            user_id, std::nullopt, "folder-" + suffix, username + "-folder-" + suffix);
    }

    uint64_t create_google_pending(const std::string& suffix, std::optional<uint64_t> folder_id = std::nullopt) {
        return files.init_external_upload(
            user_id, folder_id, "file-" + suffix, username + "-file-" + suffix,
            "fdk", 2048, "google_drive", storage_id);
    }

    void trash_folder(uint64_t folder_id) {
        folders.delete_folder(folder_id, user_id);
    }

    bool exists(uint64_t file_id) {
        auto conn = pool.acquire_connection();
        pqxx::read_transaction txn(*conn);
        return txn.exec(
            "SELECT 1 FROM files WHERE id=$1", pqxx::params{file_id}).size() == 1;
    }

    std::string row_state(uint64_t file_id) {
        auto conn = pool.acquire_connection();
        pqxx::read_transaction txn(*conn);
        const auto row = txn.exec(
            "SELECT deleted_at IS NOT NULL, is_external_cleanup_pending, folder_id "
            "FROM files WHERE id=$1",
            pqxx::params{file_id});
        REQUIRE(row.size() == 1);
        return std::to_string(row[0][0].as<bool>()) + ":" +
               std::to_string(row[0][1].as<bool>()) + ":" +
               (row[0][2].is_null() ? "null" : row[0][2].as<std::string>());
    }
};

} // namespace

TEST_CASE("B.71.E.3.M.1 external cleanup tombstone is isolated from file lifecycle", "[b71e3m1][tombstone][files]") {
    Fixture fixture("files");
    const auto file_id = fixture.create_google_pending("authority");
    const auto before = crow::json::load(fixture.files.get_user_quota(fixture.user_id).dump());
    const auto before_bytes = before["used_bytes"].i();

    REQUIRE_NOTHROW(fixture.files.mark_pending_google_upload_cancelled(file_id, fixture.user_id));
    CHECK(fixture.row_state(file_id) == "1:1:null");

    const auto token = fixture.auth.generate_token(fixture.user_id);
    crow::request unlink_request;
    unlink_request.add_header("Authorization", "Bearer " + token);
    const auto unlink_response = fixture.router.handle_unlink_google_account(
        unlink_request, static_cast<int>(fixture.storage_id));
    REQUIRE(unlink_response.code == 409);
    CHECK(unlink_response.body.find("ACCOUNT_HAS_PENDING_UPLOADS") != std::string::npos);

    crow::request trash_request;
    trash_request.add_header("Authorization", "Bearer " + token);
    const auto trash_response = fixture.router.handle_get_trash(trash_request);
    REQUIRE(trash_response.code == 200);
    CHECK(trash_response.body.find(std::to_string(file_id)) == std::string::npos);

    CHECK_THROWS(fixture.files.restore_file(file_id, fixture.user_id));
    CHECK_THROWS(fixture.files.hard_delete_file(file_id, fixture.user_id, nullptr));
    const auto batch = fixture.files.batch_hard_delete_files(
        fixture.user_id, {static_cast<int>(file_id)}, nullptr);
    CHECK(batch.deleted_count == 0);
    CHECK_NOTHROW(fixture.files.empty_trash(fixture.user_id, nullptr));
    CHECK(fixture.exists(file_id));
    CHECK(fixture.row_state(file_id) == "1:1:null");
    const auto after = crow::json::load(fixture.files.get_user_quota(fixture.user_id).dump());
    CHECK(after["used_bytes"].i() == before_bytes);

    crow::request restore_request;
    restore_request.add_header("Authorization", "Bearer " + token);
    CHECK(fixture.router.handle_restore_file(restore_request, static_cast<int>(file_id)).code == 404);

    crow::request delete_request;
    delete_request.add_header("Authorization", "Bearer " + token);
    CHECK(fixture.router.handle_hard_delete_file(delete_request, static_cast<int>(file_id)).code == 404);
    CHECK(fixture.exists(file_id));
}

TEST_CASE("B.71.E.3.M.1 detaches cleanup tombstone from every folder lifecycle", "[b71e3m1][tombstone][folders]") {
    Fixture fixture("folders");

    const auto restore_folder = fixture.create_folder("restore");
    const auto restore_file = fixture.create_google_pending("restore", restore_folder);
    REQUIRE_NOTHROW(fixture.files.mark_pending_google_upload_cancelled(restore_file, fixture.user_id));
    fixture.trash_folder(restore_folder);
    REQUIRE_NOTHROW(fixture.folders.restore_folder(restore_folder, fixture.user_id));
    CHECK(fixture.row_state(restore_file) == "1:1:null");

    const auto hard_folder = fixture.create_folder("hard");
    const auto hard_file = fixture.create_google_pending("hard", hard_folder);
    REQUIRE_NOTHROW(fixture.files.mark_pending_google_upload_cancelled(hard_file, fixture.user_id));
    fixture.trash_folder(hard_folder);
    REQUIRE_NOTHROW(fixture.folders.hard_delete_folder(hard_folder, fixture.user_id, nullptr));
    CHECK(fixture.exists(hard_file));
    CHECK(fixture.row_state(hard_file) == "1:1:null");

    const auto batch_folder = fixture.create_folder("batch");
    const auto batch_file = fixture.create_google_pending("batch", batch_folder);
    REQUIRE_NOTHROW(fixture.files.mark_pending_google_upload_cancelled(batch_file, fixture.user_id));
    fixture.trash_folder(batch_folder);
    const auto batch = fixture.folders.batch_hard_delete_folders(
        fixture.user_id, {static_cast<int>(batch_folder)}, nullptr);
    CHECK(batch.deleted_count == 1);
    CHECK(fixture.exists(batch_file));
    CHECK(fixture.row_state(batch_file) == "1:1:null");

    const auto empty_folder = fixture.create_folder("empty");
    const auto empty_file = fixture.create_google_pending("empty", empty_folder);
    REQUIRE_NOTHROW(fixture.files.mark_pending_google_upload_cancelled(empty_file, fixture.user_id));
    fixture.trash_folder(empty_folder);
    REQUIRE_NOTHROW(fixture.files.empty_trash(fixture.user_id, nullptr));
    CHECK(fixture.exists(empty_file));
    CHECK(fixture.row_state(empty_file) == "1:1:null");
}
