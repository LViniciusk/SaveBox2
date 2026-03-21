#include "storage/FileChunker.hpp"
#include <iostream>

FileChunker::FileChunker(const std::string& temp_file_path)
    : temp_file_path_(temp_file_path) {
    if (!temp_file_path_.parent_path().empty()) {
        std::filesystem::create_directories(temp_file_path_.parent_path());
    }
}


bool FileChunker::validate_chunk_size(size_t chunk_size) const {
    return chunk_size <= MAX_CHUNK_SIZE;
}


bool FileChunker::write_chunk(uint64_t file_id, int chunk_index, const std::string& binary_data) {
    const uint64_t MAX_ALLOWED_CHUNK = 5 * 1024 * 1024;

    if (binary_data.size() > MAX_ALLOWED_CHUNK) {
        std::cerr << "[SECURITY] Tentativa de upload de chunk maior que 5MB para o arquivo: " << file_id << std::endl;
        return false;
    }

    std::filesystem::create_directories(temp_file_path_);
    auto file_path = temp_file_path_ / (std::to_string(file_id) + ".dat");

    std::fstream fs;
    fs.open(file_path, std::ios::binary | std::ios::in | std::ios::out);

    if (!fs.is_open()) {
        fs.open(file_path, std::ios::binary | std::ios::out);
    }

    if (fs.is_open()) {
        uint64_t offset = static_cast<uint64_t>(chunk_index) * MAX_ALLOWED_CHUNK;

        fs.seekp(offset);
        fs.write(binary_data.data(), static_cast<std::streamsize>(binary_data.size()));
        fs.close();
        return true;
    }

    return false;
}

std::string FileChunker::read_entire_file(uint64_t file_id) const {
    auto file_path = temp_file_path_ / (std::to_string(file_id) + ".dat");

    std::ifstream ifs(file_path, std::ios::binary);
    if (!ifs.is_open()) {
        throw std::runtime_error("NOT_FOUND_ON_DISK");
    }

    return std::string(std::istreambuf_iterator<char>(ifs),
                       std::istreambuf_iterator<char>());
}

size_t FileChunker::get_file_size(uint64_t file_id) const {
    auto file_path = temp_file_path_ / (std::to_string(file_id) + ".dat");
    if (!std::filesystem::exists(file_path)) {
        throw std::runtime_error("NOT_FOUND_ON_DISK");
    }
    return std::filesystem::file_size(file_path);
}

std::string FileChunker::read_file_portion(uint64_t file_id, size_t offset, size_t length) const {
    auto file_path = temp_file_path_ / (std::to_string(file_id) + ".dat");
    std::ifstream ifs(file_path, std::ios::binary);
    if (!ifs.is_open()) {
        throw std::runtime_error("NOT_FOUND_ON_DISK");
    }

    ifs.seekg(offset, std::ios::beg);
    std::string buffer(length, '\0');
    ifs.read(&buffer[0], length);
    buffer.resize(ifs.gcount());
    
    return buffer;
}

void FileChunker::delete_file(uint64_t file_id) const {
    auto file_path = temp_file_path_ / (std::to_string(file_id) + ".dat");
    std::error_code ec;
    if (std::filesystem::exists(file_path, ec)) {
        std::filesystem::remove(file_path, ec);
    }
}

void FileChunker::delete_orphaned_files(const std::unordered_set<uint64_t>& valid_file_ids) const {
    std::error_code ec;
    if (!std::filesystem::exists(temp_file_path_, ec)) {
        return;
    }

    for (const auto& entry : std::filesystem::directory_iterator(temp_file_path_, ec)) {
        if (ec || !entry.is_regular_file()) {
            continue;
        }

        const auto path = entry.path();
        if (path.extension() != ".dat") {
            continue;
        }

        try {
            const auto stem = path.stem().string();
            const uint64_t file_id = std::stoull(stem);
            if (valid_file_ids.find(file_id) == valid_file_ids.end()) {
                std::filesystem::remove(path, ec);
            }
        } catch (...) {
        }
    }
}
