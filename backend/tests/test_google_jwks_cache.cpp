#include <catch2/catch_test_macros.hpp>

#include "Services/GoogleJwksCache.hpp"

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <future>
#include <initializer_list>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

struct GoogleJwksCacheTestProbe {
    static void install_fetch_hook(GoogleJwksCache& cache, std::function<cpr::Response()> hook) {
        cache.test_fetch_hook_ = std::move(hook);
    }

    static bool wait_for_followers(GoogleJwksCache& cache, std::size_t expected) {
        std::unique_lock<std::mutex> lock(cache.test_observer_mutex_);
        return cache.test_observer_cv_.wait_for(lock, std::chrono::seconds(5), [&] {
            return cache.test_followers_ >= expected;
        });
    }

    static void expire_refresh_window(GoogleJwksCache& cache) {
        std::lock_guard<std::mutex> lock(cache.refresh_mutex_);
        cache.next_refresh_allowed_at_ = std::chrono::steady_clock::now() - std::chrono::seconds(1);
    }
};

namespace {
    cpr::Response jwks_response(int status, const std::string& body) {
        cpr::Response response;
        response.status_code = status;
        response.text = body;
        return response;
    }

    std::string jwks_body(std::initializer_list<std::string> kids) {
        constexpr auto modulus =
            "0wkeEBFP1LxFmYb7dCmNFymhITQanUWiYvICg0iQJybsjV5QQl4aRKbAcUWl_XUyULp_-MWx8fwQnA4lw1mbGQ";
        std::string body = R"({"keys":[)";
        bool first = true;
        for (const auto& kid : kids) {
            if (!first) body += ',';
            first = false;
            body += R"({"kid":")" + kid + R"(","n":")" + modulus + R"(","e":"AQAB"})";
        }
        return body + "]}";
    }

    struct LookupResult {
        bool success = false;
        std::string pem;
        std::string error;
    };

    LookupResult lookup(GoogleJwksCache& cache, const std::string& kid) {
        try {
            LookupResult result;
            result.success = true;
            result.pem = cache.get_pem_for_kid(kid);
            return result;
        } catch (const std::exception& error) {
            return LookupResult{false, {}, error.what()};
        }
    }

    class FetchGate {
    public:
        explicit FetchGate(cpr::Response response, bool block_first = false)
            : response_(std::move(response)), block_first_(block_first) {}

        cpr::Response fetch() {
            const int call = ++fetch_count;
            std::unique_lock<std::mutex> lock(mutex);
            if (call == 1) {
                first_entered = true;
                cv.notify_all();
                cv.wait(lock, [&] { return !block_first_ || released; });
            }
            return response_;
        }

        bool wait_for_first() {
            std::unique_lock<std::mutex> lock(mutex);
            return cv.wait_for(lock, std::chrono::seconds(5), [&] {
                return first_entered;
            });
        }

        void release() {
            {
                std::lock_guard<std::mutex> lock(mutex);
                released = true;
            }
            cv.notify_all();
        }

        std::atomic<int> fetch_count{0};

    private:
        cpr::Response response_;
        bool block_first_ = false;
        std::mutex mutex;
        std::condition_variable cv;
        bool first_entered = false;
        bool released = false;
    };

    std::vector<LookupResult> run_cohort(
        GoogleJwksCache& cache,
        const std::vector<std::string>& kids,
        FetchGate& gate) {
        GoogleJwksCacheTestProbe::install_fetch_hook(cache, [&gate] { return gate.fetch(); });

        std::vector<LookupResult> results(kids.size());
        std::vector<std::thread> threads;
        threads.reserve(kids.size());
        threads.emplace_back([&] { results[0] = lookup(cache, kids[0]); });

        bool cohort_ready = gate.wait_for_first();
        for (std::size_t i = 1; i < kids.size(); ++i) {
            threads.emplace_back([&, i] { results[i] = lookup(cache, kids[i]); });
            cohort_ready = GoogleJwksCacheTestProbe::wait_for_followers(cache, i) && cohort_ready;
        }

        gate.release();
        for (auto& thread : threads) {
            thread.join();
        }
        REQUIRE(cohort_ready);
        return results;
    }
}

