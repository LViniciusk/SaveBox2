#include "Services/GoogleDriveService.hpp"
#include "database/DatabasePool.hpp"
#include "utils.hpp"

#include <pqxx/pqxx>
#include <iostream>
#include <stdexcept>
#include <cpr/cpr.h>
#include <nlohmann/json.hpp>
#include <sodium.h>
#include <jwt-cpp/jwt.h>
#include "utils/utils.hpp"

namespace {
    std::vector<unsigned char> derive_symmetric_key(const std::string& pepper) {
        std::vector<unsigned char> key(crypto_secretbox_KEYBYTES);
        crypto_generichash(key.data(), key.size(),
                           reinterpret_cast<const unsigned char*>(pepper.data()), pepper.size(),
                           nullptr, 0);
        return key;
    }

    std::string encrypt_token_symmetric(const std::string& token, const std::vector<unsigned char>& key) {
        if (token.empty()) return "";

        std::vector<unsigned char> nonce(crypto_secretbox_NONCEBYTES);
        randombytes_buf(nonce.data(), nonce.size());

        std::vector<unsigned char> ciphertext(token.size() + crypto_secretbox_MACBYTES);
        crypto_secretbox_easy(ciphertext.data(), reinterpret_cast<const unsigned char*>(token.data()), token.size(),
                              nonce.data(), key.data());

        std::vector<unsigned char> combined(nonce.begin(), nonce.end());
        combined.insert(combined.end(), ciphertext.begin(), ciphertext.end());

        size_t b64_max_len = sodium_base64_ENCODED_LEN(combined.size(), sodium_base64_VARIANT_ORIGINAL);
        std::vector<char> b64(b64_max_len);
        sodium_bin2base64(b64.data(), b64.size(), combined.data(), combined.size(), sodium_base64_VARIANT_ORIGINAL);

        return std::string(b64.data());
    }

    std::string decrypt_token_symmetric(const std::string& encrypted_b64, const std::vector<unsigned char>& key) {
        if (encrypted_b64.empty()) return "";

        size_t bin_max_len = (encrypted_b64.size() / 4) * 3;
        std::vector<unsigned char> combined(bin_max_len);
        size_t bin_len = 0;
        if (sodium_base642bin(combined.data(), combined.size(), encrypted_b64.data(), encrypted_b64.size(),
                              nullptr, &bin_len, nullptr, sodium_base64_VARIANT_ORIGINAL) != 0) {
            throw std::runtime_error("INVALID_B64_TOKEN");
        }
        combined.resize(bin_len);

        if (combined.size() < crypto_secretbox_NONCEBYTES + crypto_secretbox_MACBYTES) {
            throw std::runtime_error("INVALID_TOKEN_PAYLOAD");
        }

        std::vector<unsigned char> nonce(combined.begin(), combined.begin() + crypto_secretbox_NONCEBYTES);
        std::vector<unsigned char> ciphertext(combined.begin() + crypto_secretbox_NONCEBYTES, combined.end());
        std::vector<unsigned char> plaintext(ciphertext.size() - crypto_secretbox_MACBYTES);

        if (crypto_secretbox_open_easy(plaintext.data(), ciphertext.data(), ciphertext.size(),
                                       nonce.data(), key.data()) != 0) {
            throw std::runtime_error("DECRYPTION_FAILED");
        }

        return std::string(reinterpret_cast<char*>(plaintext.data()), plaintext.size());
    }
}

GoogleDriveService::GoogleDriveService(DatabasePool& pool)
    : pool_(pool) {
    client_id_ = Utils::get().get_var("GOOGLE_CLIENT_ID", "");
    client_secret_ = Utils::get().get_var("GOOGLE_CLIENT_SECRET", "");
}


