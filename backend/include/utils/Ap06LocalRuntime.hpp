#pragma once

#ifdef NANIKA_AP06_LOCAL_TEST_SERVER
#include "database/DatabasePool.hpp"
#include "e2e_fixture_support.hpp"
#include "utils.hpp"
#include <nlohmann/json.hpp>
#ifdef _WIN32
#include <windows.h>
#endif

// A startup capability exists only in the opt-in laboratory binary.
class Ap06LocalRuntime {
public:
    struct Config {
        std::string bind, fixture, database, user, host, storage, identity, runtime;
        bool trust_proxy;
    };

    static Config from_environment(const std::string& bind, const std::string& storage) {
        auto& cfg = Utils::get();
        Config config{bind, cfg.get_var("NANIKA_E2E_FIXTURE"), cfg.get_var("DB_NAME"),
            cfg.get_var("DB_USER"), cfg.get_var("DB_HOST"), storage,
            cfg.get_var("NANIKA_E2E_STORAGE_ID"), cfg.get_var("NANIKA_AP06_RUNTIME_ROOT"),
            DotEnv::trust_proxy_headers()};
        if (cfg.get_var("NANIKA_E2E_STORAGE_PATH") != storage) fail("AP06_LOCAL_RUNTIME_INVALID_STORAGE_CONFIG");
        validate(config);
        return config;
    }

    static void validate(const Config& c) {
        namespace fs = std::filesystem;
        if (c.bind != "127.0.0.1" || c.fixture != "1" || c.trust_proxy ||
            c.host != "127.0.0.1" || c.user != "nanika_e2e" ||
            c.database.rfind("nanika_e2e_", 0) != 0 ||
            !NanikaE2eFixture::is_safe_database_name(c.database)) fail("AP06_LOCAL_RUNTIME_INVALID_CONFIG");
        const fs::path runtime(c.runtime), storage(c.storage);
        checked(runtime); checked(storage);
        if (!fs::is_directory(runtime) || storage != runtime / "storage" ||
            fs::current_path() != runtime) fail("AP06_LOCAL_RUNTIME_INVALID_PATH_BINDING");
        NanikaE2eFixture::require_storage_identity(c.storage, c.identity);
        checked(storage / ".nanika-e2e-storage-id");
        if (read(runtime / ".owned-r10_r3") != c.identity) fail("AP06_LOCAL_RUNTIME_INVALID_OWNERSHIP");
        const auto manifest = nlohmann::json::parse(read(runtime / "ap06-runtime.json"));
        if (manifest != nlohmann::json{{"campaign", "AP-06-R10-R3"}, {"schema", 1},
                {"identity", c.identity}, {"database", c.database},
                {"storage", storage.generic_string()}}) fail("AP06_LOCAL_RUNTIME_INVALID_MANIFEST");
    }

    static Ap06LocalRuntime verify(const Config& c, DatabasePool& pool) {
        validate(c);
        auto conn = pool.acquire_connection();
        pqxx::read_transaction tx(*conn);
        const auto identity = tx.exec("SELECT current_database(), current_user, host(inet_server_addr())");
        if (identity.size() != 1 || identity[0][0].as<std::string>() != c.database ||
            identity[0][1].as<std::string>() != c.user || identity[0][2].is_null() ||
            identity[0][2].as<std::string>() != "127.0.0.1") fail("AP06_LOCAL_RUNTIME_INVALID_DATABASE_IDENTITY");
        const auto ownership = tx.exec(
            "SELECT identity, runtime_path FROM public.nanika_ap06_runtime WHERE singleton = TRUE");
        if (ownership.size() != 1 || ownership[0][0].as<std::string>() != c.identity ||
            ownership[0][1].as<std::string>() != std::filesystem::path(c.runtime).generic_string()) fail("AP06_LOCAL_RUNTIME_INVALID_DATABASE_OWNERSHIP");
        tx.commit();
        return Ap06LocalRuntime{};
    }

private:
    Ap06LocalRuntime() = default;
    [[noreturn]] static void fail(const char* code = "AP06_LOCAL_RUNTIME_INVALID") { throw std::runtime_error(code); }
    static void checked(const std::filesystem::path& path) {
        namespace fs = std::filesystem;
        if (!path.is_absolute()) fail("AP06_LOCAL_RUNTIME_INVALID_ABSOLUTE_PATH");
        fs::path part = path.root_path();
        checked_component(part);
        for (const auto& component : path.relative_path()) {
            if (component == "..") fail();
            part /= component;
            checked_component(part);
        }
    }
    static void checked_component(const std::filesystem::path& part) {
        namespace fs = std::filesystem;
        if (!fs::exists(part) || fs::is_symlink(fs::symlink_status(part))) fail("AP06_LOCAL_RUNTIME_INVALID_PATH_COMPONENT");
#ifdef _WIN32
            const auto attributes = GetFileAttributesW(part.c_str());
            if (attributes == INVALID_FILE_ATTRIBUTES || (attributes & FILE_ATTRIBUTE_REPARSE_POINT)) fail("AP06_LOCAL_RUNTIME_INVALID_REPARSE_POINT");
#endif
    }
    static std::string read(const std::filesystem::path& path) {
        checked(path);
        if (!std::filesystem::is_regular_file(path) || std::filesystem::file_size(path) > 4096) fail("AP06_LOCAL_RUNTIME_INVALID_FILE");
        std::ifstream file(path, std::ios::binary);
        std::string contents((std::istreambuf_iterator<char>(file)), {});
        if (!file || file.bad()) fail("AP06_LOCAL_RUNTIME_INVALID_FILE_READ");
        return contents;
    }
};
#endif
