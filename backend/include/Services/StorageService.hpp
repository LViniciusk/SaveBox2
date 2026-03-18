#pragma once

#include <filesystem>
#include <fstream>
#include <optional>
#include <string>
#include <vector>
#include <cstdint>

class StorageService {
public:
    explicit StorageService(const std::string& base_vault_path);

    bool save_file(const std::string& relative_path, const std::vector<uint8_t>& data);
    std::optional<std::vector<uint8_t>> read_file(const std::string& relative_path);
    bool delete_file(const std::string& relative_path);

private:
    std::filesystem::path base_vault_path_;
};
