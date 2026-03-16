#include "CryptoService.hpp"

#include <sodium.h>
#include <stdexcept>
#include <cstring>

CryptoService::CryptoService(const std::string& master_key) {
    if (sodium_init() == -1) {
        throw std::runtime_error(
            "Falha crítica: libsodium não pôde ser inicializada."
        );
    }

    if (master_key.size() != crypto_secretbox_KEYBYTES) {
        throw std::invalid_argument(
            "A master_key deve ter exatamente " +
            std::to_string(crypto_secretbox_KEYBYTES) + " bytes."
        );
    }

    key_.assign(
        reinterpret_cast<const uint8_t*>(master_key.data()),
        reinterpret_cast<const uint8_t*>(master_key.data()) + master_key.size()
    );
}

std::string CryptoService::encrypt_text(const std::string& plain_text) {
    std::vector<uint8_t> nonce(crypto_secretbox_NONCEBYTES);
    randombytes_buf(nonce.data(), nonce.size());

    std::vector<uint8_t> ciphertext(plain_text.size() + crypto_secretbox_MACBYTES);

    if (crypto_secretbox_easy(
            ciphertext.data(),
            reinterpret_cast<const uint8_t*>(plain_text.data()),
            plain_text.size(),
            nonce.data(),
            key_.data()) != 0) {
        throw std::runtime_error("Falha ao criptografar o texto.");
    }

    std::vector<uint8_t> combined(nonce.size() + ciphertext.size());
    std::memcpy(combined.data(), nonce.data(), nonce.size());
    std::memcpy(combined.data() + nonce.size(), ciphertext.data(), ciphertext.size());

    const size_t base64_max_len = sodium_base64_encoded_len(combined.size(), sodium_base64_VARIANT_ORIGINAL);
    std::vector<char> base64_buf(base64_max_len);

    sodium_bin2base64(
        base64_buf.data(), base64_buf.size(),
        combined.data(), combined.size(),
        sodium_base64_VARIANT_ORIGINAL
    );

    return std::string(base64_buf.data());
}

std::string CryptoService::decrypt_text(const std::string& cipher_base64) {
    const size_t bin_max_len = cipher_base64.size();
    std::vector<uint8_t> combined(bin_max_len);
    size_t bin_len = 0;

    if (sodium_base642bin(
            combined.data(), combined.size(),
            cipher_base64.c_str(), cipher_base64.size(),
            nullptr, &bin_len, nullptr,
            sodium_base64_VARIANT_ORIGINAL) != 0) {
        throw std::runtime_error(
            "Falha ao decodificar Base64: dados corrompidos ou inválidos."
        );
    }

    combined.resize(bin_len);

    if (combined.size() < crypto_secretbox_NONCEBYTES + crypto_secretbox_MACBYTES) {
        throw std::runtime_error(
            "Dados criptografados corrompidos: tamanho insuficiente."
        );
    }

    const uint8_t* nonce = combined.data();
    const uint8_t* ciphertext = combined.data() + crypto_secretbox_NONCEBYTES;
    const size_t ciphertext_len = combined.size() - crypto_secretbox_NONCEBYTES;

    std::vector<uint8_t> plaintext(ciphertext_len - crypto_secretbox_MACBYTES);

    if (crypto_secretbox_open_easy(
            plaintext.data(),
            ciphertext, ciphertext_len,
            nonce,
            key_.data()) != 0) {
        throw std::runtime_error(
            "Falha na autenticação: dados foram adulterados ou a chave está incorreta."
        );
    }

    return std::string(reinterpret_cast<const char*>(plaintext.data()), plaintext.size());
}
