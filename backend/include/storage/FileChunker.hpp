#pragma once

#include <filesystem>
#include <fstream>
#include <string>
#include <unordered_set>
#include <vector>
#include <cstdint>
#include <cstddef>

class FileChunker {
public:
    static constexpr size_t MAX_CHUNK_SIZE = 50 * 1024 * 1024; // 50 MB

    explicit FileChunker(const std::string& temp_file_path);

    bool validate_chunk_size(size_t chunk_size) const;
    bool write_chunk(uint64_t file_id, int chunk_index, const std::string& binary_data);
    std::string read_entire_file(uint64_t file_id) const;
    size_t get_file_size(uint64_t file_id) const;
    std::string read_file_portion(uint64_t file_id, size_t offset, size_t length) const;
    void delete_file(uint64_t file_id) const;
    void delete_orphaned_files(const std::unordered_set<uint64_t>& valid_file_ids) const;

private:
    std::filesystem::path temp_file_path_;
};
