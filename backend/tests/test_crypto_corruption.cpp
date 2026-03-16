#include <catch2/catch_test_macros.hpp>
#include "CryptoService.hpp"




TEST_CASE("Crypto Service - Dados Corrompidos e Extremos", "[crypto][security]") {
    CryptoService crypto("01234567890123456789012345678901");

    SECTION("Descriptografar lixo não deve dar Segfault, deve lançar exceção controlada") {
        std::string corrupted_cipher = "IssoNaoEhUmBase64Valido!@#$()";
        
        REQUIRE_THROWS(crypto.decrypt_text(corrupted_cipher));
    }

    SECTION("Criptografar string vazia deve ser tratado corretamente") {
        std::string empty_str = "";

        REQUIRE_NOTHROW(crypto.encrypt_text(empty_str));
    }
}