TEST_CASE("B.66 same unknown kid cohort performs one JWKS refresh", "[b66][jwks]") {
    GoogleJwksCache cache;
    FetchGate gate(jwks_response(503, {}), true);
    const auto results = run_cohort(
        cache,
        {"B66-UNKNOWN-SAME", "B66-UNKNOWN-SAME", "B66-UNKNOWN-SAME", "B66-UNKNOWN-SAME"},
        gate
    );

    CHECK(gate.fetch_count.load() == 1);
    for (const auto& result : results) {
        CHECK_FALSE(result.success);
        CHECK(result.error == "GOOGLE_API_UNAVAILABLE");
    }
}

TEST_CASE("B.66 different unknown kids share one refresh", "[b66][jwks]") {
    GoogleJwksCache cache;
    FetchGate gate(jwks_response(200, jwks_body({"KNOWN-KID"})), true);
    const auto results = run_cohort(
        cache,
        {"UNKNOWN-A", "UNKNOWN-B", "UNKNOWN-C", "UNKNOWN-D"},
        gate
    );

    CHECK(gate.fetch_count.load() == 1);
    for (const auto& result : results) {
        CHECK_FALSE(result.success);
        CHECK(result.error == "JWKS_KID_NOT_FOUND");
    }
}

TEST_CASE("B.66 successful snapshot serves mixed valid and invalid cohort", "[b66][jwks]") {
    GoogleJwksCache cache;
    FetchGate gate(jwks_response(200, jwks_body({"NEW-VALID-KID"})), true);
    const auto results = run_cohort(
        cache,
        {"NEW-VALID-KID", "UNKNOWN-X", "UNKNOWN-Y"},
        gate
    );

    REQUIRE(gate.fetch_count.load() == 1);
    CHECK(results[0].success);
    CHECK_FALSE(results[0].pem.empty());
    CHECK_FALSE(results[1].success);
    CHECK(results[1].error == "JWKS_KID_NOT_FOUND");
    CHECK_FALSE(results[2].success);
    CHECK(results[2].error == "JWKS_KID_NOT_FOUND");
}

TEST_CASE("B.66 malformed response is shared by the refresh cohort", "[b66][jwks]") {
    GoogleJwksCache cache;
    FetchGate gate(jwks_response(200, "not-json"), true);
    const auto results = run_cohort(
        cache,
        {"MALFORMED-A", "MALFORMED-B", "MALFORMED-C", "MALFORMED-D"},
        gate
    );

    CHECK(gate.fetch_count.load() == 1);
    for (const auto& result : results) {
        CHECK_FALSE(result.success);
        CHECK(result.error == "INVALID_JWKS_RESPONSE");
    }
}

TEST_CASE("B.66 success cooldown bounds sequential unknown kids", "[b66][jwks]") {
    GoogleJwksCache cache;
    FetchGate gate(jwks_response(200, jwks_body({"KNOWN-KID"})));
    GoogleJwksCacheTestProbe::install_fetch_hook(cache, [&gate] { return gate.fetch(); });

    CHECK(lookup(cache, "UNKNOWN-1").error == "JWKS_KID_NOT_FOUND");
    CHECK(lookup(cache, "UNKNOWN-2").error == "JWKS_KID_NOT_FOUND");
    CHECK(lookup(cache, "UNKNOWN-3").error == "JWKS_KID_NOT_FOUND");
    CHECK(gate.fetch_count.load() == 1);
}

TEST_CASE("B.66 success cooldown expiry permits refresh and key rotation", "[b66][jwks]") {
    GoogleJwksCache cache;
    FetchGate first(jwks_response(200, jwks_body({"OLD-KID"})));
    FetchGate second(jwks_response(200, jwks_body({"OLD-KID", "NEW-KID"})));
    std::atomic<int> fetch_count{0};
    GoogleJwksCacheTestProbe::install_fetch_hook(cache, [&] {
        if (++fetch_count == 1) return first.fetch();
        return second.fetch();
    });

    CHECK(lookup(cache, "NEW-KID").error == "JWKS_KID_NOT_FOUND");
    CHECK(fetch_count.load() == 1);
    GoogleJwksCacheTestProbe::expire_refresh_window(cache);
    const auto rotated = lookup(cache, "NEW-KID");
    CHECK(rotated.success);
    CHECK_FALSE(rotated.pem.empty());
    CHECK(fetch_count.load() == 2);
    CHECK(lookup(cache, "OLD-KID").success);
}

