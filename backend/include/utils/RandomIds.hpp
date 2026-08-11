#pragma once

#include <string>
#include <stdexcept>
#include <array>
#include <cstddef>
#include <openssl/rand.h>
#include <string_view>
#ifdef NANIKA_TESTING
#include <memory>
#endif

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
#ifdef NANIKA_TESTING
    static std::string& test_next_token() {
        static thread_local auto token = std::make_unique<std::string>();
        return *token;
    }
#endif

    static std::string generate(std::size_t length) {
#ifdef NANIKA_TESTING
        if (!test_next_token().empty()) {
            std::string token = test_next_token();
            test_next_token().clear();
            return token;
        }
#endif

        static constexpr std::string_view charset =
            "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
        static constexpr unsigned char ACCEPTED_LIMIT = 248;
        std::array<unsigned char, 64> random_bytes{};

        std::string result;
        result.reserve(length);
        while (result.size() < length) {
            if (RAND_bytes(random_bytes.data(), static_cast<int>(random_bytes.size())) != 1) {
                throw std::runtime_error("CSPRNG_FAILURE");
            }
            for (const unsigned char value : random_bytes) {
                if (value >= ACCEPTED_LIMIT) continue;
                result.push_back(charset[value % charset.size()]);
                if (result.size() == length) break;
            }
        }
        return result;
    }
};
