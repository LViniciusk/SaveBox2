#include <catch2/catch_test_macros.hpp>

// Não existe 'int main()' aqui! O Catch2 faz isso sozinho.

TEST_CASE("Testando a matemática básica do servidor", "[geral]") {
    // Aqui vai a lógica do teste depois
    REQUIRE(1 + 1 == 2);
}