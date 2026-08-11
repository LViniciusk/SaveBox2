#pragma once

#include <cpr/cpr.h>
#include <string>
#include <vector>
#include <cstdint>
#include <unordered_map>
#include <mutex>
#include <shared_mutex>
#include <optional>
#include <chrono>
#include <future>
#include <memory>
#ifdef NANIKA_TESTING
#include <condition_variable>
#include <cstddef>
#endif

class DatabasePool;

class GoogleDriveService {
public:
    explicit GoogleDriveService(DatabasePool& pool);

    enum class TokenAccess {
        ActiveStorage,
        UnlinkCleanup,
    };

    struct LinkResult {
        std::string root_folder_id;
        std::string account_email;
    };

    LinkResult link_account(uint64_t user_id, const std::string& auth_code, const std::string& state);

    struct LinkedAccount {
        uint64_t id;
        std::string account_email;
        std::string account_picture;
        std::string root_folder_id;
        bool is_unlinking = false;
    };

    struct BatchUploadTarget {
        uint64_t storage_id;
        std::string access_token;
        std::string root_folder_id;
    };

    struct StorageTarget {
        uint64_t id;
        std::string account_email;
        std::string account_picture;
        std::string status;
        std::optional<uint64_t> used_bytes;
        std::optional<uint64_t> max_bytes;
        std::optional<uint64_t> available_bytes;
        uint64_t nanika_used_bytes = 0;
    };
    
    std::vector<LinkedAccount> get_linked_accounts(uint64_t user_id, bool include_unlinking = false);
    std::vector<StorageTarget> get_storage_targets(uint64_t user_id);
    
    std::string get_access_token_for_storage(
        uint64_t storage_id,
        TokenAccess access = TokenAccess::ActiveStorage);
    void invalidate_storage_caches(const std::vector<uint64_t>& storage_ids);

    bool is_linked(uint64_t user_id);
    
    std::pair<uint64_t, uint64_t> get_total_quota(uint64_t user_id);

    void unlink_account(uint64_t user_id, std::optional<uint64_t> storage_id = std::nullopt); // Se storage_id for nullopt, remove todos

    std::string generate_oauth_state(uint64_t user_id);
    
    int64_t get_available_space(const std::string& access_token);
    
    uint64_t select_best_storage(uint64_t user_id, int64_t file_size_bytes, std::string& out_access_token, std::string& out_root_folder_id);
    std::vector<BatchUploadTarget> select_batch_storages(uint64_t user_id, const std::vector<uint64_t>& file_sizes);

    struct ResumableSession {
        std::string session_uri;
        std::string access_token;
    };
    ResumableSession create_resumable_session(uint64_t user_id, uint64_t storage_id,
                                               uint64_t size_bytes, uint64_t move_id, uint64_t item_id,
                                               const std::string& role,
                                               const std::string& validated_origin = {});
    ResumableSession create_upload_resumable_session(uint64_t user_id, uint64_t storage_id,
                                                      uint64_t file_id, uint64_t size_bytes,
                                                      const std::string& name_hash,
                                                      const std::string& validated_origin = {});
    virtual std::vector<std::string> find_external_upload_targets(uint64_t user_id, uint64_t storage_id,
                                                                   uint64_t file_id, uint64_t size_bytes);
    uint64_t get_external_file_size(uint64_t user_id, uint64_t storage_id, const std::string& external_file_id);
    uint64_t validate_external_target(uint64_t user_id, uint64_t storage_id, const std::string& external_file_id,
                                      uint64_t move_id, uint64_t item_id, const std::string& role);
    virtual std::vector<std::string> find_external_targets(uint64_t user_id, uint64_t storage_id,
                                                            uint64_t move_id, uint64_t item_id,
                                                            const std::string& role, uint64_t size_bytes);
    virtual int delete_external_file(uint64_t storage_id, const std::string& external_file_id);

protected:
    std::string client_id_;
    std::string client_secret_;

#ifdef NANIKA_TESTING
    void expire_oauth_state_for_test(uint64_t user_id);
#endif

private:
#ifdef NANIKA_TESTING
    friend struct GoogleDriveQuotaTestProbe;
#endif
    DatabasePool& pool_;
    struct TokenResponse {
        std::string access_token;
        std::string refresh_token;
        std::string account_email;
        std::string account_picture;
    };

    struct TokenCacheEntry {
        std::string access_token;
        std::chrono::steady_clock::time_point expires_at;
        bool unlinking_scope;
    };

    struct TokenRefreshKey {
        uint64_t storage_id;
        TokenAccess access;

        bool operator==(const TokenRefreshKey& other) const {
            return storage_id == other.storage_id && access == other.access;
        }
    };

    struct TokenRefreshKeyHash {
        size_t operator()(const TokenRefreshKey& key) const {
            return std::hash<uint64_t>{}(key.storage_id) ^
                (std::hash<int>{}(static_cast<int>(key.access)) << 1);
        }
    };

    static constexpr std::chrono::minutes OAUTH_STATE_TTL{10};
    static constexpr int GOOGLE_LINK_CLAIM_TTL_SECONDS = 300;

    struct PendingOAuthState {
        std::string value;
        std::chrono::steady_clock::time_point expires_at;
    };

    std::mutex states_mutex_;
    std::unordered_map<uint64_t, PendingOAuthState> pending_states_;
    
    std::shared_mutex cache_mutex_;
    std::unordered_map<uint64_t, TokenCacheEntry> token_cache_;
    std::mutex token_refreshes_mutex_;
    std::unordered_map<TokenRefreshKey, std::shared_future<std::string>, TokenRefreshKeyHash> token_refreshes_;

    struct QuotaCacheEntry {
        uint64_t used_bytes;
        std::optional<uint64_t> max_bytes;
        std::chrono::steady_clock::time_point expires_at;
    };

    struct QuotaFlight {
        std::promise<QuotaCacheEntry> promise;
        std::shared_future<QuotaCacheEntry> future;
#ifdef NANIKA_TESTING
        std::mutex test_followers_mutex;
        std::condition_variable test_followers_cv;
        std::size_t test_followers = 0;
#endif

        QuotaFlight() : future(promise.get_future().share()) {}
    };

    std::mutex quota_cache_mutex_;
    std::unordered_map<uint64_t, QuotaCacheEntry> quota_cache_;
    std::unordered_map<uint64_t, std::shared_ptr<QuotaFlight>> quota_flights_;

    bool validate_and_consume_state(uint64_t user_id, const std::string& state);

    void acquire_link_claim(uint64_t user_id, const std::string& account_email,
                            const std::string& claim_id);
    void release_link_claim(uint64_t user_id, const std::string& account_email,
                            const std::string& claim_id);
    void finalize_link_claim(uint64_t user_id, const std::string& account_email,
                             const std::string& claim_id, const TokenResponse& tokens,
                             const std::string& encrypted_refresh_token,
                             const std::string& root_folder_id);

    TokenResponse exchange_code(const std::string& auth_code);
    std::string create_nanika_folder(const std::string& access_token);
    std::string refresh_access_token(const std::string& refresh_token);
    QuotaCacheEntry get_quota_for_storage(uint64_t storage_id);

protected:
    virtual cpr::Response make_post_request(const std::string& url, const cpr::Payload& payload) const;
    virtual cpr::Response make_post_request(const std::string& url, const std::string& json_body, const cpr::Header& headers) const;
    virtual cpr::Response make_get_request(const std::string& url, const cpr::Header& headers) const;
};

