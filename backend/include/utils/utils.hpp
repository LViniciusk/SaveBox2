#pragma once

#include <string>
#include <stdexcept>
#include <openssl/rand.h>

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

}