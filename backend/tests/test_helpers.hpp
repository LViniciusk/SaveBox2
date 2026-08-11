#pragma once

#include <string>
#include <map>
#include <cstdlib>
#include <stdexcept>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <mutex>
#include <vector>

#include "Services/EmailService.hpp"
#include "utils.hpp"

inline void set_test_environment(const char* name, const char* value) {
#ifdef _WIN32
    _putenv_s(name, value);
#else
    setenv(name, value, 1);
#endif
}

inline std::string get_secure_conn_string() {
    const auto env_path = NanikaConfig::find_dotenv_upwards(std::filesystem::current_path());
    const auto env_vars = env_path
        ? NanikaConfig::read_dotenv(*env_path)
        : std::map<std::string, std::string>{};

    auto get_var = [&](const std::string& key, const std::string& default_val) {
        if (const char* sys_val = std::getenv(key.c_str())) return std::string(sys_val);
        if (const auto it = env_vars.find(key); it != env_vars.end()) return it->second;

        return default_val;
    };

    std::string user = get_var("DB_USER", "As_vezes_no_silencio_da_noite");
    std::string pass = get_var("DB_PASSWORD", "Eu_fico_imaginando_nois_dois");
    std::string db   = get_var("DB_NAME", "Eu_fico_ali_sonhando_acordado");
    std::string host = get_var("DB_HOST", "Juntando");
    std::string port = get_var("DB_PORT", "O_antes_o_agora_e_o_depois");

    return "postgresql://" + user + ":" + pass + "@" + host + ":" + port + "/" + db;
}

class MockEmailService : public EmailService {
public:
    MockEmailService() : EmailService("A_depressão_me_fez_ver", "todas_as_faces_de_helen") {}

    bool send_ok = true;

protected:
    cpr::Response make_post_request(const std::string&, const cpr::Header&, const cpr::Body&) const override {
        cpr::Response res;
        res.error = cpr::Error{};
        res.error.code = cpr::ErrorCode::OK;
        res.status_code = send_ok ? 200 : 500;
        return res;
    }

    cpr::Response make_get_request(const std::string&) const override {
        cpr::Response res;
        res.error = cpr::Error{};
        res.error.code = cpr::ErrorCode::OK;
        res.status_code = 200;
        res.text = R"({
            "email_deliverability": {
                "status": "deliverable",
                "is_smtp_valid": true,
                "is_mx_valid": true
            },
            "email_quality": {
                "score": 0.95,
                "is_disposable": false
            },
            "email_risk": {
                "address_risk_status": "low"
            }
        })";
        return res;
    }
};

#include "Services/GoogleDriveService.hpp"

class MockGoogleDriveService : public GoogleDriveService {
public:
    explicit MockGoogleDriveService(DatabasePool& pool) : GoogleDriveService(pool) {
        client_id_ = "mock_client_id";
        client_secret_ = "mock_client_secret";
    }

