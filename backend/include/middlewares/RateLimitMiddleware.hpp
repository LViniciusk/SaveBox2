#pragma once

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <shared_mutex>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <atomic>
#include <limits>
#ifdef NANIKA_TESTING
#include <functional>
#endif

#include "database/DatabasePool.hpp"
#include "utils/ClientIp.hpp"
#ifdef NANIKA_AP06_LOCAL_TEST_SERVER
#include "utils/Ap06LocalRuntime.hpp"
#endif
#include "crow_all.h"

struct RateLimitMiddleware {
    struct context {};

    explicit RateLimitMiddleware(bool trust_forwarded = false)
        : trust_forwarded_(trust_forwarded) {}

    struct ClientData {
        int auth_count = 0;
        int session_count = 0;
        int general_count = 0;
        std::chrono::steady_clock::time_point window_start = std::chrono::steady_clock::now();
        std::chrono::steady_clock::time_point last_request = std::chrono::steady_clock::now();
    };

    static constexpr size_t MAX_CLIENTS = 10000;
    static constexpr size_t MAX_BANNED_IPS = MAX_CLIENTS;
    static constexpr auto CLIENT_TTL = std::chrono::minutes(2);
    static constexpr auto BAN_CACHE_SWEEP_INTERVAL = std::chrono::minutes(1);
    static constexpr auto BAN_CACHE_REFRESH_INTERVAL = std::chrono::minutes(1);
    static constexpr int AUTH_LIMIT = 5;
    static constexpr int AUTH_BAN_THRESHOLD = 15;
    static constexpr int SESSION_CONTROL_LIMIT = 60;
    static constexpr int GENERAL_LIMIT = 5000;

    enum class RouteClass {
        CredentialAuth,
        SessionControl,
        General
    };

    void init(DatabasePool& pool, bool trust_forwarded = false) {
#ifdef NANIKA_AP06_LOCAL_TEST_SERVER
        verified_isolated_test_runtime_ = false;
#endif
        pool_ = &pool;
        trust_forwarded_ = trust_forwarded;

        const auto snapshot = load_active_bans();
        std::unique_lock<std::shared_timed_mutex> lock(mutex_);
        const auto now = std::chrono::system_clock::now();
        evict_expired_bans(now);
        merge_active_bans(snapshot, now);
        next_ban_sweep_ = std::chrono::steady_clock::now() + BAN_CACHE_SWEEP_INTERVAL;
        next_ban_refresh_ = std::chrono::steady_clock::now() + BAN_CACHE_REFRESH_INTERVAL;
    }

#ifdef NANIKA_AP06_LOCAL_TEST_SERVER
    void init_ap06_local(DatabasePool& pool, const Ap06LocalRuntime&) {
        init(pool, false);
        verified_isolated_test_runtime_ = true;
    }
#endif

