#include <catch2/catch_test_macros.hpp>
#include "middlewares/RateLimitMiddleware.hpp"
#include "test_helpers.hpp"
#include "utils/RandomIds.hpp"
#include <condition_variable>
#include <exception>
#include <thread>

static_assert(RateLimitMiddleware::MAX_BANNED_IPS == RateLimitMiddleware::MAX_CLIENTS);
static_assert(RateLimitMiddleware::MAX_BANNED_IPS == 10000);

struct RateLimitMiddlewareTestProbe {
    static void budget(RateLimitMiddleware& mw, std::size_t limit) {
        mw.max_banned_ips_ = limit;
    }
    static std::size_t cache_size(RateLimitMiddleware& mw) {
        std::shared_lock<std::shared_timed_mutex> lock(mw.mutex_);
        return mw.banned_ips_cache.size();
    }
    static void seed(RateLimitMiddleware& mw, const std::string& ip,
                     std::chrono::system_clock::time_point expiry) {
        std::unique_lock<std::shared_timed_mutex> lock(mw.mutex_);
        mw.banned_ips_cache[ip] = expiry;
    }
    static bool overflow(RateLimitMiddleware& mw) {
        std::shared_lock<std::shared_timed_mutex> lock(mw.mutex_);
        return mw.ban_cache_overflowed_;
    }
    static void sweep_due(RateLimitMiddleware& mw) {
        std::unique_lock<std::shared_timed_mutex> lock(mw.mutex_);
        mw.next_ban_sweep_ = {};
    }
    static void refresh_due(RateLimitMiddleware& mw) {
        std::unique_lock<std::shared_timed_mutex> lock(mw.mutex_);
        mw.next_ban_refresh_ = {};
    }
    static bool mutex_available(RateLimitMiddleware& mw) {
        std::unique_lock<std::shared_timed_mutex> lock(mw.mutex_, std::try_to_lock);
        return lock.owns_lock();
    }
    static std::size_t pending_persistence(RateLimitMiddleware& mw) {
        std::shared_lock<std::shared_timed_mutex> lock(mw.mutex_);
        return mw.ban_persistence_in_flight_;
    }
    static auto uncertainty_until(RateLimitMiddleware& mw) {
        std::shared_lock<std::shared_timed_mutex> lock(mw.mutex_);
        return mw.unpersisted_ban_until_;
    }
    static void expire_uncertainty(RateLimitMiddleware& mw) {
        std::unique_lock<std::shared_timed_mutex> lock(mw.mutex_);
        mw.unpersisted_ban_until_ = {};
    }
    static void snapshot_hook(RateLimitMiddleware& mw, std::function<void(std::size_t)> hook) {
        mw.ban_snapshot_test_hook_ = std::move(hook);
    }
    static void persistence_hook(RateLimitMiddleware& mw, std::function<void()> hook) {
        mw.ban_persistence_test_hook_ = std::move(hook);
    }
    static void prime_auth(RateLimitMiddleware& mw, const std::string& ip) {
        std::unique_lock<std::shared_timed_mutex> lock(mw.mutex_);
        mw.clients_[ip].auth_count = 14;
    }
    static int auth_count(RateLimitMiddleware& mw, const std::string& ip) {
        std::shared_lock<std::shared_timed_mutex> lock(mw.mutex_);
        return mw.clients_.at(ip).auth_count;
    }
};

