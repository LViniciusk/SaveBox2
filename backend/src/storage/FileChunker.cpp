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