    void before_handle(crow::request& req, crow::response& res, context&) {
#ifdef NANIKA_AP06_LOCAL_TEST_SERVER
        if (verified_isolated_test_runtime_ && ClientIp::is_actual_loopback_peer(req)) return;
#endif
        if (req.method == crow::HTTPMethod::Options) return;
        const auto now_steady = std::chrono::steady_clock::now();
        const auto now_system = std::chrono::system_clock::now();
        
        const std::string ip = ClientIp::resolve(req, trust_forwarded_);
        std::string path = req.url;
        const auto qpos = path.find('?');
        if (qpos != std::string::npos) {
            path = path.substr(0, qpos);
        }
        const RouteClass route_class = classify_path(path);

        const int64_t now_epoch = std::chrono::duration_cast<std::chrono::seconds>(now_system.time_since_epoch()).count();

        if (now_epoch < ddos_panic_until_epoch.load(std::memory_order_relaxed)) {
            res.code = 429;
            res.set_header("Content-Type", "application/json");
            res.body = R"({"error": "Too Many Requests"})";
            res.end();
            return;
        }

        bool maintenance_due;
        {
            std::shared_lock<std::shared_timed_mutex> read_lock(mutex_);
            maintenance_due = now_steady >= next_ban_sweep_ ||
                (ban_cache_overflowed_ && !ban_refresh_in_flight_ && now_steady >= next_ban_refresh_);
            auto banned_it = banned_ips_cache.find(ip);
            if (!maintenance_due && banned_it != banned_ips_cache.end() && now_system < banned_it->second) {
                res.code = 403;
                res.set_header("Content-Type", "application/json");
                res.body = R"({"error": "IP banido por atividade suspeita"})";
                res.end();
                return;
            }
        }
        if (maintenance_due) maintain_bans(now_steady, now_system);

        bool should_persist_ban = false;
        bool ban_cached = false;
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
            if (ban_cache_overflowed_) {
                res.code = 429;
                res.set_header("Content-Type", "application/json");
                res.body = R"({"error": "Too Many Requests"})";
                res.end();
                return;
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
                client.session_count = 0;
                client.general_count = 0;
                client.window_start = now_steady;
            }

            if (route_class == RouteClass::CredentialAuth) {
                ++client.auth_count;
                if (client.auth_count >= AUTH_BAN_THRESHOLD) {
                    ban_until = now_system + std::chrono::hours(24);
                    ban_cached = cache_active_ban(ip, ban_until);
                    if (!ban_cached) {
                        ban_cache_overflowed_ = true;
                        next_ban_refresh_ = now_steady + BAN_CACHE_REFRESH_INTERVAL;
                    }
                    ++ban_persistence_in_flight_;
                    should_persist_ban = true;
                }
            } else if (route_class == RouteClass::SessionControl) {
                ++client.session_count;
            } else {
                ++client.general_count;
            }

            const bool over_limit =
                (route_class == RouteClass::CredentialAuth && client.auth_count > AUTH_LIMIT) ||
                (route_class == RouteClass::SessionControl && client.session_count > SESSION_CONTROL_LIMIT) ||
                (route_class == RouteClass::General && client.general_count > GENERAL_LIMIT);
            if (over_limit) {
                if (!should_persist_ban) {
                    res.code = 429;
                    res.set_header("Content-Type", "application/json");
                    res.body = R"({"error": "Too Many Requests"})";
                    res.end();
                    return;
                }
            }
        }

