#pragma once

#include "crow_all.h"
#include <cstdlib>
#include <string>
#include <string_view>

struct CustomCorsMiddleware {
    struct context {};
    void before_handle(crow::request& /*req*/, crow::response& /*res*/, context& /*ctx*/) {}

    void after_handle(crow::request& req, crow::response& res, context& /*ctx*/) {
        std::string origin = req.get_header_value("Origin");
        if (!origin.empty() && is_allowed_origin(origin)) {
            res.set_header("Access-Control-Allow-Origin", origin);
        }
        res.set_header("Access-Control-Allow-Credentials", "true");
        
        std::string req_headers = req.get_header_value("Access-Control-Request-Headers");
        if (!req_headers.empty()) {
            res.set_header("Access-Control-Allow-Headers", req_headers);
        } else {
            res.set_header("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept, Origin, X-Requested-With, X-Encrypted-Name, Range, X-Chunk-Index");
        }
        
        res.set_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, DELETE");
    }

private:
    static bool is_allowed_origin(std::string_view origin) {
        const char* configured = std::getenv("CORS_ALLOWED_ORIGINS");
        const std::string_view fallback = "http://localhost:4200";
        std::string_view allowed = configured && *configured ? configured : fallback;

        size_t start = 0;
        while (start <= allowed.size()) {
            size_t end = allowed.find(',', start);
            std::string_view candidate = allowed.substr(start, end == std::string_view::npos ? std::string_view::npos : end - start);
            while (!candidate.empty() && candidate.front() == ' ') candidate.remove_prefix(1);
            while (!candidate.empty() && candidate.back() == ' ') candidate.remove_suffix(1);
            if (candidate == origin) return true;
            if (end == std::string_view::npos) break;
            start = end + 1;
        }
        return false;
    }
};
