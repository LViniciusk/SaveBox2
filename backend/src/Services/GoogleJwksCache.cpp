#include "Services/GoogleJwksCache.hpp"

#include <cpr/cpr.h>
#include <jwt-cpp/jwt.h>
#include <stdexcept>
#include <iostream>
#include <memory>
#include <chrono>

#include <openssl/evp.h>
#include <openssl/core_names.h>
#include <openssl/param_build.h>
#include <openssl/err.h>
#include <openssl/pem.h>
#include <openssl/bn.h>

namespace {
    constexpr auto JWKS_REFRESH_COOLDOWN = std::chrono::seconds(30);
    constexpr auto JWKS_FAILURE_BACKOFF = std::chrono::seconds(5);

    std::string normalize_base64url(std::string b64) {
        for (char& c : b64) {
            if (c == '-') c = '+';
            else if (c == '_') c = '/';
        }
        while (b64.length() % 4 != 0) {
            b64 += '=';
        }
        return b64;
    }

    std::string decode_base64(const std::string& b64) {
        if (b64.empty()) return "";
        std::string out;
        out.resize((b64.size() * 3) / 4); 
        
        int len = EVP_DecodeBlock(reinterpret_cast<unsigned char*>(&out[0]), 
                                  reinterpret_cast<const unsigned char*>(b64.data()), 
                                  b64.size());
        if (len < 0) return "";
        
        int padding = 0;
        if (b64.length() >= 1 && b64[b64.length()-1] == '=') padding++;
        if (b64.length() >= 2 && b64[b64.length()-2] == '=') padding++;
        out.resize(len - padding);
        return out;
    }

    using BIGNUM_ptr = std::unique_ptr<BIGNUM, decltype(&::BN_free)>;
    using EVP_PKEY_CTX_ptr = std::unique_ptr<EVP_PKEY_CTX, decltype(&::EVP_PKEY_CTX_free)>;
    using EVP_PKEY_ptr = std::unique_ptr<EVP_PKEY, decltype(&::EVP_PKEY_free)>;
    using BIO_ptr = std::unique_ptr<BIO, decltype(&::BIO_free_all)>;
    using OSSL_PARAM_BLD_ptr = std::unique_ptr<OSSL_PARAM_BLD, decltype(&::OSSL_PARAM_BLD_free)>;
    using OSSL_PARAM_ptr = std::unique_ptr<OSSL_PARAM, decltype(&::OSSL_PARAM_free)>;
}

std::string GoogleJwksCache::get_pem_for_kid(const std::string& kid) {
    {
        std::shared_lock<std::shared_mutex> lock(mutex_);
        auto it = key_cache_.find(kid);
        if (it != key_cache_.end()) {
            return it->second;
        }
    }

    refresh_keys(kid);

    {
        std::shared_lock<std::shared_mutex> lock(mutex_);
        auto it = key_cache_.find(kid);
        if (it != key_cache_.end()) {
            return it->second;
        }
    }

    throw std::runtime_error("JWKS_KID_NOT_FOUND");
}

