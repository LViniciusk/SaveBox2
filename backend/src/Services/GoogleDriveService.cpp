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
#include <algorithm>
#include <cctype>
#include "utils/RandomIds.hpp"

namespace {
    std::string safe_account_picture(const std::string& value) {
        if (value.empty() || value.size() > 2048 || value.rfind("https://", 0) != 0 ||
            value.find_first_of(" \t\r\n") != std::string::npos) {
            return {};
        }
        return value;
    }

    bool is_safe_external_id(const std::string& value) {
        return !value.empty() && value.size() <= 256 && std::all_of(value.begin(), value.end(), [](unsigned char c) {
            return std::isalnum(c) || c == '_' || c == '-';
        });
    }

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
    void lock_google_link(pqxx::work& txn, uint64_t user_id, const std::string& account_email) {
        txn.exec(
            "SELECT pg_advisory_xact_lock(hashtextextended('nanika:google-link:' || $1::text || "
            "':google_drive:' || $2, 0))",
            pqxx::params{user_id, account_email});
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
    std::string pepper = Utils::get().get_required_var("PASS_PEPPER");
    auto key = derive_symmetric_key(pepper);
    std::string encrypted_refresh_token = encrypt_token_symmetric(tokens.refresh_token, key);
    const std::string claim_id = UuidUtils::generate_uuid_v4();

    acquire_link_claim(user_id, tokens.account_email, claim_id);

    std::string root_folder_id;
    try {
        root_folder_id = create_nanika_folder(tokens.access_token);
    } catch (...) {
        try {
            release_link_claim(user_id, tokens.account_email, claim_id);
        } catch (...) {
        }
        throw;
    }

    try {
        finalize_link_claim(user_id, tokens.account_email, claim_id, tokens,
                            encrypted_refresh_token, root_folder_id);
    } catch (...) {
        try {
            release_link_claim(user_id, tokens.account_email, claim_id);
        } catch (...) {
        }
        throw;
    }

    return LinkResult{root_folder_id, tokens.account_email};
}

void GoogleDriveService::acquire_link_claim(uint64_t user_id, const std::string& account_email,
                                             const std::string& claim_id) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);
    lock_google_link(txn, user_id, account_email);

    const auto active = txn.exec(
        "SELECT 1 FROM user_external_storages WHERE user_id=$1 AND provider='google_drive' "
        "AND account_email=$2 AND is_unlinking=FALSE LIMIT 1",
        pqxx::params{user_id, account_email});
    if (!active.empty()) throw std::runtime_error("ALREADY_LINKED");

    const auto existing = txn.exec(
        "SELECT claim_id, expires_at <= CURRENT_TIMESTAMP AS expired "
        "FROM google_link_claims WHERE user_id=$1 AND account_email=$2 FOR UPDATE",
        pqxx::params{user_id, account_email});
    if (existing.empty()) {
        txn.exec(
            "INSERT INTO google_link_claims(user_id,account_email,claim_id,expires_at) "
            "VALUES($1,$2,$3,CURRENT_TIMESTAMP + ($4 * INTERVAL '1 second'))",
            pqxx::params{user_id, account_email, claim_id, GOOGLE_LINK_CLAIM_TTL_SECONDS});
    } else if (!existing[0][1].as<bool>()) {
        throw std::runtime_error("LINK_IN_PROGRESS");
    } else {
        txn.exec(
            "UPDATE google_link_claims SET claim_id=$3, "
            "expires_at=CURRENT_TIMESTAMP + ($4 * INTERVAL '1 second'), "
            "created_at=CURRENT_TIMESTAMP WHERE user_id=$1 AND account_email=$2",
            pqxx::params{user_id, account_email, claim_id, GOOGLE_LINK_CLAIM_TTL_SECONDS});
    }

    txn.commit();
}

void GoogleDriveService::release_link_claim(uint64_t user_id, const std::string& account_email,
                                             const std::string& claim_id) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);
    lock_google_link(txn, user_id, account_email);
    txn.exec(
        "DELETE FROM google_link_claims WHERE user_id=$1 AND account_email=$2 AND claim_id=$3",
        pqxx::params{user_id, account_email, claim_id});
    txn.commit();
}

void GoogleDriveService::finalize_link_claim(uint64_t user_id, const std::string& account_email,
                                              const std::string& claim_id, const TokenResponse& tokens,
                                              const std::string& encrypted_refresh_token,
                                              const std::string& root_folder_id) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);
    lock_google_link(txn, user_id, account_email);

    const auto claim = txn.exec(
        "SELECT claim_id FROM google_link_claims "
        "WHERE user_id=$1 AND account_email=$2 FOR UPDATE",
        pqxx::params{user_id, account_email});
    if (claim.empty() || claim[0][0].as<std::string>() != claim_id) {
        throw std::runtime_error("LINK_CLAIM_LOST");
    }

    const auto active = txn.exec(
        "SELECT 1 FROM user_external_storages WHERE user_id=$1 AND provider='google_drive' "
        "AND account_email=$2 AND is_unlinking=FALSE LIMIT 1",
        pqxx::params{user_id, account_email});
    if (!active.empty()) throw std::runtime_error("ALREADY_LINKED");

    txn.exec(
        "INSERT INTO user_external_storages (user_id, provider, account_email, account_picture, refresh_token, root_folder_id) "
        "VALUES ($1, 'google_drive', $2, $3, $4, $5)",
        pqxx::params{user_id, account_email, tokens.account_picture, encrypted_refresh_token, root_folder_id});
    txn.exec(
        "DELETE FROM google_link_claims WHERE user_id=$1 AND account_email=$2 AND claim_id=$3",
        pqxx::params{user_id, account_email, claim_id});
    txn.commit();
}