TEST_CASE("B.66 failure backoff shares provider failure and recovers", "[b66][jwks]") {
    GoogleJwksCache cache;
    FetchGate failed(jwks_response(503, {}));
    FetchGate recovered(jwks_response(200, jwks_body({"RECOVERED-KID"})));
    std::atomic<int> fetch_count{0};
    GoogleJwksCacheTestProbe::install_fetch_hook(cache, [&] {
        if (++fetch_count == 1) return failed.fetch();
        return recovered.fetch();
    });

    CHECK(lookup(cache, "FAILURE-A").error == "GOOGLE_API_UNAVAILABLE");
    CHECK(lookup(cache, "FAILURE-B").error == "GOOGLE_API_UNAVAILABLE");
    CHECK(lookup(cache, "FAILURE-C").error == "GOOGLE_API_UNAVAILABLE");
    CHECK(fetch_count.load() == 1);
    GoogleJwksCacheTestProbe::expire_refresh_window(cache);
    const auto result = lookup(cache, "RECOVERED-KID");
    CHECK(result.success);
    CHECK(fetch_count.load() == 2);
}

TEST_CASE("B.66 cached key remains available during blocked refresh", "[b66][jwks]") {
    GoogleJwksCache cache;
    FetchGate prime(jwks_response(200, jwks_body({"KNOWN-KID"})));
    GoogleJwksCacheTestProbe::install_fetch_hook(cache, [&prime] { return prime.fetch(); });
    const auto known_pem = lookup(cache, "KNOWN-KID");
    REQUIRE(known_pem.success);
    GoogleJwksCacheTestProbe::expire_refresh_window(cache);

    FetchGate blocked(jwks_response(503, {}), true);
    GoogleJwksCacheTestProbe::install_fetch_hook(cache, [&blocked] { return blocked.fetch(); });
    std::thread refresh([&] { static_cast<void>(lookup(cache, "UNKNOWN-BLOCKED")); });
    const bool provider_blocked = blocked.wait_for_first();

    auto known_future = std::async(std::launch::async, [&] {
        return lookup(cache, "KNOWN-KID");
    });
    const bool known_lookup_ready =
        known_future.wait_for(std::chrono::seconds(2)) == std::future_status::ready;

    blocked.release();
    refresh.join();
    REQUIRE(provider_blocked);
    REQUIRE(known_lookup_ready);
    const auto during_refresh = known_future.get();
    CHECK(during_refresh.success);
    CHECK(during_refresh.pem == known_pem.pem);
    CHECK(blocked.fetch_count.load() == 1);
}

TEST_CASE("B.66 cached snapshot survives a later provider failure", "[b66][jwks]") {
    GoogleJwksCache cache;
    FetchGate prime(jwks_response(200, jwks_body({"KNOWN-KID"})));
    GoogleJwksCacheTestProbe::install_fetch_hook(cache, [&prime] { return prime.fetch(); });
    const auto known_pem = lookup(cache, "KNOWN-KID");
    REQUIRE(known_pem.success);
    GoogleJwksCacheTestProbe::expire_refresh_window(cache);

    FetchGate failed(jwks_response(503, {}));
    GoogleJwksCacheTestProbe::install_fetch_hook(cache, [&failed] { return failed.fetch(); });
    CHECK(lookup(cache, "UNKNOWN-AFTER-ROTATION").error == "GOOGLE_API_UNAVAILABLE");
    CHECK(failed.fetch_count.load() == 1);
    const auto still_known = lookup(cache, "KNOWN-KID");
    CHECK(still_known.success);
    CHECK(still_known.pem == known_pem.pem);
}

TEST_CASE("B.66 invalid response backoff preserves the failure class", "[b66][jwks]") {
    GoogleJwksCache cache;
    FetchGate gate(jwks_response(200, "{}"));
    GoogleJwksCacheTestProbe::install_fetch_hook(cache, [&gate] { return gate.fetch(); });

    CHECK(lookup(cache, "INVALID-A").error == "INVALID_JWKS_RESPONSE");
    CHECK(lookup(cache, "INVALID-B").error == "INVALID_JWKS_RESPONSE");
    CHECK(gate.fetch_count.load() == 1);
}
