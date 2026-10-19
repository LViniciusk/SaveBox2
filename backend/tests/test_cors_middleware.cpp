#include <catch2/catch_test_macros.hpp>
#include "middlewares/CustomCorsMiddleware.hpp"

TEST_CASE("CORS responde preflight antes das rotas", "[cors]") {
    CustomCorsMiddleware middleware("http://localhost:4200,https://nanika.example");
    CustomCorsMiddleware::context context;

    SECTION("origem permitida recebe 204 e headers de preflight") {
        crow::request request;
        request.method = crow::HTTPMethod::Options;
        request.url = "/api/auth/google";
        request.add_header("Origin", "http://localhost:4200");
        request.add_header("Access-Control-Request-Method", "POST");
        request.add_header("Access-Control-Request-Headers", "content-type,authorization");
        crow::response response;

        middleware.before_handle(request, response, context);

        REQUIRE(response.code == 204);
        REQUIRE(response.get_header_value("Access-Control-Allow-Origin") == "http://localhost:4200");
        REQUIRE(response.get_header_value("Access-Control-Allow-Methods").find("OPTIONS") != std::string::npos);
        REQUIRE(response.get_header_value("Access-Control-Allow-Headers").find("Authorization") != std::string::npos);
        REQUIRE(response.get_header_value("Access-Control-Allow-Headers").find("X-Encrypted-Name") == std::string::npos);
        REQUIRE(response.get_header_value("Vary").find("Origin") != std::string::npos);
    }

    SECTION("origem não permitida recebe 403") {
        crow::request request;
        request.method = crow::HTTPMethod::Options;
        request.url = "/api/auth/google";
        request.add_header("Origin", "https://evil.example");
        crow::response response;

        middleware.before_handle(request, response, context);

        REQUIRE(response.code == 403);
        REQUIRE(response.get_header_value("Access-Control-Allow-Origin").empty());
    }

    SECTION("método ou header fora da allowlist recebem 403") {
        crow::request request;
        request.method = crow::HTTPMethod::Options;
        request.url = "/storage-moves/1/complete";
        request.add_header("Origin", "http://localhost:4200");
        request.add_header("Access-Control-Request-Method", "PATCH");
        request.add_header("Access-Control-Request-Headers", "x-client-secret");
        crow::response response;

        middleware.before_handle(request, response, context);

        REQUIRE(response.code == 403);
        REQUIRE(response.get_header_value("Access-Control-Allow-Origin") == "http://localhost:4200");
    }

    SECTION("header de nome criptografado nao pertence a allowlist") {
        crow::request request;
        request.method = crow::HTTPMethod::Options;
        request.url = "/share/public";
        request.add_header("Origin", "http://localhost:4200");
        request.add_header("Access-Control-Request-Method", "GET");
        request.add_header("Access-Control-Request-Headers", "x-encrypted-name");
        crow::response response;

        middleware.before_handle(request, response, context);

        REQUIRE(response.code == 403);
        REQUIRE(response.get_header_value("Access-Control-Allow-Headers").find("X-Encrypted-Name") == std::string::npos);
    }

    SECTION("segunda origem explicitamente permitida recebe ACAO exato") {
        crow::request request;
        request.method = crow::HTTPMethod::Get;
        request.add_header("Origin", "https://nanika.example");
        crow::response response;

        middleware.after_handle(request, response, context);

        REQUIRE(response.get_header_value("Access-Control-Allow-Origin") == "https://nanika.example");
    }

    SECTION("origem IPv4 dinamica e permitida por correspondencia exata") {
        CustomCorsMiddleware dynamic_middleware("http://127.0.0.1:49123");
        crow::request request;
        request.method = crow::HTTPMethod::Get;
        request.add_header("Origin", "http://127.0.0.1:49123");
        crow::response response;

        dynamic_middleware.after_handle(request, response, context);

        REQUIRE(response.get_header_value("Access-Control-Allow-Origin") == "http://127.0.0.1:49123");
    }

    SECTION("host diferente na mesma porta nao e permitido") {
        CustomCorsMiddleware exact_middleware("http://localhost:49123");
        crow::request request;
        request.method = crow::HTTPMethod::Get;
        request.add_header("Origin", "http://127.0.0.1:49123");
        crow::response response;

        exact_middleware.after_handle(request, response, context);

        REQUIRE(response.get_header_value("Access-Control-Allow-Origin").empty());
    }

    SECTION("porta diferente nao e permitida") {
        CustomCorsMiddleware exact_middleware("http://127.0.0.1:49123");
        crow::request request;
        request.method = crow::HTTPMethod::Get;
        request.add_header("Origin", "http://127.0.0.1:49124");
        crow::response response;

        exact_middleware.after_handle(request, response, context);

        REQUIRE(response.get_header_value("Access-Control-Allow-Origin").empty());
    }

    SECTION("host lookalike nao e permitido") {
        CustomCorsMiddleware exact_middleware("http://127.0.0.1:49123");
        crow::request request;
        request.method = crow::HTTPMethod::Get;
        request.add_header("Origin", "http://127.0.0.1.evil.example:49123");
        crow::response response;

        exact_middleware.after_handle(request, response, context);

        REQUIRE(response.get_header_value("Access-Control-Allow-Origin").empty());
    }

    SECTION("candidatos da allowlist aceitam espacos externos") {
        CustomCorsMiddleware whitespace_middleware("http://localhost:4200,  https://nanika.example  ");
        crow::request request;
        request.method = crow::HTTPMethod::Get;
        request.add_header("Origin", "https://nanika.example");
        crow::response response;

        whitespace_middleware.after_handle(request, response, context);

        REQUIRE(response.get_header_value("Access-Control-Allow-Origin") == "https://nanika.example");
    }

    SECTION("origin ausente nao recebe ACAO") {
        crow::request request;
        request.method = crow::HTTPMethod::Get;
        crow::response response;

        middleware.after_handle(request, response, context);

        REQUIRE(response.get_header_value("Access-Control-Allow-Origin").empty());
    }
}
