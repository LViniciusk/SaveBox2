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

bool FileChunker::append_chunk(const std::vector<uint8_t>& chunk_data) {
    try {
        std::ofstream ofs(temp_file_path_, std::ios::binary | std::ios::app);
        if (!ofs.is_open()) {
            return false;
        }

        ofs.write(reinterpret_cast<const char*>(chunk_data.data()),
                  static_cast<std::streamsize>(chunk_data.size()));

        return ofs.good();
    } catch (const std::exception&) {
        return false;
    }
}

size_t FileChunker::get_current_size() const {
    try {
        if (!std::filesystem::exists(temp_file_path_)) {
            return 0;
        }
        return static_cast<size_t>(std::filesystem::file_size(temp_file_path_));
    } catch (const std::filesystem::filesystem_error&) {
        return 0;
    }
}

bool FileChunker::finalize_upload(size_t expected_total_size) const {
    return get_current_size() == expected_total_size;
}

void FileChunker::append_chunk(uint64_t file_id, int chunk_index, const std::string& binary_data) {
    const uint64_t MAX_ALLOWED_CHUNK = 5 * 1024 * 1024;

    if (binary_data.size() > MAX_ALLOWED_CHUNK) {
        std::cerr << "[SECURITY] Tentativa de upload de chunk maior que 5MB para o arquivo: " << file_id << std::endl;
        return; 
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
    }
}
