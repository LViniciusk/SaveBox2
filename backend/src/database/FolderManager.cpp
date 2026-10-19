#include "database/FolderManager.hpp"
#include "database/DatabasePool.hpp"
#include "storage/FileChunker.hpp"
#include <pqxx/pqxx>
#include <algorithm>
#include <cctype>
#include <queue>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace {

constexpr size_t MAX_BATCH_FOLDERS = 1000;
constexpr size_t MAX_TREE_DEPTH = 128;
constexpr size_t MAX_CLIENT_REF_LENGTH = 128;
constexpr size_t MAX_ENCRYPTED_NAME_LENGTH = 64 * 1024;
constexpr size_t MAX_NAME_HASH_LENGTH = 128;

std::string to_pg_bigint_array(const std::vector<uint64_t>& ids) {
    std::string result = "{";
    for (size_t i = 0; i < ids.size(); ++i) {
        if (i > 0) result += ',';
        result += std::to_string(ids[i]);
    }
    result += '}';
    return result;
}

void lock_user_pins(pqxx::work& txn, uint64_t user_id) {
    // ponytail: one PostgreSQL transaction lock per user; replace only if pin throughput demands finer granularity.
    txn.exec("SELECT pg_advisory_xact_lock($1::bigint)", pqxx::params{user_id});
}

void lock_user_folders(pqxx::work& txn, uint64_t user_id) {
    // A single deterministic lock serializes individual and batch folder creates.
    txn.exec("SELECT pg_advisory_xact_lock($1::bigint)", pqxx::params{user_id});
}

bool is_valid_client_ref(const std::string& value) {
    if (value.empty() || value.size() > MAX_CLIENT_REF_LENGTH || value == "." || value == "..") {
        return false;
    }
    for (const unsigned char ch : value) {
        if (!(std::isalnum(ch) || ch == '-' || ch == '_')) {
            return false;
        }
    }
    return true;
}

void validate_batch_structure(const std::vector<BatchCreateFolderItem>& folders) {
    if (folders.empty() || folders.size() > MAX_BATCH_FOLDERS) {
        throw std::runtime_error("BAD_REQUEST");
    }

    std::unordered_map<std::string, size_t> by_ref;
    by_ref.reserve(folders.size());
    for (size_t i = 0; i < folders.size(); ++i) {
        const auto& folder = folders[i];
        if (!is_valid_client_ref(folder.client_ref) || !by_ref.emplace(folder.client_ref, i).second ||
            folder.encrypted_name.empty() || folder.encrypted_name.size() > MAX_ENCRYPTED_NAME_LENGTH ||
            folder.name_hash.empty() || folder.name_hash.size() > MAX_NAME_HASH_LENGTH) {
            throw std::runtime_error("BAD_REQUEST");
        }
        if (folder.parent_client_ref.has_value() && !is_valid_client_ref(*folder.parent_client_ref)) {
            throw std::runtime_error("BAD_REQUEST");
        }
    }

    std::vector<std::vector<size_t>> children(folders.size());
    std::vector<size_t> indegree(folders.size(), 0);
    for (size_t i = 0; i < folders.size(); ++i) {
        if (!folders[i].parent_client_ref.has_value()) {
            continue;
        }
        auto parent = by_ref.find(*folders[i].parent_client_ref);
        if (parent == by_ref.end() || parent->second == i) {
            throw std::runtime_error("BAD_REQUEST");
        }
        children[parent->second].push_back(i);
        ++indegree[i];
    }

    std::queue<size_t> ready;
    for (size_t i = 0; i < indegree.size(); ++i) {
        if (indegree[i] == 0) ready.push(i);
    }

    std::vector<size_t> order;
    order.reserve(folders.size());
    std::vector<size_t> depth(folders.size(), 1);
    while (!ready.empty()) {
        const size_t current = ready.front();
        ready.pop();
        order.push_back(current);
        for (const size_t child : children[current]) {
            depth[child] = std::max(depth[child], depth[current] + 1);
            if (depth[child] > MAX_TREE_DEPTH) {
                throw std::runtime_error("BAD_REQUEST");
            }
            if (--indegree[child] == 0) ready.push(child);
        }
    }
    if (order.size() != folders.size()) {
        throw std::runtime_error("BAD_REQUEST");
    }
}