std::vector<GoogleDriveService::LinkedAccount> GoogleDriveService::get_linked_accounts(uint64_t user_id, bool include_unlinking) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);

    const auto result = include_unlinking
        ? txn.exec(
            "SELECT id, account_email, root_folder_id, account_picture, is_unlinking FROM user_external_storages "
            "WHERE user_id = $1 AND provider = 'google_drive' ORDER BY id",
            pqxx::params{user_id})
        : txn.exec(
            "SELECT id, account_email, root_folder_id, account_picture, is_unlinking FROM user_external_storages "
            "WHERE user_id = $1 AND provider = 'google_drive' AND is_unlinking = FALSE ORDER BY id",
            pqxx::params{user_id});

    txn.commit();

    std::vector<LinkedAccount> accounts;
    for (const auto& row : result) {
        LinkedAccount acc;
        acc.id = row[0].as<uint64_t>();
        acc.account_email = row[1].is_null() ? "" : row[1].as<std::string>();
        acc.root_folder_id = row[2].is_null() ? "" : row[2].as<std::string>();
        acc.account_picture = row[3].is_null() ? "" : safe_account_picture(row[3].as<std::string>());
        acc.is_unlinking = row[4].as<bool>();
        accounts.push_back(acc);
    }

    return accounts;
}

std::string GoogleDriveService::get_access_token_for_storage(uint64_t storage_id, TokenAccess access) {
    const auto cached_token = [&]() -> std::optional<std::string> {
        std::shared_lock<std::shared_mutex> lock(cache_mutex_);
        const auto it = token_cache_.find(storage_id);
        if (it != token_cache_.end()
            && std::chrono::steady_clock::now() < it->second.expires_at) {
            if (access == TokenAccess::UnlinkCleanup || !it->second.unlinking_scope) {
                return it->second.access_token;
            }
        }
        return std::nullopt;
    };

    if (const auto cached = cached_token()) return *cached;

    std::promise<std::string> promise;
    std::shared_future<std::string> refresh;
    bool owner = false;
    const TokenRefreshKey refresh_key{storage_id, access};
    {
        std::lock_guard<std::mutex> lock(token_refreshes_mutex_);
        const auto existing = token_refreshes_.find(refresh_key);
        if (existing != token_refreshes_.end()) {
            refresh = existing->second;
        } else {
            refresh = promise.get_future().share();
            token_refreshes_.emplace(refresh_key, refresh);
            owner = true;
        }
    }

    if (!owner) return refresh.get();

    const auto release_refresh = [&]() {
        std::lock_guard<std::mutex> lock(token_refreshes_mutex_);
        token_refreshes_.erase(refresh_key);
    };

    try {
        if (const auto cached = cached_token()) {
            promise.set_value(*cached);
            release_refresh();
            return *cached;
        }

        std::string encrypted_refresh_token;
        bool refresh_started_while_unlinking;
        {
            auto conn = pool_.acquire_connection();
            pqxx::work txn(*conn);
            auto result = txn.exec(
                "SELECT refresh_token,is_unlinking FROM user_external_storages "
                "WHERE id = $1 AND provider = 'google_drive'",
                pqxx::params{storage_id}
            );
            if (result.empty()) throw std::runtime_error("STORAGE_NOT_FOUND");
            encrypted_refresh_token = result[0][0].as<std::string>();
            refresh_started_while_unlinking = result[0][1].as<bool>();
            txn.commit();
        }

        if (refresh_started_while_unlinking && access == TokenAccess::ActiveStorage) {
            throw std::runtime_error("STORAGE_NOT_FOUND");
        }

        const std::string pepper = Utils::get().get_required_var("PASS_PEPPER");
        const auto key = derive_symmetric_key(pepper);
        const std::string refresh_token = decrypt_token_symmetric(encrypted_refresh_token, key);

        const std::string new_access_token = refresh_access_token(refresh_token);

        {
            auto conn = pool_.acquire_connection();
            pqxx::work txn(*conn);
            const auto lifecycle = txn.exec(
                "SELECT is_unlinking FROM user_external_storages "
                "WHERE id = $1 AND provider = 'google_drive' FOR SHARE",
                pqxx::params{storage_id}
            );
            if (lifecycle.empty()
                || lifecycle[0][0].as<bool>() != refresh_started_while_unlinking) {
                throw std::runtime_error("STORAGE_NOT_FOUND");
            }
            {
                std::unique_lock<std::shared_mutex> lock(cache_mutex_);
                token_cache_[storage_id] = {
                    new_access_token,
                    std::chrono::steady_clock::now() + std::chrono::minutes(50),
                    refresh_started_while_unlinking,
                };
            }
            txn.commit();
        }
        promise.set_value(new_access_token);
        release_refresh();
        return new_access_token;
    } catch (...) {
        const auto error = std::current_exception();
        promise.set_exception(error);
        release_refresh();
        std::rethrow_exception(error);
    }
}

