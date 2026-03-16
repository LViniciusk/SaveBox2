#include "services/AuthService.hpp"
#include <sodium.h>
#include <stdexcept>
#include <cstring>
#include <vector>

AuthService::AuthService(const std::string& server_pepper) 
    : pepper_(server_pepper) {
    if (sodium_init() == -1) {
        throw std::runtime_error("Falha critica: libsodium nao pode ser inicializada.");
    }
    if (pepper_.empty()) {
        throw std::invalid_argument("O Pepper do servidor nao pode ser vazio.");
    }
}

std::string AuthService::apply_pepper(const std::string& plain_password) const {
    std::vector<unsigned char> pre_hash(crypto_generichash_BYTES);
    
    crypto_generichash(
        pre_hash.data(), pre_hash.size(),
        reinterpret_cast<const unsigned char*>(plain_password.data()), plain_password.size(),
        reinterpret_cast<const unsigned char*>(pepper_.data()), pepper_.size()
    );

    std::string hex_pre_hash(crypto_generichash_BYTES * 2 + 1, '\0');
    sodium_bin2hex(hex_pre_hash.data(), hex_pre_hash.size(), pre_hash.data(), pre_hash.size());
    
    hex_pre_hash.resize(crypto_generichash_BYTES * 2);
    
    return hex_pre_hash;
}

std::string AuthService::hash_password(const std::string& plain_password) {
    std::string peppered_password = apply_pepper(plain_password);

    char hashed[crypto_pwhash_STRBYTES];
    std::memset(hashed, 0, sizeof(hashed));

    if (crypto_pwhash_str(
            hashed,
            peppered_password.c_str(),
            peppered_password.size(),
            crypto_pwhash_OPSLIMIT_INTERACTIVE,
            crypto_pwhash_MEMLIMIT_INTERACTIVE) != 0) {
        throw std::runtime_error("Falha ao gerar hash da senha (memoria insuficiente?).");
    }

    sodium_memzero(peppered_password.data(), peppered_password.size());

    return std::string(hashed);
}

bool AuthService::verify_password(const std::string& plain_password, const std::string& hashed_password) {
    std::string peppered_password = apply_pepper(plain_password);

    bool is_valid = crypto_pwhash_str_verify(
        hashed_password.c_str(),
        peppered_password.c_str(),
        peppered_password.size()
    ) == 0;

    sodium_memzero(peppered_password.data(), peppered_password.size());

    return is_valid;
}
