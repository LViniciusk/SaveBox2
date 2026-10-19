#pragma once

#include <string>
#include <unordered_map>
#include <shared_mutex>
#include <condition_variable>

class GoogleJwksCache {
public:
    GoogleJwksCache() = default;

    std::string get_pem_for_kid(const std::string& kid);

private:
    std::shared_mutex mutex_;
    std::condition_variable_any cv_;
    bool is_fetching_ = false;
    std::unordered_map<std::string, std::string> key_cache_;

    void refresh_keys(const std::string& missing_kid);
};
