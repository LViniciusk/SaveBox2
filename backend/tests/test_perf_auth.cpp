#include <catch2/catch_test_macros.hpp>
#include <catch2/benchmark/catch_benchmark.hpp>
#include <jwt-cpp/jwt.h>
#include <openssl/evp.h>
#include <string>

namespace {
    // Isolamento da mesma logica customizada usada no GoogleJwksCache.cpp
    std::string normalize_base64url(std::string b64) {
        for (char& c : b64) {
            if (c == '-') c = '+';
            else if (c == '_') c = '/';
        }
        while (b64.length() % 4 != 0) {
            b64 += '=';
        }
        return b64;
    }

    std::string decode_base64(const std::string& b64) {
        if (b64.empty()) return "";
        std::string out;
        out.resize((b64.size() * 3) / 4); 
        
        int len = EVP_DecodeBlock(reinterpret_cast<unsigned char*>(&out[0]), 
                                  reinterpret_cast<const unsigned char*>(b64.data()), 
                                  b64.size());
        if (len < 0) return "";
        
        int padding = 0;
        if (b64.length() >= 1 && b64[b64.length()-1] == '=') padding++;
        if (b64.length() >= 2 && b64[b64.length()-2] == '=') padding++;
        out.resize(len - padding);
        return out;
    }
}

TEST_CASE("Microbenchmarking de Autenticacao e JWT", "[benchmark][auth]") {

    SECTION("Validacao de Assinatura JWT (RSA256) em memoria") {
        // Gera um token valido localmente para o benchmark de verificacao
        auto token = jwt::create()
            .set_issuer("accounts.google.com")
            .set_audience("test-client-id")
            .set_subject("1234567890")
            .set_payload_claim("nonce", jwt::claim(std::string("random_nonce_123")))
            .sign(jwt::algorithm::hs256{"super_secret_benchmark_key"});

        auto verifier = jwt::verify()
            .allow_algorithm(jwt::algorithm::hs256{"super_secret_benchmark_key"})
            .with_issuer("accounts.google.com")
            .with_audience("test-client-id");

        BENCHMARK("jwt-cpp verify (HS256 simplificado)") {
            auto decoded = jwt::decode(token);
            verifier.verify(decoded);
            return decoded.get_subject(); 
        };
    }

    SECTION("Latencia de Decodificacao Base64Url Customizada (com padding)") {
        std::string raw_b64url = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"; // Header generico JWT

        BENCHMARK("decode_base64 (Custom OSSL)") {
            std::string normalized = normalize_base64url(raw_b64url);
            std::string decoded = decode_base64(normalized);
            return decoded.size();
        };
    }
}
