#pragma once

#include <string>
#include "database/DatabasePool.hpp"

class UsersManager {
public:
    explicit UsersManager(DatabasePool& pool);

    int create_oauth_user(const std::string& email, const std::string& provider, 
                          const std::string& provider_id, const std::string& full_name = "", 
                          const std::string& avatar_url = "");

private:
    DatabasePool& pool_;
};
