#pragma once
#include <string>
#include <map>
#include <fstream>
#include <cstdlib>

class Utils {
private:
    std::map<std::string, std::string> env_vars;

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
};

inline std::string get_secure_conn_string() {
    auto& cfg = Utils::get();
    std::string user = cfg.get_var("DB_USER", "As_vezes_no_silencio_da_noite");
    std::string pass = cfg.get_var("DB_PASSWORD", "Eu_fico_imaginando_nois_dois");
    std::string db   = cfg.get_var("DB_NAME", "Eu_fico_ali_sonhando_acordado");
    std::string host = cfg.get_var("DB_HOST", "Juntando");
    std::string port = cfg.get_var("DB_PORT", "O_antes_o_agora_e_o_depois");

    return "postgresql://" + user + ":" + pass + "@" + host + ":" + port + "/" + db;
}

inline std::string get_pepper() {
    auto& cfg = Utils::get();
    return cfg.get_var("SAVEBOX_PEPPER", "Garotos_do_Relogio");
}

inline std::string get_jwt_secret() {
    auto& cfg = Utils::get();
    return cfg.get_var("SAVEBOX_JWT_SECRET", "Com_ou_sem_susanoo");
}

inline std::string get_storage_path() {
    auto& cfg = Utils::get();
    return cfg.get_var("SAVEBOX_STORAGE_PATH", "Módulo_lunar");
}