#include "storage/StorageService.hpp"

StorageService::StorageService(const std::string& base_vault_path)
    : base_vault_path_(base_vault_path) {}

bool StorageService::save_file(const std::string& relative_path,
                               const std::vector<uint8_t>& data) {
    try {
        std::filesystem::path full_path = base_vault_path_ / relative_path;

        std::filesystem::create_directories(full_path.parent_path());

        std::ofstream ofs(full_path, std::ios::binary);
        if (!ofs.is_open()) {
            return false;
        }

        ofs.write(reinterpret_cast<const char*>(data.data()),
                  static_cast<std::streamsize>(data.size()));

        return ofs.good();
    } catch (const std::exception&) {
        return false;
    }
}

std::optional<std::vector<uint8_t>> StorageService::read_file(const std::string& relative_path) {
    try {
        std::filesystem::path full_path = base_vault_path_ / relative_path;

        if (!std::filesystem::exists(full_path)) {
            return std::nullopt;
        }

        std::ifstream ifs(full_path, std::ios::ate | std::ios::binary);
        if (!ifs.is_open()) {
            return std::nullopt;
        }

        auto size = ifs.tellg();
        ifs.seekg(0);

        std::vector<uint8_t> buffer(static_cast<size_t>(size));
        ifs.read(reinterpret_cast<char*>(buffer.data()),
                 static_cast<std::streamsize>(size));

        return buffer;
    } catch (const std::exception&) {
        return std::nullopt;
    }
}

bool StorageService::delete_file(const std::string& relative_path) {
    try {
        std::filesystem::path full_path = base_vault_path_ / relative_path;
        return std::filesystem::remove(full_path);
    } catch (const std::exception&) {
        return false;
    }
}
