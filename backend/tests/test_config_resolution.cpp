#include <catch2/catch_test_macros.hpp>

#include <chrono>
#include <filesystem>
#include <fstream>
#include <string>

#include "utils.hpp"

namespace {

class TemporaryDirectory {
public:
    TemporaryDirectory() {
        const auto suffix = std::chrono::steady_clock::now().time_since_epoch().count();
        root_ = std::filesystem::temp_directory_path() /
            ("nanika-config-resolution-" + std::to_string(suffix));
        std::filesystem::create_directories(root_);
    }

    ~TemporaryDirectory() {
        std::error_code ignored;
        std::filesystem::remove_all(root_, ignored);
    }

    const std::filesystem::path& path() const { return root_; }

private:
    std::filesystem::path root_;
};

void write_file(const std::filesystem::path& path, const std::string& contents) {
    std::filesystem::create_directories(path.parent_path());
    std::ofstream file(path, std::ios::binary);
    REQUIRE(file.is_open());
    file << contents;
}

} // namespace

TEST_CASE("dotenv resolves the nearest ancestor without depending on build CWD", "[config][dotenv]") {
    TemporaryDirectory temporary;
    const auto workspace = temporary.path();
    const auto nested = workspace / "work" / "run";
    std::filesystem::create_directories(nested);
    write_file(workspace / ".env", "PORT=18082\n");

    const auto resolved = NanikaConfig::find_dotenv_upwards(nested);

    REQUIRE(resolved.has_value());
    CHECK(resolved->lexically_normal() == (workspace / ".env").lexically_normal());
}

TEST_CASE("dotenv stops at the nearest invalid candidate", "[config][dotenv]") {
    TemporaryDirectory temporary;
    const auto parent = temporary.path() / "workspace";
    const auto nested = parent / "work";
    std::filesystem::create_directories(nested / ".env");
    write_file(parent / ".env", "PORT=18082\n");

    CHECK_FALSE(NanikaConfig::find_dotenv_upwards(nested).has_value());
}

TEST_CASE("dotenv discovery is bounded and returns no result when absent", "[config][dotenv]") {
    TemporaryDirectory temporary;
    auto nested = temporary.path();
    for (std::size_t index = 0; index <= NanikaConfig::kMaxDotenvAncestors; ++index) {
        nested /= "x";
    }
    std::filesystem::create_directories(nested);
    write_file(temporary.path() / ".env", "PORT=18082\n");

    CHECK_FALSE(NanikaConfig::find_dotenv_upwards(nested).has_value());
}

TEST_CASE("dotenv parser preserves first equals, CRLF and literal values", "[config][dotenv]") {
    TemporaryDirectory temporary;
    const auto env_path = temporary.path() / ".env";
    write_file(env_path,
        "# comment\r\n"
        "EMPTY=\r\n"
        "URL=https://example.invalid/a=b\r\n"
        "LITERAL=${NOT_EXPANDED}\r\n"
        "ignored-without-equals\r\n");

    const auto values = NanikaConfig::read_dotenv(env_path);

    CHECK(values.at("EMPTY").empty());
    CHECK(values.at("URL") == "https://example.invalid/a=b");
    CHECK(values.at("LITERAL") == "${NOT_EXPANDED}");
    CHECK(values.find("ignored-without-equals") == values.end());
}

TEST_CASE("dotenv symlink candidate is rejected without fallback when supported", "[config][dotenv]") {
    TemporaryDirectory temporary;
    const auto parent = temporary.path() / "workspace";
    const auto nested = parent / "work";
    std::filesystem::create_directories(nested);
    write_file(parent / ".env", "PORT=18082\n");
    write_file(temporary.path() / "real.env", "PORT=18082\n");

    std::error_code error;
    std::filesystem::create_symlink(temporary.path() / "real.env", nested / ".env", error);
    if (error) {
        WARN("symlink creation is unavailable in this test environment");
        return;
    }

    CHECK_FALSE(NanikaConfig::find_dotenv_upwards(nested).has_value());
}

TEST_CASE("bind address accepts only explicit IPv4 listen authorities", "[config][bind]") {
    CHECK(NanikaConfig::validate_bind_address("0.0.0.0") == "0.0.0.0");
    CHECK(NanikaConfig::validate_bind_address("127.0.0.1") == "127.0.0.1");

    for (const auto& invalid : {
             "", "localhost", "::1", "[::1]", "0.0.0.0 ", " 127.0.0.1",
             "127.0.0.2", "192.168.1.1", "10.0.0.1", "*",
             "http://127.0.0.1", "127.0.0.1:8080"}) {
        std::string message;
        try {
            NanikaConfig::validate_bind_address(invalid);
        } catch (const std::runtime_error& error) {
            message = error.what();
        }
        CHECK(message == "Invalid NANIKA_BIND_ADDRESS");
    }
}
