#pragma once

#include "DatabasePool.hpp"

class DatabaseMigration {
public:
    static bool run(DatabasePool& pool);
};