namespace {
crow::response request(RateLimitMiddleware& mw, const std::string& ip,
                       const std::string& path = "/ordinary") {
    crow::request req;
    req.remote_ip_address = ip;
    req.url = path;
    crow::response res;
    RateLimitMiddleware::context ctx;
    mw.before_handle(req, res, ctx);
    return res;
}

void ban(RateLimitMiddleware& mw, const std::string& ip) {
    for (int attempt = 1; attempt <= 15; ++attempt) {
        const auto response = request(mw, ip, "/login");
        CHECK(response.code == (attempt <= 5 ? 200 : attempt < 15 ? 429 : 403));
    }
}

struct BanDatabase {
    DatabasePool pool{1, get_secure_conn_string()};
    const std::string schema = "b98_" + UuidUtils::generate_uuid_v4();
    BanDatabase() {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("CREATE SCHEMA " + txn.quote_name(schema));
        txn.exec("CREATE TABLE " + txn.quote_name(schema) +
                 ".banned_ips (LIKE public.banned_ips INCLUDING ALL)");
        txn.exec("SET search_path TO " + txn.quote_name(schema));
        txn.commit();
    }
    ~BanDatabase() {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("SET search_path TO public");
        txn.exec("DROP SCHEMA " + txn.quote_name(schema) + " CASCADE");
        txn.commit();
    }
    void seed(int count) {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        for (int n = 1; n <= count; ++n) {
            txn.exec("INSERT INTO banned_ips(ip,expires_at,reason) "
                     "VALUES($1,NOW()+INTERVAL '24 hours','B98 synthetic')",
                     pqxx::params{"198.18.0." + std::to_string(n)});
        }
        txn.commit();
    }
    void erase(const std::string& ip) {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM banned_ips WHERE ip=$1", pqxx::params{ip});
        txn.commit();
    }
    int count(const std::string& ip) {
        auto conn = pool.acquire_connection();
        pqxx::nontransaction txn(*conn);
        return txn.exec("SELECT COUNT(*) FROM banned_ips WHERE ip=$1", pqxx::params{ip})[0][0].as<int>();
    }
};

struct Gate {
    std::mutex mutex;
    std::condition_variable cv;
    bool entered = false;
    bool released = false;
    void block() {
        std::unique_lock<std::mutex> lock(mutex);
        entered = true;
        cv.notify_all();
        cv.wait(lock, [&] { return released; });
    }
    bool wait_entered() {
        std::unique_lock<std::mutex> lock(mutex);
        return cv.wait_for(lock, std::chrono::seconds(5), [&] { return entered; });
    }
    void release() {
        std::lock_guard<std::mutex> lock(mutex);
        released = true;
        cv.notify_all();
    }
};

struct WorkerCleanup {
    Gate& gate;
    std::vector<std::thread>& workers;
    ~WorkerCleanup() {
        gate.release();
        join();
    }
    void join() {
        for (auto& worker : workers) if (worker.joinable()) worker.join();
    }
};

struct DownstreamCounter {
    struct context {};
    int calls = 0;
    void before_handle(crow::request&, crow::response&, context&) { ++calls; }
    void after_handle(crow::request&, crow::response&, context&) {}
};
}

TEST_CASE("B.98 runtime ban cache respects a hard cardinality budget", "[b98][rate_limiter]") {
    RateLimitMiddleware mw;
    RateLimitMiddlewareTestProbe::budget(mw, 2);
    ban(mw, "198.18.1.1");
    CHECK(RateLimitMiddlewareTestProbe::cache_size(mw) == 1);
    ban(mw, "198.18.1.2");
    CHECK(RateLimitMiddlewareTestProbe::cache_size(mw) == 2);
    ban(mw, "198.18.1.3");
    CHECK(RateLimitMiddlewareTestProbe::cache_size(mw) <= 2);
    CHECK(RateLimitMiddlewareTestProbe::overflow(mw));
    CHECK(request(mw, "198.18.1.1").code == 403);
    CHECK(request(mw, "198.18.1.3").code == 429);
    CHECK(request(mw, "198.18.1.4").code == 429);
}

TEST_CASE("B.98 startup active ban load respects a hard cardinality budget", "[b98][rate_limiter][database]") {
    BanDatabase db;
    int active_rows = 4;
    SECTION("below cap") { active_rows = 1; }
    SECTION("at cap") { active_rows = 2; }
    SECTION("cap plus one") { active_rows = 3; }
    SECTION("well above cap") { active_rows = 5; }
    db.seed(active_rows);
    RateLimitMiddleware mw;
    RateLimitMiddlewareTestProbe::budget(mw, 2);
    std::size_t snapshot_rows = 0;
    RateLimitMiddlewareTestProbe::snapshot_hook(mw, [&](std::size_t rows) { snapshot_rows = rows; });
    mw.init(db.pool);
    CHECK(RateLimitMiddlewareTestProbe::cache_size(mw) <= 2);
    CHECK(snapshot_rows == static_cast<std::size_t>(active_rows < 3 ? active_rows : 3));
    CHECK(RateLimitMiddlewareTestProbe::overflow(mw) == (active_rows > 2));
    CHECK(request(mw, "198.18.0.1").code == 403);
    CHECK(request(mw, "198.18.4.1").code == (active_rows > 2 ? 429 : 200));
}

