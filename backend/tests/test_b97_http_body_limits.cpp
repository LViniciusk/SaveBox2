#include <catch2/catch_test_macros.hpp>
#include "controllers/ApiRouter.hpp"
#include "database/FolderManager.hpp"
#include "storage/FileChunker.hpp"
#include "test_helpers.hpp"
#include "utils/RandomIds.hpp"
#include <iostream>
#include <sstream>
#include <tuple>

namespace {
// Exercise Connection's global middleware/completion branch, which handle_full skips.
template<class App>
crow::response dispatch(App& app, typename App::mw_container_t& middlewares, crow::request& request) {
    typename App::context_t context;
    crow::response response;
    auto found = app.handle_initial(request, response);
    request.middleware_context = &context;
    request.middleware_container = &middlewares;
    const bool ended = crow::detail::middleware_call_helper<
        crow::detail::middleware_call_criteria_only_global, 0,
        typename App::context_t, typename App::mw_container_t>({}, middlewares, request, response, context);
    if (!response.is_completed()) app.handle(request, response, found);
    if (!ended) {
        crow::detail::after_handlers_call_helper<
            crow::detail::middleware_call_criteria_only_global,
            std::tuple_size<typename App::mw_container_t>::value - 1,
            typename App::context_t, typename App::mw_container_t>({}, middlewares, context, request, response);
    }
    request.middleware_context = nullptr;
    request.middleware_container = nullptr;
    return response;
}

struct DownstreamCounter {
    struct context {};
    int before_calls = 0;
    int after_calls = 0;
    void before_handle(crow::request&, crow::response&, context&) { ++before_calls; }
    void after_handle(crow::request&, crow::response&, context&) { ++after_calls; }
};
using CountingApp = crow::App<CustomCorsMiddleware, HttpBodyLimitMiddleware, DownstreamCounter>;
static_assert(std::is_same_v<NanikaCrowApp::mw_container_t,
    std::tuple<CustomCorsMiddleware, HttpBodyLimitMiddleware, RateLimitMiddleware>>);

struct StreamCapture {
    std::ostringstream output;
    std::streambuf* cout_previous = std::cout.rdbuf(output.rdbuf());
    std::streambuf* cerr_previous = std::cerr.rdbuf(output.rdbuf());
    ~StreamCapture() {
        std::cout.rdbuf(cout_previous);
        std::cerr.rdbuf(cerr_previous);
    }
};

struct ParserSink {
    int completed = 0;
    void handle_url() {}
    void handle_header() {}
    void handle() { ++completed; }
};

struct ProfileScenario {
    DatabasePool pool{1, get_secure_conn_string()};
    MockEmailService email;
    AuthService auth{"b97-synthetic-secret", "b97-synthetic-pepper", &email};
    FolderManager folders{pool};
    ApiRouter router{pool, auth, folders};
    uint64_t user_id = 0;
    std::string token;

    ProfileScenario() {
        const std::string username = "b97_" + UuidUtils::generate_uuid_v4();
        {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            user_id = txn.exec("INSERT INTO users (username,email,password_hash,is_email_verified,avatar_url) "
                "VALUES ($1,$2,'b97-synthetic-hash',TRUE,'https://old.example.invalid/avatar') RETURNING id",
                pqxx::params{username, username + "@test.invalid"})[0][0].as<uint64_t>();
            txn.commit();
        }
        token = auth.generate_token(user_id);
    }

    ~ProfileScenario() {
        ApiRouter::clear_profile_image_upload_test_hook();
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE id=$1", pqxx::params{user_id});
        txn.commit();
    }
};
}

