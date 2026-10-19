#pragma once

#include <string>
#include <stdexcept>
#include <openssl/rand.h>
#include <random>

namespace UuidUtils {

    static inline std::string generate_uuid_v4() {
        static constexpr char kHex[] = "0123456789abcdef";

        unsigned char bytes[16];
        if (RAND_bytes(bytes, sizeof(bytes)) != 1) {
            throw std::runtime_error("CSPRNG_FAILURE");
        }

        bytes[6] = (bytes[6] & 0x0F) | 0x40;
        bytes[8] = (bytes[8] & 0x3F) | 0x80;

        std::string uuid;
        uuid.reserve(36);

        auto append_hex = [&](int idx) {
            uuid.push_back(kHex[(bytes[idx] >> 4) & 0x0F]);
            uuid.push_back(kHex[bytes[idx] & 0x0F]);
        };

        for (int i = 0; i < 4; ++i) append_hex(i);
        uuid.push_back('-');
        for (int i = 4; i < 6; ++i) append_hex(i);
        uuid.push_back('-');
        for (int i = 6; i < 8; ++i) append_hex(i);
        uuid.push_back('-');
        for (int i = 8; i < 10; ++i) append_hex(i);
        uuid.push_back('-');
        for (int i = 10; i < 16; ++i) append_hex(i);

        return uuid;
    }

} // namespace UuidUtils

class Base62Generator {
public:
    static inline std::string mock_next_token = "";

    static std::string generate(int length) {
        if (!mock_next_token.empty()) {
            std::string token = mock_next_token;
            mock_next_token = ""; 
            return token;
        }

        static const char charset[] = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
        static const size_t max_index = sizeof(charset) - 2; 

        thread_local std::random_device rd;
        thread_local std::mt19937_64 gen(rd());
        std::uniform_int_distribution<size_t> dist(0, max_index);

        std::string result;
        result.reserve(length);
        for (int i = 0; i < length; ++i) {
            result += charset[dist(gen)];
        }
        return result;
    }
};