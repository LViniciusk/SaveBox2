#pragma once

#include <filesystem>
#include <fstream>
#include <string>
#include <unordered_set>
#include <vector>
#include <mutex>
#include <array>
#include <cstdint>
#include <cstddef>
#include <optional>

class FileChunker {
public:
    static constexpr size_t MAX_CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB
    static constexpr size_t NUM_STRIPES = 256;

    explicit FileChunker(const std::string& temp_file_path);

    bool validate_chunk_size(size_t chunk_size) const;
    bool write_chunk(uint64_t file_id, int chunk_index, const std::string& binary_data);
    std::string read_entire_file(uint64_t file_id) const;
    size_t get_file_size(uint64_t file_id) const;
    std::string read_file_portion(uint64_t file_id, size_t offset, size_t length) const;
    void delete_file(uint64_t file_id) const;
    std::vector<std::string> snapshot_canonical_files() const;
    void delete_orphaned_files(const std::vector<std::string>& candidates,
                               const std::unordered_set<uint64_t>& valid_file_ids) const;
    bool write_move_chunk(uint64_t move_item_id, int chunk_index, const std::string& binary_data);
    std::optional<uint64_t> try_get_move_file_size(uint64_t move_item_id) const;
    size_t get_move_file_size(uint64_t move_item_id) const;
    void delete_move_file(uint64_t move_item_id) const;
    void promote_move_file(uint64_t move_item_id, uint64_t file_id);
    void promote_move_proxy(uint64_t move_item_id, uint64_t file_id);
    void demote_move_file(uint64_t move_item_id, uint64_t file_id);
    void demote_move_proxy(uint64_t move_item_id, uint64_t file_id);
    std::optional<uint64_t> try_get_file_size(uint64_t file_id) const;
    std::optional<uint64_t> try_get_proxy_file_size(uint64_t file_id) const;
    void delete_uncommitted_move_target(uint64_t file_id, bool proxy) const;
    std::string read_proxy_file_portion(uint64_t file_id, size_t offset, size_t length) const;
    void quarantine_file(uint64_t file_id, uint64_t move_job_id);
    std::optional<uint64_t> try_get_quarantined_file_size(uint64_t move_job_id) const;
    void restore_quarantined_file(uint64_t file_id, uint64_t move_job_id);
    void delete_quarantined_file(uint64_t move_job_id) const;
    void quarantine_proxy(uint64_t file_id, uint64_t move_job_id);
    std::optional<uint64_t> try_get_quarantined_proxy_size(uint64_t move_job_id) const;
    void restore_quarantined_proxy(uint64_t file_id, uint64_t move_job_id);
    std::vector<std::string> snapshot_move_artifacts() const;
    void delete_orphaned_move_files(const std::vector<std::string>& candidates,
                                    const std::unordered_set<uint64_t>& valid_item_ids,
                                    const std::unordered_set<uint64_t>& protected_cleanup_job_ids) const;

private:
    std::filesystem::path temp_file_path_;
    mutable std::array<std::mutex, NUM_STRIPES> m_locks;
    std::filesystem::path move_path() const;
    std::optional<uint64_t> try_file_size(const std::filesystem::path& path) const;
};
