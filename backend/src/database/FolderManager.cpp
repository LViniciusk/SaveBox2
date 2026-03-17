#include "database/FolderManager.hpp"
#include <pqxx/pqxx>
#include <stdexcept>
#include <vector>

FolderManager::FolderManager(DatabasePool& pool)
    : pool_(pool) {}

uint64_t FolderManager::create_folder(uint64_t user_id,
                                      std::optional<uint64_t> parent_id,
                                      const std::string& encrypted_name,
                                      const std::string& name_hash) {
    auto conn = pool_.acquire_connection();
    pqxx::work W(*conn);

    pqxx::result res;

    if (parent_id.has_value()) {
        res = W.exec(
            "INSERT INTO folders (user_id, parent_id, encrypted_name, name_hash) "
            "VALUES ($1, $2, $3, $4) RETURNING id;",
            pqxx::params{user_id, parent_id.value(), encrypted_name, name_hash}
        );
    } else {
        res = W.exec(
            "INSERT INTO folders (user_id, parent_id, encrypted_name, name_hash) "
            "VALUES ($1, NULL, $2, $3) RETURNING id;",
            pqxx::params{user_id, encrypted_name, name_hash}
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

crow::json::wvalue FolderManager::get_folder_contents(int folder_id, int user_id) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);

    auto check = txn.exec(
        "SELECT id FROM folders WHERE id = $1 AND user_id = $2",
        pqxx::params{folder_id, user_id}
    );
    if (check.empty()) {
        throw std::runtime_error("NOT_FOUND");
    }

    auto sub_rows = txn.exec(
        "SELECT id, encrypted_name FROM folders WHERE parent_id = $1 AND user_id = $2",
        pqxx::params{folder_id, user_id}
    );

    std::vector<crow::json::wvalue> subfolders;
    for (const auto& row : sub_rows) {
        crow::json::wvalue item;
        item["id"] = row[0].as<int>();
        item["encrypted_name"] = row[1].as<std::string>();
        subfolders.push_back(std::move(item));
    }

    auto file_rows = txn.exec(
        "SELECT id, encrypted_name, size_bytes FROM files "
        "WHERE folder_id = $1 AND user_id = $2 AND is_upload_complete = true",
        pqxx::params{folder_id, user_id}
    );

    std::vector<crow::json::wvalue> files;
    for (const auto& row : file_rows) {
        crow::json::wvalue item;
        item["id"] = row[0].as<int>();
        item["encrypted_name"] = row[1].as<std::string>();
        item["size_bytes"] = row[2].as<int64_t>();
        files.push_back(std::move(item));
    }

    txn.commit();

    crow::json::wvalue response;
    response["subfolders"] = std::move(subfolders);
    response["files"] = std::move(files);
    return response;
}

std::vector<crow::json::wvalue> FolderManager::get_all_folders(uint64_t user_id) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);

    auto folder_rows = txn.exec(
        "SELECT id, encrypted_name, parent_id FROM folders WHERE user_id = $1",
        pqxx::params{user_id}
    );

    std::vector<crow::json::wvalue> folders;
    for (const auto& row : folder_rows) {
        crow::json::wvalue item;
        item["id"] = row[0].as<int>();
        item["encrypted_name"] = row[1].as<std::string>();
        if (!row[2].is_null()) {
            item["parent_id"] = row[2].as<int>();
        }
        folders.push_back(std::move(item));
    }

    txn.commit();
    return folders;
}