void normalize_active_pins(pqxx::work& txn, uint64_t user_id) {
    txn.exec(
        "WITH ordered AS ("
        "  SELECT p.user_id, p.folder_id, "
        "         ROW_NUMBER() OVER (ORDER BY p.position, p.created_at, p.folder_id) - 1 AS new_position "
        "  FROM pinned_folders p "
        "  JOIN folders f ON f.id = p.folder_id "
        "  WHERE p.user_id = $1 AND f.deleted_at IS NULL"
        ") "
        "UPDATE pinned_folders p SET position = ordered.new_position "
        "FROM ordered "
        "WHERE p.user_id = ordered.user_id AND p.folder_id = ordered.folder_id",
        pqxx::params{user_id}
    );
}

}

FolderManager::FolderManager(DatabasePool& pool)
    : pool_(pool) {}

uint64_t FolderManager::create_folder(uint64_t user_id,
                                      std::optional<uint64_t> parent_id,
                                      const std::string& encrypted_name,
                                      const std::string& name_hash) {
    auto conn = pool_.acquire_connection();
    pqxx::work W(*conn);
    lock_user_folders(W, user_id);

    if (parent_id.has_value()) {
        auto parent_check = W.exec(
            "SELECT id FROM folders WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
            pqxx::params{parent_id.value(), user_id}
        );
        if (parent_check.empty()) {
            throw std::runtime_error("FORBIDDEN");
        }
    }

    pqxx::result res;

    try {
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
    } catch (const pqxx::unique_violation& e) {
        throw std::runtime_error("FOLDER_ALREADY_EXISTS");
    }

    return res[0][0].as<uint64_t>();
}