TEST_CASE("B.97 route budgets enforce real body length before downstream dispatch", "[b97][http][body-limit][security]") {
    CountingApp app;
    CountingApp::mw_container_t middlewares;
    std::get<CustomCorsMiddleware>(middlewares) = CustomCorsMiddleware("http://localhost:4200");
    std::get<HttpBodyLimitMiddleware>(middlewares).set_limits_for_testing(128, 256);
    int handler_calls = 0;
    auto handler = [&] {
        ++handler_calls;
        return crow::response(200);
    };
    CROW_ROUTE(app, "/ordinary").methods(crow::HTTPMethod::Post, crow::HTTPMethod::Get)(handler);
    CROW_ROUTE(app, "/folders/batch-create").methods(crow::HTTPMethod::Post, crow::HTTPMethod::Put)(handler);
    app.validate();
    crow::request request;
    request.method = crow::HTTPMethod::Post;
    request.url = "/ordinary";
    request.add_header("Origin", "http://localhost:4200");
    int expected = 200;
    SECTION("empty body") {}
    SECTION("small body") { request.body = "{}"; }
    SECTION("default exact boundary") { request.body.resize(128, 'x'); }
    SECTION("default plus one without Content-Length") { request.body.resize(129, 'x'); expected = 413; }
    SECTION("lying Content-Length") { request.body.resize(129, 'x'); request.add_header("Content-Length", "1"); expected = 413; }
    SECTION("malformed Content-Length is irrelevant") { request.body.resize(129, 'x'); request.add_header("Content-Length", "not-a-number"); expected = 413; }
    SECTION("chunked header does not exempt the materialized body") { request.body.resize(129, 'x'); request.add_header("Transfer-Encoding", "chunked"); expected = 413; }
    SECTION("folder batch POST exact boundary") { request.url = "/folders/batch-create"; request.body.resize(256, 'x'); }
    SECTION("folder batch POST plus one") { request.url = "/folders/batch-create"; request.body.resize(257, 'x'); expected = 413; }
    SECTION("folder batch PUT gets default") { request.url = "/folders/batch-create"; request.method = crow::HTTPMethod::Put; request.body.resize(129, 'x'); expected = 413; }
    SECTION("unrelated POST gets default") { request.body.resize(200, 'x'); expected = 413; }
    SECTION("GET body also gets default") { request.method = crow::HTTPMethod::Get; request.body.resize(129, 'x'); expected = 413; }
    SECTION("body sentinel never enters logs or response") { request.body = "B97-SECRET-BODY-SENTINEL"; request.body.resize(129, 'x'); expected = 413; }

    crow::response response;
    std::string logs;
    {
        StreamCapture capture;
        response = dispatch(app, middlewares, request);
        logs = capture.output.str();
    }
    CHECK(response.code == expected);
    CHECK(handler_calls == (expected == 200 ? 1 : 0));
    const auto& downstream = std::get<DownstreamCounter>(middlewares);
    CHECK(downstream.before_calls == (expected == 200 ? 1 : 0));
    CHECK(downstream.after_calls == (expected == 200 ? 1 : 0));
    CHECK(response.get_header_value("Access-Control-Allow-Origin") == "http://localhost:4200");
    CHECK(response.get_header_value("Access-Control-Allow-Credentials") == "true");
    CHECK(logs.find("B97-SECRET-BODY-SENTINEL") == std::string::npos);
    CHECK(response.body.find("B97-SECRET-BODY-SENTINEL") == std::string::npos);
    if (expected == 413) {
        CHECK(response.is_completed());
        CHECK(response.get_header_value("Content-Type") == "application/json");
        CHECK(response.body == R"({"error":"Payload muito grande"})");
    }
}

TEST_CASE("B.97 M1 folder batch wire fixture remains admitted", "[b97][http][body-limit][compatibility]") {
    NanikaCrowApp app;
    NanikaCrowApp::mw_container_t middlewares;
    int handler_calls = 0;
    auto handler = [&] {
        ++handler_calls;
        return crow::response(200);
    };
    CROW_ROUTE(app, "/folders/batch-create").methods(crow::HTTPMethod::Post, crow::HTTPMethod::Put)(handler);
    CROW_ROUTE(app, "/ordinary").methods(crow::HTTPMethod::Post)(handler);
    CROW_ROUTE(app, "/files/1/chunks").methods(crow::HTTPMethod::Post)(handler);
    app.validate();
    crow::request request;
    request.method = crow::HTTPMethod::Post;
    request.url = "/folders/batch-create";
    request.body.resize(16875573, 'x');
    const auto response = dispatch(app, middlewares, request);
    CHECK(response.code == 200);
    CHECK(handler_calls == 1);

    request.url = "/ordinary";
    handler_calls = 0;
    const auto ordinary = dispatch(app, middlewares, request);
    CHECK(ordinary.code == 413);
    CHECK(handler_calls == 0);

    request.url = "/folders/batch-create";
    request.method = crow::HTTPMethod::Put;
    CHECK(dispatch(app, middlewares, request).code == 413);
    CHECK(handler_calls == 0);

    request.method = crow::HTTPMethod::Post;
    request.url = "/files/1/chunks";
    request.body.resize(FileChunker::MAX_CHUNK_SIZE);
    CHECK(dispatch(app, middlewares, request).code == 200);
    CHECK(handler_calls == 1);
}