void GoogleDriveService::invalidate_storage_caches(const std::vector<uint64_t>& storage_ids) {
    if (storage_ids.empty()) return;
    {
        std::unique_lock lock(cache_mutex_);
        for (const auto storage_id : storage_ids) token_cache_.erase(storage_id);
    }
    {
        std::lock_guard lock(quota_cache_mutex_);
        for (const auto storage_id : storage_ids) {
            quota_cache_.erase(storage_id);
            quota_flights_.erase(storage_id);
        }
    }
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

    std::vector<uint64_t> captured_storage_ids;
    if (storage_id.has_value()) {
        const auto captured = txn.exec(
            "SELECT id FROM user_external_storages "
            "WHERE id=$1 AND user_id=$2 AND provider='google_drive' AND is_unlinking=FALSE FOR UPDATE",
            pqxx::params{storage_id.value(), user_id});
        if (captured.empty()) throw std::runtime_error("GOOGLE_DRIVE_NOT_LINKED");
        captured_storage_ids.push_back(captured[0][0].as<uint64_t>());
    } else {
        const auto captured = txn.exec(
            "SELECT id FROM user_external_storages "
            "WHERE user_id=$1 AND provider='google_drive' AND is_unlinking=FALSE "
            "ORDER BY id FOR UPDATE",
            pqxx::params{user_id});
        if (captured.empty()) throw std::runtime_error("GOOGLE_DRIVE_NOT_LINKED");
        captured_storage_ids.reserve(captured.size());
        for (const auto& row : captured) captured_storage_ids.push_back(row[0].as<uint64_t>());
    }

    std::string captured_ids = "{";
    for (size_t i = 0; i < captured_storage_ids.size(); ++i) {
        if (i > 0) captured_ids += ",";
        captured_ids += std::to_string(captured_storage_ids[i]);
    }
    captured_ids += "}";

    const auto dependency = txn.exec(
        "SELECT 1 FROM user_external_storages s WHERE s.user_id=$1 "
        "AND s.id=ANY($2::bigint[]) AND ("
        "EXISTS (SELECT 1 FROM storage_move_jobs m WHERE m.user_id=$1 AND "
        "(m.source_external_storage_id=s.id OR m.target_external_storage_id=s.id) AND "
        "m.status IN ('prepared','transferring','paused','target_uploaded','committing','cleanup_pending')) OR "
        "EXISTS (SELECT 1 FROM pending_external_deletions p WHERE p.external_storage_id=s.id) OR "
        "EXISTS (SELECT 1 FROM pending_storage_move_reconciliations r WHERE r.external_storage_id=s.id)) LIMIT 1",
        pqxx::params{user_id, captured_ids});
    if (!dependency.empty()) throw std::runtime_error("ACCOUNT_HAS_ACTIVE_STORAGE_MOVES");

    const auto pending_upload = txn.exec(
        "SELECT 1 FROM user_external_storages s "
        "WHERE s.user_id=$1 AND s.id=ANY($2::bigint[]) AND s.provider='google_drive' "
        "AND s.is_unlinking=FALSE AND EXISTS ("
        "SELECT 1 FROM files f WHERE f.external_storage_id=s.id "
        "AND f.storage_provider='google_drive' AND f.is_upload_complete=FALSE) LIMIT 1",
        pqxx::params{user_id, captured_ids});
    if (!pending_upload.empty()) throw std::runtime_error("ACCOUNT_HAS_PENDING_UPLOADS");

    const auto result = txn.exec(
        "UPDATE user_external_storages SET is_unlinking = TRUE "
        "WHERE user_id=$1 AND provider='google_drive' AND is_unlinking=FALSE "
        "AND id=ANY($2::bigint[]) RETURNING id",
        pqxx::params{user_id, captured_ids});

    std::vector<uint64_t> unlinked_storage_ids;
    unlinked_storage_ids.reserve(result.size());
    for (const auto& row : result) {
        uint64_t s_id = row[0].as<uint64_t>();
        unlinked_storage_ids.push_back(s_id);
        
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

    if (unlinked_storage_ids.empty()) {
        throw std::runtime_error("GOOGLE_DRIVE_NOT_LINKED");
    }

    invalidate_storage_caches(unlinked_storage_ids);
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
        std::cerr << "[GoogleDrive] exchange_code falhou. Status=" << r.status_code << std::endl;
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

    if (at_it == obj.end() || !at_it->second.is<std::string>() || at_it->second.get<std::string>().empty()) {
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
            auto picture_it = ui_json.get<picojson::object>().find("picture");
            if (picture_it != ui_json.get<picojson::object>().end() && picture_it->second.is<std::string>()) {
                tokens.account_picture = safe_account_picture(picture_it->second.get<std::string>());
            }
        }
    }
    
    if (tokens.account_email.empty()) {
        throw std::runtime_error("GOOGLE_EMAIL_SCOPE_MISSING");
    }

    return tokens;
}

