#pragma once

#include "crow_all.h"
#include "middlewares/RateLimitMiddleware.hpp"
#include "middlewares/CustomCorsMiddleware.hpp"
#include "middlewares/HttpBodyLimitMiddleware.hpp"
#include "database/DatabasePool.hpp"
#include "Services/AuthService.hpp"

class FileManager;
class FolderManager;
class FileChunker;
class GoogleDriveService;

#include <optional>
#include <cstdint>
#include <string>
#include <string_view>
#include <functional>

#ifdef NANIKA_TESTING
#include <cpr/cpr.h>
#endif

namespace AuthHttpPolicy {
bool secure_cookie_for_origin(std::string_view configured_origin);
}

using NanikaCrowApp = crow::App<CustomCorsMiddleware, HttpBodyLimitMiddleware, RateLimitMiddleware>;

class ApiRouter {
public:
    ApiRouter() = default;
    ApiRouter(DatabasePool& pool, AuthService& auth, FolderManager& folder_mgr,
              FileManager* file_mgr = nullptr, FileChunker* chunker = nullptr,
              GoogleDriveService* gdrive = nullptr,
              std::function<void()> cleanup_trigger = {},
              bool trust_forwarded = false,
              std::string auth_cookie_origin = {});

    std::string handle_healthcheck() const;
    crow::response handle_get_quota(const crow::request& req);
    crow::response handle_delete_user(const crow::request& req);
    crow::response handle_update_profile(const crow::request& req);
    crow::response handle_register(const crow::request& req);
    crow::response handle_login(const crow::request& req);
    crow::response handle_google_login(const crow::request& req);
    crow::response handle_refresh(const crow::request& req);
    crow::response handle_logout(const crow::request& req);
    crow::response handle_logout_global(const crow::request& req);
    crow::response handle_verify_email(const crow::request& req);
    crow::response handle_update_profile_pic(const crow::request& req);
#ifdef NANIKA_TESTING
    using ProfileImageUploadTestHook = std::function<cpr::Response()>;
    static void set_profile_image_upload_test_hook(ProfileImageUploadTestHook hook);
    static void clear_profile_image_upload_test_hook();
#endif
    crow::response handle_create_folder(const crow::request& req);
    crow::response handle_batch_create_folders(const crow::request& req);
    crow::response handle_get_pinned_folders(const crow::request& req);
    crow::response handle_pin_folder(const crow::request& req, int folder_id);
    crow::response handle_unpin_folder(const crow::request& req, int folder_id);
    crow::response handle_reorder_pinned_folders(const crow::request& req);
    crow::response handle_init_file_upload(const crow::request& req);
    crow::response handle_batch_init_uploads(const crow::request& req);
    crow::response handle_upload_chunk(const crow::request& req, int file_id);
    crow::response handle_download_file(const crow::request& req, int file_id);
    crow::response handle_list_folder_contents(const crow::request& req, int folder_id);
    crow::response handle_get_tree(const crow::request& req);
    crow::response handle_get_uploaded_chunks(const crow::request& req, int file_id);
    crow::response handle_get_pending_uploads(const crow::request& req);
    crow::response handle_get_external_upload_recovery_context(const crow::request& req, int file_id);
    crow::response handle_create_external_upload_session(const crow::request& req, int file_id);
    crow::response handle_cancel_external_upload(const crow::request& req, int file_id);
    crow::response handle_get_pending_upload_recovery_prefix(const crow::request& req, int file_id);
    crow::response handle_delete_file(const crow::request& req, int file_id);
    crow::response handle_batch_delete(const crow::request& req);
    crow::response handle_batch_hard_delete(const crow::request& req);
    crow::response handle_batch_delete_folders(const crow::request& req);
    crow::response handle_batch_hard_delete_folders(const crow::request& req);
    crow::response handle_delete_folder(const crow::request& req, int folder_id);
    crow::response handle_trash_folder(const crow::request& req, int folder_id);
    crow::response handle_trash_file(const crow::request& req, int file_id);
    crow::response handle_hard_delete_folder(const crow::request& req, int folder_id);
    crow::response handle_hard_delete_file(const crow::request& req, int file_id);
    crow::response handle_restore_folder(const crow::request& req, int folder_id);
    crow::response handle_restore_file(const crow::request& req, int file_id);
    crow::response handle_get_trash(const crow::request& req);
    crow::response handle_empty_trash(const crow::request& req);
    crow::response handle_update_file(const crow::request& req, int file_id);
    crow::response handle_update_folder(const crow::request& req, int folder_id);
    crow::response handle_share_file(const crow::request& req, int file_id);
    crow::response handle_get_shared_file(const crow::request& req, const std::string& uuid);
    crow::response handle_list_shares(const crow::request& req, int file_id);
    crow::response handle_revoke_share(const crow::request& req, const std::string& uuid);
    crow::response handle_get_share_metadata(const crow::request& req, const std::string& uuid);
    crow::response handle_link_google_drive(const crow::request& req);
    crow::response handle_get_google_accounts(const crow::request& req);
    crow::response handle_get_storage_targets(const crow::request& req);
    crow::response handle_get_storage_tree(const crow::request& req);
    crow::response handle_start_storage_move(const crow::request& req, int file_id);
    crow::response handle_get_active_storage_moves(const crow::request& req);
    crow::response handle_get_storage_move(const crow::request& req, int move_id);
    crow::response handle_pause_storage_move(const crow::request& req, int move_id);
    crow::response handle_resume_storage_move(const crow::request& req, int move_id);
    crow::response handle_cancel_storage_move(const crow::request& req, int move_id);
    crow::response handle_clear_storage_move(const crow::request& req, int move_id);
    crow::response handle_storage_move_failure(const crow::request& req, int move_id);
    crow::response handle_storage_move_progress(const crow::request& req, int move_id);
    crow::response handle_upload_storage_move_chunk(const crow::request& req, int move_id, int item_id, int chunk_index);
    crow::response handle_get_storage_move_chunks(const crow::request& req, int move_id, int item_id);
    crow::response handle_get_storage_move_source(const crow::request& req, int move_id, int item_id);
    crow::response handle_storage_move_target_uploaded(const crow::request& req, int move_id, int item_id);
    crow::response handle_reconcile_storage_move(const crow::request& req, int move_id);
    crow::response handle_create_storage_move_google_session(const crow::request& req, int move_id, int item_id);
    crow::response handle_complete_storage_move(const crow::request& req, int move_id);
    crow::response handle_unlink_google_account(const crow::request& req, int account_id);
    crow::response handle_generate_google_state(const crow::request& req);
    crow::response handle_finalize_external_upload(const crow::request& req, int file_id);
    crow::response handle_get_google_sync_map(const crow::request& req, int account_id);
    crow::response handle_google_sync_cleanup(const crow::request& req, int account_id);
    crow::response handle_init_vault(const crow::request& req);
    crow::response handle_get_vault_verification(const crow::request& req);

    void setup_routes(NanikaCrowApp& app);

private:
    DatabasePool* pool_ = nullptr;
    AuthService* auth_ = nullptr;
    FolderManager* folder_mgr_ = nullptr;
    FileManager* file_mgr_ = nullptr;
    FileChunker* chunker_ = nullptr;
    GoogleDriveService* gdrive_ = nullptr;
    std::function<void()> cleanup_trigger_;
    bool trust_forwarded_ = false;
    std::string auth_cookie_origin_;

    std::optional<uint64_t> authenticate_request(const crow::request& req) const;
    void trigger_gc_cleanup();
};