std::vector<BatchCreateFolderResult> FolderManager::batch_create_folders(
    uint64_t user_id,
    std::optional<uint64_t> root_parent_id,
    const std::vector<BatchCreateFolderItem>& folders) {
    validate_batch_structure(folders);

    std::unordered_map<std::string, size_t> by_ref;
    by_ref.reserve(folders.size());
    for (size_t i = 0; i < folders.size(); ++i) by_ref.emplace(folders[i].client_ref, i);

    std::vector<size_t> order;
    order.reserve(folders.size());
    std::vector<size_t> indegree(folders.size(), 0);
    std::vector<std::vector<size_t>> children(folders.size());
    for (size_t i = 0; i < folders.size(); ++i) {
        if (folders[i].parent_client_ref.has_value()) {
            const auto parent = by_ref.at(*folders[i].parent_client_ref);
            children[parent].push_back(i);
            ++indegree[i];
        }
    }
    std::queue<size_t> ready;
    for (size_t i = 0; i < folders.size(); ++i) if (indegree[i] == 0) ready.push(i);
    std::vector<size_t> depth(folders.size(), 1);
    while (!ready.empty()) {
        const size_t current = ready.front();
        ready.pop();
        order.push_back(current);
        for (const size_t child : children[current]) {
            depth[child] = std::max(depth[child], depth[current] + 1);
            if (--indegree[child] == 0) ready.push(child);
        }
    }

    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);
    lock_user_folders(txn, user_id);

    if (root_parent_id.has_value()) {
        const auto root = txn.exec(
            "SELECT user_id, deleted_at FROM folders WHERE id = $1",
            pqxx::params{*root_parent_id}
        );
        if (root.empty()) throw std::runtime_error("NOT_FOUND");
        if (root[0][0].as<uint64_t>() != user_id) throw std::runtime_error("FORBIDDEN");
        if (!root[0][1].is_null()) throw std::runtime_error("NOT_FOUND");
    }

    std::unordered_map<std::string, uint64_t> resolved_ids;
    std::unordered_set<std::string> request_names;
    resolved_ids.reserve(folders.size());
    request_names.reserve(folders.size());

    auto find_active = [&](std::optional<uint64_t> parent_id, const std::string& hash) {
        if (parent_id.has_value()) {
            return txn.exec(
                "SELECT id FROM folders WHERE user_id = $1 AND parent_id = $2 AND name_hash = $3 AND deleted_at IS NULL",
                pqxx::params{user_id, *parent_id, hash}
            );
        }
        return txn.exec(
            "SELECT id FROM folders WHERE user_id = $1 AND parent_id IS NULL AND name_hash = $2 AND deleted_at IS NULL",
            pqxx::params{user_id, hash}
        );
    };

    auto find_deleted = [&](std::optional<uint64_t> parent_id, const std::string& hash) {
        if (parent_id.has_value()) {
            return txn.exec(
                "SELECT id FROM folders WHERE user_id = $1 AND parent_id = $2 AND name_hash = $3 AND deleted_at IS NOT NULL",
                pqxx::params{user_id, *parent_id, hash}
            );
        }
        return txn.exec(
            "SELECT id FROM folders WHERE user_id = $1 AND parent_id IS NULL AND name_hash = $2 AND deleted_at IS NOT NULL",
            pqxx::params{user_id, hash}
        );
    };

    // Preflight all logical collisions before the first insert.
    for (const size_t index : order) {
        const auto& folder = folders[index];
        std::optional<uint64_t> parent_id;
        std::string parent_key;
        if (folder.parent_client_ref.has_value()) {
            const auto& parent_ref = *folder.parent_client_ref;
            const auto parent_id_it = resolved_ids.find(parent_ref);
            if (parent_id_it != resolved_ids.end()) {
                parent_id = parent_id_it->second;
                parent_key = "id:" + std::to_string(*parent_id);
            } else {
                parent_key = "ref:" + parent_ref;
            }
        } else if (root_parent_id.has_value()) {
            parent_id = root_parent_id;
            parent_key = "id:" + std::to_string(*root_parent_id);
        } else {
            parent_key = "root";
        }

        const std::string logical_key = parent_key + "\n" + folder.name_hash;
        if (!request_names.emplace(logical_key).second) throw std::runtime_error("BAD_REQUEST");
        if (!parent_id.has_value() && parent_key.rfind("ref:", 0) == 0) continue;
        const auto active = find_active(parent_id, folder.name_hash);
        if (!active.empty()) {
            resolved_ids.emplace(folder.client_ref, active[0][0].as<uint64_t>());
        } else if (!find_deleted(parent_id, folder.name_hash).empty()) {
            throw std::runtime_error("FOLDER_ALREADY_EXISTS");
        }
    }

    std::unordered_map<std::string, BatchCreateFolderResult> results;
    results.reserve(folders.size());
    for (const size_t index : order) {
        const auto& folder = folders[index];
        auto existing = resolved_ids.find(folder.client_ref);
        if (existing != resolved_ids.end()) {
            results.emplace(folder.client_ref, BatchCreateFolderResult{folder.client_ref, existing->second, false});
            continue;
        }

        std::optional<uint64_t> parent_id;
        if (folder.parent_client_ref.has_value()) {
            parent_id = resolved_ids.at(*folder.parent_client_ref);
        } else {
            parent_id = root_parent_id;
        }

        pqxx::result inserted;
        if (parent_id.has_value()) {
            inserted = txn.exec(
                "INSERT INTO folders (user_id, parent_id, encrypted_name, name_hash) VALUES ($1, $2, $3, $4) RETURNING id",
                pqxx::params{user_id, *parent_id, folder.encrypted_name, folder.name_hash}
            );
        } else {
            inserted = txn.exec(
                "INSERT INTO folders (user_id, parent_id, encrypted_name, name_hash) VALUES ($1, NULL, $2, $3) RETURNING id",
                pqxx::params{user_id, folder.encrypted_name, folder.name_hash}
            );
        }
        const auto id = inserted[0][0].as<uint64_t>();
        resolved_ids.emplace(folder.client_ref, id);
        results.emplace(folder.client_ref, BatchCreateFolderResult{folder.client_ref, id, true});
    }

    txn.commit();
    std::vector<BatchCreateFolderResult> response;
    response.reserve(folders.size());
    for (const auto& folder : folders) response.push_back(results.at(folder.client_ref));
    return response;
}

