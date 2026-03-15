#pragma once

#include <pqxx/pqxx>
#include <queue>
#include <mutex>
#include <condition_variable>
#include <memory>
#include <string>

class DatabasePool {
public:
    // O ConnectionWrapper implementa o RAII para devolver a conexão ao pool
    class ConnectionWrapper {
    public:
        ConnectionWrapper(DatabasePool* pool, std::unique_ptr<pqxx::connection> conn)
            : pool_(pool), conn_(std::move(conn)) {}

        ~ConnectionWrapper() {
            if (pool_) {
                pool_->release_connection(std::move(conn_));
            }
        }

        // Delete do construtor de cópia e operador de atribuição de cópia
        ConnectionWrapper(const ConnectionWrapper&) = delete;
        ConnectionWrapper& operator=(const ConnectionWrapper&) = delete;

        // Habilita move semantics
        ConnectionWrapper(ConnectionWrapper&& other) noexcept
            : pool_(other.pool_), conn_(std::move(other.conn_)) {
            other.pool_ = nullptr;
        }

        ConnectionWrapper& operator=(ConnectionWrapper&& other) noexcept {
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

        // Acesso à conexão do pqxx
        pqxx::connection& operator*() { return *conn_; }
        pqxx::connection* operator->() { return conn_.get(); }
        
        bool is_valid() const { return conn_ != nullptr; }

    private:
        DatabasePool* pool_;
        std::unique_ptr<pqxx::connection> conn_;
    };

    // Construtor do Pool: inicializa N conexões.
    // Como os testes de unidade da lógica do Pool não se conectam a um BD real,
    // usamos uma string de conexão default vazia para mockar (nullptr).
    explicit DatabasePool(size_t pool_size, const std::string& conn_str = "") {
        for (size_t i = 0; i < pool_size; ++i) {
            std::unique_ptr<pqxx::connection> conn;
            if (!conn_str.empty()) {
                conn = std::make_unique<pqxx::connection>(conn_str);
            }
            // Insere a conexão (que pode ser nullptr se conn_str for vazia, o que basta pro teste)
            connections_.push(std::move(conn));
        }
    }

    ~DatabasePool() {
        std::lock_guard<std::mutex> lock(mutex_);
        while (!connections_.empty()) {
            connections_.pop();
        }
    }

    // Método que adquire uma conexão utilizando thread-safety e mutex/condition_variable
    ConnectionWrapper acquire_connection() {
        std::unique_lock<std::mutex> lock(mutex_);
        
        // Bloqueia a thread atual caso não haja conexões disponíveis no pool
        condition_.wait(lock, [this]() { return !connections_.empty(); });

        auto conn = std::move(connections_.front());
        connections_.pop();

        return ConnectionWrapper(this, std::move(conn));
    }

    size_t get_available_count() const {
        std::lock_guard<std::mutex> lock(mutex_);
        return connections_.size();
    }

private:
    friend class ConnectionWrapper;

    // Método privado chamado pelo destrutor do ConnectionWrapper
    void release_connection(std::unique_ptr<pqxx::connection> conn) {
        {
            std::lock_guard<std::mutex> lock(mutex_);
            connections_.push(std::move(conn));
        }
        // Notifica uma das threads que estava esperando por uma conexão
        condition_.notify_one();
    }

    mutable std::mutex mutex_;
    std::condition_variable condition_;
    std::queue<std::unique_ptr<pqxx::connection>> connections_;
};