GoogleDriveService::LinkResult GoogleDriveService::link_account(uint64_t user_id, const std::string& auth_code, const std::string& state) {
    if (client_id_.empty() || client_secret_.empty()) {
        throw std::runtime_error("GOOGLE_DRIVE_NOT_CONFIGURED");
    }

    if (auth_code.empty()) {
        throw std::invalid_argument("AUTH_CODE_REQUIRED");
    }

    if (state.empty() || !validate_and_consume_state(user_id, state)) {
        throw std::invalid_argument("INVALID_OAUTH_STATE");
    }

    TokenResponse tokens = exchange_code(auth_code);
    

    {
        auto conn = pool_.acquire_connection();
        pqxx::work txn(*conn);
        auto check_res = txn.exec(
            "SELECT 1 FROM user_external_storages WHERE user_id = $1 AND provider = 'google_drive' AND account_email = $2 AND is_unlinking = FALSE",
            pqxx::params{user_id, tokens.account_email}
        );
        if (!check_res.empty()) {
            throw std::runtime_error("ALREADY_LINKED");
        }
    }

    std::string root_folder_id = create_savebox_folder(tokens.access_token);

    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);

    std::string pepper = Utils::get().get_required_var("PASS_PEPPER");
    auto key = derive_symmetric_key(pepper);
    std::string encrypted_refresh_token = encrypt_token_symmetric(tokens.refresh_token, key);

    txn.exec(
        "INSERT INTO user_external_storages (user_id, provider, account_email, refresh_token, root_folder_id) "
        "VALUES ($1, 'google_drive', $2, $3, $4)",
        pqxx::params{user_id, tokens.account_email, encrypted_refresh_token, root_folder_id}
    );

    txn.commit();

    return LinkResult{root_folder_id, tokens.account_email};
}

std::vector<GoogleDriveService::LinkedAccount> GoogleDriveService::get_linked_accounts(uint64_t user_id) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);

    auto result = txn.exec(
        "SELECT id, account_email, root_folder_id FROM user_external_storages "
        "WHERE user_id = $1 AND provider = 'google_drive' AND is_unlinking = FALSE",
        pqxx::params{user_id}
    );

    txn.commit();

    std::vector<LinkedAccount> accounts;
    for (const auto& row : result) {
        LinkedAccount acc;
        acc.id = row[0].as<uint64_t>();
        acc.account_email = row[1].is_null() ? "" : row[1].as<std::string>();
        acc.root_folder_id = row[2].is_null() ? "" : row[2].as<std::string>();
        accounts.push_back(acc);
    }

    return accounts;
}

std::string GoogleDriveService::get_access_token_for_storage(uint64_t storage_id) {
    {
        std::shared_lock<std::shared_mutex> lock(cache_mutex_);
        auto it = token_cache_.find(storage_id);
        if (it != token_cache_.end()) {
            if (std::chrono::steady_clock::now() < it->second.expires_at) {
                return it->second.access_token;
            }
        }
    }

    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);
    auto result = txn.exec(
        "SELECT refresh_token FROM user_external_storages WHERE id = $1",
        pqxx::params{storage_id}
    );
    txn.commit();
    
    if (result.empty()) throw std::runtime_error("STORAGE_NOT_FOUND");
    
    std::string encrypted_refresh_token = result[0][0].as<std::string>();
    std::string pepper = Utils::get().get_required_var("PASS_PEPPER");
    auto key = derive_symmetric_key(pepper);
    std::string refresh_token = decrypt_token_symmetric(encrypted_refresh_token, key);
    
    std::string new_access_token = refresh_access_token(refresh_token);
    
    {
        std::unique_lock<std::shared_mutex> lock(cache_mutex_);
        token_cache_[storage_id] = { new_access_token, std::chrono::steady_clock::now() + std::chrono::minutes(50) };
    }
    return new_access_token;
}

bool GoogleDriveService::is_linked(uint64_t user_id) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);

    auto result = txn.exec(
        "SELECT 1 FROM user_external_storages "
        "WHERE user_id = $1 AND provider = 'google_drive' AND is_unlinking = FALSE",
        pqxx::params{user_id}
    );

    txn.commit();
    return !result.empty();
}

void GoogleDriveService::unlink_account(uint64_t user_id, std::optional<uint64_t> storage_id) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);

    pqxx::result result;
    if (storage_id.has_value()) {
        result = txn.exec(
            "UPDATE user_external_storages SET is_unlinking = TRUE "
            "WHERE user_id = $1 AND id = $2 AND provider = 'google_drive' AND is_unlinking = FALSE RETURNING id",
            pqxx::params{user_id, storage_id.value()}
        );
    } else {
        result = txn.exec(
            "UPDATE user_external_storages SET is_unlinking = TRUE "
            "WHERE user_id = $1 AND provider = 'google_drive' AND is_unlinking = FALSE RETURNING id",
            pqxx::params{user_id}
        );
    }

    for (const auto& row : result) {
        uint64_t s_id = row[0].as<uint64_t>();
        
        auto count_res = txn.exec(
            "SELECT count(*) FROM files WHERE external_storage_id = $1 AND storage_provider = 'google_drive'",
            pqxx::params{s_id}
        );
        uint64_t file_count = count_res[0][0].as<uint64_t>();
        uint64_t refund_bytes = file_count * 2048;
        if (refund_bytes > 0) {
            txn.exec(
                "UPDATE users SET used_storage_bytes = GREATEST(0, used_storage_bytes - $1) WHERE id = $2",
                pqxx::params{refund_bytes, user_id}
            );
        }

        txn.exec(
            "INSERT INTO pending_external_deletions (external_file_id, external_storage_id) "
            "SELECT external_file_id, external_storage_id FROM files "
            "WHERE external_storage_id = $1 AND storage_provider = 'google_drive' AND external_file_id IS NOT NULL",
            pqxx::params{s_id}
        );

        txn.exec("DELETE FROM files WHERE external_storage_id = $1", pqxx::params{s_id});
    }

    txn.commit();

    if (result.empty()) {
        throw std::runtime_error("GOOGLE_DRIVE_NOT_LINKED");
    }
}

