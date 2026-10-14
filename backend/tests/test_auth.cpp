#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers.hpp>
#include "Services/AuthService.hpp"
#include "test_helpers.hpp"
#include <sodium.h>
#include <string>
#include <stdexcept>
#include <algorithm>
#include <array>
#include <cstring>
#include "Services/detail/ScopedMemoryWipe.hpp"

namespace {
std::array<size_t, 3> wiped_buffers{};
bool all_wiped = true;
void observe_wipe(const void* data, size_t size) noexcept {
    const auto* bytes = static_cast<const unsigned char*>(data);
    all_wiped = all_wiped && std::all_of(bytes, bytes + size, [](auto byte) { return byte == 0; });
    if (size == crypto_generichash_BYTES) ++wiped_buffers[0];
    if (size == crypto_generichash_BYTES * 2) ++wiped_buffers[1];
    if (size == crypto_pwhash_STRBYTES) ++wiped_buffers[2];
}
struct PasswordCleanupHooks {
    PasswordCleanupHooks() {
        wiped_buffers = {};
        all_wiped = true;
        AuthDetail::wipe_observer = observe_wipe;
    }
    ~PasswordCleanupHooks() {
        AuthService::clear_password_material_test_hook();
        AuthService::clear_password_crypto_test_hook();
        AuthDetail::wipe_observer = nullptr;
    }
};
}

TEST_CASE("Sensitive guards wipe live buffers during return and unwinding", "[auth][security-track-a][memory-wipe]") {
    for (const bool fail : {false, true}) {
        std::string sensitive(64, 'x');
        char temporary[128];
        std::memset(temporary, 'y', sizeof(temporary));
        try {
            AuthDetail::ScopedMemoryWipe string_wipe(sensitive);
            AuthDetail::ScopedMemoryWipe buffer_wipe(temporary, sizeof(temporary));
            if (fail) throw std::runtime_error("TEST_FAILURE");
        } catch (const std::runtime_error&) {}
        REQUIRE(std::all_of(sensitive.begin(), sensitive.end(), [](char c) { return c == 0; }));
        REQUIRE(std::all_of(std::begin(temporary), std::end(temporary), [](char c) { return c == 0; }));
    }
}

TEST_CASE("AuthService cleans each intermediate on success and deterministic failures", "[auth][security-track-a][memory-wipe]") {
    MockEmailService email;
    AuthService auth("track-a-unit-pepper", "track-a-unit-jwt", &email);
    const auto existing_hash = auth.hash_password("track-a-unit-password");
    PasswordCleanupHooks hooks;

    SECTION("successful hash returns a live compatible Argon2id hash") {
        const auto hash = auth.hash_password("track-a-unit-password");
        REQUIRE(hash.find("$argon2id$v=19$m=65536,t=2,p=1$") == 0);
        REQUIRE(wiped_buffers == std::array<size_t, 3>{1, 1, 1});
        REQUIRE(auth.verify_password("track-a-unit-password", hash));
        REQUIRE(all_wiped);
    }
    SECTION("correct and incorrect verification both clean intermediates") {
        REQUIRE(auth.verify_password("track-a-unit-password", existing_hash));
        REQUIRE_FALSE(auth.verify_password("wrong-password", existing_hash));
        REQUIRE(wiped_buffers == std::array<size_t, 3>{2, 2, 0});
        REQUIRE(all_wiped);
    }
    SECTION("exception after material exists wipes hash and verification buffers") {
        AuthService::set_password_material_test_hook([] { throw std::runtime_error("AUTH_CRYPTO_FAILURE"); });
        REQUIRE_THROWS_WITH(auth.hash_password("track-a-unit-password"), "AUTH_CRYPTO_FAILURE");
        REQUIRE(wiped_buffers == std::array<size_t, 3>{1, 1, 1});
        REQUIRE_THROWS_WITH(auth.verify_password("track-a-unit-password", existing_hash), "AUTH_CRYPTO_FAILURE");
        REQUIRE(wiped_buffers == std::array<size_t, 3>{2, 2, 1});
        REQUIRE(all_wiped);
    }
    SECTION("pwhash failure after writing output wipes both live buffers") {
        bool reached = false;
        AuthService::set_password_crypto_test_hook([&](char* output, const char*, size_t size) {
            reached = size == crypto_generichash_BYTES * 2;
            std::memset(output, 'x', crypto_pwhash_STRBYTES);
            return -1;
        });
        REQUIRE_THROWS_WITH(auth.hash_password("track-a-unit-password"), "AUTH_CRYPTO_FAILURE");
        REQUIRE(reached);
        REQUIRE(wiped_buffers == std::array<size_t, 3>{1, 1, 1});
        REQUIRE(all_wiped);
    }
    SECTION("throwing crypto seam also unwinds both live buffers") {
        AuthService::set_password_crypto_test_hook([](char*, const char*, size_t) -> int { throw std::bad_alloc(); });
        REQUIRE_THROWS_AS(auth.hash_password("track-a-unit-password"), std::bad_alloc);
        REQUIRE(wiped_buffers == std::array<size_t, 3>{1, 1, 1});
        REQUIRE(all_wiped);
    }
}

