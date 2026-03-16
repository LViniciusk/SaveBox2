#pragma once

#include <string>
#include <vector>
#include <cstdint>

class CryptoService {
public:
    explicit CryptoService(const std::string& master_key);

    std::string encrypt_text(const std::string& plain_text);
    std::string decrypt_text(const std::string& cipher_base64);
    std::string generate_blind_index(const std::string& plain_text) const;

private:
    std::vector<uint8_t> key_;
};