void GoogleJwksCache::refresh_keys(const std::string& missing_kid) {
    const auto has_cached_key = [&]() {
        std::shared_lock<std::shared_mutex> lock(mutex_);
        return key_cache_.find(missing_kid) != key_cache_.end();
    };

    {
        std::unique_lock<std::mutex> lock(refresh_mutex_);
        if (has_cached_key()) {
            return;
        }

        if (is_fetching_) {
            // One completed snapshot or failure satisfies the entire miss cohort.
            const std::uint64_t generation_before_wait = refresh_generation_;
#ifdef NANIKA_TESTING
            {
                std::lock_guard<std::mutex> observer_lock(test_observer_mutex_);
                ++test_followers_;
            }
            test_observer_cv_.notify_all();
#endif
            cv_.wait(lock, [this, generation_before_wait] {
                return refresh_generation_ != generation_before_wait;
            });
#ifdef NANIKA_TESTING
            {
                std::lock_guard<std::mutex> observer_lock(test_observer_mutex_);
                --test_followers_;
            }
#endif
            if (last_refresh_error_ && last_refresh_error_generation_ == refresh_generation_) {
                std::rethrow_exception(last_refresh_error_);
            }
            return;
        }

        if (std::chrono::steady_clock::now() < next_refresh_allowed_at_) {
            // Unknown attacker-controlled kids are bounded globally, not per kid.
            if (last_refresh_error_ && last_refresh_error_generation_ == refresh_generation_) {
                std::rethrow_exception(last_refresh_error_);
            }
            return;
        }

        is_fetching_ = true;
    }

    std::unordered_map<std::string, std::string> new_keys;

    try {
        cpr::Response r;
#ifdef NANIKA_TESTING
        if (test_fetch_hook_) {
            r = test_fetch_hook_();
        } else
#endif
        {
            r = cpr::Get(
                cpr::Url{"https://www.googleapis.com/oauth2/v3/certs"},
                cpr::Timeout{2000}
            );
        }

        if (r.status_code != 200) {
            throw std::runtime_error("GOOGLE_API_UNAVAILABLE");
        }

        picojson::value json_val;
        std::string err = picojson::parse(json_val, r.text);
        if (!err.empty() || !json_val.is<picojson::object>()) {
            throw std::runtime_error("INVALID_JWKS_RESPONSE");
        }

        auto& root = json_val.get<picojson::object>();
        auto keys_it = root.find("keys");
        if (keys_it == root.end() || !keys_it->second.is<picojson::array>()) {
            throw std::runtime_error("INVALID_JWKS_RESPONSE");
        }

        for (const auto& key_val : keys_it->second.get<picojson::array>()) {
            if (!key_val.is<picojson::object>()) continue;
            auto& key_obj = key_val.get<picojson::object>();
        
            auto kid_it = key_obj.find("kid");
            if (kid_it == key_obj.end() || !kid_it->second.is<std::string>()) continue;
        
            std::string kid_val = kid_it->second.get<std::string>();

            auto n_it = key_obj.find("n");
            auto e_it = key_obj.find("e");
        
            if (n_it == key_obj.end() || !n_it->second.is<std::string>() ||
                e_it == key_obj.end() || !e_it->second.is<std::string>()) {
                continue;
            }

            std::string n_b64 = normalize_base64url(n_it->second.get<std::string>());
            std::string e_b64 = normalize_base64url(e_it->second.get<std::string>());

            std::string n_bin = decode_base64(n_b64);
            std::string e_bin = decode_base64(e_b64);

            if (n_bin.empty() || e_bin.empty()) continue;

            BIGNUM_ptr n(BN_bin2bn(reinterpret_cast<const unsigned char*>(n_bin.data()), n_bin.size(), nullptr), ::BN_free);
            BIGNUM_ptr e(BN_bin2bn(reinterpret_cast<const unsigned char*>(e_bin.data()), e_bin.size(), nullptr), ::BN_free);

            if (!n || !e) continue;

            OSSL_PARAM_BLD_ptr bld(OSSL_PARAM_BLD_new(), ::OSSL_PARAM_BLD_free);
            if (!bld) continue;

            if (OSSL_PARAM_BLD_push_BN(bld.get(), OSSL_PKEY_PARAM_RSA_N, n.get()) != 1 ||
                OSSL_PARAM_BLD_push_BN(bld.get(), OSSL_PKEY_PARAM_RSA_E, e.get()) != 1) {
                continue;
            }

            OSSL_PARAM_ptr params(OSSL_PARAM_BLD_to_param(bld.get()), ::OSSL_PARAM_free);
            if (!params) continue;

            EVP_PKEY_CTX_ptr ctx(EVP_PKEY_CTX_new_from_name(nullptr, "RSA", nullptr), ::EVP_PKEY_CTX_free);
            if (!ctx) continue;

            if (EVP_PKEY_fromdata_init(ctx.get()) <= 0) continue;

            EVP_PKEY* pkey_raw = nullptr;
            if (EVP_PKEY_fromdata(ctx.get(), &pkey_raw, EVP_PKEY_PUBLIC_KEY, params.get()) <= 0 || !pkey_raw) {
                continue;
            }
            EVP_PKEY_ptr pkey(pkey_raw, ::EVP_PKEY_free);

            BIO_ptr bio(BIO_new(BIO_s_mem()), ::BIO_free_all);
            if (!bio) continue;

            if (PEM_write_bio_PUBKEY(bio.get(), pkey.get()) != 1) {
                continue;
            }

            char* pem_data = nullptr;
            long pem_len = BIO_get_mem_data(bio.get(), &pem_data);
            if (pem_len > 0 && pem_data != nullptr) {
                std::string pem(pem_data, pem_len);
                new_keys[kid_val] = pem;
            }
        }

        {
            std::lock_guard<std::mutex> state_lock(refresh_mutex_);
            {
                std::unique_lock<std::shared_mutex> cache_lock(mutex_);
                key_cache_ = std::move(new_keys);
            }
            is_fetching_ = false;
            ++refresh_generation_;
            last_refresh_error_ = nullptr;
            last_refresh_error_generation_ = refresh_generation_;
            next_refresh_allowed_at_ = std::chrono::steady_clock::now() + JWKS_REFRESH_COOLDOWN;
        }
        cv_.notify_all();
    } catch (...) {
        {
            std::lock_guard<std::mutex> state_lock(refresh_mutex_);
            last_refresh_error_ = std::current_exception();
            ++refresh_generation_;
            last_refresh_error_generation_ = refresh_generation_;
            is_fetching_ = false;
            next_refresh_allowed_at_ = std::chrono::steady_clock::now() + JWKS_FAILURE_BACKOFF;
        }
        cv_.notify_all();
        throw;
    }
}