std::vector<std::string> FolderManager::delete_folder(uint64_t folder_id, uint64_t user_id) {
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
        "RETURNING external_file_id;",
        pqxx::params{folder_id}
    );

    std::vector<std::string> external_files;
    for (const auto& row : file_res) {
        if (!row[0].is_null()) {
            external_files.push_back(row[0].as<std::string>());
        }
    }

    txn.commit();
    return external_files;
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

            auto circular_res = txn.exec(
                "WITH RECURSIVE folder_tree AS ("
                "  SELECT id, parent_id FROM folders WHERE id = $1 "
                "  UNION ALL "
                "  SELECT f.id, f.parent_id FROM folders f "
                "  INNER JOIN folder_tree ft ON f.id = ft.parent_id "
                ") "
                "SELECT 1 FROM folder_tree WHERE id = $2 LIMIT 1",
                pqxx::params{parent_id.value(), folder_id}
            );
            if (!circular_res.empty()) {
                throw std::runtime_error("BAD_REQUEST");
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

std::vector<std::string> FolderManager::restore_folder(uint64_t folder_id, uint64_t user_id) {
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

    std::vector<std::string> external_files;

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

        auto file_res = txn.exec(
            "WITH RECURSIVE folder_tree AS ( "
            "  SELECT id FROM folders WHERE id = $1 "
            "  UNION ALL "
            "  SELECT f.id FROM folders f INNER JOIN folder_tree ft ON f.parent_id = ft.id "
            ") "
            "UPDATE files SET deleted_at = NULL "
            "WHERE folder_id IN (SELECT id FROM folder_tree) "
            "RETURNING external_file_id;",
            pqxx::params{folder_id}
        );

        for (const auto& row : file_res) {
            if (!row[0].is_null()) {
                external_files.push_back(row[0].as<std::string>());
            }
        }
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

        auto file_res = txn.exec(
            "WITH RECURSIVE folder_tree AS ( "
            "  SELECT id FROM folders WHERE id = $1 "
            "  UNION ALL "
            "  SELECT f.id FROM folders f INNER JOIN folder_tree ft ON f.parent_id = ft.id "
            ") "
            "UPDATE files SET deleted_at = NULL "
            "WHERE folder_id IN (SELECT id FROM folder_tree) "
            "RETURNING external_file_id;",
            pqxx::params{folder_id}
        );

        for (const auto& row : file_res) {
            if (!row[0].is_null()) {
                external_files.push_back(row[0].as<std::string>());
            }
        }
    }

    txn.commit();
    return external_files;
}



