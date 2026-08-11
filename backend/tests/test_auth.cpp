#include <catch2/catch_test_macros.hpp>
#include "Services/AuthService.hpp"
#include "test_helpers.hpp"
#include <sodium.h>
#include <string>
#include <stdexcept>




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
