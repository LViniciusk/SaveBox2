#pragma once
#include <string>
#include <map>
#include <fstream>
#include <cstdlib>
#include <algorithm>
#include <cctype>
#include <regex>
#include <unordered_set>
#include <iostream>
#include <stdexcept>

class Utils {
private:
    std::map<std::string, std::string> env_vars;
    std::unordered_set<std::string> blocked_domains;

    Utils() {
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

        std::ifstream domain_file("../../config/disposable_domains.txt");
        if (domain_file.is_open()) {
            std::string line;
            while (std::getline(domain_file, line)) {
                line.erase(std::remove_if(line.begin(), line.end(), ::isspace), line.end());
                if (!line.empty()) {
                    blocked_domains.insert(line);
                }
            }
        } else {
            std::cerr << "Aviso: blocklist nao encontrada" << std::endl;
        }
    }

public:
    static Utils& get() {
        static Utils instance;
        return instance;
    }

    std::string get_var(const std::string& key, const std::string& default_val = "") {
        if (env_vars.count(key)) return env_vars[key];
        if (const char* sys_val = std::getenv(key.c_str())) return std::string(sys_val);
        return default_val;
    }

    std::string get_required_var(const std::string& key) {
        auto it = env_vars.find(key);
        if (it != env_vars.end() && !it->second.empty()) {
            return it->second;
        }

        if (const char* sys_val = std::getenv(key.c_str())) {
            std::string value(sys_val);
            if (!value.empty()) {
                return value;
            }
        }

        throw std::runtime_error("Missing critical env var: " + key);
    }

    bool is_domain_blocked(const std::string& domain) const {
        return blocked_domains.find(domain) != blocked_domains.end();
    }
};




namespace DotEnv{

    inline std::string get_secure_conn_string() {
        auto& cfg = Utils::get();
        std::string user = cfg.get_required_var("DB_USER");
        std::string pass = cfg.get_required_var("DB_PASSWORD");
        std::string db   = cfg.get_required_var("DB_NAME");
        std::string host = cfg.get_required_var("DB_HOST");
        std::string port = cfg.get_required_var("DB_PORT");

        return "postgresql://" + user + ":" + pass + "@" + host + ":" + port + "/" + db;
    }

    inline std::string get_pepper() {
        auto& cfg = Utils::get();
        return cfg.get_required_var("SAVEBOX_PEPPER");
    }

    inline std::string get_jwt_secret() {
        auto& cfg = Utils::get();
        return cfg.get_required_var("SAVEBOX_JWT_SECRET");
    }

    inline std::string get_storage_path() {
        auto& cfg = Utils::get();
        return cfg.get_required_var("SAVEBOX_STORAGE_PATH");
    }

    inline std::string get_resend_api_key() {
        auto& cfg = Utils::get();
        return cfg.get_required_var("RESEND_API_KEY");
    }

    inline std::string get_email_validation_api_key() {
        auto& cfg = Utils::get();
        return cfg.get_required_var("EMAIL_VALIDATION_API_KEY");
    }
}

namespace EmailUtils {
    inline bool is_valid_format(const std::string& email) {
        static const std::regex email_regex(
            R"(^[A-Za-z0-9._-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$)");

        return std::regex_match(email, email_regex);
    }

    inline std::string extract_domain(const std::string& email) {
        std::size_t at_pos = email.find('@');
        if (at_pos == std::string::npos || at_pos + 1 >= email.size()) {
            return "";
        }

        std::string domain = email.substr(at_pos + 1);
        std::transform(domain.begin(), domain.end(), domain.begin(),
                    [](unsigned char c) { return static_cast<char>(std::tolower(c)); });

        return domain;
    }

    inline bool is_disposable(const std::string& email) {
        const std::string domain = extract_domain(email);
        return Utils::get().is_domain_blocked(domain);
    }
}