TEST_CASE("AuthService accepts hashes produced before scoped cleanup", "[auth][security-track-a][compatibility]") {
    MockEmailService email;
    const std::string password = "track-a-legacy-password";
    const std::string pepper = "track-a-unit-pepper";
    std::array<unsigned char, crypto_generichash_BYTES> pre_hash{};
    std::array<char, crypto_generichash_BYTES * 2 + 1> hex{};
    char hash[crypto_pwhash_STRBYTES]{};
    AuthService auth(pepper, "track-a-unit-jwt", &email);
    REQUIRE(crypto_generichash(pre_hash.data(), pre_hash.size(),
        reinterpret_cast<const unsigned char*>(password.data()), password.size(),
        reinterpret_cast<const unsigned char*>(pepper.data()), pepper.size()) == 0);
    sodium_bin2hex(hex.data(), hex.size(), pre_hash.data(), pre_hash.size());
    REQUIRE(crypto_pwhash_str(hash, hex.data(), hex.size() - 1,
        crypto_pwhash_OPSLIMIT_INTERACTIVE, crypto_pwhash_MEMLIMIT_INTERACTIVE) == 0);
    REQUIRE(auth.verify_password(password, hash));
    REQUIRE_FALSE(auth.verify_password("wrong-password", hash));
    sodium_memzero(pre_hash.data(), pre_hash.size());
    sodium_memzero(hex.data(), hex.size());
    sodium_memzero(hash, sizeof(hash));
}




TEST_CASE("Hashing e Verificação de Senhas", "[auth][security]") {
    MockEmailService mock_email;
    AuthService auth("Ultimo_romance", "vento", &mock_email);

    SECTION("Hash não deve ser vazio nem igual à senha original") {
        std::string hash = auth.hash_password("minha_senha_123");

        REQUIRE_FALSE(hash.empty());
        REQUIRE(hash != "minha_senha_123");
    }

    SECTION("Verificação deve aceitar a senha correta") {
        std::string hash = auth.hash_password("minha_senha_123");

        bool is_valid = auth.verify_password("minha_senha_123", hash);
        REQUIRE(is_valid == true);
    }

    SECTION("Verificação deve rejeitar uma senha incorreta") {
        std::string hash = auth.hash_password("minha_senha_123");

        bool is_valid = auth.verify_password("senha_errada", hash);
        REQUIRE(is_valid == false);
    }
}

TEST_CASE("B.60 AuthService rejeita PASS_PEPPER fora da boundary", "[auth][security][b60]") {
    MockEmailService mock_email;
    const std::string max_pepper(crypto_generichash_KEYBYTES_MAX, 'p');
    const std::string oversized_pepper(crypto_generichash_KEYBYTES_MAX + 1, 'p');

    SECTION("pepper vazio continua rejeitado pelos dois construtores") {
        REQUIRE_THROWS_AS(
            AuthService("", "B60_secret", &mock_email),
            std::invalid_argument);
        REQUIRE_THROWS_AS(
            AuthService("", "B60_secret", "B60_resend", "B60_validation"),
            std::invalid_argument);
    }

    SECTION("pepper acima do limite e rejeitado pelos dois construtores") {
        REQUIRE_THROWS_AS(
            AuthService(oversized_pepper, "B60_secret", &mock_email),
            std::invalid_argument);
        REQUIRE_THROWS_AS(
            AuthService(oversized_pepper, "B60_secret", "B60_resend", "B60_validation"),
            std::invalid_argument);
    }

    SECTION("pepper exatamente no limite preserva o fluxo de senha") {
        AuthService auth(max_pepper, "B60_secret", &mock_email);
        const auto hash = auth.hash_password("B60_correct_password");

        REQUIRE(auth.verify_password("B60_correct_password", hash));
        REQUIRE_FALSE(auth.verify_password("B60_wrong_password", hash));
    }
}

TEST_CASE("B.38 logout local sem pool falha fechado", "[auth][b38]") {
    MockEmailService mock_email;
    AuthService auth("B38_no_pool_pepper", "B38_no_pool_secret", &mock_email);

    try {
        auth.logout_local("B38ERR1");
        FAIL("logout_local deveria falhar sem pool");
    } catch (const std::runtime_error& error) {
        REQUIRE(std::string(error.what()) == "AUTH_DB_NOT_CONFIGURED");
    }
}
