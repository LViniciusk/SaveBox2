#pragma once

#include <filesystem>
#include <fstream>
#include <string>
#include <vector>
#include <cstdint>
#include <cstddef>

class FileChunker {
public:
    static constexpr size_t MAX_CHUNK_SIZE = 50 * 1024 * 1024; // 50 MB

    explicit FileChunker(const std::string& temp_file_path);

    bool validate_chunk_size(size_t chunk_size) const;
    bool append_chunk(const std::vector<uint8_t>& chunk_data);
    size_t get_current_size() const;
    bool finalize_upload(size_t expected_total_size) const;

private:
    std::filesystem::path temp_file_path_;
};