std::vector<std::string> FolderManager::hard_delete_folder(uint64_t folder_id, uint64_t user_id, class FileChunker* chunker) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);

    auto check = txn.exec(
        "SELECT id FROM folders WHERE id = $1 AND user_id = $2 AND deleted_at IS NOT NULL",
        pqxx::params{folder_id, user_id}
    );
    if (check.empty()) throw std::runtime_error("NOT_FOUND");

    auto deleted_files_res = txn.exec(
        "WITH RECURSIVE folder_tree AS ( "
        "  SELECT id FROM folders WHERE id = $1 "
        "  UNION ALL "
        "  SELECT f.id FROM folders f INNER JOIN folder_tree ft ON f.parent_id = ft.id "
        "), "
        "deleted_files AS ("
        "  DELETE FROM files WHERE folder_id IN (SELECT id FROM folder_tree) "
        "  RETURNING id, storage_provider, size_bytes, external_file_id, external_storage_id"
        ") "
        "SELECT id, storage_provider, size_bytes, external_file_id, external_storage_id FROM deleted_files;",
        pqxx::params{folder_id}
    );

    uint64_t freed_bytes = 0;
    std::vector<std::string> external_files;

    for (const auto& row : deleted_files_res) {
        auto fid = row[0].as<uint64_t>();
        std::string provider = row[1].as<std::string>();
        uint64_t size = row[2].as<uint64_t>();
        
        freed_bytes += (provider == "local") ? size : 2048;
        
        if (provider == "google_drive") {
            if (!row[3].is_null() && !row[4].is_null()) {
                std::string ext_file_id = row[3].as<std::string>();
                external_files.push_back(ext_file_id);
                txn.exec("INSERT INTO pending_external_deletions (external_file_id, external_storage_id) VALUES ($1, $2)",
                         pqxx::params{ext_file_id, row[4].as<uint64_t>()});
            }
        } else {
            if (chunker) chunker->delete_file(fid);
        }
    }

    if (freed_bytes > 0) {
        txn.exec("UPDATE users SET used_storage_bytes = GREATEST(0, used_storage_bytes - $1) WHERE id = $2",
                 pqxx::params{freed_bytes, user_id});
    }

    txn.exec(
        "WITH RECURSIVE folder_tree AS ( "
        "  SELECT id FROM folders WHERE id = $1 "
        "  UNION ALL "
        "  SELECT f.id FROM folders f INNER JOIN folder_tree ft ON f.parent_id = ft.id "
        ") "
        "DELETE FROM folders WHERE id IN (SELECT id FROM folder_tree);",
        pqxx::params{folder_id}
    );

    txn.commit();
    return external_files;
}

BatchDeleteFolderResult FolderManager::batch_delete_folders(uint64_t user_id, const std::vector<int>& folder_ids) {
    if (folder_ids.empty()) return {};

    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);

    std::string arr_str = "{";
    for (size_t i = 0; i < folder_ids.size(); ++i) {
        arr_str += std::to_string(folder_ids[i]);
        if (i < folder_ids.size() - 1) arr_str += ",";
    }
    arr_str += "}";

    auto check_res = txn.exec(
        "SELECT id FROM folders WHERE id = ANY($1::int[]) AND user_id = $2 AND deleted_at IS NULL",
        pqxx::params{arr_str, user_id}
    );

    if (check_res.empty()) return {};

    std::string actual_arr = "{";
    int count = 0;
    for (const auto& row : check_res) {
        if (count > 0) actual_arr += ",";
        actual_arr += row[0].as<std::string>();
        count++;
    }
    actual_arr += "}";

    txn.exec(
        "WITH RECURSIVE folder_tree AS ( "
        "  SELECT id FROM folders WHERE id = ANY($1::int[]) "
        "  UNION ALL "
        "  SELECT f.id FROM folders f INNER JOIN folder_tree ft ON f.parent_id = ft.id "
        ") "
        "UPDATE folders SET deleted_at = CURRENT_TIMESTAMP "
        "WHERE id IN (SELECT id FROM folder_tree);",
        pqxx::params{actual_arr}
    );

    auto file_res = txn.exec(
        "WITH RECURSIVE folder_tree AS ( "
        "  SELECT id FROM folders WHERE id = ANY($1::int[]) "
        "  UNION ALL "
        "  SELECT f.id FROM folders f INNER JOIN folder_tree ft ON f.parent_id = ft.id "
        ") "
        "UPDATE files SET deleted_at = CURRENT_TIMESTAMP "
        "WHERE folder_id IN (SELECT id FROM folder_tree) AND deleted_at IS NULL "
        "RETURNING external_file_id;",
        pqxx::params{actual_arr}
    );

    BatchDeleteFolderResult result;
    result.deleted_count = count;
    for (const auto& row : file_res) {
        if (!row[0].is_null()) {
            result.external_files.push_back(row[0].as<std::string>());
        }
    }

    txn.commit();
    return result;
}

