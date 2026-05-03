#include "Services/StorageService.hpp"

namespace {

    std::optional<std::filesystem::path> resolve_safe_path(
        const std::filesystem::path& base, const std::string& relative_path) {
        std::error_code ec;
        std::filesystem::path base_abs = std::filesystem::absolute(base, ec);
        if (ec) {
            return std::nullopt;
        }

        base_abs = base_abs.lexically_normal();
        std::filesystem::path candidate = (base_abs / relative_path).lexically_normal();

        const std::filesystem::path rel = candidate.lexically_relative(base_abs);
        if (rel.empty()) {
            return std::nullopt;
        }

        auto rel_it = rel.begin();
        if (rel_it != rel.end() && *rel_it == "..") {
            return std::nullopt;
        }

        return candidate;
    }

}

StorageService::StorageService(const std::string& base_vault_path)
    : base_vault_path_(base_vault_path) {}

bool StorageService::save_file(const std::string& relative_path,
                               const std::vector<uint8_t>& data) {
    try {
        auto full_path_opt = resolve_safe_path(base_vault_path_, relative_path);
        if (!full_path_opt.has_value()) {
            return false;
        }

        std::filesystem::path full_path = *full_path_opt;

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
        auto full_path_opt = resolve_safe_path(base_vault_path_, relative_path);
        if (!full_path_opt.has_value()) {
            return std::nullopt;
        }

        std::filesystem::path full_path = *full_path_opt;

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
        auto full_path_opt = resolve_safe_path(base_vault_path_, relative_path);
        if (!full_path_opt.has_value()) {
            return false;
        }

        std::filesystem::path full_path = *full_path_opt;
        return std::filesystem::remove(full_path);
    } catch (const std::exception&) {
        return false;
    }
}
