#include <catch2/catch_test_macros.hpp>
#include "Services/CryptoService.hpp"
#include <string>




TEST_CASE("Criptografia Reversível", "[crypto][security]") {
    CryptoService crypto("01234567890123456789012345678901");

    std::string original = "relatorio_financeiro.pdf";

    SECTION("Texto criptografado deve ser diferente do original") {
        std::string cipher = crypto.encrypt_text(original);

        REQUIRE_FALSE(cipher.empty());
        REQUIRE(cipher != original);
    }

    SECTION("Descriptografia deve recuperar o texto original") {
        std::string cipher = crypto.encrypt_text(original);
        std::string decrypted = crypto.decrypt_text(cipher);

        REQUIRE(decrypted == original);
    }
}
