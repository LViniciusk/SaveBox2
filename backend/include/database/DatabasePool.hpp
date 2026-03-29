#pragma once

#include <pqxx/pqxx>
#include <queue>
#include <mutex>
#include <atomic>
#include <condition_variable>
#include <memory>
#include <string>

class DatabasePool {
public:
    class ConnectionWrapper {
    public:
        ConnectionWrapper(DatabasePool* pool, std::unique_ptr<pqxx::connection> conn);
        ~ConnectionWrapper();

        ConnectionWrapper(const ConnectionWrapper&) = delete;
        ConnectionWrapper& operator=(const ConnectionWrapper&) = delete;

        ConnectionWrapper(ConnectionWrapper&& other) noexcept;
        ConnectionWrapper& operator=(ConnectionWrapper&& other) noexcept;

        pqxx::connection& operator*();
        pqxx::connection* operator->();

        bool is_valid() const;

    private:
        DatabasePool* pool_;
        std::unique_ptr<pqxx::connection> conn_;
    };

    explicit DatabasePool(size_t pool_size, const std::string& conn_str = "");
    ~DatabasePool();

    ConnectionWrapper acquire_connection();
    size_t get_available_count() const;
    void close_all_connections();

private:
    friend class ConnectionWrapper;

    void release_connection(std::unique_ptr<pqxx::connection> conn);

    mutable std::mutex mutex_;
    std::condition_variable condition_;
    std::queue<std::unique_ptr<pqxx::connection>> connections_;
    std::string connection_string_;
    std::atomic<bool> is_shutting_down_{false};
};
