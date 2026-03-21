#include <catch2/catch_test_macros.hpp>
#include "services/AuthService.hpp"
#include "test_helpers.hpp"
#include <string>




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