#pragma once

#include <fstream>
#include <string>
#include <map>
#include <cstdlib>

#include "Services/EmailService.hpp"

inline std::string get_secure_conn_string() {
    std::map<std::string, std::string> env_vars;

    std::ifstream file("../../.env");

    if (file.is_open()) {
        std::string line;
        while (std::getline(file, line)) {
            if (line.empty() || line[0] == '#') continue;

            auto pos = line.find('=');
            if (pos != std::string::npos) {
                std::string key = line.substr(0, pos);
                std::string value = line.substr(pos + 1);
                env_vars[key] = value;
            }
        }
    }

    auto get_var = [&](const std::string& key, const std::string& default_val) {
        if (env_vars.count(key)) return env_vars[key];
        if (const char* sys_val = std::getenv(key.c_str())) return std::string(sys_val);

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

    bool allow_domain = true;
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
        res.text = allow_domain ? R"({"is_disposable_email": false})" : R"({"is_disposable_email": true})";
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
    std::string mock_root_folder_id = "mock_folder_123";
    std::string mock_access_token = "mock_access_token_xyz";
    std::string mock_refresh_token = "mock_refresh_token_abc";

    bool expect_refresh = false;

    // Helper para gerar state e usar nos testes
    std::string generate_test_state(uint64_t user_id) {
        return generate_oauth_state(user_id);
    }

protected:
    cpr::Response make_post_request(const std::string& url, const cpr::Payload& payload) const override {
        cpr::Response res;
        res.error = cpr::Error{};
        res.error.code = cpr::ErrorCode::OK;

        if (url.find("oauth2.googleapis.com/token") != std::string::npos) {
            if (expect_refresh) {
                res.status_code = refresh_token_ok ? 200 : 400;
                res.text = refresh_token_ok ? R"({"access_token": ")" + mock_access_token + R"("})" : R"({"error": "invalid_grant"})";
            } else {
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
        
        if (url.find("drive/v3/files") != std::string::npos) {
            res.status_code = create_folder_ok ? 200 : 500;
            res.text = create_folder_ok ? R"({"id": ")" + mock_root_folder_id + R"("})" : R"({"error": "internal"})";
        }
        return res;
    }

    cpr::Response make_get_request(const std::string& url, const cpr::Header& headers) const override {
        cpr::Response res;
        res.error = cpr::Error{};
        res.error.code = cpr::ErrorCode::OK;
        
        if (url.find("drive/v3/files") != std::string::npos) {
            res.status_code = 200;
            res.text = R"({"files": []})";
        } else if (url.find("oauth2/v2/userinfo") != std::string::npos) {
            res.status_code = 200;
            res.text = R"({"email": "mock@test.com"})";
        } else if (url.find("drive/v3/about") != std::string::npos) {
            res.status_code = 200;
            res.text = R"({
                "storageQuota": {
                    "limit": "1000000000000",
                    "usage": "500000000000"
                }
            })";
        }
        return res;
    }
};