    bool token_exchange_ok = true;
    bool create_folder_ok = true;
    bool refresh_token_ok = true;
    bool final_file_in_root = true;
    bool reconcile_has_match = false;
    bool reconcile_multiple = false;
    bool reconcile_paged = false;
    mutable std::atomic<int> quota_requests{0};
    mutable std::atomic<int> token_exchange_requests{0};
    mutable std::atomic<int> refresh_requests{0};
    mutable std::atomic<int> folder_search_requests{0};
    mutable std::atomic<int> folder_create_requests{0};
    mutable std::mutex refresh_gate_mutex;
    mutable std::condition_variable refresh_gate_cv;
    mutable int refresh_gate_waiters = 0;
    bool refresh_gate_enabled = false;
    mutable bool refresh_gate_released = false;
    mutable std::mutex quota_gate_mutex;
    mutable std::condition_variable quota_gate_cv;
    mutable int quota_gate_waiters = 0;
    mutable int quota_gate_block_requests = 0;
    bool quota_gate_enabled = false;
    mutable bool quota_gate_released = false;
    mutable int quota_gate_released_request = 0;
    mutable int quota_status_code = 200;
    mutable std::string quota_response_body = R"({
                "storageQuota": {
                    "limit": "1000000000000",
                    "usage": "500000000000"
                }
            })";
    mutable std::vector<std::pair<int, std::string>> quota_response_sequence;
    mutable std::mutex link_gate_mutex;
    mutable std::condition_variable link_gate_cv;
    mutable int link_gate_waiters = 0;
    mutable int link_gate_block_requests = 0;
    mutable int link_gate_released_request = 0;
    mutable bool link_gate_enabled = false;
    mutable bool link_gate_released = false;
    mutable std::string last_json_body;
    mutable cpr::Header last_session_headers;
    std::string mock_root_folder_id = "mock_folder_123";
    std::string mock_access_token = "mock_access_token_xyz";
    std::string mock_refresh_token = "mock_refresh_token_abc";
    std::string mock_account_email = "mock@test.com";
    std::string mock_account_picture;
    bool numbered_folder_ids = false;
    bool folder_search_has_existing = false;

    bool expect_refresh = false;
    bool override_reconciliation = false;
    bool reconciliation_fails = false;
    std::vector<std::string> reconciliation_targets;
    mutable int reconciliation_requests = 0;
    bool override_upload_reconciliation = false;
    bool upload_reconciliation_fails = false;
    std::vector<std::string> upload_reconciliation_targets;
    std::map<uint64_t, std::vector<std::string>> upload_reconciliation_targets_by_file;
    mutable int upload_reconciliation_requests = 0;
    mutable int deletion_requests = 0;
    int deletion_status = 204;

    void enable_refresh_gate() {
        std::lock_guard<std::mutex> lock(refresh_gate_mutex);
        refresh_gate_enabled = true;
        refresh_gate_released = false;
        refresh_gate_waiters = 0;
    }

    bool wait_for_refresh_waiters(int count) const {
        std::unique_lock<std::mutex> lock(refresh_gate_mutex);
        return refresh_gate_cv.wait_for(lock, std::chrono::seconds(5), [&] {
            return refresh_gate_waiters >= count;
        });
    }

    void release_refresh_gate() {
        std::lock_guard<std::mutex> lock(refresh_gate_mutex);
        refresh_gate_released = true;
        refresh_gate_enabled = false;
        refresh_gate_cv.notify_all();
    }

    void enable_quota_gate(int blocked_requests = 1) {
        std::lock_guard<std::mutex> lock(quota_gate_mutex);
        quota_gate_enabled = true;
        quota_gate_released = false;
        quota_gate_released_request = 0;
        quota_gate_waiters = 0;
        quota_gate_block_requests = blocked_requests;
    }

    bool wait_for_quota_waiters(int count) const {
        std::unique_lock<std::mutex> lock(quota_gate_mutex);
        return quota_gate_cv.wait_for(lock, std::chrono::seconds(5), [&] {
            return quota_gate_waiters >= count;
        });
    }

    void release_quota_gate() {
        std::lock_guard<std::mutex> lock(quota_gate_mutex);
        quota_gate_released = true;
        quota_gate_enabled = false;
        quota_gate_cv.notify_all();
    }

    void release_quota_request(int request_number) {
        std::lock_guard<std::mutex> lock(quota_gate_mutex);
        quota_gate_released_request = request_number;
        quota_gate_cv.notify_all();
    }

    void set_quota_response(int status_code, std::string body) {
        std::lock_guard<std::mutex> lock(quota_gate_mutex);
        quota_status_code = status_code;
        quota_response_body = std::move(body);
    }

    void set_quota_response_sequence(std::vector<std::pair<int, std::string>> responses) {
        std::lock_guard<std::mutex> lock(quota_gate_mutex);
        quota_response_sequence = std::move(responses);
        quota_requests = 0;
    }

    void enable_link_gate(int blocked_requests) {
        std::lock_guard<std::mutex> lock(link_gate_mutex);
        link_gate_enabled = true;
        link_gate_released = false;
        link_gate_waiters = 0;
        link_gate_released_request = 0;
        link_gate_block_requests = blocked_requests;
    }

    bool wait_for_link_waiters(int count) const {
        std::unique_lock<std::mutex> lock(link_gate_mutex);
        return link_gate_cv.wait_for(lock, std::chrono::seconds(5), [&] {
            return link_gate_waiters >= count;
        });
    }

    bool wait_for_folder_searches(int count) const {
        std::unique_lock<std::mutex> lock(link_gate_mutex);
        return link_gate_cv.wait_for(lock, std::chrono::seconds(5), [&] {
            return folder_search_requests.load() >= count;
        });
    }

    void release_link_gate() {
        std::lock_guard<std::mutex> lock(link_gate_mutex);
        link_gate_released = true;
        link_gate_enabled = false;
        link_gate_cv.notify_all();
    }

    void release_link_request(int request_number) {
        std::lock_guard<std::mutex> lock(link_gate_mutex);
        link_gate_released_request = request_number;
        link_gate_cv.notify_all();
    }

    // Helper para gerar state e usar nos testes
    std::string generate_test_state(uint64_t user_id) {
        return generate_oauth_state(user_id);
    }

