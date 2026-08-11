#include "storage/FileChunker.hpp"
#include <iostream>
#include <limits>
#include <string_view>

namespace {
std::optional<uint64_t> parse_decimal_id(std::string_view digits) {
    if (digits.empty()) return std::nullopt;
    uint64_t value = 0;
    for (const char character : digits) {
        if (character < '0' || character > '9') return std::nullopt;
        const uint64_t digit = static_cast<uint64_t>(character - '0');
        if (value > (std::numeric_limits<uint64_t>::max() - digit) / 10) return std::nullopt;
        value = value * 10 + digit;
    }
    return value;
}

std::optional<uint64_t> parse_move_artifact_id(const std::string& name) {
    const auto parse_between = [&name](std::string_view prefix, std::string_view suffix) {
        if (name.size() <= prefix.size() + suffix.size() ||
            name.compare(0, prefix.size(), prefix) != 0 ||
            name.compare(name.size() - suffix.size(), suffix.size(), suffix) != 0) {
            return std::optional<uint64_t>{};
        }
        return parse_decimal_id(std::string_view(name).substr(
            prefix.size(), name.size() - prefix.size() - suffix.size()));
    };

    if (const auto id = parse_between("item-", ".part")) return id;
    if (const auto id = parse_between("cleanup-", ".proxy.dat")) return id;
    return parse_between("cleanup-", ".dat");
}

std::optional<uint64_t> parse_canonical_file_id(const std::string& name) {
    const auto parse_between = [&name](std::string_view suffix) {
        if (name.size() <= suffix.size() ||
            name.compare(name.size() - suffix.size(), suffix.size(), suffix) != 0) {
            return std::optional<uint64_t>{};
        }
        return parse_decimal_id(std::string_view(name).substr(0, name.size() - suffix.size()));
    };

    if (const auto id = parse_between(".proxy.dat")) return id;
    return parse_between(".dat");
}
}

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
    std::lock_guard<std::mutex> lock(m_locks[file_id % NUM_STRIPES]);

    const uint64_t MAX_ALLOWED_CHUNK = 4 * 1024 * 1024;

    if (binary_data.size() > MAX_ALLOWED_CHUNK) {
        std::cerr << "[SECURITY] Tentativa de upload de chunk maior que 4MB para o arquivo: " << file_id << std::endl;
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
        if (!fs) return false;

        fs.write(binary_data.data(), static_cast<std::streamsize>(binary_data.size()));
        if (!fs) return false;

        fs.flush();
        if (!fs) return false;

        fs.close();
        return !fs.fail();
    }

    return false;
}

std::string FileChunker::read_entire_file(uint64_t file_id) const {
    auto file_path = temp_file_path_ / (std::to_string(file_id) + ".dat");

    std::ifstream ifs(file_path, std::ios::binary);
    if (!ifs.is_open() || !ifs.good()) {
        throw std::runtime_error("NOT_FOUND_ON_DISK");
    }

    std::string content{std::istreambuf_iterator<char>(ifs),
                        std::istreambuf_iterator<char>()};

    if (ifs.fail() && !ifs.eof()) {
        throw std::runtime_error("IO_RESOURCE_EXHAUSTED");
    }

    return content;
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
    if (!ifs.is_open() || !ifs.good()) {
        throw std::runtime_error("NOT_FOUND_ON_DISK");
    }

    ifs.seekg(offset, std::ios::beg);
    std::string buffer(length, '\0');
    ifs.read(&buffer[0], length);
    buffer.resize(ifs.gcount());

    if (ifs.fail() && !ifs.eof()) {
        throw std::runtime_error("IO_RESOURCE_EXHAUSTED");
    }

    return buffer;
}

void FileChunker::delete_file(uint64_t file_id) const {
    auto file_path = temp_file_path_ / (std::to_string(file_id) + ".dat");
    std::error_code ec;
    if (std::filesystem::exists(file_path, ec)) {
        std::filesystem::remove(file_path, ec);
    }
}

std::vector<std::string> FileChunker::snapshot_canonical_files() const {
    std::vector<std::string> candidates;
    std::error_code ec;
    if (!std::filesystem::exists(temp_file_path_, ec)) {
        return candidates;
    }

    for (const auto& entry : std::filesystem::directory_iterator(temp_file_path_, ec)) {
        if (ec || !entry.is_regular_file()) {
            continue;
        }

        const auto filename = entry.path().filename().string();
        if (parse_canonical_file_id(filename)) candidates.push_back(filename);
    }
    return candidates;
}

