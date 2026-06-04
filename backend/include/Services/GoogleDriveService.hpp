#pragma once

#include <cpr/cpr.h>
#include <string>
#include <cstdint>
#include <unordered_map>
#include <mutex>

class DatabasePool;

class GoogleDriveService {
public:
    explicit GoogleDriveService(DatabasePool& pool);

    struct LinkResult {
        std::string root_folder_id;
    };

    LinkResult link_account(uint64_t user_id, const std::string& auth_code, const std::string& state);

    std::string get_valid_access_token(uint64_t user_id);

    std::string get_root_folder_id(uint64_t user_id);

    bool is_linked(uint64_t user_id);

    void unlink_account(uint64_t user_id);

    std::string generate_oauth_state(uint64_t user_id);

protected:
    std::string client_id_;
    std::string client_secret_;

private:
    DatabasePool& pool_;
    struct TokenResponse {
        std::string access_token;
        std::string refresh_token;
    };

    std::mutex states_mutex_;
    std::unordered_map<uint64_t, std::string> pending_states_;

    bool validate_and_consume_state(uint64_t user_id, const std::string& state);

    TokenResponse exchange_code(const std::string& auth_code);
    std::string create_savebox_folder(const std::string& access_token);
    std::string refresh_access_token(const std::string& refresh_token);

protected:
    virtual cpr::Response make_post_request(const std::string& url, const cpr::Payload& payload) const;
    virtual cpr::Response make_post_request(const std::string& url, const std::string& json_body, const cpr::Header& headers) const;
    virtual cpr::Response make_get_request(const std::string& url, const cpr::Header& headers) const;
};

