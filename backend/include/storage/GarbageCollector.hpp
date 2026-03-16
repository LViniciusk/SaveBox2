#pragma once

#include "database/DatabasePool.hpp"
#include <filesystem>
#include <string>
#include <cstdint>
#include <cstddef>

class GarbageCollector {
public:
    GarbageCollector(DatabasePool& pool, const std::string& temp_vault_path);

    size_t cleanup_abandoned_uploads(int hours_old);

private:
    DatabasePool& pool_;
    std::filesystem::path temp_vault_path_;
};