GoogleDriveService::TokenResponse GoogleDriveService::exchange_code(const std::string& auth_code) {
    cpr::Response r = make_post_request(
        "https://oauth2.googleapis.com/token",
        cpr::Payload{
            {"code", auth_code},
            {"client_id", client_id_},
            {"client_secret", client_secret_},
            {"grant_type", "authorization_code"},
            {"redirect_uri", Utils::get().get_var("GOOGLE_REDIRECT_URI", "postmessage")}
        }
    );

    if (r.status_code != 200) {
        std::cerr << "[GoogleDrive] exchange_code falhou. Status=" << r.status_code 
                  << " Body=" << r.text << std::endl;
        throw std::runtime_error("GOOGLE_TOKEN_EXCHANGE_FAILED");
    }

    picojson::value json_val;
    std::string err = picojson::parse(json_val, r.text);
    if (!err.empty() || !json_val.is<picojson::object>()) {
        throw std::runtime_error("GOOGLE_TOKEN_EXCHANGE_FAILED");
    }

    auto& obj = json_val.get<picojson::object>();

    auto at_it = obj.find("access_token");
    auto rt_it = obj.find("refresh_token");

    if (at_it == obj.end() || !at_it->second.is<std::string>()) {
        throw std::runtime_error("GOOGLE_TOKEN_EXCHANGE_FAILED");
    }

    TokenResponse tokens;
    tokens.access_token = at_it->second.get<std::string>();

    if (rt_it != obj.end() && rt_it->second.is<std::string>()) {
        tokens.refresh_token = rt_it->second.get<std::string>();
    } else {
        throw std::runtime_error("GOOGLE_REFRESH_TOKEN_MISSING");
    }

    cpr::Response userinfo_r = make_get_request(
        "https://www.googleapis.com/oauth2/v2/userinfo",
        cpr::Header{{"Authorization", "Bearer " + tokens.access_token}}
    );
    if (userinfo_r.status_code == 200) {
        picojson::value ui_json;
        if (picojson::parse(ui_json, userinfo_r.text).empty() && ui_json.is<picojson::object>()) {
            auto email_it = ui_json.get<picojson::object>().find("email");
            if (email_it != ui_json.get<picojson::object>().end() && email_it->second.is<std::string>()) {
                tokens.account_email = email_it->second.get<std::string>();
            }
        }
    }
    
    if (tokens.account_email.empty()) {
        throw std::runtime_error("GOOGLE_EMAIL_SCOPE_MISSING");
    }

    return tokens;
}

