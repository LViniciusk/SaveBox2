#pragma once

#include <fstream>
#include <string>
#include <map>
#include <cstdlib>

#include "services/EmailService.hpp"

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
