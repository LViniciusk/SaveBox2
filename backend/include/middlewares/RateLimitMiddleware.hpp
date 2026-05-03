#pragma once

#include <chrono>
#include <cstdint>
#include <shared_mutex>
#include <string>
#include <unordered_map>
#include <utility>

#include "database/DatabasePool.hpp"
#include "crow_all.h"

struct RateLimitMiddleware {
    struct context {};

    struct ClientData {
        int count = 0;
        std::chrono::steady_clock::time_point window_start = std::chrono::steady_clock::now();
    };

    void init(DatabasePool& pool) {
        pool_ = &pool;

        auto conn_wrapper = pool_->acquire_connection();
        pqxx::work w(*conn_wrapper);

        auto result = w.exec(
            "SELECT ip, EXTRACT(EPOCH FROM banned_until)::BIGINT AS banned_until_epoch "
            "FROM banned_ips WHERE banned_until > NOW();");
        w.commit();

        const auto now = std::chrono::system_clock::now();

        std::unique_lock<std::shared_timed_mutex> lock(mutex_);
        for (const auto& row : result) {
            const std::string ip = row["ip"].c_str();
            const std::int64_t epoch_seconds = row["banned_until_epoch"].as<std::int64_t>();
            const auto banned_until = std::chrono::system_clock::time_point(std::chrono::seconds(epoch_seconds));

            if (banned_until > now) {
                banned_ips_cache[ip] = banned_until;
            }
        }
    }

    void before_handle(crow::request& req, crow::response& res, context&) {
        const auto now_steady = std::chrono::steady_clock::now();
        const auto now_system = std::chrono::system_clock::now();
        const std::string ip = req.remote_ip_address.empty() ? "unknown" : req.remote_ip_address;
        std::string path = req.url;
        const auto qpos = path.find('?');
        if (qpos != std::string::npos) {
            path = path.substr(0, qpos);
        }
        const bool is_auth_route = (path == "/login" || path == "/register");

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

            if (clients_.size() > 10000) {
                clients_.clear();
            }

            auto& client = clients_[ip];

            if (now_steady - client.window_start >= std::chrono::minutes(1)) {
                client.count = 0;
                client.window_start = now_steady;
            }

            ++client.count;

            if (is_auth_route && client.count >= 15) {
                ban_until = now_system + std::chrono::hours(24);
                banned_ips_cache[ip] = ban_until;
                should_persist_ban = true;
            }

            const int max_requests = is_auth_route ? 5 : 100;

            if (client.count > max_requests) {
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
                    "INSERT INTO banned_ips (ip, banned_until, reason) "
                    "VALUES ($1, to_timestamp($2), 'Força bruta em autenticação') "
                    "ON CONFLICT (ip) DO UPDATE "
                    "SET banned_until = EXCLUDED.banned_until, reason = EXCLUDED.reason;",
                    pqxx::params{ip, epoch_seconds});
                w.commit();
            } catch (...) {
                // Mantem o ban em RAM mesmo se houver falha no banco.
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
    std::unordered_map<std::string, ClientData> clients_;
    std::unordered_map<std::string, std::chrono::system_clock::time_point> banned_ips_cache;
    DatabasePool* pool_ = nullptr;
    std::shared_timed_mutex mutex_;
};