std::string GoogleDriveService::create_savebox_folder(const std::string& access_token) {
    cpr::Response search_r = make_get_request(
        "https://www.googleapis.com/drive/v3/files?q=name%20=%20'Nanika'%20and%20mimeType%20=%20'application/vnd.google-apps.folder'%20and%20trashed%20=%20false&fields=files(id,name)&spaces=drive",
        cpr::Header{{"Authorization", "Bearer " + access_token}}
    );

    if (search_r.status_code == 200) {
        picojson::value json_val;
        std::string err = picojson::parse(json_val, search_r.text);
        if (err.empty() && json_val.is<picojson::object>()) {
            auto& obj = json_val.get<picojson::object>();
            auto files_it = obj.find("files");
            if (files_it != obj.end() && files_it->second.is<picojson::array>()) {
                auto& files_arr = files_it->second.get<picojson::array>();
                if (!files_arr.empty() && files_arr[0].is<picojson::object>()) {
                    auto& first = files_arr[0].get<picojson::object>();
                    auto id_it = first.find("id");
                    if (id_it != first.end() && id_it->second.is<std::string>()) {
                        return id_it->second.get<std::string>();
                    }
                }
            }
        }
    }

    std::string create_body = R"({"name": "Nanika", "mimeType": "application/vnd.google-apps.folder"})";

    cpr::Response create_r = make_post_request(
        "https://www.googleapis.com/drive/v3/files",
        create_body,
        cpr::Header{
            {"Authorization", "Bearer " + access_token},
            {"Content-Type", "application/json"}
        }
    );

    if (create_r.status_code != 200) {
        std::cerr << "[GoogleDrive] create_savebox_folder falhou. Status=" << create_r.status_code << std::endl;
        throw std::runtime_error("GOOGLE_FOLDER_CREATION_FAILED");
    }

    picojson::value create_json;
    std::string create_err = picojson::parse(create_json, create_r.text);
    if (!create_err.empty() || !create_json.is<picojson::object>()) {
        throw std::runtime_error("GOOGLE_FOLDER_CREATION_FAILED");
    }

    auto& create_obj = create_json.get<picojson::object>();
    auto id_it = create_obj.find("id");
    if (id_it == create_obj.end() || !id_it->second.is<std::string>()) {
        throw std::runtime_error("GOOGLE_FOLDER_CREATION_FAILED");
    }

    return id_it->second.get<std::string>();
}

std::string GoogleDriveService::refresh_access_token(const std::string& refresh_token) {
    cpr::Response r = make_post_request(
        "https://oauth2.googleapis.com/token",
        cpr::Payload{
            {"client_id", client_id_},
            {"client_secret", client_secret_},
            {"refresh_token", refresh_token},
            {"grant_type", "refresh_token"}
        }
    );

    if (r.status_code != 200) {
        std::cerr << "[GoogleDrive] refresh_access_token falhou. Status=" << r.status_code << std::endl;
        throw std::runtime_error("GOOGLE_TOKEN_REFRESH_FAILED");
    }

    picojson::value json_val;
    std::string err = picojson::parse(json_val, r.text);
    if (!err.empty() || !json_val.is<picojson::object>()) {
        throw std::runtime_error("GOOGLE_TOKEN_REFRESH_FAILED");
    }

    auto& obj = json_val.get<picojson::object>();
    auto at_it = obj.find("access_token");

    if (at_it == obj.end() || !at_it->second.is<std::string>()) {
        throw std::runtime_error("GOOGLE_TOKEN_REFRESH_FAILED");
    }

    return at_it->second.get<std::string>();
}

int64_t GoogleDriveService::get_available_space(const std::string& access_token) {
    cpr::Response r = make_get_request(
        "https://www.googleapis.com/drive/v3/about?fields=storageQuota",
        cpr::Header{{"Authorization", "Bearer " + access_token}}
    );
    if (r.status_code != 200) return 0;
    
    picojson::value json_val;
    if (!picojson::parse(json_val, r.text).empty() || !json_val.is<picojson::object>()) return 0;
    
    auto& obj = json_val.get<picojson::object>();
    auto quota_it = obj.find("storageQuota");
    if (quota_it == obj.end() || !quota_it->second.is<picojson::object>()) return 0;
    
    auto& quota = quota_it->second.get<picojson::object>();
    auto limit_it = quota.find("limit");
    auto usage_it = quota.find("usage");
    
    if (limit_it != quota.end() && usage_it != quota.end() && limit_it->second.is<std::string>() && usage_it->second.is<std::string>()) {
        try {
            int64_t limit = std::stoll(limit_it->second.get<std::string>());
            int64_t usage = std::stoll(usage_it->second.get<std::string>());
            return limit - usage;
        } catch (...) {}
    }
    return 0;
}

uint64_t GoogleDriveService::select_best_storage(uint64_t user_id, int64_t file_size_bytes, std::string& out_access_token, std::string& out_root_folder_id) {
    std::vector<std::pair<uint64_t, std::string>> storages;
    {
        auto conn = pool_.acquire_connection();
        pqxx::work txn(*conn);
        auto result = txn.exec(
            "SELECT id, root_folder_id FROM user_external_storages WHERE user_id = $1 AND is_unlinking = FALSE ORDER BY id ASC",
            pqxx::params{user_id}
        );
        txn.commit();
        for (const auto& row : result) {
            uint64_t storage_id = row[0].as<uint64_t>();
            std::string root_folder_id = row[1].as<std::string>();
            storages.emplace_back(storage_id, root_folder_id);
        }
    }
    
    for (const auto& storage : storages) {
        uint64_t storage_id = storage.first;
        std::string root_folder_id = storage.second;
        
        try {
            std::string token = get_access_token_for_storage(storage_id);
            int64_t free_space = get_available_space(token);
            if (free_space >= file_size_bytes) {
                out_access_token = token;
                out_root_folder_id = root_folder_id;
                return storage_id;
            }
        } catch (...) {
            continue;
        }
    }
    
    return 0;
}