        if (should_persist_ban) {
            bool persisted = false;
            if (pool_ != nullptr) {
                try {
#ifdef NANIKA_TESTING
                    if (ban_persistence_test_hook_) ban_persistence_test_hook_();
#endif
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
                    persisted = true;
                } catch (...) {
                }
            }
            {
                std::unique_lock<std::shared_timed_mutex> lock(mutex_);
                --ban_persistence_in_flight_;
                if (!persisted && !ban_cached && unpersisted_ban_until_ < ban_until) {
                    unpersisted_ban_until_ = ban_until;
                }
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
#ifdef NANIKA_TESTING
    friend struct RateLimitMiddlewareTestProbe;
    std::size_t max_banned_ips_ = MAX_BANNED_IPS;
    std::function<void(std::size_t)> ban_snapshot_test_hook_;
    std::function<void()> ban_persistence_test_hook_;
#else
    static constexpr std::size_t max_banned_ips_ = MAX_BANNED_IPS;
#endif

    pqxx::result load_active_bans() {
        pqxx::result snapshot;
        {
            auto conn = pool_->acquire_connection();
            pqxx::work txn(*conn);
            snapshot = txn.exec(
                "SELECT ip, EXTRACT(EPOCH FROM expires_at)::BIGINT AS expires_at_epoch "
                "FROM banned_ips WHERE expires_at > NOW() "
                "ORDER BY expires_at DESC, ip ASC LIMIT $1;",
                pqxx::params{max_banned_ips_ + 1});
            txn.commit();
        }
#ifdef NANIKA_TESTING
        if (ban_snapshot_test_hook_) ban_snapshot_test_hook_(snapshot.size());
#endif
        return snapshot;
    }

    bool cache_active_ban(const std::string& ip, std::chrono::system_clock::time_point until) {
        const auto existing = banned_ips_cache.find(ip);
        if (existing != banned_ips_cache.end()) {
            if (existing->second < until) existing->second = until;
            return true;
        }
        if (banned_ips_cache.size() >= max_banned_ips_) return false;
        banned_ips_cache.emplace(ip, until);
        return true;
    }

    void merge_active_bans(const pqxx::result& snapshot, std::chrono::system_clock::time_point now) {
        const auto count = static_cast<std::size_t>(snapshot.size());
        bool complete = count <= max_banned_ips_;
        for (std::size_t n = 0; n < count && n < max_banned_ips_; ++n) {
            const auto& row = snapshot[n];
            const auto until = std::chrono::system_clock::time_point(
                std::chrono::seconds(row["expires_at_epoch"].as<std::int64_t>()));
            if (until > now && !cache_active_ban(row["ip"].c_str(), until)) complete = false;
        }
        ban_cache_overflowed_ = !complete || ban_persistence_in_flight_ != 0 || unpersisted_ban_until_ > now;
    }

    void evict_expired_bans(std::chrono::system_clock::time_point now) {
        for (auto it = banned_ips_cache.begin(); it != banned_ips_cache.end();) {
            if (it->second <= now) it = banned_ips_cache.erase(it);
            else ++it;
        }
    }

    void maintain_bans(std::chrono::steady_clock::time_point steady_now,
                       std::chrono::system_clock::time_point system_now) {
        {
            std::unique_lock<std::shared_timed_mutex> lock(mutex_);
            if (steady_now >= next_ban_sweep_) {
                evict_expired_bans(system_now);
                next_ban_sweep_ = steady_now + BAN_CACHE_SWEEP_INTERVAL;
            }
            if (!ban_cache_overflowed_ || ban_refresh_in_flight_ || steady_now < next_ban_refresh_) return;
            next_ban_refresh_ = steady_now + BAN_CACHE_REFRESH_INTERVAL;
            if (ban_persistence_in_flight_ != 0 || unpersisted_ban_until_ > system_now) return;
            if (pool_ == nullptr) {
                // Without a pool, the watermark covers every uncached ban.
                ban_cache_overflowed_ = false;
                return;
            }
            ban_refresh_in_flight_ = true;
        }
        try {
            // Overflow admission blocks new bans; earlier persistence must be finished before this snapshot.
            const auto snapshot = load_active_bans();
            std::unique_lock<std::shared_timed_mutex> lock(mutex_);
            const auto now = std::chrono::system_clock::now();
            evict_expired_bans(now);
            merge_active_bans(snapshot, now);
            ban_refresh_in_flight_ = false;
        } catch (...) {
            std::unique_lock<std::shared_timed_mutex> lock(mutex_);
            ban_refresh_in_flight_ = false;
        }
    }

    static RouteClass classify_path(std::string_view path) {
        if (path == "/login" || path == "/register" || path == "/verify" ||
            path == "/api/auth/google") {
            return RouteClass::CredentialAuth;
        }
        if (path == "/api/auth/refresh") return RouteClass::SessionControl;
        return RouteClass::General;
    }

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
    bool ban_cache_overflowed_ = false;
    bool ban_refresh_in_flight_ = false;
    std::size_t ban_persistence_in_flight_ = 0;
    std::chrono::system_clock::time_point unpersisted_ban_until_{};
    std::chrono::steady_clock::time_point next_ban_sweep_{};
    std::chrono::steady_clock::time_point next_ban_refresh_{};
    DatabasePool* pool_ = nullptr;
    bool trust_forwarded_ = false;
#ifdef NANIKA_AP06_LOCAL_TEST_SERVER
    bool verified_isolated_test_runtime_ = false;
#endif
    std::shared_timed_mutex mutex_;
    std::atomic<int64_t> ddos_panic_until_epoch{0};
};
