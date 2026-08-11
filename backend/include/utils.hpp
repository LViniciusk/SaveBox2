#pragma once
#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <map>
#include <optional>
#include <regex>
#include <iostream>
#include <stdexcept>
#include <system_error>
#include <string>
#include <unordered_set>
#include <vector>

namespace NanikaConfig {

inline std::string validate_bind_address(const std::string& value) {
    if (value == "0.0.0.0" || value == "127.0.0.1") return value;
    throw std::runtime_error("Invalid NANIKA_BIND_ADDRESS");
}

inline constexpr std::size_t kMaxDotenvAncestors = 32;

inline bool readable_regular_file(const std::filesystem::path& candidate) {
    std::error_code ec;
    const auto status = std::filesystem::symlink_status(candidate, ec);
    if (ec || status.type() == std::filesystem::file_type::symlink ||
        !std::filesystem::is_regular_file(status)) {
        return false;
    }

    std::ifstream probe(candidate, std::ios::binary);
    return probe.good();
}

inline std::optional<std::filesystem::path> find_dotenv_upwards(
    const std::filesystem::path& start_path) {
    std::error_code ec;
    std::filesystem::path current = std::filesystem::absolute(start_path, ec);
    if (ec) return std::nullopt;
    current = current.lexically_normal();

    for (std::size_t level = 0; level <= kMaxDotenvAncestors; ++level) {
        const auto candidate = current / ".env";
        ec.clear();
        const auto status = std::filesystem::symlink_status(candidate, ec);
        if (ec) {
            if (ec == std::errc::no_such_file_or_directory) {
                // The candidate is absent; continuing upward is safe.
            } else {
                // An inaccessible candidate is not bypassed by searching above it.
                return std::nullopt;
            }
        } else if (status.type() != std::filesystem::file_type::not_found) {
            if (!readable_regular_file(candidate)) return std::nullopt;
            return candidate;
        }

        const auto parent = current.parent_path();
        if (parent.empty() || parent == current) return std::nullopt;
        current = parent;
    }

    return std::nullopt;
}

inline std::map<std::string, std::string> read_dotenv(
    const std::filesystem::path& path) {
    std::map<std::string, std::string> values;
    std::ifstream file(path);
    if (!file.is_open()) return values;

    std::string line;
    while (std::getline(file, line)) {
        if (line.empty() || line[0] == '#') continue;
        const auto pos = line.find('=');
        if (pos == std::string::npos) continue;

        std::string value = line.substr(pos + 1);
        if (!value.empty() && value.back() == '\r') value.pop_back();
        values[line.substr(0, pos)] = value;
    }
    return values;
}

} // namespace NanikaConfig

class Utils {
private:
    std::map<std::string, std::string> env_vars;
    std::unordered_set<std::string> blocked_domains;

    Utils() {
        const auto env_path = NanikaConfig::find_dotenv_upwards(std::filesystem::current_path());
        if (env_path) env_vars = NanikaConfig::read_dotenv(*env_path);

        std::ifstream domain_file;
        std::vector<std::filesystem::path> domain_paths;
        if (env_path) domain_paths.push_back(env_path->parent_path() / "config" / "disposable_domains.txt");
        for (const char* path : {
            "config/disposable_domains.txt",
            "../config/disposable_domains.txt",
            "../../config/disposable_domains.txt",
            "/app/config/disposable_domains.txt"
        }) {
            domain_paths.emplace_back(path);
        }
        for (const auto& path : domain_paths) {
            domain_file.open(path);
            if (domain_file.is_open()) break;
            domain_file.clear();
        }
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
        if (const char* sys_val = std::getenv(key.c_str())) {
            std::string value(sys_val);
            if (!value.empty() && value.back() == '\r') value.pop_back();
            return value;
        }
        return default_val;
    }

    std::string get_required_var(const std::string& key) {
        auto it = env_vars.find(key);
        if (it != env_vars.end() && !it->second.empty()) {
            return it->second;
        }

        if (const char* sys_val = std::getenv(key.c_str())) {
            std::string value(sys_val);
            if (!value.empty() && value.back() == '\r') value.pop_back();
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

    inline std::string get_bind_address() {
        auto& cfg = Utils::get();
        return NanikaConfig::validate_bind_address(cfg.get_var("NANIKA_BIND_ADDRESS", "0.0.0.0"));
    }

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
        return cfg.get_required_var("PASS_PEPPER");
    }

    inline std::string get_jwt_secret() {
        auto& cfg = Utils::get();
        return cfg.get_required_var("NANIKA_JWT_SECRET");
    }

    inline std::string get_storage_path() {
        auto& cfg = Utils::get();
        return cfg.get_required_var("NANIKA_STORAGE_PATH");
    }

    inline std::string get_resend_api_key() {
        auto& cfg = Utils::get();
        return cfg.get_required_var("RESEND_API_KEY");
    }

    inline std::string get_email_validation_api_key() {
        auto& cfg = Utils::get();
        return cfg.get_required_var("EMAIL_VALIDATION_API_KEY");
    }

    inline std::string get_imgur_client_id() {
        auto& cfg = Utils::get();
        return cfg.get_required_var("IMGUR_CLIENT_ID");
    }

    inline uint16_t get_port() {
        auto& cfg = Utils::get();
        std::string port_str = cfg.get_var("PORT", "8080");
        try {
            return static_cast<uint16_t>(std::stoi(port_str));
        } catch (...) {
            return 8080;
        }
    }

    inline bool trust_proxy_headers() {
        return Utils::get().get_var("TRUST_PROXY_HEADERS", "false") == "true";
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
