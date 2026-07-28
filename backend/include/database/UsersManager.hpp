#pragma once

#include <string>
#include "database/DatabasePool.hpp"

class UsersManager {
public:
    explicit UsersManager(DatabasePool& pool);

    int create_oauth_user(const std::string& email, const std::string& provider, 
                          const std::string& provider_id, const std::string& full_name = "", 
                          const std::string& avatar_url = "");

    void delete_user(uint64_t user_id);
    void increment_token_version(uint64_t user_id);

private:
    DatabasePool& pool_;
};
