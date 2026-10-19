#pragma once

#include <cpr/cpr.h>
#include <string>
#include <vector>
#include <cstdint>
#include <unordered_map>
#include <mutex>
#include <shared_mutex>
#include <optional>

class DatabasePool;

class GoogleDriveService {
public:
    explicit GoogleDriveService(DatabasePool& pool);

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
    };
    
    std::vector<LinkedAccount> get_linked_accounts(uint64_t user_id);
    
    std::string get_access_token_for_storage(uint64_t storage_id);

    bool is_linked(uint64_t user_id);
    
    std::pair<uint64_t, uint64_t> get_total_quota(uint64_t user_id);

    void unlink_account(uint64_t user_id, std::optional<uint64_t> storage_id = std::nullopt); // Se storage_id for nullopt, remove todos

    std::string generate_oauth_state(uint64_t user_id);
    
    int64_t get_available_space(const std::string& access_token);
    
    uint64_t select_best_storage(uint64_t user_id, int64_t file_size_bytes, std::string& out_access_token, std::string& out_root_folder_id);

    std::string get_access_token_for_user_file(uint64_t file_id);
    virtual std::string fetch_file_media(uint64_t file_id, const std::string& external_file_id, const std::string& range_header = "");

    virtual void make_file_public(uint64_t user_id, const std::string& external_file_id);
    virtual void revoke_file_public(uint64_t user_id, const std::string& external_file_id);

protected:
    std::string client_id_;
    std::string client_secret_;

private:
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
    };

    std::mutex states_mutex_;
    std::unordered_map<uint64_t, std::string> pending_states_;
    
    std::shared_mutex cache_mutex_;
    std::unordered_map<uint64_t, TokenCacheEntry> token_cache_;

    bool validate_and_consume_state(uint64_t user_id, const std::string& state);

    TokenResponse exchange_code(const std::string& auth_code);
    std::string create_nanika_folder(const std::string& access_token);
    std::string refresh_access_token(const std::string& refresh_token);

protected:
    virtual cpr::Response make_post_request(const std::string& url, const cpr::Payload& payload) const;
    virtual cpr::Response make_post_request(const std::string& url, const std::string& json_body, const cpr::Header& headers) const;
    virtual cpr::Response make_get_request(const std::string& url, const cpr::Header& headers) const;
};