void FileChunker::delete_orphaned_files(
    const std::vector<std::string>& candidates,
    const std::unordered_set<uint64_t>& valid_file_ids) const {
    for (const auto& filename : candidates) {
        const auto file_id = parse_canonical_file_id(filename);
        if (!file_id || std::filesystem::path(filename).filename().string() != filename) continue;
        if (valid_file_ids.find(*file_id) != valid_file_ids.end()) continue;

        std::error_code remove_error;
        std::filesystem::remove(temp_file_path_ / filename, remove_error);
    }
}

std::filesystem::path FileChunker::move_path() const {
    return temp_file_path_ / "storage-moves";
}

std::optional<uint64_t> FileChunker::try_file_size(const std::filesystem::path& path) const {
    std::error_code error;
    if (std::filesystem::is_directory(path, error)) {
        throw std::runtime_error("STORAGE_MOVE_FILESYSTEM_ERROR");
    }
    const auto size = std::filesystem::file_size(path, error);
    if (!error) return static_cast<uint64_t>(size);
    if (error == std::errc::no_such_file_or_directory) return std::nullopt;
    throw std::runtime_error("STORAGE_MOVE_FILESYSTEM_ERROR");
}

bool FileChunker::write_move_chunk(uint64_t move_item_id, int chunk_index, const std::string& binary_data) {
    if (chunk_index < 0 || !validate_chunk_size(binary_data.size())) return false;
    std::lock_guard<std::mutex> lock(m_locks[move_item_id % NUM_STRIPES]);
    std::filesystem::create_directories(move_path());
    const auto path = move_path() / ("item-" + std::to_string(move_item_id) + ".part");
    std::fstream stream(path, std::ios::binary | std::ios::in | std::ios::out);
    if (!stream.is_open()) stream.open(path, std::ios::binary | std::ios::out);
    if (!stream.is_open()) return false;
    stream.seekp(static_cast<uint64_t>(chunk_index) * MAX_CHUNK_SIZE);
    stream.write(binary_data.data(), static_cast<std::streamsize>(binary_data.size()));
    return stream.good();
}

std::optional<uint64_t> FileChunker::try_get_move_file_size(uint64_t move_item_id) const {
    return try_file_size(move_path() / ("item-" + std::to_string(move_item_id) + ".part"));
}

size_t FileChunker::get_move_file_size(uint64_t move_item_id) const {
    const auto size = try_get_move_file_size(move_item_id);
    if (!size) throw std::runtime_error("MOVE_STAGING_NOT_FOUND");
    return *size;
}

void FileChunker::delete_move_file(uint64_t move_item_id) const {
    std::error_code error;
    std::filesystem::remove(move_path() / ("item-" + std::to_string(move_item_id) + ".part"), error);
}

void FileChunker::promote_move_file(uint64_t move_item_id, uint64_t file_id) {
    std::lock_guard<std::mutex> lock(m_locks[file_id % NUM_STRIPES]);
    const auto source = move_path() / ("item-" + std::to_string(move_item_id) + ".part");
    const auto target = temp_file_path_ / (std::to_string(file_id) + ".dat");
    if (!try_file_size(source)) throw std::runtime_error("MOVE_STAGING_NOT_FOUND");
    if (try_file_size(target)) throw std::runtime_error("STORAGE_MOVE_TARGET_CONFLICT");
    std::error_code error;
    std::filesystem::rename(source, target, error);
    if (error) throw std::runtime_error("MOVE_STAGING_PROMOTION_FAILED");
}

void FileChunker::promote_move_proxy(uint64_t move_item_id, uint64_t file_id) {
    std::lock_guard<std::mutex> lock(m_locks[file_id % NUM_STRIPES]);
    const auto source = move_path() / ("item-" + std::to_string(move_item_id) + ".part");
    const auto target = temp_file_path_ / (std::to_string(file_id) + ".proxy.dat");
    if (!try_file_size(source)) throw std::runtime_error("MOVE_STAGING_NOT_FOUND");
    if (try_file_size(target)) throw std::runtime_error("STORAGE_MOVE_TARGET_CONFLICT");
    std::error_code error;
    std::filesystem::rename(source, target, error);
    if (error) throw std::runtime_error("MOVE_STAGING_PROMOTION_FAILED");
}

