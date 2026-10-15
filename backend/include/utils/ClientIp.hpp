#pragma once

#include "crow_all.h"

#include <string>

namespace ClientIp {

#ifdef NANIKA_AP06_LOCAL_TEST_SERVER
inline bool is_actual_loopback_peer(const crow::request& req) {
    asio::error_code error;
    const auto address = asio::ip::make_address(req.remote_ip_address, error);
    if (error) return false;
    return address.is_v4() ? address.to_v4() == asio::ip::address_v4::loopback()
                           : address.to_v6() == asio::ip::address_v6::loopback();
}
#endif

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
