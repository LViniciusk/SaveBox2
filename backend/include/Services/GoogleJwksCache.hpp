#pragma once

#include <string>
#include <unordered_map>
#include <shared_mutex>
#include <condition_variable>
#include <chrono>
#include <cstdint>
#include <exception>
#include <mutex>

#ifdef NANIKA_TESTING
#include <cpr/cpr.h>
#include <cstddef>
#include <functional>
#endif

class GoogleJwksCache {
public:
    GoogleJwksCache() = default;

    std::string get_pem_for_kid(const std::string& kid);

private:
#ifdef NANIKA_TESTING
    friend struct GoogleJwksCacheTestProbe;
#endif
    std::shared_mutex mutex_;
    std::mutex refresh_mutex_;
    std::condition_variable cv_;
    bool is_fetching_ = false;
    std::uint64_t refresh_generation_ = 0;
    std::unordered_map<std::string, std::string> key_cache_;
    std::chrono::steady_clock::time_point next_refresh_allowed_at_{};
    std::exception_ptr last_refresh_error_;
    std::uint64_t last_refresh_error_generation_ = 0;

#ifdef NANIKA_TESTING
    std::function<cpr::Response()> test_fetch_hook_;
    std::mutex test_observer_mutex_;
    std::condition_variable test_observer_cv_;
    std::size_t test_followers_ = 0;
#endif

    void refresh_keys(const std::string& missing_kid);
};