TEST_CASE("B.98 unrelated requests reclaim globally expired bans", "[b98][rate_limiter]") {
    RateLimitMiddleware mw;
    const auto now = std::chrono::system_clock::now();
    for (int n = 1; n <= 3; ++n) {
        RateLimitMiddlewareTestProbe::seed(mw, "198.18.2." + std::to_string(n), now - std::chrono::hours(1));
    }
    RateLimitMiddlewareTestProbe::seed(mw, "198.18.2.4", now + std::chrono::hours(1));
    const auto response = request(mw, "198.18.3.1");
    CHECK(response.code == 200);
    CHECK(RateLimitMiddlewareTestProbe::cache_size(mw) == 1);
    CHECK(request(mw, "198.18.2.4").code == 403);
    RateLimitMiddlewareTestProbe::seed(mw, "198.18.2.5", now - std::chrono::hours(1));
    CHECK(request(mw, "198.18.3.2").code == 200);
    CHECK(RateLimitMiddlewareTestProbe::cache_size(mw) == 2);
    RateLimitMiddlewareTestProbe::sweep_due(mw);
    CHECK(request(mw, "198.18.3.2").code == 200);
    CHECK(RateLimitMiddlewareTestProbe::cache_size(mw) == 1);
}

TEST_CASE("B.98 overflow transition persists without active eviction", "[b98][rate_limiter][database][security]") {
    BanDatabase db;
    RateLimitMiddleware mw;
    RateLimitMiddlewareTestProbe::budget(mw, 2);
    mw.init(db.pool);
    ban(mw, "198.18.5.1");
    ban(mw, "198.18.5.2");
    ban(mw, "198.18.5.3");
    CHECK(RateLimitMiddlewareTestProbe::cache_size(mw) == 2);
    CHECK(RateLimitMiddlewareTestProbe::overflow(mw));
    CHECK(db.count("198.18.5.3") == 1);
    CHECK(request(mw, "198.18.5.1").code == 403);
    CHECK(request(mw, "198.18.5.3").code == 429);
    RateLimitMiddleware restarted;
    RateLimitMiddlewareTestProbe::budget(restarted, 2);
    restarted.init(db.pool);
    CHECK(RateLimitMiddlewareTestProbe::overflow(restarted));
    CHECK(request(restarted, "198.18.5.3").code != 200);
}

TEST_CASE("B.98 overflow miss ends real middleware dispatch before business effects", "[b98][rate_limiter][security]") {
    using App = crow::App<RateLimitMiddleware, DownstreamCounter>;
    App app;
    App::mw_container_t middlewares;
    auto& limiter = std::get<RateLimitMiddleware>(middlewares);
    RateLimitMiddlewareTestProbe::budget(limiter, 1);
    ban(limiter, "198.18.5.10");
    ban(limiter, "198.18.5.11");
    int handler_calls = 0;
    CROW_ROUTE(app, "/ordinary")([&] {
        ++handler_calls;
        return crow::response(200);
    });
    app.validate();
    crow::request req;
    req.url = "/ordinary";
    req.remote_ip_address = "198.18.5.12";
    App::context_t ctx;
    crow::response response;
    auto found = app.handle_initial(req, response);
    req.middleware_context = &ctx;
    req.middleware_container = &middlewares;
    const bool ended = crow::detail::middleware_call_helper<
        crow::detail::middleware_call_criteria_only_global, 0,
        App::context_t, App::mw_container_t>({}, middlewares, req, response, ctx);
    if (!response.is_completed()) app.handle(req, response, found);
    CHECK(ended);
    CHECK(response.is_completed());
    CHECK(response.code == 429);
    CHECK(std::get<DownstreamCounter>(middlewares).calls == 0);
    CHECK(handler_calls == 0);
}

