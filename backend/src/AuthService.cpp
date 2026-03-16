#include "AuthService.hpp"

#include <sodium.h>
#include <stdexcept>
#include <cstring>

AuthService::AuthService() {
    if (sodium_init() == -1) {
        throw std::runtime_error(
            "Falha crítica: libsodium não pôde ser inicializada."
        );
    }
}

std::string AuthService::hash_password(const std::string& plain_password) {
    char hashed[crypto_pwhash_STRBYTES];
    std::memset(hashed, 0, sizeof(hashed));

    if (crypto_pwhash_str(
            hashed,
            plain_password.c_str(),
            plain_password.size(),
            crypto_pwhash_OPSLIMIT_INTERACTIVE,
            crypto_pwhash_MEMLIMIT_INTERACTIVE) != 0) {
        throw std::runtime_error(
            "Falha ao gerar hash da senha (memória insuficiente?)."
        );
    }

    return std::string(hashed);
}

bool AuthService::verify_password(const std::string& plain_password,
                                  const std::string& hashed_password) {
    return crypto_pwhash_str_verify(
        hashed_password.c_str(),
        plain_password.c_str(),
        plain_password.size()) == 0;
}