#ifdef NANIKA_TESTING
    void expire_test_state(uint64_t user_id) {
        expire_oauth_state_for_test(user_id);
    }
#endif

    std::vector<std::string> find_external_targets(uint64_t user_id, uint64_t storage_id,
                                                    uint64_t move_id, uint64_t item_id,
                                                    const std::string& role, uint64_t size_bytes) override {
        if (!override_reconciliation) {
            return GoogleDriveService::find_external_targets(user_id, storage_id, move_id, item_id, role, size_bytes);
        }
        ++reconciliation_requests;
        if (reconciliation_fails) throw std::runtime_error("mock reconciliation failure");
        return reconciliation_targets;
    }

    std::vector<std::string> find_external_upload_targets(uint64_t user_id, uint64_t storage_id,
                                                           uint64_t file_id, uint64_t size_bytes) override {
        if (!override_upload_reconciliation) {
            return GoogleDriveService::find_external_upload_targets(user_id, storage_id, file_id, size_bytes);
        }
        ++upload_reconciliation_requests;
        if (upload_reconciliation_fails) throw std::runtime_error("mock upload reconciliation failure");
        const auto by_file = upload_reconciliation_targets_by_file.find(file_id);
        if (by_file != upload_reconciliation_targets_by_file.end()) return by_file->second;
        return upload_reconciliation_targets;
    }

    int delete_external_file(uint64_t, const std::string&) override {
        ++deletion_requests;
        return deletion_status;
    }