TEST_CASE("B.98 bounded refresh recovers after durable overflow ends", "[b98][rate_limiter][database]") {
    BanDatabase db;
    db.seed(4);
    RateLimitMiddleware mw;
    RateLimitMiddlewareTestProbe::budget(mw, 2);
    mw.init(db.pool);
    int query_calls = 0;
    std::size_t snapshot_rows = 0;
    RateLimitMiddlewareTestProbe::snapshot_hook(mw, [&](std::size_t rows) {
        ++query_calls;
        snapshot_rows = rows;
    });
    RateLimitMiddlewareTestProbe::refresh_due(mw);
    CHECK(request(mw, "198.18.6.1").code == 429);
    CHECK(query_calls == 1);
    CHECK(snapshot_rows == 3);
    CHECK(RateLimitMiddlewareTestProbe::overflow(mw));
    CHECK(request(mw, "198.18.6.2").code == 429);
    CHECK(query_calls == 1);
    db.erase("198.18.0.3");
    db.erase("198.18.0.4");
    RateLimitMiddlewareTestProbe::refresh_due(mw);
    CHECK(request(mw, "198.18.6.1").code == 200);
    CHECK(query_calls == 2);
    CHECK(snapshot_rows == 2);
    CHECK_FALSE(RateLimitMiddlewareTestProbe::overflow(mw));
    CHECK(RateLimitMiddlewareTestProbe::cache_size(mw) == 2);
    CHECK(request(mw, "198.18.0.1").code == 403);
}

TEST_CASE("B.98 refresh preserves active runtime bans missing from the snapshot", "[b98][rate_limiter][database][security]") {
    BanDatabase db;
    db.seed(3);
    RateLimitMiddleware mw;
    RateLimitMiddlewareTestProbe::budget(mw, 2);
    mw.init(db.pool);
    db.erase("198.18.0.1");
    RateLimitMiddlewareTestProbe::refresh_due(mw);
    CHECK(request(mw, "198.18.7.1").code == 429);
    CHECK(RateLimitMiddlewareTestProbe::overflow(mw));
    CHECK(RateLimitMiddlewareTestProbe::cache_size(mw) == 2);
    CHECK(request(mw, "198.18.0.1").code == 403);
    RateLimitMiddlewareTestProbe::seed(mw, "198.18.0.1", std::chrono::system_clock::now() - std::chrono::hours(1));
    RateLimitMiddlewareTestProbe::sweep_due(mw);
    RateLimitMiddlewareTestProbe::refresh_due(mw);
    CHECK(request(mw, "198.18.7.1").code == 200);
    CHECK_FALSE(RateLimitMiddlewareTestProbe::overflow(mw));
    CHECK(request(mw, "198.18.0.3").code == 403);
}

TEST_CASE("B.98 snapshot failure remains fail closed and waits for its refresh window", "[b98][rate_limiter][database]") {
    BanDatabase db;
    db.seed(3);
    RateLimitMiddleware mw;
    RateLimitMiddlewareTestProbe::budget(mw, 2);
    mw.init(db.pool);
    int query_calls = 0;
    RateLimitMiddlewareTestProbe::snapshot_hook(mw, [&](std::size_t) {
        ++query_calls;
        throw std::runtime_error("B98 synthetic snapshot failure");
    });
    RateLimitMiddlewareTestProbe::refresh_due(mw);
    CHECK(request(mw, "198.18.8.1").code == 429);
    CHECK(query_calls == 1);
    CHECK(request(mw, "198.18.8.2").code == 429);
    CHECK(query_calls == 1);
    CHECK(request(mw, "198.18.0.1").code == 403);
    CHECK(RateLimitMiddlewareTestProbe::overflow(mw));
}

TEST_CASE("B.98 normal misses add no database queries", "[b98][rate_limiter][database]") {
    BanDatabase db;
    RateLimitMiddleware mw;
    mw.init(db.pool);
    int query_calls = 0;
    RateLimitMiddlewareTestProbe::snapshot_hook(mw, [&](std::size_t) { ++query_calls; });
    for (int n = 1; n <= 100; ++n) {
        CHECK(request(mw, "198.18.9." + std::to_string(n)).code == 200);
    }
    RateLimitMiddlewareTestProbe::sweep_due(mw);
    CHECK(request(mw, "198.18.9.101").code == 200);
    CHECK(query_calls == 0);
    CHECK_FALSE(RateLimitMiddlewareTestProbe::overflow(mw));
}

TEST_CASE("B.98 cached ban survives persistence failure", "[b98][rate_limiter][database][security]") {
    BanDatabase db;
    RateLimitMiddleware mw;
    mw.init(db.pool);
    RateLimitMiddlewareTestProbe::persistence_hook(mw, [] {
        throw std::runtime_error("B98 synthetic persistence failure");
    });
    ban(mw, "198.18.10.10");
    CHECK(db.count("198.18.10.10") == 0);
    CHECK(request(mw, "198.18.10.10").code == 403);
    CHECK_FALSE(RateLimitMiddlewareTestProbe::overflow(mw));
}