void FileChunker::demote_move_file(uint64_t move_item_id, uint64_t file_id) {
    std::lock_guard<std::mutex> lock(m_locks[file_id % NUM_STRIPES]);
    const auto source = temp_file_path_ / (std::to_string(file_id) + ".dat");
    const auto target = move_path() / ("item-" + std::to_string(move_item_id) + ".part");
    std::error_code error;
    if (try_file_size(target)) throw std::runtime_error("STORAGE_MOVE_ROLLBACK_FAILED");
    if (!try_file_size(source)) throw std::runtime_error("STORAGE_MOVE_ROLLBACK_FAILED");
    std::filesystem::rename(source, target, error);
    if (error) throw std::runtime_error("STORAGE_MOVE_ROLLBACK_FAILED");
}

void FileChunker::demote_move_proxy(uint64_t move_item_id, uint64_t file_id) {
    std::lock_guard<std::mutex> lock(m_locks[file_id % NUM_STRIPES]);
    const auto source = temp_file_path_ / (std::to_string(file_id) + ".proxy.dat");
    const auto target = move_path() / ("item-" + std::to_string(move_item_id) + ".part");
    std::error_code error;
    if (try_file_size(target)) throw std::runtime_error("STORAGE_MOVE_ROLLBACK_FAILED");
    if (!try_file_size(source)) throw std::runtime_error("STORAGE_MOVE_ROLLBACK_FAILED");
    std::filesystem::rename(source, target, error);
    if (error) throw std::runtime_error("STORAGE_MOVE_ROLLBACK_FAILED");
}

std::optional<uint64_t> FileChunker::try_get_file_size(uint64_t file_id) const {
    return try_file_size(temp_file_path_ / (std::to_string(file_id) + ".dat"));
}

std::optional<uint64_t> FileChunker::try_get_proxy_file_size(uint64_t file_id) const {
    return try_file_size(temp_file_path_ / (std::to_string(file_id) + ".proxy.dat"));
}

void FileChunker::delete_uncommitted_move_target(uint64_t file_id, bool proxy) const {
    std::lock_guard<std::mutex> lock(m_locks[file_id % NUM_STRIPES]);
    std::error_code error;
    std::filesystem::remove(temp_file_path_ / (std::to_string(file_id) + (proxy ? ".proxy.dat" : ".dat")), error);
    if (error) throw std::runtime_error("STORAGE_MOVE_FILESYSTEM_ERROR");
}

std::string FileChunker::read_proxy_file_portion(uint64_t file_id, size_t offset, size_t length) const {
    const auto path = temp_file_path_ / (std::to_string(file_id) + ".proxy.dat");
    std::ifstream stream(path, std::ios::binary);
    if (!stream.is_open()) throw std::runtime_error("NOT_FOUND_ON_DISK");
    stream.seekg(offset);
    std::string data(length, '\0');
    stream.read(data.data(), static_cast<std::streamsize>(length));
    data.resize(static_cast<size_t>(stream.gcount()));
    return data;
}

void FileChunker::quarantine_file(uint64_t file_id, uint64_t move_job_id) {
    std::lock_guard<std::mutex> lock(m_locks[file_id % NUM_STRIPES]);
    const auto source = temp_file_path_ / (std::to_string(file_id) + ".dat");
    const auto target = move_path() / ("cleanup-" + std::to_string(move_job_id) + ".dat");
    if (!try_file_size(source)) throw std::runtime_error("SOURCE_QUARANTINE_FAILED");
    if (try_file_size(target)) throw std::runtime_error("STORAGE_MOVE_TARGET_CONFLICT");
    std::error_code create_error;
    std::filesystem::create_directories(move_path(), create_error);
    if (create_error) throw std::runtime_error("SOURCE_QUARANTINE_FAILED");
    std::error_code error;
    std::filesystem::rename(source, target, error);
    if (error) throw std::runtime_error("SOURCE_QUARANTINE_FAILED");
}

std::optional<uint64_t> FileChunker::try_get_quarantined_file_size(uint64_t move_job_id) const {
    return try_file_size(move_path() / ("cleanup-" + std::to_string(move_job_id) + ".dat"));
}