TEST_CASE("B.97 Crow normalized URL grants the batch budget with query parameters", "[b97][http][body-limit]") {
    ParserSink sink;
    crow::HTTPParser<ParserSink> parser(&sink);
    const std::string wire = "POST /folders/batch-create?foo=bar HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n";
    REQUIRE(parser.feed(wire.data(), static_cast<int>(wire.size())));
    CHECK(sink.completed == 1);
    CHECK(parser.req.url == "/folders/batch-create");
    CHECK(parser.req.raw_url == "/folders/batch-create?foo=bar");
    HttpBodyLimitMiddleware middleware;
    middleware.set_limits_for_testing(128, 256);
    HttpBodyLimitMiddleware::context context;
    crow::response response;
    parser.req.body.resize(256, 'x');
    middleware.before_handle(parser.req, response, context);
    CHECK_FALSE(response.is_completed());
}

TEST_CASE("B.97 normal preflight still ends at CORS", "[b97][cors][http]") {
    CountingApp app;
    CountingApp::mw_container_t middlewares;
    std::get<CustomCorsMiddleware>(middlewares) = CustomCorsMiddleware("http://localhost:4200");
    int handler_calls = 0;
    CROW_ROUTE(app, "/ordinary")([&] { ++handler_calls; return crow::response(200); });
    app.validate();
    crow::request request;
    request.url = "/ordinary";
    request.method = crow::HTTPMethod::Options;
    request.add_header("Origin", "http://localhost:4200");
    request.add_header("Access-Control-Request-Method", "POST");
    auto response = dispatch(app, middlewares, request);
    CHECK(response.code == 204);
    CHECK(handler_calls == 0);
    CHECK(std::get<DownstreamCounter>(middlewares).before_calls == 0);
    CHECK(response.get_header_value("Access-Control-Allow-Origin") == "http://localhost:4200");
}

TEST_CASE("B.97 oversized real profile dispatch cannot call provider or mutate avatar", "[b97][api][profile][security]") {
    ProfileScenario scenario;
    NanikaCrowApp app;
    NanikaCrowApp::mw_container_t middlewares;
    std::get<HttpBodyLimitMiddleware>(middlewares).set_limits_for_testing(128, 256);
    scenario.router.setup_routes(app);
    app.validate();
    int provider_calls = 0;
    ApiRouter::set_profile_image_upload_test_hook([&] {
        ++provider_calls;
        return cpr::Response{};
    });
    crow::request request;
    request.url = "/users/me/profile-pic";
    request.method = crow::HTTPMethod::Post;
    request.add_header("Authorization", "Bearer " + scenario.token);
    request.add_header("Content-Type", "multipart/form-data; boundary=B97Boundary");
    request.body = "--B97Boundary\r\nContent-Disposition: form-data; name=\"image\"; filename=\"B97-SENTINEL.png\"\r\n\r\n";
    request.body.append(129, 'x');
    request.body += "\r\n--B97Boundary--\r\n";
    const auto response = dispatch(app, middlewares, request);
    CHECK(response.code == 413);
    CHECK(provider_calls == 0);
    CHECK(scenario.pool.get_available_count() == 1);
    auto conn = scenario.pool.acquire_connection();
    pqxx::work txn(*conn);
    const auto avatar = txn.exec("SELECT avatar_url FROM users WHERE id=$1", pqxx::params{scenario.user_id});
    REQUIRE(avatar.size() == 1);
    CHECK(avatar[0][0].as<std::string>() == "https://old.example.invalid/avatar");
    txn.commit();
}
