#pragma once

#include "crow_all.h"
#include <cstddef>

namespace HttpBodyBudget {
inline constexpr std::size_t DEFAULT_BODY_LIMIT_BYTES = 16ULL * 1024ULL * 1024ULL;
inline constexpr std::size_t FOLDER_BATCH_BODY_LIMIT_BYTES = 64ULL * 1024ULL * 1024ULL;
}

struct HttpBodyLimitMiddleware {
    struct context {};

#ifdef NANIKA_TESTING
    void set_limits_for_testing(std::size_t default_limit, std::size_t folder_batch_limit) noexcept {
        default_limit_ = default_limit;
        folder_batch_limit_ = folder_batch_limit;
    }
#endif

    void before_handle(crow::request& req, crow::response& res, context&) {
        const auto limit = req.method == crow::HTTPMethod::Post && req.url == "/folders/batch-create"
            ? folder_batch_limit_ : default_limit_;
        // Crow has already materialized the body; this guards downstream side effects.
        if (req.body.size() <= limit) return;
        res.code = 413;
        res.set_header("Content-Type", "application/json");
        res.body = R"({"error":"Payload muito grande"})";
        res.end();
    }

    void after_handle(crow::request&, crow::response&, context&) {}

private:
#ifdef NANIKA_TESTING
    std::size_t default_limit_ = HttpBodyBudget::DEFAULT_BODY_LIMIT_BYTES;
    std::size_t folder_batch_limit_ = HttpBodyBudget::FOLDER_BATCH_BODY_LIMIT_BYTES;
#else
    static constexpr auto default_limit_ = HttpBodyBudget::DEFAULT_BODY_LIMIT_BYTES;
    static constexpr auto folder_batch_limit_ = HttpBodyBudget::FOLDER_BATCH_BODY_LIMIT_BYTES;
#endif
};
