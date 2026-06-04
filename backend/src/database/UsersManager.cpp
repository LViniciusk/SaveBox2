#include "database/UsersManager.hpp"
#include <pqxx/pqxx>
#include <stdexcept>
#include <iostream>

UsersManager::UsersManager(DatabasePool& pool) : pool_(pool) {}

int UsersManager::create_oauth_user(const std::string& email, const std::string& provider, 
                                    const std::string& provider_id, const std::string& full_name, 
                                    const std::string& avatar_url) {
    if (email.empty() || provider.empty() || provider_id.empty()) {
        throw std::invalid_argument("Email, provider and provider_id are required.");
    }

    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);

    auto result = txn.exec(
        "SELECT id, auth_provider FROM users WHERE email = $1",
        pqxx::params{email}
    );

    if (!result.empty()) {
        int user_id = result[0][0].as<int>();
        std::string existing_provider = result[0][1].is_null() ? "local" : result[0][1].as<std::string>();

        if (existing_provider != provider) {
            txn.abort();
            throw std::runtime_error("ACCOUNT_EXISTS_WITH_DIFFERENT_PROVIDER");
        }
        
        txn.commit();
        return user_id;
    }

    std::string base_username = email.substr(0, email.find('@'));
    std::string username = base_username;
    int suffix = 1;

    while (true) {
        auto check_username = txn.exec("SELECT 1 FROM users WHERE username = $1", pqxx::params{username});
        if (check_username.empty()) {
            break;
        }
        username = base_username + std::to_string(suffix++);
    }

    auto insert_result = txn.exec(
        "INSERT INTO users (username, email, auth_provider, provider_id, full_name, avatar_url, is_email_verified) "
        "VALUES ($1, $2, $3, $4, $5, $6, TRUE) RETURNING id",
        pqxx::params{username, email, provider, provider_id, full_name, avatar_url}
    );

    txn.commit();
    return insert_result[0][0].as<int>();
}
