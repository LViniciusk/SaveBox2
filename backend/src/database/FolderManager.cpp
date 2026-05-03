#include "database/FolderManager.hpp"
#include "database/DatabasePool.hpp"
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

    if (parent_id.has_value()) {
        auto parent_check = W.exec(
            "SELECT id FROM folders WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
            pqxx::params{parent_id.value(), user_id}
        );
        if (parent_check.empty()) {
            throw std::runtime_error("FORBIDDEN");
        }
    }

    // Verificação de duplicidade
    std::string dup_query;
    pqxx::result dup_res;
    if (parent_id.has_value()) {
        dup_query = "SELECT id FROM folders WHERE user_id = $1 AND name_hash = $2 AND deleted_at IS NULL AND parent_id = $3";
        dup_res = W.exec(dup_query, pqxx::params{user_id, name_hash, parent_id.value()});
    } else {
        dup_query = "SELECT id FROM folders WHERE user_id = $1 AND name_hash = $2 AND deleted_at IS NULL AND parent_id IS NULL";
        dup_res = W.exec(dup_query, pqxx::params{user_id, name_hash});
    }

    if (!dup_res.empty()) {
        throw std::runtime_error("FOLDER_ALREADY_EXISTS");
    }

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

std::vector<uint64_t> FolderManager::delete_folder(uint64_t folder_id, uint64_t user_id) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);

    auto check = txn.exec(
        "SELECT id FROM folders WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
        pqxx::params{folder_id, user_id}
    );
    if (check.empty()) {
        throw std::runtime_error("NOT_FOUND");
    }

    txn.exec(
        "WITH RECURSIVE folder_tree AS ( "
        "  SELECT id FROM folders WHERE id = $1 "
        "  UNION ALL "
        "  SELECT f.id FROM folders f INNER JOIN folder_tree ft ON f.parent_id = ft.id "
        ") "
        "UPDATE folders SET deleted_at = CURRENT_TIMESTAMP "
        "WHERE id IN (SELECT id FROM folder_tree);",
        pqxx::params{folder_id}
    );

    auto file_res = txn.exec(
        "WITH RECURSIVE folder_tree AS ( "
        "  SELECT id FROM folders WHERE id = $1 "
        "  UNION ALL "
        "  SELECT f.id FROM folders f INNER JOIN folder_tree ft ON f.parent_id = ft.id "
        ") "
        "UPDATE files SET deleted_at = CURRENT_TIMESTAMP "
        "WHERE folder_id IN (SELECT id FROM folder_tree) "
        "RETURNING id;",
        pqxx::params{folder_id}
    );

    std::vector<uint64_t> files_to_delete;
    for (const auto& row : file_res) {
        files_to_delete.push_back(row[0].as<uint64_t>());
    }

    txn.commit();
    return files_to_delete;
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

    if (folder_id != 0) {
        auto check = txn.exec(
            "SELECT id FROM folders WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
            pqxx::params{folder_id, user_id}
        );
        if (check.empty()) {
            throw std::runtime_error("NOT_FOUND");
        }
    }

    pqxx::result sub_rows;
    if (folder_id == 0) {
        sub_rows = txn.exec(
            "SELECT id, encrypted_name FROM folders WHERE parent_id IS NULL AND user_id = $1 AND deleted_at IS NULL",
            pqxx::params{user_id}
        );
    } else {
        sub_rows = txn.exec(
            "SELECT id, encrypted_name FROM folders WHERE parent_id = $1 AND user_id = $2 AND deleted_at IS NULL",
            pqxx::params{folder_id, user_id}
        );
    }

    std::vector<crow::json::wvalue> subfolders;
    for (const auto& row : sub_rows) {
        crow::json::wvalue item;
        item["id"] = row[0].as<int>();
        item["encrypted_name"] = row[1].as<std::string>();
        subfolders.push_back(std::move(item));
    }

    pqxx::result file_rows;
    if (folder_id == 0) {
        file_rows = txn.exec(
            "SELECT id, encrypted_name, size_bytes, encrypted_fdk FROM files "
            "WHERE folder_id IS NULL AND user_id = $1 AND is_upload_complete = true AND deleted_at IS NULL",
            pqxx::params{user_id}
        );
    } else {
        file_rows = txn.exec(
            "SELECT id, encrypted_name, size_bytes, encrypted_fdk FROM files "
            "WHERE folder_id = $1 AND user_id = $2 AND is_upload_complete = true AND deleted_at IS NULL",
            pqxx::params{folder_id, user_id}
        );
    }

    std::vector<crow::json::wvalue> files;
    for (const auto& row : file_rows) {
        crow::json::wvalue item;
        item["id"] = row[0].as<int>();
        item["encrypted_name"] = row[1].as<std::string>();
        item["size_bytes"] = row[2].as<int64_t>();
        item["encrypted_fdk"] = row[3].as<std::string>();
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
        "SELECT id, encrypted_name, parent_id FROM folders WHERE user_id = $1 AND deleted_at IS NULL",
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

crow::json::wvalue FolderManager::update_folder(uint64_t folder_id, uint64_t user_id, const std::optional<std::string>& enc_name, const std::optional<std::string>& name_hash, const std::optional<uint64_t>& parent_id) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);

    auto result = txn.exec(
        "SELECT id FROM folders WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
        pqxx::params{folder_id, user_id}
    );
    if (result.empty()) {
        throw std::runtime_error("NOT_FOUND");
    }

    if (parent_id.has_value()) {
        if (parent_id.value() == folder_id) {
            throw std::runtime_error("BAD_REQUEST");
        }
        if (parent_id.value() != 0) { // 0 significa "Mover para a Raiz"
            auto parent_res = txn.exec(
                "SELECT id FROM folders WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
                pqxx::params{parent_id.value(), user_id}
            );
            if (parent_res.empty()) {
                throw std::runtime_error("FORBIDDEN");
            }
        }
    }

    bool has_name = enc_name.has_value() && name_hash.has_value();
    bool has_parent = parent_id.has_value();

    pqxx::result res;
    if (has_name || has_parent) {
        if (has_parent) {
            if (parent_id.value() == 0) {
                if (has_name) {
                    res = txn.exec(
                        "UPDATE folders SET encrypted_name = $1, name_hash = $2, parent_id = NULL "
                        "WHERE id = $3 AND user_id = $4 "
                        "RETURNING encrypted_name, name_hash, parent_id",
                        pqxx::params{enc_name.value(), name_hash.value(), folder_id, user_id}
                    );
                } else {
                    res = txn.exec(
                        "UPDATE folders SET parent_id = NULL WHERE id = $1 AND user_id = $2 "
                        "RETURNING encrypted_name, name_hash, parent_id",
                        pqxx::params{folder_id, user_id}
                    );
                }
            } else {
                if (has_name) {
                    res = txn.exec(
                        "UPDATE folders SET encrypted_name = $1, name_hash = $2, parent_id = $3 "
                        "WHERE id = $4 AND user_id = $5 "
                        "RETURNING encrypted_name, name_hash, parent_id",
                        pqxx::params{enc_name.value(), name_hash.value(), parent_id.value(), folder_id, user_id}
                    );
                } else {
                    res = txn.exec(
                        "UPDATE folders SET parent_id = $1 WHERE id = $2 AND user_id = $3 "
                        "RETURNING encrypted_name, name_hash, parent_id",
                        pqxx::params{parent_id.value(), folder_id, user_id}
                    );
                }
            }
        } else {
            if (has_name) {
                res = txn.exec(
                    "UPDATE folders SET encrypted_name = $1, name_hash = $2 WHERE id = $3 AND user_id = $4 "
                    "RETURNING encrypted_name, name_hash, parent_id",
                    pqxx::params{enc_name.value(), name_hash.value(), folder_id, user_id}
                );
            }
        }
    }

    if (res.empty()) {
        res = txn.exec(
            "SELECT encrypted_name, name_hash, parent_id FROM folders WHERE id = $1",
            pqxx::params{folder_id}
        );
    }

    crow::json::wvalue ret;
    ret["encrypted_name"] = res[0][0].as<std::string>();    
    ret["name_hash"] = res[0][1].as<std::string>();
    if (res[0][2].is_null()) ret["parent_id"] = nullptr;
    else ret["parent_id"] = res[0][2].as<int>();
    
    txn.commit();
    return ret;
}

