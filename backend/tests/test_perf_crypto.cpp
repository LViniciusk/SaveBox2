#include <catch2/catch_test_macros.hpp>
#include <catch2/benchmark/catch_benchmark.hpp>
#include <sodium.h>
#include <openssl/evp.h>
#include <openssl/bn.h>
#include <openssl/param_build.h>
#include <openssl/core_names.h>
#include <memory>
#include <string>

namespace {
    struct SodiumInitializer {
        SodiumInitializer() {
            if (sodium_init() < 0) {
                throw std::runtime_error("sodium_init failed");
            }
        }
    };
    // Initialize exactly once
    SodiumInitializer g_sodium_init;
}

using BIGNUM_ptr = std::unique_ptr<BIGNUM, decltype(&::BN_free)>;
using EVP_PKEY_CTX_ptr = std::unique_ptr<EVP_PKEY_CTX, decltype(&::EVP_PKEY_CTX_free)>;
using EVP_PKEY_ptr = std::unique_ptr<EVP_PKEY, decltype(&::EVP_PKEY_free)>;
using OSSL_PARAM_BLD_ptr = std::unique_ptr<OSSL_PARAM_BLD, decltype(&::OSSL_PARAM_BLD_free)>;
using OSSL_PARAM_ptr = std::unique_ptr<OSSL_PARAM, decltype(&::OSSL_PARAM_free)>;

TEST_CASE("Microbenchmarking de Criptografia", "[benchmark][crypto]") {
    
    SECTION("Derivacao de chave com BLAKE2b (crypto_generichash)") {
        std::string pepper = "UmaPepperExtraLongaParaTestarPerformanceDoHash_1234567890";
        
        BENCHMARK("crypto_generichash (32 bytes)") {
            std::vector<unsigned char> key(crypto_secretbox_KEYBYTES);
            crypto_generichash(key.data(), key.size(),
                               reinterpret_cast<const unsigned char*>(pepper.data()), pepper.size(),
                               nullptr, 0);
            return key[0]; // Retorna para evitar otimização do compilador
        };
    }

    SECTION("Overhead de alocacao RAII do OpenSSL (Simulacao de parsing RSA)") {
        // Simulando strings convertidas de base64url do payload JWKS
        std::string n_bin_simulated(256, '\x01'); // 2048-bit modulus
        std::string e_bin_simulated = "\x01\x00\x01"; // 65537
        
        BENCHMARK("RAII OpenSSL EVP_PKEY Creation") {
            BIGNUM_ptr n(BN_bin2bn(reinterpret_cast<const unsigned char*>(n_bin_simulated.data()), n_bin_simulated.size(), nullptr), ::BN_free);
            BIGNUM_ptr e(BN_bin2bn(reinterpret_cast<const unsigned char*>(e_bin_simulated.data()), e_bin_simulated.size(), nullptr), ::BN_free);

            OSSL_PARAM_BLD_ptr bld(OSSL_PARAM_BLD_new(), ::OSSL_PARAM_BLD_free);
            OSSL_PARAM_BLD_push_BN(bld.get(), OSSL_PKEY_PARAM_RSA_N, n.get());
            OSSL_PARAM_BLD_push_BN(bld.get(), OSSL_PKEY_PARAM_RSA_E, e.get());

            OSSL_PARAM_ptr params(OSSL_PARAM_BLD_to_param(bld.get()), ::OSSL_PARAM_free);

            EVP_PKEY_CTX_ptr ctx(EVP_PKEY_CTX_new_from_name(nullptr, "RSA", nullptr), ::EVP_PKEY_CTX_free);
            EVP_PKEY_fromdata_init(ctx.get());

            EVP_PKEY* pkey_raw = nullptr;
            EVP_PKEY_fromdata(ctx.get(), &pkey_raw, EVP_PKEY_PUBLIC_KEY, params.get());
            EVP_PKEY_ptr pkey(pkey_raw, ::EVP_PKEY_free);
            
            return pkey != nullptr;
        };
    }
}