cpr::Response GoogleDriveService::make_post_request(const std::string& url, const cpr::Payload& payload) const {
    return cpr::Post(
        cpr::Url{url},
        payload,
        cpr::Timeout{5000}
    );
}

cpr::Response GoogleDriveService::make_post_request(const std::string& url, const std::string& json_body, const cpr::Header& headers) const {
    return cpr::Post(
        cpr::Url{url},
        cpr::Body{json_body},
        headers,
        cpr::Timeout{5000}
    );
}

cpr::Response GoogleDriveService::make_get_request(const std::string& url, const cpr::Header& headers) const {
    return cpr::Get(
        cpr::Url{url},
        headers,
        cpr::Timeout{5000}
    );
}

std::string GoogleDriveService::generate_oauth_state(uint64_t user_id) {
    std::string state = UuidUtils::generate_uuid_v4();
    std::lock_guard<std::mutex> lock(states_mutex_);
    pending_states_[user_id] = state;
    return state;
}

bool GoogleDriveService::validate_and_consume_state(uint64_t user_id, const std::string& state) {
    std::lock_guard<std::mutex> lock(states_mutex_);
    auto it = pending_states_.find(user_id);
    if (it == pending_states_.end() || it->second != state) {
        return false;
    }
    pending_states_.erase(it);
    return true;
}

std::pair<uint64_t, uint64_t> GoogleDriveService::get_total_quota(uint64_t user_id) {
    struct StorageItem {
        uint64_t id;
    };
    std::vector<StorageItem> storages;
    {
        auto conn = pool_.acquire_connection();
        pqxx::work txn(*conn);
        auto result = txn.exec(
            "SELECT id FROM user_external_storages WHERE user_id = $1 AND is_unlinking = FALSE",
            pqxx::params{user_id}
        );
        txn.commit();
        for (const auto& row : result) {
            storages.push_back({row[0].as<uint64_t>()});
        }
    }

    uint64_t total_virtual_used = 0;
    uint64_t total_virtual_max = 0;

    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);

    for (const auto& storage : storages) {
        std::string token;
        try {
            token = get_access_token_for_storage(storage.id);
        } catch (...) {
            continue;
        }

        cpr::Response r = make_get_request(
            "https://www.googleapis.com/drive/v3/about?fields=storageQuota",
            cpr::Header{{"Authorization", "Bearer " + token}}
        );
        if (r.status_code != 200) continue;

        picojson::value json_val;
        if (!picojson::parse(json_val, r.text).empty() || !json_val.is<picojson::object>()) continue;

        auto& obj = json_val.get<picojson::object>();
        auto quota_it = obj.find("storageQuota");
        if (quota_it == obj.end() || !quota_it->second.is<picojson::object>()) continue;

        auto& quota = quota_it->second.get<picojson::object>();
        auto limit_it = quota.find("limit");
        auto usage_it = quota.find("usage");

        if (limit_it != quota.end() && usage_it != quota.end() && limit_it->second.is<std::string>() && usage_it->second.is<std::string>()) {
            try {
                uint64_t limit = std::stoull(limit_it->second.get<std::string>());
                uint64_t usage = std::stoull(usage_it->second.get<std::string>());
                
                uint64_t available = (limit > usage) ? (limit - usage) : 0;

                // Query files size inside SaveBox for this storage
                auto size_res = txn.exec(
                    "SELECT COALESCE(SUM(size_bytes), 0) FROM files WHERE external_storage_id = $1 AND is_upload_complete = TRUE AND deleted_at IS NULL",
                    pqxx::params{storage.id}
                );
                uint64_t app_usage = 0;
                if (!size_res.empty()) {
                    app_usage = size_res[0][0].as<uint64_t>();
                }

                total_virtual_used += app_usage;
                total_virtual_max += (app_usage + available);
            } catch (...) {}
        }
    }
    txn.commit();

    return {total_virtual_used, total_virtual_max};
}
