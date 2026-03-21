#include <catch2/catch_test_macros.hpp>
#include "utils.hpp"

TEST_CASE("EmailValidator - Formato e Dominios", "[email][validator]") {
    SECTION("Valida formato de e-mail") {
        REQUIRE(EmailUtils::is_valid_format("bob_123@hotmail.com"));
        REQUIRE(EmailUtils::is_valid_format("nome.sobrenome_123@gmail.com"));

        REQUIRE_FALSE(EmailUtils::is_valid_format("semarroba.com"));
        REQUIRE_FALSE(EmailUtils::is_valid_format("alice.silva+tag@gmail.com"));
        REQUIRE_FALSE(EmailUtils::is_valid_format("@dominio.com"));
        REQUIRE_FALSE(EmailUtils::is_valid_format("usuario@"));
        REQUIRE_FALSE(EmailUtils::is_valid_format("usuario@dominio"));
    }

    SECTION("Extrai dominio em lowercase") {
        REQUIRE(EmailUtils::extract_domain("User@Mailinator.COM") == "mailinator.com");
        REQUIRE(EmailUtils::extract_domain("normal.user@GMAIL.com") == "gmail.com");
        REQUIRE(EmailUtils::extract_domain("invalido_sem_arroba") == "");
    }

    SECTION("Identifica dominios descartaveis") {
        REQUIRE(EmailUtils::is_disposable("teste@mailinator.com"));
        REQUIRE(EmailUtils::is_disposable("teste@10MinuteMail.com"));
        REQUIRE(EmailUtils::is_disposable("teste@temp-mail.org"));
        REQUIRE(EmailUtils::is_disposable("teste@guerrillamail.com"));
        REQUIRE(EmailUtils::is_disposable("teste@yopmail.com"));

        REQUIRE_FALSE(EmailUtils::is_disposable("pessoa@gmail.com"));
        REQUIRE_FALSE(EmailUtils::is_disposable("pessoa@hotmail.com"));
    }
}