TEST_CASE("B.98 in-flight failed overflow persistence cannot be cleared by refresh", "[b98][rate_limiter][database][security]") {
    BanDatabase db;
    db.seed(2);
    RateLimitMiddleware mw;
    RateLimitMiddlewareTestProbe::budget(mw, 2);
    mw.init(db.pool);
    int query_calls = 0;
    RateLimitMiddlewareTestProbe::snapshot_hook(mw, [&](std::size_t) { ++query_calls; });
    Gate gate;
    RateLimitMiddlewareTestProbe::persistence_hook(mw, [&] {
        gate.block();
        throw std::runtime_error("B98 synthetic persistence failure");
    });
    RateLimitMiddlewareTestProbe::prime_auth(mw, "198.18.10.1");
    std::vector<std::thread> workers;
    WorkerCleanup cleanup{gate, workers};
    std::exception_ptr error;
    int status = 0;
    workers.emplace_back([&] {
        try { status = request(mw, "198.18.10.1", "/login").code; }
        catch (...) { error = std::current_exception(); }
    });
    REQUIRE(gate.wait_entered());
    REQUIRE(RateLimitMiddlewareTestProbe::mutex_available(mw));
    CHECK(db.pool.get_available_count() == 1);
    CHECK(RateLimitMiddlewareTestProbe::pending_persistence(mw) == 1);
    CHECK(RateLimitMiddlewareTestProbe::overflow(mw));
    RateLimitMiddlewareTestProbe::refresh_due(mw);
    CHECK(request(mw, "198.18.10.2").code == 429);
    CHECK(query_calls == 0);
    gate.release();
    cleanup.join();
    if (error) std::rethrow_exception(error);
    CHECK(status == 403);
    CHECK(db.count("198.18.10.1") == 0);
    CHECK(RateLimitMiddlewareTestProbe::pending_persistence(mw) == 0);
    CHECK(RateLimitMiddlewareTestProbe::uncertainty_until(mw) > std::chrono::system_clock::now() + std::chrono::hours(23));
    RateLimitMiddlewareTestProbe::refresh_due(mw);
    CHECK(request(mw, "198.18.10.2").code == 429);
    CHECK(query_calls == 0);
    CHECK(request(mw, "198.18.0.1").code == 403);
    RateLimitMiddlewareTestProbe::expire_uncertainty(mw);
    RateLimitMiddlewareTestProbe::refresh_due(mw);
    CHECK(request(mw, "198.18.10.2").code == 200);
    CHECK(query_calls == 1);
    CHECK_FALSE(RateLimitMiddlewareTestProbe::overflow(mw));
}

TEST_CASE("B.98 concurrent due requests elect one bounded refresh", "[b98][rate_limiter][database][concurrency]") {
    BanDatabase db;
    db.seed(4);
    RateLimitMiddleware mw;
    RateLimitMiddlewareTestProbe::budget(mw, 2);
    mw.init(db.pool);
    Gate gate;
    std::atomic<int> query_calls{0};
    std::atomic<std::size_t> snapshot_rows{0};
    RateLimitMiddlewareTestProbe::snapshot_hook(mw, [&](std::size_t rows) {
        ++query_calls;
        snapshot_rows = rows;
        gate.block();
    });
    RateLimitMiddlewareTestProbe::refresh_due(mw);
    std::mutex completion_mutex;
    std::condition_variable completion_cv;
    int completed = 0;
    std::vector<int> statuses(8);
    std::vector<std::exception_ptr> errors(8);
    std::vector<std::thread> workers;
    WorkerCleanup cleanup{gate, workers};
    for (int n = 0; n < 8; ++n) {
        workers.emplace_back([&, n] {
            try { statuses[n] = request(mw, "198.18.11." + std::to_string(n + 1)).code; }
            catch (...) { errors[n] = std::current_exception(); }
            std::lock_guard<std::mutex> lock(completion_mutex);
            ++completed;
            completion_cv.notify_all();
        });
    }
    REQUIRE(gate.wait_entered());
    {
        std::unique_lock<std::mutex> lock(completion_mutex);
        REQUIRE(completion_cv.wait_for(lock, std::chrono::seconds(5), [&] { return completed == 7; }));
    }
    REQUIRE(RateLimitMiddlewareTestProbe::mutex_available(mw));
    CHECK(query_calls.load() == 1);
    CHECK(snapshot_rows.load() == 3);
    CHECK(RateLimitMiddlewareTestProbe::cache_size(mw) == 2);
    CHECK(db.pool.get_available_count() == 1);
    gate.release();
    cleanup.join();
    for (const auto& error : errors) if (error) std::rethrow_exception(error);
    for (int status : statuses) CHECK(status == 429);
    CHECK(RateLimitMiddlewareTestProbe::overflow(mw));
    CHECK(request(mw, "198.18.11.9").code == 429);
    CHECK(query_calls.load() == 1);
}