protected:
    cpr::Response make_post_request(const std::string& url, const cpr::Payload&) const override {
        cpr::Response res;
        res.error = cpr::Error{};
        res.error.code = cpr::ErrorCode::OK;

        if (url.find("oauth2.googleapis.com/token") != std::string::npos) {
            if (expect_refresh) {
                ++refresh_requests;
                std::unique_lock<std::mutex> gate_lock(refresh_gate_mutex);
                if (refresh_gate_enabled) {
                    ++refresh_gate_waiters;
                    refresh_gate_cv.notify_all();
                    refresh_gate_cv.wait(gate_lock, [&] { return refresh_gate_released; });
                }
                res.status_code = refresh_token_ok ? 200 : 400;
                res.text = refresh_token_ok ? R"({"access_token": ")" + mock_access_token + R"("})" : R"({"error": "invalid_grant"})";
            } else {
                ++token_exchange_requests;
                res.status_code = token_exchange_ok ? 200 : 400;
                res.text = token_exchange_ok ? R"({"access_token": ")" + mock_access_token + R"(", "refresh_token": ")" + mock_refresh_token + R"("})" : R"({"error": "invalid_request"})";
            }
        }
        return res;
    }

    cpr::Response make_post_request(const std::string& url, const std::string& json_body, const cpr::Header& headers) const override {
        cpr::Response res;
        res.error = cpr::Error{};
        res.error.code = cpr::ErrorCode::OK;
        
        if (url.find("upload/drive/v3/files") != std::string::npos) {
            last_json_body = json_body;
            last_session_headers = headers;
            res.status_code = 200;
            res.header["location"] = "https://upload.example/session-redacted";
        } else if (url.find("drive/v3/files") != std::string::npos) {
            const int request_number = folder_create_requests.fetch_add(1) + 1;
            res.status_code = create_folder_ok ? 200 : 500;
            const std::string folder_id = numbered_folder_ids
                ? "b37_folder_" + std::to_string(request_number)
                : mock_root_folder_id;
            res.text = create_folder_ok ? R"({"id": ")" + folder_id + R"("})" : R"({"error": "internal"})";
        }
        return res;
    }

    cpr::Response make_get_request(const std::string& url, const cpr::Header&) const override {
        cpr::Response res;
        res.error = cpr::Error{};
        res.error.code = cpr::ErrorCode::OK;
        
        if (url.find("?fields=size%2Cparents%2CappProperties") != std::string::npos) {
            res.status_code = 200;
            const auto parent = final_file_in_root ? mock_root_folder_id : "wrong-root";
            res.text = R"({"size":"10","parents":[")" + parent + R"("],"appProperties":{"nanika_move_id":"42","nanika_move_item_id":"43","nanika_role":"original"}})";
        } else if (url.find("?fields=size%2Cparents") != std::string::npos) {
            res.status_code = 200;
            const auto parent = final_file_in_root ? mock_root_folder_id : "wrong-root";
            res.text = R"({"size":"10","parents":[")" + parent + R"("]})";
        } else if (url.find("appProperties%20has") != std::string::npos) {
            res.status_code = 200;
            if (!reconcile_has_match) res.text = R"({"files":[]})";
            else if (reconcile_paged && url.find("pageToken=") == std::string::npos) res.text = R"({"nextPageToken":"page-2","files":[{"id":"target-b","size":"10","parents":["mock_folder_123"],"appProperties":{"nanika_move_id":"42","nanika_move_item_id":"43","nanika_role":"original"}}]})";
            else if (reconcile_paged) res.text = R"({"files":[{"id":"target-a","size":"10","parents":["mock_folder_123"],"appProperties":{"nanika_move_id":"42","nanika_move_item_id":"43","nanika_role":"original"}}]})";
            else if (reconcile_multiple) res.text = R"({"files":[{"id":"target-b","size":"10","parents":["mock_folder_123"],"appProperties":{"nanika_move_id":"42","nanika_move_item_id":"43","nanika_role":"original"}},{"id":"target-a","size":"10","parents":["mock_folder_123"],"appProperties":{"nanika_move_id":"42","nanika_move_item_id":"43","nanika_role":"original"}}]})";
            else res.text = R"({"files":[{"id":"target-a","size":"10","parents":["mock_folder_123"],"appProperties":{"nanika_move_id":"42","nanika_move_item_id":"43","nanika_role":"original"}}]})";
        } else if (url.find("drive/v3/files?q=name%20=%20'Nanika'") != std::string::npos) {
            const int request_number = folder_search_requests.fetch_add(1) + 1;
            std::unique_lock<std::mutex> gate_lock(link_gate_mutex);
            link_gate_cv.notify_all();
            if (link_gate_enabled && request_number <= link_gate_block_requests) {
                ++link_gate_waiters;
                link_gate_cv.notify_all();
                link_gate_cv.wait(gate_lock, [&] {
                    return link_gate_released || link_gate_released_request >= request_number;
                });
            }
            gate_lock.unlock();
            res.status_code = 200;
            res.text = folder_search_has_existing
                ? R"({"files":[{"id":"existing_b37_folder","name":"Nanika"}]})"
                : R"({"files": []})";
        } else if (url.find("oauth2/v2/userinfo") != std::string::npos) {
            res.status_code = 200;
            res.text = R"({"email": ")" + mock_account_email + '"';
            if (!mock_account_picture.empty()) res.text += R"(, "picture": ")" + mock_account_picture + '"';
            res.text += '}';
        } else if (url.find("drive/v3/about") != std::string::npos) {
            const int request_number = quota_requests.fetch_add(1) + 1;
            std::unique_lock<std::mutex> gate_lock(quota_gate_mutex);
            if (quota_gate_enabled && request_number <= quota_gate_block_requests) {
                ++quota_gate_waiters;
                quota_gate_cv.notify_all();
                quota_gate_cv.wait(gate_lock, [&] {
                    return quota_gate_released || quota_gate_released_request == request_number;
                });
            }
            gate_lock.unlock();
            res.status_code = quota_status_code;
            res.text = quota_response_body;
            {
                std::lock_guard<std::mutex> response_lock(quota_gate_mutex);
                if (request_number <= static_cast<int>(quota_response_sequence.size())) {
                    const auto& response = quota_response_sequence[request_number - 1];
                    res.status_code = response.first;
                    res.text = response.second;
                }
            }
        }
        return res;
    }
};