BatchHardDeleteFolderResult FolderManager::batch_hard_delete_folders(uint64_t user_id, const std::vector<int>& folder_ids, FileChunker* chunker) {
    if (folder_ids.empty()) return {};

    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);

    std::string arr_str = "{";
    for (size_t i = 0; i < folder_ids.size(); ++i) {
        arr_str += std::to_string(folder_ids[i]);
        if (i < folder_ids.size() - 1) arr_str += ",";
    }
    arr_str += "}";

    auto check_res = txn.exec(
        "SELECT id FROM folders WHERE id = ANY($1::int[]) AND user_id = $2 AND deleted_at IS NOT NULL",
        pqxx::params{arr_str, user_id}
    );

    if (check_res.empty()) return {};

    std::string actual_arr = "{";
    int count = 0;
    for (const auto& row : check_res) {
        if (count > 0) actual_arr += ",";
        actual_arr += row[0].as<std::string>();
        count++;
    }
    actual_arr += "}";

    auto deleted_files_res = txn.exec(
        "WITH RECURSIVE folder_tree AS ( "
        "  SELECT id FROM folders WHERE id = ANY($1::int[]) "
        "  UNION ALL "
        "  SELECT f.id FROM folders f INNER JOIN folder_tree ft ON f.parent_id = ft.id "
        "), "
        "deleted_files AS ("
        "  DELETE FROM files WHERE folder_id IN (SELECT id FROM folder_tree) "
        "  RETURNING id, storage_provider, size_bytes, external_file_id, external_storage_id"
        ") "
        "SELECT id, storage_provider, size_bytes, external_file_id, external_storage_id FROM deleted_files;",
        pqxx::params{actual_arr}
    );

    BatchHardDeleteFolderResult result;
    result.deleted_count = count;
    uint64_t total_freed_bytes = 0;

    for (const auto& row : deleted_files_res) {
        auto fid = row[0].as<uint64_t>();
        std::string provider = row[1].as<std::string>();
        uint64_t size = row[2].as<uint64_t>();
        
        uint64_t freed_bytes = (provider == "local") ? size : 2048;
        total_freed_bytes += freed_bytes;
        
        if (provider == "google_drive") {
            if (!row[3].is_null() && !row[4].is_null()) {
                std::string ext_file_id = row[3].as<std::string>();
                result.external_files.push_back(ext_file_id);
                txn.exec("INSERT INTO pending_external_deletions (external_file_id, external_storage_id) VALUES ($1, $2)",
                         pqxx::params{ext_file_id, row[4].as<uint64_t>()});
            }
        } else {
            if (chunker) chunker->delete_file(fid);
        }
    }

    if (total_freed_bytes > 0) {
        txn.exec("UPDATE users SET used_storage_bytes = GREATEST(0, used_storage_bytes - $1) WHERE id = $2",
                 pqxx::params{total_freed_bytes, user_id});
    }

    txn.exec(
        "WITH RECURSIVE folder_tree AS ( "
        "  SELECT id FROM folders WHERE id = ANY($1::int[]) "
        "  UNION ALL "
        "  SELECT f.id FROM folders f INNER JOIN folder_tree ft ON f.parent_id = ft.id "
        ") "
        "DELETE FROM folders WHERE id IN (SELECT id FROM folder_tree);",
        pqxx::params{actual_arr}
    );

    txn.commit();
    return result;
}

std::vector<PinnedFolder> FolderManager::get_pinned_folders(uint64_t user_id) {
    auto conn = pool_.acquire_connection();
    pqxx::nontransaction txn(*conn);
    auto rows = txn.exec(
        "SELECT p.folder_id, p.position "
        "FROM pinned_folders p "
        "JOIN folders f ON f.id = p.folder_id "
        "WHERE p.user_id = $1 AND f.deleted_at IS NULL "
        "ORDER BY p.position, p.created_at, p.folder_id",
        pqxx::params{user_id}
    );

    std::vector<PinnedFolder> result;
    result.reserve(rows.size());
    for (const auto& row : rows) {
        result.push_back({row[0].as<uint64_t>(), row[1].as<int>()});
    }
    return result;
}