TEST_CASE("B.98 a complete paused snapshot cannot race a new ban transition", "[b98][rate_limiter][database][concurrency][security]") {
    BanDatabase db;
    db.seed(3);
    RateLimitMiddleware mw;
    RateLimitMiddlewareTestProbe::budget(mw, 2);
    mw.init(db.pool);
    db.erase("198.18.0.3");
    const std::string new_ip = "198.18.12.1";
    RateLimitMiddlewareTestProbe::prime_auth(mw, new_ip);
    Gate gate;
    std::atomic<int> query_calls{0};
    std::atomic<std::size_t> snapshot_rows{0};
    RateLimitMiddlewareTestProbe::snapshot_hook(mw, [&](std::size_t rows) {
        ++query_calls;
        snapshot_rows = rows;
        gate.block();
    });
    int persist_calls = 0;
    RateLimitMiddlewareTestProbe::persistence_hook(mw, [&] { ++persist_calls; });
    RateLimitMiddlewareTestProbe::refresh_due(mw);
    std::vector<std::thread> workers;
    WorkerCleanup cleanup{gate, workers};
    std::exception_ptr error;
    int status = 0;
    workers.emplace_back([&] {
        try { status = request(mw, "198.18.12.2").code; }
        catch (...) { error = std::current_exception(); }
    });
    REQUIRE(gate.wait_entered());
    REQUIRE(RateLimitMiddlewareTestProbe::mutex_available(mw));
    CHECK(snapshot_rows.load() == 2);
    CHECK(request(mw, new_ip, "/login").code == 429);
    CHECK(RateLimitMiddlewareTestProbe::auth_count(mw, new_ip) == 14);
    CHECK(persist_calls == 0);
    CHECK(RateLimitMiddlewareTestProbe::overflow(mw));
    gate.release();
    cleanup.join();
    if (error) std::rethrow_exception(error);
    CHECK(status == 200);
    CHECK_FALSE(RateLimitMiddlewareTestProbe::overflow(mw));
    CHECK(request(mw, new_ip, "/login").code == 403);
    CHECK(persist_calls == 1);
    CHECK(db.count(new_ip) == 1);
    CHECK(RateLimitMiddlewareTestProbe::overflow(mw));
    CHECK(RateLimitMiddlewareTestProbe::cache_size(mw) == 2);
    CHECK(query_calls.load() == 1);
}

TEST_CASE("B.98 no-pool overflow recovers only after all uncached risk expires", "[b98][rate_limiter][no-pool][regression]") {
    RateLimitMiddleware mw;
    RateLimitMiddlewareTestProbe::budget(mw, 1);
    ban(mw, "198.18.13.1");
    ban(mw, "198.18.13.2");
    RateLimitMiddlewareTestProbe::refresh_due(mw);
    CHECK(request(mw, "198.18.13.3").code == 429);
    CHECK(RateLimitMiddlewareTestProbe::overflow(mw));
    CHECK(request(mw, "198.18.13.1").code == 403);
    RateLimitMiddlewareTestProbe::seed(mw, "198.18.13.1", std::chrono::system_clock::now() - std::chrono::hours(1));
    RateLimitMiddlewareTestProbe::expire_uncertainty(mw);
    RateLimitMiddlewareTestProbe::sweep_due(mw);
    RateLimitMiddlewareTestProbe::refresh_due(mw);
    const auto response = request(mw, "198.18.13.3");
    CHECK(RateLimitMiddlewareTestProbe::cache_size(mw) == 0);
    CHECK(response.code == 200);
    CHECK_FALSE(RateLimitMiddlewareTestProbe::overflow(mw));
}
