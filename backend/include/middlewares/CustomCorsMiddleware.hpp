#pragma once

#include "crow_all.h"
#include "utils.hpp"
#include <algorithm>
#include <cctype>
#include <string>
#include <string_view>
#include <iterator>
#include <utility>
#include <vector>

struct CustomCorsMiddleware {
    struct context {};

    CustomCorsMiddleware()
        : allowed_origins_(configured_allowed_origins()) {}

    explicit CustomCorsMiddleware(std::string allowed_origins)
        : allowed_origins_(std::move(allowed_origins)) {}

    static bool origin_allowed(std::string_view origin) {
        return origin_in_allowlist(origin, configured_allowed_origins());
    }

    void before_handle(crow::request& req, crow::response& res, context& /*ctx*/) {
        apply_headers(req, res);
        if (req.method == crow::HTTPMethod::Options) {
            const std::string origin = req.get_header_value("Origin");
            const std::string requested_method = req.get_header_value("Access-Control-Request-Method");
            if (origin.empty() || !origin_in_allowlist(origin, allowed_origins_) || !is_allowed_method(requested_method) ||
                !requested_headers_are_allowed(req.get_header_value("Access-Control-Request-Headers"))) {
                res.code = 403;
                res.body.clear();
                res.end();
                return;
            }
            res.code = 204;
            res.end();
        }
    }

    void after_handle(crow::request& req, crow::response& res, context& /*ctx*/) {
        apply_headers(req, res);
    }

private:
    std::string allowed_origins_;

    static std::string configured_allowed_origins() {
        return Utils::get().get_var("CORS_ALLOWED_ORIGINS", "http://localhost:4200");
    }

    void apply_headers(crow::request& req, crow::response& res) const {
        std::string origin = req.get_header_value("Origin");
        if (!origin.empty() && origin_in_allowlist(origin, allowed_origins_)) {
            res.set_header("Access-Control-Allow-Origin", origin);
        }
        res.set_header("Access-Control-Allow-Credentials", "true");
        
        res.set_header("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept, Origin, X-Requested-With, Range, X-Chunk-Index");
        res.set_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, DELETE");
        res.set_header("Access-Control-Max-Age", "600");
        res.set_header("Vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers");
    }

    static std::string lower_trim(std::string_view value) {
        size_t start = 0;
        while (start < value.size() && value[start] == ' ') ++start;
        size_t end = value.size();
        while (end > start && value[end - 1] == ' ') --end;
        std::string normalized(value.substr(start, end - start));
        std::transform(normalized.begin(), normalized.end(), normalized.begin(),
                       [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
        return normalized;
    }

    static bool is_allowed_method(std::string_view method) {
        const std::string normalized = lower_trim(method);
        return normalized == "get" || normalized == "post" || normalized == "options" ||
               normalized == "put" || normalized == "delete";
    }

    static bool requested_headers_are_allowed(std::string_view headers) {
        static constexpr std::string_view allowed[] = {
            "authorization", "content-type", "accept", "origin", "range",
            "x-requested-with", "x-chunk-index"
        };
        size_t start = 0;
        while (start <= headers.size()) {
            const size_t end = headers.find(',', start);
            const std::string header = lower_trim(headers.substr(start, end == std::string_view::npos
                ? std::string_view::npos : end - start));
            if (!header.empty() && std::none_of(std::begin(allowed), std::end(allowed),
                [&](std::string_view candidate) { return candidate == header; })) return false;
            if (end == std::string_view::npos) break;
            start = end + 1;
        }
        return true;
    }

    static bool origin_in_allowlist(std::string_view origin, std::string_view allowed) {
        std::size_t start = 0;
        while (start <= allowed.size()) {
            const std::size_t end = allowed.find(',', start);
            std::string_view candidate = allowed.substr(
                start,
                end == std::string_view::npos ? std::string_view::npos : end - start);
            while (!candidate.empty() && candidate.front() == ' ') candidate.remove_prefix(1);
            while (!candidate.empty() && candidate.back() == ' ') candidate.remove_suffix(1);
            if (candidate == origin) return true;
            if (end == std::string_view::npos) break;
            start = end + 1;
        }
        return false;
    }
};