void FolderManager::pin_folder(uint64_t folder_id, uint64_t user_id) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);
    lock_user_pins(txn, user_id);

    auto folder = txn.exec(
        "SELECT user_id, deleted_at FROM folders WHERE id = $1 FOR SHARE",
        pqxx::params{folder_id}
    );
    if (folder.empty()) throw std::runtime_error("NOT_FOUND");
    if (folder[0][0].as<uint64_t>() != user_id) throw std::runtime_error("FORBIDDEN");
    if (!folder[0][1].is_null()) throw std::runtime_error("NOT_FOUND");

    auto existing = txn.exec(
        "SELECT 1 FROM pinned_folders WHERE user_id = $1 AND folder_id = $2",
        pqxx::params{user_id, folder_id}
    );
    if (!existing.empty()) {
        txn.commit();
        return;
    }

    auto next_position = txn.exec(
        "SELECT COALESCE(MAX(p.position) + 1, 0) "
        "FROM pinned_folders p JOIN folders f ON f.id = p.folder_id "
        "WHERE p.user_id = $1 AND f.deleted_at IS NULL",
        pqxx::params{user_id}
    )[0][0].as<int>();

    txn.exec(
        "INSERT INTO pinned_folders (user_id, folder_id, position) VALUES ($1, $2, $3) "
        "ON CONFLICT (user_id, folder_id) DO NOTHING",
        pqxx::params{user_id, folder_id, next_position}
    );
    txn.commit();
}

void FolderManager::unpin_folder(uint64_t folder_id, uint64_t user_id) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);
    lock_user_pins(txn, user_id);

    auto folder = txn.exec(
        "SELECT user_id, deleted_at FROM folders WHERE id = $1 FOR SHARE",
        pqxx::params{folder_id}
    );
    if (folder.empty()) throw std::runtime_error("NOT_FOUND");
    if (folder[0][0].as<uint64_t>() != user_id) throw std::runtime_error("FORBIDDEN");
    if (!folder[0][1].is_null()) throw std::runtime_error("NOT_FOUND");

    txn.exec(
        "DELETE FROM pinned_folders WHERE user_id = $1 AND folder_id = $2",
        pqxx::params{user_id, folder_id}
    );
    normalize_active_pins(txn, user_id);
    txn.commit();
}

void FolderManager::reorder_pinned_folders(uint64_t user_id, const std::vector<uint64_t>& folder_ids) {
    auto conn = pool_.acquire_connection();
    pqxx::work txn(*conn);
    lock_user_pins(txn, user_id);

    auto current_rows = txn.exec(
        "SELECT p.folder_id "
        "FROM pinned_folders p JOIN folders f ON f.id = p.folder_id "
        "WHERE p.user_id = $1 AND f.deleted_at IS NULL "
        "ORDER BY p.folder_id FOR UPDATE",
        pqxx::params{user_id}
    );

    std::vector<uint64_t> current_ids;
    current_ids.reserve(current_rows.size());
    for (const auto& row : current_rows) current_ids.push_back(row[0].as<uint64_t>());

    auto requested = folder_ids;
    auto sorted_current = current_ids;
    auto sorted_requested = requested;
    std::sort(sorted_current.begin(), sorted_current.end());
    std::sort(sorted_requested.begin(), sorted_requested.end());
    if (sorted_current != sorted_requested) throw std::runtime_error("BAD_REQUEST");

    if (!folder_ids.empty()) {
        txn.exec(
            "WITH requested AS ("
            "  SELECT folder_id, position - 1 AS position "
            "  FROM unnest($1::bigint[]) WITH ORDINALITY AS x(folder_id, position)"
            ") "
            "UPDATE pinned_folders p SET position = requested.position "
            "FROM requested "
            "WHERE p.user_id = $2 AND p.folder_id = requested.folder_id",
            pqxx::params{to_pg_bigint_array(folder_ids), user_id}
        );
    }
    txn.commit();
}
