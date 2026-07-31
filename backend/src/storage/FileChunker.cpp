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
        fs.write(binary_data.data(), static_cast<std::streamsize>(binary_data.size()));
        fs.close();
        return true;
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

std::filesystem::path FileChunker::move_path() const {
    return temp_file_path_ / "storage-moves";
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

size_t FileChunker::get_move_file_size(uint64_t move_item_id) const {
    const auto path = move_path() / ("item-" + std::to_string(move_item_id) + ".part");
    if (!std::filesystem::exists(path)) throw std::runtime_error("MOVE_STAGING_NOT_FOUND");
    return std::filesystem::file_size(path);
}

void FileChunker::delete_move_file(uint64_t move_item_id) const {
    std::error_code error;
    std::filesystem::remove(move_path() / ("item-" + std::to_string(move_item_id) + ".part"), error);
}

void FileChunker::promote_move_file(uint64_t move_item_id, uint64_t file_id) {
    std::lock_guard<std::mutex> lock(m_locks[file_id % NUM_STRIPES]);
    const auto source = move_path() / ("item-" + std::to_string(move_item_id) + ".part");
    const auto target = temp_file_path_ / (std::to_string(file_id) + ".dat");
    if (!std::filesystem::exists(source)) throw std::runtime_error("MOVE_STAGING_NOT_FOUND");
    std::error_code error;
    std::filesystem::rename(source, target, error);
    if (error) throw std::runtime_error("MOVE_STAGING_PROMOTION_FAILED");
}

void FileChunker::promote_move_proxy(uint64_t move_item_id, uint64_t file_id) {
    const auto source = move_path() / ("item-" + std::to_string(move_item_id) + ".part");
    const auto target = temp_file_path_ / (std::to_string(file_id) + ".proxy.dat");
    std::error_code error;
    std::filesystem::rename(source, target, error);
    if (error) throw std::runtime_error("MOVE_STAGING_PROMOTION_FAILED");
}

void FileChunker::demote_move_file(uint64_t move_item_id, uint64_t file_id) {
    std::lock_guard<std::mutex> lock(m_locks[file_id % NUM_STRIPES]);
    const auto source = temp_file_path_ / (std::to_string(file_id) + ".dat");
    const auto target = move_path() / ("item-" + std::to_string(move_item_id) + ".part");
    std::error_code error;
    if (std::filesystem::exists(source)) std::filesystem::rename(source, target, error);
    if (error) throw std::runtime_error("STORAGE_MOVE_ROLLBACK_FAILED");
}

void FileChunker::demote_move_proxy(uint64_t move_item_id, uint64_t file_id) {
    const auto source = temp_file_path_ / (std::to_string(file_id) + ".proxy.dat");
    const auto target = move_path() / ("item-" + std::to_string(move_item_id) + ".part");
    std::error_code error;
    if (std::filesystem::exists(source)) std::filesystem::rename(source, target, error);
    if (error) throw std::runtime_error("STORAGE_MOVE_ROLLBACK_FAILED");
}

size_t FileChunker::get_proxy_file_size(uint64_t file_id) const {
    const auto path = temp_file_path_ / (std::to_string(file_id) + ".proxy.dat");
    if (!std::filesystem::exists(path)) throw std::runtime_error("NOT_FOUND_ON_DISK");
    return std::filesystem::file_size(path);
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
    std::filesystem::create_directories(move_path());
    const auto source = temp_file_path_ / (std::to_string(file_id) + ".dat");
    const auto target = move_path() / ("cleanup-" + std::to_string(move_job_id) + ".dat");
    std::error_code error;
    std::filesystem::rename(source, target, error);
    if (error) throw std::runtime_error("SOURCE_QUARANTINE_FAILED");
}

void FileChunker::quarantine_proxy(uint64_t file_id, uint64_t move_job_id) {
    const auto source = temp_file_path_ / (std::to_string(file_id) + ".proxy.dat");
    if (!std::filesystem::exists(source)) return;
    std::filesystem::create_directories(move_path());
    std::error_code error;
    std::filesystem::rename(source, move_path() / ("cleanup-" + std::to_string(move_job_id) + ".proxy.dat"), error);
    if (error) throw std::runtime_error("SOURCE_QUARANTINE_FAILED");
}

void FileChunker::restore_quarantined_file(uint64_t file_id, uint64_t move_job_id) {
    const auto source = move_path() / ("cleanup-" + std::to_string(move_job_id) + ".dat");
    const auto target = temp_file_path_ / (std::to_string(file_id) + ".dat");
    std::error_code error;
    if (std::filesystem::exists(source)) std::filesystem::rename(source, target, error);
}

void FileChunker::restore_quarantined_proxy(uint64_t file_id, uint64_t move_job_id) {
    const auto source = move_path() / ("cleanup-" + std::to_string(move_job_id) + ".proxy.dat");
    const auto target = temp_file_path_ / (std::to_string(file_id) + ".proxy.dat");
    std::error_code error;
    if (std::filesystem::exists(source)) std::filesystem::rename(source, target, error);
}

void FileChunker::delete_quarantined_file(uint64_t move_job_id) const {
    std::error_code error;
    std::filesystem::remove(move_path() / ("cleanup-" + std::to_string(move_job_id) + ".dat"), error);
    if (error) throw std::runtime_error("SOURCE_CLEANUP_FAILED");
    error.clear();
    std::filesystem::remove(move_path() / ("cleanup-" + std::to_string(move_job_id) + ".proxy.dat"), error);
}

void FileChunker::delete_orphaned_move_files(const std::unordered_set<uint64_t>& valid_item_ids,
                                             const std::unordered_set<uint64_t>& cleanup_job_ids) const {
    std::error_code error;
    if (!std::filesystem::exists(move_path(), error)) return;
    for (const auto& entry : std::filesystem::directory_iterator(move_path(), error)) {
        if (error || !entry.is_regular_file()) continue;
        const std::string name = entry.path().filename().string();
        try {
            if (name.rfind("item-",0) == 0) {
                const uint64_t id = std::stoull(name.substr(5));
                if (!valid_item_ids.count(id)) std::filesystem::remove(entry.path(),error);
            } else if (name.rfind("cleanup-",0) == 0) {
                const uint64_t id = std::stoull(name.substr(8));
                if (!cleanup_job_ids.count(id)) std::filesystem::remove(entry.path(),error);
            }
        } catch (...) {
        }
    }
}
