#include "storage/FolderManager.hpp"

#include <pqxx/pqxx>
#include <stdexcept>

FolderManager::FolderManager(DatabasePool& pool)
    : pool_(pool) {}

uint64_t FolderManager::create_folder(uint64_t user_id,
                                      std::optional<uint64_t> parent_id,
                                      const std::string& encrypted_name) {
    auto conn = pool_.acquire_connection();
    pqxx::work W(*conn);

    pqxx::result res;

    if (parent_id.has_value()) {
        res = W.exec(
            "INSERT INTO folders (user_id, parent_id, encrypted_name) "
            "VALUES ($1, $2, $3) RETURNING id;",
            pqxx::params{user_id, parent_id.value(), encrypted_name}
        );
    } else {
        res = W.exec(
            "INSERT INTO folders (user_id, parent_id, encrypted_name) "
            "VALUES ($1, NULL, $2) RETURNING id;",
            pqxx::params{user_id, encrypted_name}
        );
    }

    W.commit();

    return res[0][0].as<uint64_t>();
}

bool FolderManager::delete_folder(uint64_t folder_id) {
    auto conn = pool_.acquire_connection();
    pqxx::work W(*conn);

    pqxx::result res = W.exec(
        "DELETE FROM folders WHERE id = $1;",
        pqxx::params{folder_id}
    );

    W.commit();

    return res.affected_rows() > 0;
}

bool FolderManager::folder_exists(uint64_t folder_id) {
    auto conn = pool_.acquire_connection();
    pqxx::nontransaction N(*conn);

    pqxx::result res = N.exec(
        "SELECT count(*) FROM folders WHERE id = $1;",
        pqxx::params{folder_id}
    );

    return res[0][0].as<int64_t>() > 0;
}
