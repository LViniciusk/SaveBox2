#include <catch2/catch_test_macros.hpp>
#include "controllers/ApiRouter.hpp"
#include <filesystem>
#include <fstream>

namespace {
crow::response docs_request(NanikaCrowApp& app, const std::string& url) {
    crow::request request;
    request.url = url;
    request.method = crow::HTTPMethod::Get;
    crow::response response;
    app.handle_full(request, response);
    return response;
}
}

TEST_CASE("Swagger serves isolated local documentation", "[security-track-a][swagger]") {
    ApiRouter router;
    NanikaCrowApp app;
    router.setup_routes(app);
    app.validate();

    for (const auto* url : {"/api/docs", "/api/docs/"}) {
        auto response = docs_request(app, url);
        REQUIRE(response.code == 200);
        REQUIRE(response.get_header_value("Content-Type") == "text/html; charset=utf-8");
        REQUIRE(response.get_header_value("Content-Security-Policy") ==
            "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
            "font-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'; "
            "frame-ancestors 'none'; form-action 'none';");
        REQUIRE(response.get_header_value("X-Content-Type-Options") == "nosniff");
        REQUIRE(response.get_header_value("Referrer-Policy") == "no-referrer");
        REQUIRE(response.get_header_value("X-Frame-Options") == "DENY");
        REQUIRE(response.get_header_value("Cache-Control") == "no-store");
        REQUIRE(response.body.find("https://") == std::string::npos);
        REQUIRE(response.body.find("<script>") == std::string::npos);
        REQUIRE(response.body.find("onload=") == std::string::npos);
        const auto relative = std::string(url).back() == '/' ? "assets/" : "docs/assets/";
        REQUIRE(response.body.find(relative + std::string("swagger-init.js")) != std::string::npos);
    }

    for (const auto& asset : {std::pair{"swagger-ui.css", "text/css; charset=utf-8"},
                              std::pair{"swagger-ui-bundle.js", "application/javascript; charset=utf-8"},
                              std::pair{"swagger-init.js", "application/javascript; charset=utf-8"}}) {
        auto response = docs_request(app, "/api/docs/assets/" + std::string(asset.first));
        REQUIRE(response.code == 200);
        REQUIRE_FALSE(response.body.empty());
        REQUIRE(response.get_header_value("Content-Type") == asset.second);
        REQUIRE(response.get_header_value("X-Content-Type-Options") == "nosniff");
    }
    auto yaml = docs_request(app, "/api/docs/swagger.yaml");
    REQUIRE(yaml.code == 200);
    REQUIRE(yaml.body.find("openapi:") != std::string::npos);
    REQUIRE(yaml.get_header_value("Content-Type") == "text/yaml; charset=utf-8");

    for (const auto* path : {"unknown.js", "../swagger.yaml", "%2e%2e/swagger.yaml", "../../.env", "LICENSE"}) {
        REQUIRE(docs_request(app, "/api/docs/assets/" + std::string(path)).code == 404);
    }
    for (const auto* path : {"/api/docsevil", "/api/docs//", "/api/docs/unknown"}) {
        REQUIRE(docs_request(app, path).code == 404);
    }
    auto health = docs_request(app, "/health");
    REQUIRE(health.code == 200);
    REQUIRE(health.get_header_value("Content-Security-Policy").empty());
    REQUIRE(health.get_header_value("Content-Type") == "application/json");
}

TEST_CASE("Swagger missing assets fail closed", "[security-track-a][swagger]") {
    const auto previous = std::filesystem::current_path();
    const auto isolated = std::filesystem::temp_directory_path() / "nanika-swagger-missing-assets";
    REQUIRE(std::filesystem::create_directory(isolated));
    struct Restore {
        std::filesystem::path previous, isolated;
        ~Restore() { std::filesystem::current_path(previous); std::filesystem::remove(isolated); }
    } restore{previous, isolated};
    std::filesystem::current_path(isolated);
    ApiRouter router;
    NanikaCrowApp app;
    router.setup_routes(app);
    app.validate();
    for (const auto* path : {"swagger.yaml", "assets/swagger-ui.css", "assets/swagger-ui-bundle.js", "assets/swagger-init.js"}) {
        auto response = docs_request(app, "/api/docs/" + std::string(path));
        REQUIRE(response.code == 503);
        REQUIRE(response.get_header_value("X-Content-Type-Options") == "nosniff");
        REQUIRE(response.get_header_value("Cache-Control") == "no-store");
    }
}