void FileChunker::quarantine_proxy(uint64_t file_id, uint64_t move_job_id) {
    std::lock_guard<std::mutex> lock(m_locks[file_id % NUM_STRIPES]);
    const auto source = temp_file_path_ / (std::to_string(file_id) + ".proxy.dat");
    const auto target = move_path() / ("cleanup-" + std::to_string(move_job_id) + ".proxy.dat");
    if (!try_file_size(source)) throw std::runtime_error("SOURCE_QUARANTINE_FAILED");
    if (try_file_size(target)) throw std::runtime_error("STORAGE_MOVE_TARGET_CONFLICT");
    std::error_code create_error;
    std::filesystem::create_directories(move_path(), create_error);
    if (create_error) throw std::runtime_error("SOURCE_QUARANTINE_FAILED");
    std::error_code error;
    std::filesystem::rename(source, target, error);
    if (error) throw std::runtime_error("SOURCE_QUARANTINE_FAILED");
}

std::optional<uint64_t> FileChunker::try_get_quarantined_proxy_size(uint64_t move_job_id) const {
    return try_file_size(move_path() / ("cleanup-" + std::to_string(move_job_id) + ".proxy.dat"));
}

void FileChunker::restore_quarantined_file(uint64_t file_id, uint64_t move_job_id) {
    std::lock_guard<std::mutex> lock(m_locks[file_id % NUM_STRIPES]);
    const auto source = move_path() / ("cleanup-" + std::to_string(move_job_id) + ".dat");
    const auto target = temp_file_path_ / (std::to_string(file_id) + ".dat");
    const auto source_size = try_file_size(source);
    const auto target_size = try_file_size(target);
    if (source_size && target_size) throw std::runtime_error("STORAGE_MOVE_TARGET_CONFLICT");
    if (target_size && !source_size) return;
    if (!source_size && !target_size) throw std::runtime_error("STORAGE_MOVE_ROLLBACK_FAILED");
    std::error_code error;
    std::filesystem::rename(source, target, error);
    if (error) throw std::runtime_error("STORAGE_MOVE_ROLLBACK_FAILED");
}

void FileChunker::restore_quarantined_proxy(uint64_t file_id, uint64_t move_job_id) {
    std::lock_guard<std::mutex> lock(m_locks[file_id % NUM_STRIPES]);
    const auto source = move_path() / ("cleanup-" + std::to_string(move_job_id) + ".proxy.dat");
    const auto target = temp_file_path_ / (std::to_string(file_id) + ".proxy.dat");
    const auto source_size = try_file_size(source);
    const auto target_size = try_file_size(target);
    if (source_size && target_size) throw std::runtime_error("STORAGE_MOVE_TARGET_CONFLICT");
    if (target_size && !source_size) return;
    if (!source_size && !target_size) throw std::runtime_error("STORAGE_MOVE_ROLLBACK_FAILED");
    std::error_code error;
    std::filesystem::rename(source, target, error);
    if (error) throw std::runtime_error("STORAGE_MOVE_ROLLBACK_FAILED");
}

void FileChunker::delete_quarantined_file(uint64_t move_job_id) const {
    std::error_code error;
    std::filesystem::remove(move_path() / ("cleanup-" + std::to_string(move_job_id) + ".dat"), error);
    if (error) throw std::runtime_error("SOURCE_CLEANUP_FAILED");
    error.clear();
    std::filesystem::remove(move_path() / ("cleanup-" + std::to_string(move_job_id) + ".proxy.dat"), error);
    if (error) throw std::runtime_error("SOURCE_CLEANUP_FAILED");
}

std::vector<std::string> FileChunker::snapshot_move_artifacts() const {
    std::vector<std::string> candidates;
    std::error_code error;
    if (!std::filesystem::exists(move_path(), error)) return candidates;
    for (const auto& entry : std::filesystem::directory_iterator(move_path(), error)) {
        if (error || !entry.is_regular_file()) continue;
        const auto name = entry.path().filename().string();
        if (parse_move_artifact_id(name)) candidates.push_back(name);
    }
    return candidates;
}

void FileChunker::delete_orphaned_move_files(const std::vector<std::string>& candidates,
                                             const std::unordered_set<uint64_t>& valid_item_ids,
                                             const std::unordered_set<uint64_t>& protected_cleanup_job_ids) const {
    for (const auto& name : candidates) {
        if (std::filesystem::path(name).filename().string() != name) continue;
        const auto id = parse_move_artifact_id(name);
        if (!id) continue;
        const bool is_cleanup = name.rfind("cleanup-", 0) == 0;
        const bool protected_artifact = is_cleanup
            ? protected_cleanup_job_ids.count(*id) > 0
            : valid_item_ids.count(*id) > 0;
        if (!protected_artifact) {
            std::error_code remove_error;
            std::filesystem::remove(move_path() / name, remove_error);
        }
    }
}
