#include <catch2/catch_test_macros.hpp>

#include "controllers/ApiRouter.hpp"
#include "database/FolderManager.hpp"
#include "test_helpers.hpp"
#include "utils/RandomIds.hpp"

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <exception>
#include <iostream>
#include <mutex>
#include <sstream>
#include <thread>
#include <utility>

namespace {

constexpr const char* old_avatar = "https://old.example.invalid/avatar";
constexpr const char* new_avatar = "https://new.example.invalid/avatar";

cpr::Response provider_response(long status = 200, std::string body =
    R"({"success":true,"data":{"link":"https://new.example.invalid/avatar"}})") {
    cpr::Response response;
    response.error.code = cpr::ErrorCode::OK;
    response.status_code = status;
    response.text = std::move(body);
    return response;
}

struct B96ProfileScenario {
    DatabasePool pool{1, get_secure_conn_string()};
    MockEmailService email;
    AuthService auth{"b96-synthetic-secret", "b96-synthetic-pepper", &email};
    FolderManager folders{pool};
    ApiRouter router{pool, auth, folders};
    const std::string username = "b96_" + UuidUtils::generate_uuid_v4();
    uint64_t user_id = 0;
    std::string token;

    B96ProfileScenario() {
        {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            const auto result = txn.exec(
                "INSERT INTO users (username, email, password_hash, is_email_verified, avatar_url) "
                "VALUES ($1, $2, 'b96-synthetic-hash', TRUE, $3) RETURNING id",
                pqxx::params{username, username + "@test.invalid", old_avatar});
            user_id = result[0][0].as<uint64_t>();
            txn.commit();
        }
        token = auth.generate_token(user_id);
    }

    ~B96ProfileScenario() {
        ApiRouter::clear_profile_image_upload_test_hook();
        try {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            txn.exec("DELETE FROM users WHERE id = $1", pqxx::params{user_id});
            txn.commit();
        } catch (...) {
        }
    }

    // xmin also detects an UPDATE that merely rewrites the old URL.
    std::pair<std::string, std::string> avatar_state() {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        const auto result = txn.exec("SELECT avatar_url, xmin::text FROM users WHERE id = $1",
                                     pqxx::params{user_id});
        const auto state = std::make_pair(result[0][0].as<std::string>(), result[0][1].as<std::string>());
        txn.commit();
        return state;
    }

    crow::request request(const std::string& part_name = "image",
                          const std::string& image = "B96-SYNTHETIC-IMAGE") const {
        crow::request req;
        req.url = "/users/me/profile-pic";
        req.method = crow::HTTPMethod::Post;
        req.add_header("Authorization", "Bearer " + token);
        req.add_header("Content-Type", "multipart/form-data; boundary=B96Boundary");
        req.body =
            "--B96Boundary\r\n"
            "Content-Disposition: form-data; name=\"" + part_name + "\"; "
            "filename=\"B96-FILENAME-SENTINEL.jpg\"\r\n"
            "X-B96-Metadata: B96-HEADER-SENTINEL\r\n"
            "Content-Type: image/jpeg\r\n\r\n" + image + "\r\n"
            "--B96Boundary--\r\n";
        return req;
    }
};

struct RemoteGate {
    std::mutex mutex;
    std::condition_variable cv;
    bool entered = false;
    bool released = false;
    std::thread worker;

    ~RemoteGate() {
        release_and_join();
        ApiRouter::clear_profile_image_upload_test_hook();
    }

    void block() {
        std::unique_lock<std::mutex> lock(mutex);
        entered = true;
        cv.notify_all();
        cv.wait(lock, [&] { return released; });
    }

    bool wait_for_entry() {
        std::unique_lock<std::mutex> lock(mutex);
        return cv.wait_for(lock, std::chrono::seconds(5), [&] { return entered; });
    }

    void release_and_join() {
        {
            std::lock_guard<std::mutex> lock(mutex);
            released = true;
        }
        cv.notify_all();
        if (worker.joinable()) worker.join();
    }
};

struct LogCapture {
    std::ostringstream output;
    std::ostringstream errors;
    std::streambuf* previous_output = std::cout.rdbuf(output.rdbuf());
    std::streambuf* previous_errors = std::cerr.rdbuf(errors.rdbuf());

    ~LogCapture() {
        std::cout.rdbuf(previous_output);
        std::cerr.rdbuf(previous_errors);
    }
};

} // namespace

TEST_CASE("B.96 pending Imgur call holds zero DB lease and precedes avatar persistence",
          "[b96][api][profile][network][security][regression][lease]") {
    B96ProfileScenario scenario;
    const auto initial = scenario.avatar_state();
    const auto request = scenario.request();
    std::atomic<int> provider_calls{0};
    crow::response response;
    std::exception_ptr worker_error;
    RemoteGate gate;
    ApiRouter::set_profile_image_upload_test_hook([&] {
        ++provider_calls;
        gate.block();
        return provider_response();
    });
    gate.worker = std::thread([&] {
        try {
            response = scenario.router.handle_update_profile_pic(request);
        } catch (...) {
            worker_error = std::current_exception();
        }
    });

    REQUIRE(gate.wait_for_entry());
    // The provider cannot return while these ownership and row-state checks run.
    REQUIRE(scenario.pool.get_available_count() == 1);
    CHECK(scenario.avatar_state() == initial);
    CHECK(provider_calls.load() == 1);
    gate.release_and_join();
    if (worker_error) std::rethrow_exception(worker_error);

    REQUIRE(response.code == 200);
    const auto persisted = scenario.avatar_state();
    CHECK(persisted.first == new_avatar);
    CHECK(persisted.second != initial.second);
    CHECK(provider_calls.load() == 1);
    CHECK(scenario.pool.get_available_count() == 1);
}

