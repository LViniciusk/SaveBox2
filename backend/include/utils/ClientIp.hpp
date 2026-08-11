#pragma once

#include "crow_all.h"

#include <string>

namespace ClientIp {

inline std::string resolve(const crow::request& req, bool trust_forwarded) {
    const std::string fallback = req.remote_ip_address.empty() ? "unknown" : req.remote_ip_address;
    if (!trust_forwarded) return fallback;

    const std::string forwarded = req.get_header_value("X-Real-IP");
    if (forwarded.empty() || forwarded.size() > 45) return fallback;

    asio::error_code error;
    const auto address = asio::ip::make_address(forwarded, error);
    return error ? fallback : address.to_string();
}

}