std::string GoogleDriveService::create_nanika_folder(const std::string& access_token) {
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
        std::cerr << "[GoogleDrive] create_nanika_folder falhou. Status=" << create_r.status_code << std::endl;
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

std::vector<GoogleDriveService::BatchUploadTarget> GoogleDriveService::select_batch_storages(
    uint64_t user_id, const std::vector<uint64_t>& file_sizes) {
    if (file_sizes.empty()) return {};

    struct Candidate {
        uint64_t storage_id;
        std::string access_token;
        std::string root_folder_id;
        uint64_t remaining_bytes;
    };

    std::vector<Candidate> candidates;
    for (const auto& account : get_linked_accounts(user_id)) {
        if (account.root_folder_id.empty()) continue;
        try {
            const auto token = get_access_token_for_storage(account.id);
            if (token.empty()) continue;
            const auto available = get_available_space(token);
            if (available <= 0) continue;
            candidates.push_back({account.id, token, account.root_folder_id,
                                  static_cast<uint64_t>(available)});
        } catch (...) {
            continue;
        }
    }

    std::vector<BatchUploadTarget> assignments;
    assignments.reserve(file_sizes.size());
    for (const auto size : file_sizes) {
        auto target = std::find_if(candidates.begin(), candidates.end(),
            [size](const Candidate& candidate) { return candidate.remaining_bytes >= size; });
        if (target == candidates.end()) return {};
        target->remaining_bytes -= size;
        assignments.push_back({target->storage_id, target->access_token, target->root_folder_id});
    }
    return assignments;
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
    pending_states_[user_id] = PendingOAuthState{
        state,
        std::chrono::steady_clock::now() + OAUTH_STATE_TTL
    };
    return state;
}

bool GoogleDriveService::validate_and_consume_state(uint64_t user_id, const std::string& state) {
    std::lock_guard<std::mutex> lock(states_mutex_);
    auto it = pending_states_.find(user_id);
    if (it == pending_states_.end()) {
        return false;
    }

    if (std::chrono::steady_clock::now() >= it->second.expires_at) {
        pending_states_.erase(it);
        return false;
    }

    if (it->second.value != state) {
        return false;
    }

    pending_states_.erase(it);
    return true;
}

#ifdef NANIKA_TESTING
void GoogleDriveService::expire_oauth_state_for_test(uint64_t user_id) {
    std::lock_guard<std::mutex> lock(states_mutex_);
    auto it = pending_states_.find(user_id);
    if (it != pending_states_.end()) {
        it->second.expires_at = std::chrono::steady_clock::time_point::min();
    }
}
#endif

std::pair<uint64_t, uint64_t> GoogleDriveService::get_total_quota(uint64_t user_id) {
    std::vector<uint64_t> storage_ids;
    {
        auto conn = pool_.acquire_connection();
        pqxx::work txn(*conn);
        auto result = txn.exec(
            "SELECT id FROM user_external_storages WHERE user_id = $1 AND is_unlinking = FALSE",
            pqxx::params{user_id}
        );
        txn.commit();
        storage_ids.reserve(result.size());
        for (const auto& row : result) storage_ids.push_back(row[0].as<uint64_t>());
    }

    uint64_t total_virtual_used = 0;
    uint64_t total_virtual_max = 0;

    for (const uint64_t storage_id : storage_ids) {
        std::string token;
        try {
            token = get_access_token_for_storage(storage_id);
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
            uint64_t limit = 0;
            uint64_t usage = 0;
            try {
                limit = std::stoull(limit_it->second.get<std::string>());
                usage = std::stoull(usage_it->second.get<std::string>());
            } catch (...) {
                continue;
            }

            const uint64_t available = (limit > usage) ? (limit - usage) : 0;
            uint64_t app_usage = 0;
            {
                auto conn = pool_.acquire_connection();
                pqxx::work txn(*conn);
                const auto size_res = txn.exec(
                    "SELECT COALESCE(SUM(size_bytes), 0) FROM files WHERE external_storage_id = $1 AND is_upload_complete = TRUE",
                    pqxx::params{storage_id}
                );
                if (!size_res.empty()) app_usage = size_res[0][0].as<uint64_t>();
                txn.commit();
            }

            total_virtual_used += app_usage;
            total_virtual_max += (app_usage + available);
        }
    }

    return {total_virtual_used, total_virtual_max};
}

GoogleDriveService::ResumableSession GoogleDriveService::create_resumable_session(
    uint64_t user_id, uint64_t storage_id, uint64_t size_bytes, uint64_t move_id,
    uint64_t item_id, const std::string& role, const std::string& validated_origin) {
    std::string root_folder_id;
    {
        auto conn = pool_.acquire_connection();
        pqxx::work txn(*conn);
        auto storage = txn.exec(
            "SELECT root_folder_id,is_unlinking FROM user_external_storages WHERE id=$1 AND user_id=$2 AND provider='google_drive'",
            pqxx::params{storage_id,user_id});
        if (storage.empty()) throw std::runtime_error("STORAGE_TARGET_NOT_FOUND");
        if (storage[0][1].as<bool>()) throw std::runtime_error("STORAGE_TARGET_UNAVAILABLE");
        root_folder_id = storage[0][0].as<std::string>();
        txn.commit();
    }

    const std::string access_token = get_access_token_for_storage(storage_id);
    if (role != "original" && role != "proxy") throw std::invalid_argument("STORAGE_MOVE_INVALID_STATE");
    nlohmann::json metadata = {
        {"name", "nanika-move-" + std::to_string(move_id) + "-" + std::to_string(item_id) + "-" + role + ".bin"},
        {"parents", nlohmann::json::array({root_folder_id})},
        {"appProperties", {
            {"nanika_move_id", std::to_string(move_id)},
            {"nanika_move_item_id", std::to_string(item_id)},
            {"nanika_role", role}
        }}
    };
    cpr::Header headers{
        {"Authorization", "Bearer " + access_token},
        {"Content-Type", "application/json; charset=UTF-8"},
        {"X-Upload-Content-Type", "application/octet-stream"},
        {"X-Upload-Content-Length", std::to_string(size_bytes)}
    };
    if (!validated_origin.empty()) headers.emplace("Origin", validated_origin);
    cpr::Response response = make_post_request(
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable",
        metadata.dump(),
        headers);
    if (response.status_code != 200) throw std::runtime_error("GOOGLE_SESSION_FAILED");
    auto location = response.header.find("location");
    if (location == response.header.end() || location->second.empty()) throw std::runtime_error("GOOGLE_SESSION_FAILED");
    return {location->second, access_token};
}

GoogleDriveService::ResumableSession GoogleDriveService::create_upload_resumable_session(
    uint64_t user_id, uint64_t storage_id, uint64_t file_id, uint64_t size_bytes,
    const std::string& name_hash, const std::string& validated_origin) {
    std::string root_folder_id;
    {
        auto conn = pool_.acquire_connection();
        pqxx::work txn(*conn);
        const auto storage = txn.exec(
            "SELECT root_folder_id,is_unlinking FROM user_external_storages "
            "WHERE id=$1 AND user_id=$2 AND provider='google_drive'",
            pqxx::params{storage_id, user_id});
        if (storage.empty()) throw std::runtime_error("STORAGE_TARGET_NOT_FOUND");
        if (storage[0][1].as<bool>()) throw std::runtime_error("STORAGE_TARGET_UNAVAILABLE");
        root_folder_id = storage[0][0].as<std::string>();
        if (root_folder_id.empty()) throw std::runtime_error("STORAGE_TARGET_NOT_FOUND");
        txn.commit();
    }

    const std::string access_token = get_access_token_for_storage(storage_id);
    if (name_hash.empty()) throw std::invalid_argument("GOOGLE_SESSION_FAILED");
    nlohmann::json metadata = {
        {"name", name_hash},
        {"parents", nlohmann::json::array({root_folder_id})},
        {"appProperties", {{"nanika_upload_file_id", std::to_string(file_id)}}}
    };
    cpr::Header headers{
        {"Authorization", "Bearer " + access_token},
        {"Content-Type", "application/json; charset=UTF-8"},
        {"X-Upload-Content-Type", "application/octet-stream"},
        {"X-Upload-Content-Length", std::to_string(size_bytes)}
    };
    if (!validated_origin.empty()) headers.emplace("Origin", validated_origin);
    const auto response = make_post_request(
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable",
        metadata.dump(), headers);
    if (response.status_code != 200) throw std::runtime_error("GOOGLE_SESSION_FAILED");
    const auto location = response.header.find("location");
    if (location == response.header.end() || location->second.empty()) {
        throw std::runtime_error("GOOGLE_SESSION_FAILED");
    }
    return {location->second, access_token};
}

std::vector<std::string> GoogleDriveService::find_external_upload_targets(
    uint64_t user_id, uint64_t storage_id, uint64_t file_id, uint64_t size_bytes) {
    std::string root_folder_id;
    {
        auto conn = pool_.acquire_connection();
        pqxx::work txn(*conn);
        const auto storage = txn.exec(
            "SELECT root_folder_id FROM user_external_storages "
            "WHERE id=$1 AND user_id=$2 AND provider='google_drive' AND is_unlinking=FALSE",
            pqxx::params{storage_id, user_id});
        if (storage.empty() || storage[0][0].is_null()) throw std::runtime_error("STORAGE_TARGET_NOT_FOUND");
        root_folder_id = storage[0][0].as<std::string>();
        if (root_folder_id.empty()) throw std::runtime_error("STORAGE_TARGET_NOT_FOUND");
        txn.commit();
    }

    const std::string token = get_access_token_for_storage(storage_id);
    const std::string query =
        "appProperties%20has%20%7Bkey%3D%27nanika_upload_file_id%27%20and%20value%3D%27" +
        std::to_string(file_id) + "%27%7D%20and%20trashed%3Dfalse";
    std::vector<std::string> matches;
    std::string page_token;
    do {
        const std::string page_parameter = page_token.empty()
            ? ""
            : "&pageToken=" + std::string(cpr::util::urlEncode(page_token));
        const auto response = make_get_request(
            "https://www.googleapis.com/drive/v3/files?q=" + query +
            "&pageSize=100&fields=nextPageToken%2Cfiles(id%2Csize%2Cparents%2CappProperties)&spaces=drive" +
            page_parameter,
            cpr::Header{{"Authorization", "Bearer " + token}});
        if (response.status_code != 200) throw std::runtime_error("GOOGLE_RECONCILIATION_FAILED");

        picojson::value json;
        if (!picojson::parse(json, response.text).empty() || !json.is<picojson::object>()) {
            throw std::runtime_error("GOOGLE_RECONCILIATION_FAILED");
        }
        const auto& object = json.get<picojson::object>();
        const auto files = object.find("files");
        if (files != object.end() && files->second.is<picojson::array>()) {
            for (const auto& value : files->second.get<picojson::array>()) {
                if (!value.is<picojson::object>()) continue;
                const auto& candidate = value.get<picojson::object>();
                const auto id = candidate.find("id");
                const auto size = candidate.find("size");
                const auto parents = candidate.find("parents");
                const auto properties = candidate.find("appProperties");
                if (id == candidate.end() || !id->second.is<std::string>() ||
                    !is_safe_external_id(id->second.get<std::string>()) ||
                    size == candidate.end() || !size->second.is<std::string>() ||
                    parents == candidate.end() || !parents->second.is<picojson::array>() ||
                    properties == candidate.end() || !properties->second.is<picojson::object>()) continue;
                uint64_t candidate_size = 0;
                try {
                    const auto& size_text = size->second.get<std::string>();
                    std::size_t parsed = 0;
                    candidate_size = std::stoull(size_text, &parsed);
                    if (parsed != size_text.size()) continue;
                }
                catch (...) { continue; }
                if (candidate_size != size_bytes) continue;
                bool in_root = false;
                for (const auto& parent : parents->second.get<picojson::array>()) {
                    if (parent.is<std::string>() && parent.get<std::string>() == root_folder_id) {
                        in_root = true;
                        break;
                    }
                }
                const auto& app = properties->second.get<picojson::object>();
                const auto property = app.find("nanika_upload_file_id");
                if (in_root && property != app.end() && property->second.is<std::string>() &&
                    property->second.get<std::string>() == std::to_string(file_id)) {
                    matches.push_back(id->second.get<std::string>());
                    if (matches.size() == 2) return matches;
                }
            }
        }
        const auto next = object.find("nextPageToken");
        page_token = next != object.end() && next->second.is<std::string>()
            ? next->second.get<std::string>()
            : "";
    } while (!page_token.empty());
    return matches;
}

uint64_t GoogleDriveService::get_external_file_size(uint64_t user_id, uint64_t storage_id,
                                                    const std::string& external_file_id) {
    if (!is_safe_external_id(external_file_id)) throw std::invalid_argument("STORAGE_MOVE_TARGET_INCOMPLETE");
    std::string root_folder_id;
    {
        auto conn = pool_.acquire_connection();
        pqxx::work txn(*conn);
        auto storage = txn.exec(
            "SELECT root_folder_id FROM user_external_storages WHERE id=$1 AND user_id=$2 AND provider='google_drive'",
            pqxx::params{storage_id,user_id});
        if (storage.empty() || storage[0][0].is_null()) throw std::runtime_error("STORAGE_TARGET_NOT_FOUND");
        root_folder_id = storage[0][0].as<std::string>();
        txn.commit();
    }
    const std::string token = get_access_token_for_storage(storage_id);
    cpr::Response response = make_get_request(
        "https://www.googleapis.com/drive/v3/files/" + external_file_id + "?fields=size%2Cparents",
        cpr::Header{{"Authorization", "Bearer " + token}});
    if (response.status_code != 200) throw std::runtime_error("STORAGE_MOVE_TARGET_INCOMPLETE");
    picojson::value json;
    if (!picojson::parse(json,response.text).empty() || !json.is<picojson::object>()) throw std::runtime_error("STORAGE_MOVE_TARGET_INCOMPLETE");
    const auto& object = json.get<picojson::object>();
    auto size = object.find("size");
    auto parents = object.find("parents");
    if (size == object.end() || !size->second.is<std::string>() ||
        parents == object.end() || !parents->second.is<picojson::array>()) {
        throw std::runtime_error("STORAGE_MOVE_TARGET_INCOMPLETE");
    }
    const auto& parent_ids = parents->second.get<picojson::array>();
    const bool in_target_root = std::any_of(parent_ids.begin(), parent_ids.end(), [&](const picojson::value& parent) {
        return parent.is<std::string>() && parent.get<std::string>() == root_folder_id;
    });
    if (!in_target_root) throw std::runtime_error("STORAGE_MOVE_TARGET_INCOMPLETE");
    return std::stoull(size->second.get<std::string>());
}

uint64_t GoogleDriveService::validate_external_target(uint64_t user_id, uint64_t storage_id,
                                                      const std::string& external_file_id,
                                                      uint64_t move_id, uint64_t item_id,
                                                      const std::string& role) {
    if (!is_safe_external_id(external_file_id) || (role != "original" && role != "proxy")) {
        throw std::invalid_argument("STORAGE_MOVE_TARGET_INCOMPLETE");
    }
    std::string root_folder_id;
    {
        auto conn = pool_.acquire_connection();
        pqxx::work txn(*conn);
        auto storage = txn.exec(
            "SELECT root_folder_id FROM user_external_storages WHERE id=$1 AND user_id=$2 AND provider='google_drive' AND is_unlinking=FALSE",
            pqxx::params{storage_id,user_id});
        if (storage.empty() || storage[0][0].is_null()) throw std::runtime_error("STORAGE_TARGET_NOT_FOUND");
        root_folder_id = storage[0][0].as<std::string>();
        txn.commit();
    }
    const std::string token = get_access_token_for_storage(storage_id);
    const auto response = make_get_request(
        "https://www.googleapis.com/drive/v3/files/" + external_file_id + "?fields=size%2Cparents%2CappProperties",
        cpr::Header{{"Authorization", "Bearer " + token}});
    if (response.status_code != 200) throw std::runtime_error("STORAGE_MOVE_TARGET_INCOMPLETE");
    picojson::value json;
    if (!picojson::parse(json,response.text).empty() || !json.is<picojson::object>()) throw std::runtime_error("STORAGE_MOVE_TARGET_INCOMPLETE");
    const auto& object = json.get<picojson::object>();
    const auto size = object.find("size");
    const auto parents = object.find("parents");
    const auto properties = object.find("appProperties");
    if (size == object.end() || !size->second.is<std::string>() || parents == object.end() || !parents->second.is<picojson::array>() ||
        properties == object.end() || !properties->second.is<picojson::object>()) throw std::runtime_error("STORAGE_MOVE_TARGET_INCOMPLETE");
    bool in_root = false;
    for (const auto& parent : parents->second.get<picojson::array>()) {
        if (parent.is<std::string>() && parent.get<std::string>() == root_folder_id) { in_root = true; break; }
    }
    const auto& app = properties->second.get<picojson::object>();
    const auto matches = [&](const char* key, const std::string& value) {
        const auto it = app.find(key);
        return it != app.end() && it->second.is<std::string>() && it->second.get<std::string>() == value;
    };
    if (!in_root || !matches("nanika_move_id", std::to_string(move_id)) ||
        !matches("nanika_move_item_id", std::to_string(item_id)) || !matches("nanika_role", role)) {
        throw std::runtime_error("STORAGE_MOVE_TARGET_INCOMPLETE");
    }
    return std::stoull(size->second.get<std::string>());
}

std::vector<std::string> GoogleDriveService::find_external_targets(uint64_t user_id, uint64_t storage_id,
                                                                    uint64_t move_id, uint64_t item_id,
                                                                    const std::string& role, uint64_t size_bytes) {
    if (role != "original" && role != "proxy") throw std::invalid_argument("STORAGE_MOVE_INVALID_STATE");
    std::string root_folder_id;
    {
        auto conn = pool_.acquire_connection();
        pqxx::work txn(*conn);
        auto storage = txn.exec(
            "SELECT root_folder_id FROM user_external_storages WHERE id=$1 AND user_id=$2 AND provider='google_drive' AND is_unlinking=FALSE",
            pqxx::params{storage_id,user_id});
        if (storage.empty()) throw std::runtime_error("STORAGE_TARGET_NOT_FOUND");
        root_folder_id = storage[0][0].as<std::string>();
        txn.commit();
    }
    const std::string token = get_access_token_for_storage(storage_id);
    const std::string query = "appProperties%20has%20%7Bkey%3D%27nanika_move_id%27%20and%20value%3D%27" +
        std::to_string(move_id) + "%27%7D%20and%20trashed%3Dfalse";
    std::vector<std::string> matches;
    std::string page_token;
    do {
        const std::string page_parameter = page_token.empty()
            ? ""
            : "&pageToken=" + std::string(cpr::util::urlEncode(page_token));
        const auto response = make_get_request(
            "https://www.googleapis.com/drive/v3/files?q=" + query +
            "&pageSize=1000&fields=nextPageToken%2Cfiles(id%2Csize%2Cparents%2CappProperties)&spaces=drive" + page_parameter,
            cpr::Header{{"Authorization", "Bearer " + token}});
        if (response.status_code != 200) throw std::runtime_error("STORAGE_MOVE_RECONCILE_FAILED");
        picojson::value json;
        if (!picojson::parse(json,response.text).empty() || !json.is<picojson::object>()) throw std::runtime_error("STORAGE_MOVE_RECONCILE_FAILED");
        const auto& object_root = json.get<picojson::object>();
        const auto files = object_root.find("files");
        if (files != object_root.end() && files->second.is<picojson::array>()) {
            for (const auto& value : files->second.get<picojson::array>()) {
                if (!value.is<picojson::object>()) continue;
                const auto& object = value.get<picojson::object>();
                const auto id = object.find("id");
                const auto size = object.find("size");
                const auto parents = object.find("parents");
                const auto props = object.find("appProperties");
                if (id == object.end() || !id->second.is<std::string>() || !is_safe_external_id(id->second.get<std::string>()) ||
                    size == object.end() || !size->second.is<std::string>() || std::stoull(size->second.get<std::string>()) != size_bytes ||
                    parents == object.end() || !parents->second.is<picojson::array>() || props == object.end() || !props->second.is<picojson::object>()) continue;
                bool in_root = false;
                for (const auto& parent : parents->second.get<picojson::array>()) if (parent.is<std::string>() && parent.get<std::string>() == root_folder_id) in_root = true;
                const auto& app = props->second.get<picojson::object>();
                const auto property_matches = [&](const char* key, const std::string& expected) {
                    const auto property = app.find(key);
                    return property != app.end() && property->second.is<std::string>() && property->second.get<std::string>() == expected;
                };
                if (in_root && property_matches("nanika_move_id", std::to_string(move_id)) &&
                    property_matches("nanika_move_item_id", std::to_string(item_id)) && property_matches("nanika_role", role)) {
                    matches.push_back(id->second.get<std::string>());
                }
            }
        }
        const auto next_page = object_root.find("nextPageToken");
        page_token = next_page != object_root.end() && next_page->second.is<std::string>()
            ? next_page->second.get<std::string>()
            : "";
    } while (!page_token.empty());
    std::sort(matches.begin(), matches.end());
    return matches;
}

int GoogleDriveService::delete_external_file(uint64_t storage_id, const std::string& external_file_id) {
    if (!is_safe_external_id(external_file_id)) throw std::invalid_argument("STORAGE_MOVE_TARGET_INCOMPLETE");
    const std::string token = get_access_token_for_storage(storage_id, TokenAccess::UnlinkCleanup);
    const auto response = cpr::Delete(
        cpr::Url{"https://www.googleapis.com/drive/v3/files/" + external_file_id},
        cpr::Header{{"Authorization", "Bearer " + token}},
        cpr::Timeout{5000});
    return response.status_code;
}

GoogleDriveService::QuotaCacheEntry GoogleDriveService::get_quota_for_storage(uint64_t storage_id) {
    std::shared_ptr<QuotaFlight> flight;
    bool owner = false;
    std::chrono::steady_clock::time_point expires_at;
    {
        std::lock_guard<std::mutex> lock(quota_cache_mutex_);
        const auto now = std::chrono::steady_clock::now();
        const auto cached = quota_cache_.find(storage_id);
        if (cached != quota_cache_.end() && now < cached->second.expires_at) return cached->second;

        const auto existing = quota_flights_.find(storage_id);
        if (existing != quota_flights_.end()) {
            flight = existing->second;
        } else {
            flight = std::make_shared<QuotaFlight>();
            quota_flights_.emplace(storage_id, flight);
            owner = true;
        }
        expires_at = now + std::chrono::seconds(30);
    }

    if (!owner) {
#ifdef NANIKA_TESTING
        {
            std::lock_guard lock(flight->test_followers_mutex);
            ++flight->test_followers;
        }
        flight->test_followers_cv.notify_all();
#endif
        return flight->future.get();
    }

    try {
        const std::string token = get_access_token_for_storage(storage_id);
        cpr::Response response = make_get_request(
            "https://www.googleapis.com/drive/v3/about?fields=storageQuota",
            cpr::Header{{"Authorization", "Bearer " + token}});
        if (response.status_code != 200) throw std::runtime_error("STORAGE_UNAVAILABLE");

        picojson::value json;
        if (!picojson::parse(json, response.text).empty() || !json.is<picojson::object>()) {
            throw std::runtime_error("STORAGE_UNAVAILABLE");
        }
        const auto& root = json.get<picojson::object>();
        const auto quota_it = root.find("storageQuota");
        if (quota_it == root.end() || !quota_it->second.is<picojson::object>()) {
            throw std::runtime_error("STORAGE_UNAVAILABLE");
        }
        const auto& quota = quota_it->second.get<picojson::object>();
        uint64_t used = 0;
        std::optional<uint64_t> max;
        const auto usage_it = quota.find("usage");
        const auto limit_it = quota.find("limit");
        if (usage_it != quota.end() && usage_it->second.is<std::string>()) used = std::stoull(usage_it->second.get<std::string>());
        if (limit_it != quota.end() && limit_it->second.is<std::string>()) max = std::stoull(limit_it->second.get<std::string>());

        QuotaCacheEntry entry{used, max, expires_at};
        {
            std::lock_guard<std::mutex> lock(quota_cache_mutex_);
            const auto current = quota_flights_.find(storage_id);
            if (current != quota_flights_.end() && current->second == flight) {
                quota_cache_[storage_id] = entry;
                quota_flights_.erase(current);
            }
        }
        flight->promise.set_value(entry);
        return entry;
    } catch (...) {
        const auto error = std::current_exception();
        {
            std::lock_guard<std::mutex> lock(quota_cache_mutex_);
            const auto current = quota_flights_.find(storage_id);
            if (current != quota_flights_.end() && current->second == flight) quota_flights_.erase(current);
        }
        flight->promise.set_exception(error);
        std::rethrow_exception(error);
    }
}

std::vector<GoogleDriveService::StorageTarget> GoogleDriveService::get_storage_targets(uint64_t user_id) {
    const auto accounts = get_linked_accounts(user_id, true);
    std::unordered_map<uint64_t, uint64_t> nanika_usage;
    {
        auto conn = pool_.acquire_connection();
        pqxx::work txn(*conn);
        auto result = txn.exec(
            "SELECT external_storage_id, COALESCE(SUM(size_bytes) FILTER (WHERE is_upload_complete = TRUE AND deleted_at IS NULL), 0) "
            "FROM files WHERE user_id = $1 AND storage_provider = 'google_drive' AND external_storage_id IS NOT NULL "
            "GROUP BY external_storage_id",
            pqxx::params{user_id});
        for (const auto& row : result) {
            nanika_usage[row[0].as<uint64_t>()] = row[1].as<uint64_t>();
        }
        txn.commit();
    }

    std::vector<StorageTarget> targets;
    targets.reserve(accounts.size());
    for (const auto& account : accounts) {
        StorageTarget target;
        target.id = account.id;
        target.account_email = account.account_email;
        target.account_picture = account.account_picture;
        target.nanika_used_bytes = nanika_usage[account.id];
        if (account.is_unlinking) {
            target.status = "unlinking";
        } else {
            try {
                const auto quota = get_quota_for_storage(account.id);
                target.status = "ready";
                target.used_bytes = quota.used_bytes;
                target.max_bytes = quota.max_bytes;
                if (quota.max_bytes.has_value()) {
                    target.available_bytes = *quota.max_bytes > quota.used_bytes ? *quota.max_bytes - quota.used_bytes : 0;
                }
            } catch (...) {
                target.status = "unavailable";
            }
        }
        targets.push_back(std::move(target));
    }
    return targets;
}