TEST_CASE("B.96 provider failures never update avatar or retry the upload",
          "[b96][api][profile][network][security][regression][failure]") {
    struct Failure {
        const char* name;
        long status;
        cpr::ErrorCode error;
        const char* body;
    };
    const Failure failures[] = {
        {"transport timeout", 0, cpr::ErrorCode::OPERATION_TIMEDOUT, "B96-PROVIDER-SENTINEL"},
        {"timeout after HTTP 200 headers", 200, cpr::ErrorCode::OPERATION_TIMEDOUT,
         R"({"success":true,"data":{"link":"https://new.example.invalid/avatar"}})"},
        {"transport connection failure", 0, cpr::ErrorCode::COULDNT_CONNECT, "B96-PROVIDER-SENTINEL"},
        {"HTTP 500", 500, cpr::ErrorCode::OK, "B96-PROVIDER-SENTINEL"},
        {"HTTP 429", 429, cpr::ErrorCode::OK, "B96-PROVIDER-SENTINEL"},
        {"HTTP 400", 400, cpr::ErrorCode::OK, "B96-PROVIDER-SENTINEL"},
        {"malformed JSON", 200, cpr::ErrorCode::OK, "not-json"},
        {"success false", 200, cpr::ErrorCode::OK, R"({"success":false})"},
        {"missing data", 200, cpr::ErrorCode::OK, R"({"success":true})"},
        {"data wrong type", 200, cpr::ErrorCode::OK, R"({"success":true,"data":"not-an-object"})"},
        {"missing link", 200, cpr::ErrorCode::OK, R"({"success":true,"data":{}})"},
        {"link wrong type", 200, cpr::ErrorCode::OK, R"({"success":true,"data":{"link":123}})"}
    };
    for (const auto& failure : failures) {
        DYNAMIC_SECTION(failure.name) {
            B96ProfileScenario scenario;
            const auto initial = scenario.avatar_state();
            int provider_calls = 0;
            ApiRouter::set_profile_image_upload_test_hook([&] {
                ++provider_calls;
                auto response = provider_response(failure.status, failure.body);
                response.error.code = failure.error;
                response.error.message = "B96-TRANSPORT-SENTINEL";
                return response;
            });
            const auto response = scenario.router.handle_update_profile_pic(scenario.request());
            CHECK(response.code == 500);
            CHECK(scenario.avatar_state() == initial);
            CHECK(provider_calls == 1);
            CHECK(response.body.find("B96-PROVIDER-SENTINEL") == std::string::npos);
            CHECK(response.body.find("B96-TRANSPORT-SENTINEL") == std::string::npos);
            CHECK(scenario.pool.get_available_count() == 1);
        }
    }
}

TEST_CASE("B.96 invalid auth and image requests never reach the provider",
          "[b96][api][profile][network][security][regression][validation]") {
    B96ProfileScenario scenario;
    const auto initial = scenario.avatar_state();
    int provider_calls = 0;
    ApiRouter::set_profile_image_upload_test_hook([&] {
        ++provider_calls;
        return provider_response();
    });
    auto request = scenario.request();
    int expected = 400;
    SECTION("missing auth") {
        request.headers.erase("Authorization");
        expected = 401;
    }
    SECTION("invalid auth") {
        request.headers.erase("Authorization");
        request.add_header("Authorization", "Bearer b96-invalid-token");
        expected = 401;
    }
    SECTION("invalid content type") {
        request.headers.erase("Content-Type");
        request.add_header("Content-Type", "application/json");
        request.body = "{}";
    }
    SECTION("missing image part") { request = scenario.request("not-image"); }
    SECTION("empty image part") { request = scenario.request("image", ""); }
    SECTION("malformed multipart without image") { request.body = "B96-MALFORMED-MULTIPART"; }
    const auto response = scenario.router.handle_update_profile_pic(request);
    CHECK(response.code == expected);
    CHECK(provider_calls == 0);
    CHECK(scenario.avatar_state() == initial);
}

TEST_CASE("B.96 profile failure logs contain no multipart image auth or provider detail",
          "[b96][api][profile][network][security][regression][privacy]") {
    B96ProfileScenario scenario;
    int provider_calls = 0;
    ApiRouter::set_profile_image_upload_test_hook([&] {
        ++provider_calls;
        auto response = provider_response(0, "B96-PROVIDER-BODY-SENTINEL");
        response.error.code = cpr::ErrorCode::OPERATION_TIMEDOUT;
        response.error.message = "B96-TRANSPORT-DETAIL-SENTINEL";
        return response;
    });
    crow::response response;
    std::string logs;
    {
        LogCapture capture;
        response = scenario.router.handle_update_profile_pic(scenario.request());
        logs = capture.output.str() + capture.errors.str();
    }
    CHECK(response.code == 500);
    CHECK(provider_calls == 1);
    for (const char* sentinel : {"B96-FILENAME-SENTINEL", "B96-HEADER-SENTINEL",
                               "B96-SYNTHETIC-IMAGE", "B96-PROVIDER-BODY-SENTINEL",
                               "B96-TRANSPORT-DETAIL-SENTINEL", "Authorization", "Client-ID"}) {
        CHECK(logs.find(sentinel) == std::string::npos);
    }
    CHECK(logs.find(scenario.token) == std::string::npos);
}
