#include "storage/FileChunker.hpp"

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
