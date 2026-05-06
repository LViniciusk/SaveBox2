#include "database/DatabasePool.hpp"
#include <stdexcept>




DatabasePool::ConnectionWrapper::ConnectionWrapper(
    DatabasePool* pool, std::unique_ptr<pqxx::connection> conn)
    : pool_(pool), conn_(std::move(conn)) {}

DatabasePool::ConnectionWrapper::~ConnectionWrapper() {
    if (pool_) {
        pool_->release_connection(std::move(conn_));
    }
}

DatabasePool::ConnectionWrapper::ConnectionWrapper(ConnectionWrapper&& other) noexcept
    : pool_(other.pool_), conn_(std::move(other.conn_)) {
    other.pool_ = nullptr;
}

DatabasePool::ConnectionWrapper&
DatabasePool::ConnectionWrapper::operator=(ConnectionWrapper&& other) noexcept {
    if (this != &other) {
        if (pool_ && conn_) {
            pool_->release_connection(std::move(conn_));
        }
        pool_ = other.pool_;
        conn_ = std::move(other.conn_);
        other.pool_ = nullptr;
    }
    return *this;
}

pqxx::connection& DatabasePool::ConnectionWrapper::operator*() {
    return *conn_;
}

pqxx::connection* DatabasePool::ConnectionWrapper::operator->() {
    return conn_.get();
}

bool DatabasePool::ConnectionWrapper::is_valid() const {
    return conn_ != nullptr;
}




DatabasePool::DatabasePool(size_t pool_size, const std::string& conn_str)
    : connection_string_(conn_str) {
    for (size_t i = 0; i < pool_size; ++i) {
        std::unique_ptr<pqxx::connection> conn;
        if (!connection_string_.empty()) {
            conn = std::make_unique<pqxx::connection>(connection_string_);
        }
        connections_.push(std::move(conn));
    }
}

DatabasePool::~DatabasePool() {
    close_all_connections();
}

DatabasePool::ConnectionWrapper DatabasePool::acquire_connection() {
    std::unique_lock<std::mutex> lock(mutex_);

    if (is_shutting_down_) {
        throw std::runtime_error("SERVER_IS_SHUTTING_DOWN");
    }

    // Bloqueia a thread atual caso não haja conexões disponíveis no pool
    condition_.wait(lock, [this]() { return !connections_.empty() || is_shutting_down_.load(); });

    if (is_shutting_down_) {
        throw std::runtime_error("SERVER_IS_SHUTTING_DOWN");
    }

    auto conn = std::move(connections_.front());
    connections_.pop();

    if (conn && !conn->is_open()) {
        if (connection_string_.empty()) {
            throw std::runtime_error("DATABASE_OFFLINE");
        }

        try {
            conn = std::make_unique<pqxx::connection>(connection_string_);
        } catch (...) {
            throw std::runtime_error("DATABASE_OFFLINE");
        }
    }

    if (!conn && !connection_string_.empty()) {
        try {
            conn = std::make_unique<pqxx::connection>(connection_string_);
        } catch (...) {
            throw std::runtime_error("DATABASE_OFFLINE");
        }
    }

    return ConnectionWrapper(this, std::move(conn));
}

size_t DatabasePool::get_available_count() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return connections_.size();
}

void DatabasePool::release_connection(std::unique_ptr<pqxx::connection> conn) {
    {
        std::lock_guard<std::mutex> lock(mutex_);

        if (is_shutting_down_) {
            if (conn && conn->is_open()) {
                conn->close();
            }
            return;
        }

        connections_.push(std::move(conn));
    }
    // Notifica uma das threads que estava esperando por uma conexão
    condition_.notify_one();
}

void DatabasePool::close_all_connections() {
    std::lock_guard<std::mutex> lock(mutex_);
    is_shutting_down_ = true;

    while (!connections_.empty()) {
        auto conn = std::move(connections_.front());
        connections_.pop();

        if (conn && conn->is_open()) {
            conn->close();
        }
    }

    condition_.notify_all();
}
