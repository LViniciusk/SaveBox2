#pragma once

#include <chrono>
#include <cstdint>
#include <shared_mutex>
#include <string>
#include <unordered_map>
#include <utility>
#include <atomic>

#include "database/DatabasePool.hpp"
#include "crow_all.h"

struct RateLimitMiddleware {
    struct context {};

    struct ClientData {
        int auth_count = 0;
        int general_count = 0;
        std::chrono::steady_clock::time_point window_start = std::chrono::steady_clock::now();
        std::chrono::steady_clock::time_point last_request = std::chrono::steady_clock::now();
    };

    static constexpr size_t MAX_CLIENTS = 10000;
    static constexpr auto CLIENT_TTL = std::chrono::minutes(2);

    void init(DatabasePool& pool) {
        pool_ = &pool;

        auto conn_wrapper = pool_->acquire_connection();
        pqxx::work w(*conn_wrapper);

        auto result = w.exec(
            "SELECT ip, EXTRACT(EPOCH FROM expires_at)::BIGINT AS expires_at_epoch "
            "FROM banned_ips WHERE expires_at > NOW();");
        w.commit();

        const auto now = std::chrono::system_clock::now();

        std::unique_lock<std::shared_timed_mutex> lock(mutex_);
        for (const auto& row : result) {
            const std::string ip = row["ip"].c_str();
            const std::int64_t epoch_seconds = row["expires_at_epoch"].as<std::int64_t>();
            const auto banned_until = std::chrono::system_clock::time_point(std::chrono::seconds(epoch_seconds));

            if (banned_until > now) {
                banned_ips_cache[ip] = banned_until;
            }
        }
    }

    void before_handle(crow::request& req, crow::response& res, context&) {
        const auto now_steady = std::chrono::steady_clock::now();
        const auto now_system = std::chrono::system_clock::now();
        
        std::string ip = req.get_header_value("CF-Connecting-IP");
        if (ip.empty()) {
            ip = req.remote_ip_address.empty() ? "unknown" : req.remote_ip_address;
        }
        std::string path = req.url;
        const auto qpos = path.find('?');
        if (qpos != std::string::npos) {
            path = path.substr(0, qpos);
        }
        const bool is_auth_route = (path == "/login" || path == "/register" || path == "/verify");

        const int64_t now_epoch = std::chrono::duration_cast<std::chrono::seconds>(now_system.time_since_epoch()).count();

        if (now_epoch < ddos_panic_until_epoch.load(std::memory_order_relaxed)) {
            res.code = 429;
            res.set_header("Content-Type", "application/json");
            res.body = R"({"error": "Too Many Requests"})";
            res.end();
            return;
        }

        {
            std::shared_lock<std::shared_timed_mutex> read_lock(mutex_);
            auto banned_it = banned_ips_cache.find(ip);
            if (banned_it != banned_ips_cache.end() && now_system < banned_it->second) {
                res.code = 403;
                res.set_header("Content-Type", "application/json");
                res.body = R"({"error": "IP banido por atividade suspeita"})";
                res.end();
                return;
            }
        }

        bool should_persist_ban = false;
        std::chrono::system_clock::time_point ban_until;

        {
            std::unique_lock<std::shared_timed_mutex> write_lock(mutex_);
            auto banned_it = banned_ips_cache.find(ip);
            if (banned_it != banned_ips_cache.end()) {
                if (now_system < banned_it->second) {
                    res.code = 403;
                    res.set_header("Content-Type", "application/json");
                    res.body = R"({"error": "IP banido por atividade suspeita"})";
                    res.end();
                    return;
                }
                banned_ips_cache.erase(banned_it);
            }

            if (clients_.size() >= MAX_CLIENTS) {
                evict_expired_clients(now_steady);

                if (clients_.size() >= MAX_CLIENTS) {
                    auto existing = clients_.find(ip);
                    if (existing == clients_.end()) {
                        auto lowest_it = clients_.end();
                        int lowest_count = std::numeric_limits<int>::max();

                        for (auto it = clients_.begin(); it != clients_.end(); ++it) {
                            if (it->second.general_count < lowest_count) {
                                lowest_count = it->second.general_count;
                                lowest_it = it;
                            }
                        }

                        const int HIGH_THREAT_THRESHOLD = 5;
                        if (lowest_it != clients_.end() && lowest_count < HIGH_THREAT_THRESHOLD) {
                            clients_.erase(lowest_it);
                        } else {
                            ddos_panic_until_epoch.store(now_epoch + 15, std::memory_order_relaxed);
                            res.code = 429;
                            res.set_header("Content-Type", "application/json");
                            res.body = R"({"error": "Too Many Requests"})";
                            res.end();
                            return;
                        }
                    }
                }
            }

            auto& client = clients_[ip];
            client.last_request = now_steady;

            if (now_steady - client.window_start >= std::chrono::minutes(1)) {
                client.auth_count = 0;
                client.general_count = 0;
                client.window_start = now_steady;
            }

            if (is_auth_route) {
                ++client.auth_count;
                if (client.auth_count >= 15) {
                    ban_until = now_system + std::chrono::hours(24);
                    banned_ips_cache[ip] = ban_until;
                    should_persist_ban = true;
                }
            } else {
                ++client.general_count;
            }

            if ((is_auth_route && client.auth_count > 5) || (!is_auth_route && client.general_count > 5000)) {
                if (should_persist_ban) {
                    res.code = 403;
                    res.set_header("Content-Type", "application/json");
                    res.body = R"({"error": "IP banido por atividade suspeita"})";
                    res.end();
                    return;
                }

                res.code = 429;
                res.set_header("Content-Type", "application/json");
                res.body = R"({"error": "Too Many Requests"})";
                res.end();
                return;
            }
        }

        if (should_persist_ban && pool_ != nullptr) {
            try {
                auto conn_wrapper = pool_->acquire_connection();
                pqxx::work w(*conn_wrapper);

                const std::int64_t epoch_seconds = std::chrono::duration_cast<std::chrono::seconds>(
                    ban_until.time_since_epoch()).count();

                w.exec(
                    "INSERT INTO banned_ips (ip, expires_at, reason) "
                    "VALUES ($1, to_timestamp($2), 'Força bruta em autenticação') "
                    "ON CONFLICT (ip) DO UPDATE "
                    "SET expires_at = EXCLUDED.expires_at, reason = EXCLUDED.reason;",
                    pqxx::params{ip, epoch_seconds});
                w.commit();
            } catch (...) {
            }

            res.code = 403;
            res.set_header("Content-Type", "application/json");
            res.body = R"({"error": "IP banido por atividade suspeita"})";
            res.end();
            return;
        }
    }

    void after_handle(crow::request&, crow::response&, context&) {}

private:
    void evict_expired_clients(std::chrono::steady_clock::time_point now) {
        for (auto it = clients_.begin(); it != clients_.end(); ) {
            if (now - it->second.last_request >= CLIENT_TTL) {
                it = clients_.erase(it);
            } else {
                ++it;
            }
        }
    }

    std::unordered_map<std::string, ClientData> clients_;
    std::unordered_map<std::string, std::chrono::system_clock::time_point> banned_ips_cache;
    DatabasePool* pool_ = nullptr;
    std::shared_timed_mutex mutex_;
    std::atomic<int64_t> ddos_panic_until_epoch{0};
};
