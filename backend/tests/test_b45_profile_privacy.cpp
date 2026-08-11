#include <catch2/catch_test_macros.hpp>

#include "controllers/ApiRouter.hpp"
#include "database/DatabasePool.hpp"
#include "database/FolderManager.hpp"
#include "Services/AuthService.hpp"
#include "test_helpers.hpp"

#include <crow_all.h>
#include <pqxx/pqxx>

#include <iostream>
#include <sstream>
#include <string>

namespace {

class ScopedStreamCapture {
public:
    ScopedStreamCapture(std::ostream& stream, std::ostringstream& output)
        : stream_(stream), previous_(stream.rdbuf(output.rdbuf())) {}

    ~ScopedStreamCapture() {
        stream_.rdbuf(previous_);
    }

    ScopedStreamCapture(const ScopedStreamCapture&) = delete;
    ScopedStreamCapture& operator=(const ScopedStreamCapture&) = delete;

private:
    std::ostream& stream_;
    std::streambuf* previous_;
};

struct B45ProfileFixture {
    static constexpr const char* username = "b45_profile_privacy_user";
    static constexpr const char* email = "b45_profile_privacy@test.invalid";

    DatabasePool pool;
    MockEmailService email_service;
    AuthService auth;
    FolderManager folder_manager;
    ApiRouter router;
    uint64_t user_id = 0;
    std::string token;

    B45ProfileFixture()
        : pool(2, get_secure_conn_string()),
          auth("b45_profile_secret", "b45_profile_pepper", &email_service),
          folder_manager(pool),
          router(pool, auth, folder_manager) {
        auto connection = pool.acquire_connection();
        pqxx::work transaction(*connection);
        transaction.exec("DELETE FROM users WHERE username = $1", pqxx::params{username});
        const auto result = transaction.exec(
            "INSERT INTO users(username, email, password_hash, is_email_verified) "
            "VALUES($1, $2, 'b45_profile_hash', TRUE) RETURNING id",
            pqxx::params{username, email});
        transaction.commit();

        user_id = result[0][0].as<uint64_t>();
        token = auth.generate_token(user_id);
    }

    ~B45ProfileFixture() {
        try {
            auto connection = pool.acquire_connection();
            pqxx::work transaction(*connection);
            transaction.exec("DELETE FROM users WHERE username = $1", pqxx::params{username});
            transaction.commit();
        } catch (...) {
        }
    }
};

crow::request make_profile_request(const std::string& token, const std::string& part_name = "not-image") {
    constexpr const char* boundary = "B45Boundary";
    crow::request request;
    request.url = "/users/me/profile-pic";
    request.method = crow::HTTPMethod::Post;
    request.add_header("Authorization", "Bearer " + token);
    request.add_header("Content-Type", "multipart/form-data; boundary=" + std::string(boundary));
    request.body =
        "--" + std::string(boundary) + "\r\n"
        "Content-Disposition: form-data; name=\"" + part_name + "\"; "
        "filename=\"B45-PLAINTEXT-SENTINEL.jpg\"\r\n"
        "X-B45-Metadata: B45-PART-HEADER-SENTINEL\r\n"
        "Content-Type: image/jpeg\r\n"
        "\r\n"
        "x\r\n"
        "--" + std::string(boundary) + "--\r\n";
    return request;
}

} // namespace

TEST_CASE("B45 profile upload does not log multipart metadata", "[b45][api][profile]") {
    B45ProfileFixture fixture;
    const auto request = make_profile_request(fixture.token);
    std::ostringstream stdout_capture;
    std::ostringstream stderr_capture;
    crow::response response;

    {
        ScopedStreamCapture stdout_redirect(std::cout, stdout_capture);
        ScopedStreamCapture stderr_redirect(std::cerr, stderr_capture);
        response = fixture.router.handle_update_profile_pic(request);
    }

    const auto logs = stdout_capture.str() + stderr_capture.str();
    REQUIRE(response.code == 400);
    CHECK(logs.find("B45-PLAINTEXT-SENTINEL.jpg") == std::string::npos);
    CHECK(logs.find("B45-PART-HEADER-SENTINEL") == std::string::npos);
}

TEST_CASE("B45 profile upload preserves auth and content type validation", "[b45][api][profile]") {
    B45ProfileFixture fixture;

    auto unauthenticated_request = make_profile_request("");
    unauthenticated_request.headers.erase("Authorization");
    const auto unauthenticated_response = fixture.router.handle_update_profile_pic(unauthenticated_request);
    REQUIRE(unauthenticated_response.code == 401);

    crow::request invalid_content_type_request;
    invalid_content_type_request.url = "/users/me/profile-pic";
    invalid_content_type_request.method = crow::HTTPMethod::Post;
    invalid_content_type_request.add_header("Authorization", "Bearer " + fixture.token);
    invalid_content_type_request.add_header("Content-Type", "application/json");
    invalid_content_type_request.body = "{}";

    const auto invalid_content_type_response =
        fixture.router.handle_update_profile_pic(invalid_content_type_request);
    REQUIRE(invalid_content_type_response.code == 400);
    CHECK(invalid_content_type_response.body.find("Apenas multipart/form-data eh suportado") != std::string::npos);
}