void FolderManager::restore_folder(uint64_t folder_id, uint64_t user_id) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);

    auto check = txn.exec(
        "SELECT id, parent_id, name_hash FROM folders WHERE id = $1 AND user_id = $2 AND deleted_at IS NOT NULL",
        pqxx::params{folder_id, user_id}
    );
    if (check.empty()) throw std::runtime_error("NOT_FOUND");

    std::string name_hash = check[0][2].as<std::string>();

    std::optional<uint64_t> parent_id;
    if (!check[0][1].is_null()) {
        parent_id = check[0][1].as<uint64_t>();
        auto parent_check = txn.exec(
            "SELECT deleted_at FROM folders WHERE id = $1 AND user_id = $2",
            pqxx::params{*parent_id, user_id}
        );
        if (!parent_check.empty() && !parent_check[0][0].is_null()) {
            parent_id.reset();
        }
    }

    std::string dup_query;
    pqxx::result dup_res;
    if (parent_id.has_value()) {
        dup_query = "SELECT id FROM folders WHERE user_id = $1 AND name_hash = $2 AND deleted_at IS NULL AND parent_id = $3";
        dup_res = txn.exec(dup_query, pqxx::params{user_id, name_hash, *parent_id});
    } else {
        dup_query = "SELECT id FROM folders WHERE user_id = $1 AND name_hash = $2 AND deleted_at IS NULL AND parent_id IS NULL";
        dup_res = txn.exec(dup_query, pqxx::params{user_id, name_hash});
    }

    if (!dup_res.empty()) {
        throw std::runtime_error("FOLDER_ALREADY_EXISTS");
    }

    if (parent_id.has_value()) {
        txn.exec(
            "WITH RECURSIVE folder_tree AS ( "
            "  SELECT id FROM folders WHERE id = $1 "
            "  UNION ALL "
            "  SELECT f.id FROM folders f INNER JOIN folder_tree ft ON f.parent_id = ft.id "
            ") "
            "UPDATE folders SET deleted_at = NULL "
            "WHERE id IN (SELECT id FROM folder_tree);",
            pqxx::params{folder_id}
        );

        txn.exec(
            "WITH RECURSIVE folder_tree AS ( "
            "  SELECT id FROM folders WHERE id = $1 "
            "  UNION ALL "
            "  SELECT f.id FROM folders f INNER JOIN folder_tree ft ON f.parent_id = ft.id "
            ") "
            "UPDATE files SET deleted_at = NULL "
            "WHERE folder_id IN (SELECT id FROM folder_tree);",
            pqxx::params{folder_id}
        );
    } else {
        txn.exec(
            "UPDATE folders SET parent_id = NULL WHERE id = $1 AND user_id = $2",
            pqxx::params{folder_id, user_id}
        );

        txn.exec(
            "WITH RECURSIVE folder_tree AS ( "
            "  SELECT id FROM folders WHERE id = $1 "
            "  UNION ALL "
            "  SELECT f.id FROM folders f INNER JOIN folder_tree ft ON f.parent_id = ft.id "
            ") "
            "UPDATE folders SET deleted_at = NULL "
            "WHERE id IN (SELECT id FROM folder_tree);",
            pqxx::params{folder_id}
        );

        txn.exec(
            "WITH RECURSIVE folder_tree AS ( "
            "  SELECT id FROM folders WHERE id = $1 "
            "  UNION ALL "
            "  SELECT f.id FROM folders f INNER JOIN folder_tree ft ON f.parent_id = ft.id "
            ") "
            "UPDATE files SET deleted_at = NULL "
            "WHERE folder_id IN (SELECT id FROM folder_tree);",
            pqxx::params{folder_id}
        );
    }

    txn.commit();
}
