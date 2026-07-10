#pragma once

#include "crow_all.h"
#include <string>

struct CustomCorsMiddleware {
    struct context {};
    void before_handle(crow::request& /*req*/, crow::response& /*res*/, context& /*ctx*/) {}

    void after_handle(crow::request& req, crow::response& res, context& /*ctx*/) {
        std::string origin = req.get_header_value("Origin");
        if (!origin.empty() && (origin.find("localhost") != std::string::npos || origin.find("127.0.0.1") != std::string::npos)) {
            res.set_header("Access-Control-Allow-Origin", origin);
        } else {
            res.set_header("Access-Control-Allow-Origin", "http://localhost:4200");
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
};
