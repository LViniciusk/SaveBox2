#pragma once

#include <random>
#include <string>

namespace UuidUtils {

    static inline std::string generate_uuid_v4() {
        static constexpr char kHex[] = "0123456789abcdef";

        thread_local std::mt19937 gen([]() {
            std::random_device rd;
            std::seed_seq seed{rd(), rd(), rd(), rd(), rd(), rd(), rd(), rd()};
            return std::mt19937(seed);
        }());

        std::uniform_int_distribution<int> hex_dist(0, 15);
        std::uniform_int_distribution<int> variant_dist(8, 11);

        std::string uuid;
        uuid.reserve(36);

        for (int i = 0; i < 8; ++i) uuid.push_back(kHex[hex_dist(gen)]);
        uuid.push_back('-');
        for (int i = 0; i < 4; ++i) uuid.push_back(kHex[hex_dist(gen)]);
        uuid.push_back('-');
        uuid.push_back('4');
        for (int i = 0; i < 3; ++i) uuid.push_back(kHex[hex_dist(gen)]);
        uuid.push_back('-');
        uuid.push_back(kHex[variant_dist(gen)]);
        for (int i = 0; i < 3; ++i) uuid.push_back(kHex[hex_dist(gen)]);
        uuid.push_back('-');
        for (int i = 0; i < 12; ++i) uuid.push_back(kHex[hex_dist(gen)]);

        return uuid;
    }

}
 