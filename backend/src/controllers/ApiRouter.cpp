#include "controllers/ApiRouter.hpp"
#include <optional>

ApiRouter::ApiRouter(DatabasePool& pool, AuthService& auth, FolderManager& folder_mgr,
                     FileManager* file_mgr, FileChunker* chunker)
    : pool_(&pool), auth_(&auth), folder_mgr_(&folder_mgr),
      file_mgr_(file_mgr), chunker_(chunker) {}

std::string ApiRouter::handle_healthcheck() const {
    return R"({"status":"online"})";
}

crow::response ApiRouter::handle_register(const crow::request& req) {
    try {
        auto body = crow::json::load(req.body);
        if (!body) {
            return crow::response(400, R"({"error":"JSON invalido"})");
        }

        std::string username = body["username"].s();
        std::string password = body["password"].s();

        auto conn = pool_->acquire_connection();
        pqxx::work txn(*conn);

        auto check = txn.exec(
            "SELECT count(*) FROM users WHERE username = $1",
            pqxx::params{username}
        );

        if (check[0][0].as<int>() > 0) {
            return crow::response(409, R"({"error":"Usuario ja existe"})");
        }

        std::string hash = auth_->hash_password(password);

        auto result = txn.exec(
            "INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id",
            pqxx::params{username, hash}
        );

        txn.commit();

        int user_id = result[0][0].as<int>();
        return crow::response(201,
            R"({"message":"Usuario criado", "token":")" + auth_->generate_token(user_id) + R"("})");

    } catch (const std::exception& e) {
        return crow::response(500, R"({"error":"Erro interno"})");
    }
}

crow::response ApiRouter::handle_login(const crow::request& req) {
    try {
        auto body = crow::json::load(req.body);
        if (!body) {
            return crow::response(400, R"({"error":"JSON invalido"})");
        }

        std::string username = body["username"].s();
        std::string password = body["password"].s();

        auto conn = pool_->acquire_connection();
        pqxx::work txn(*conn);

        auto result = txn.exec(
            "SELECT id, password_hash FROM users WHERE username = $1",
            pqxx::params{username}
        );

        txn.commit();

        if (result.empty()) {
            return crow::response(401, R"({"error":"Credenciais invalidas"})");
        }

        int user_id = result[0][0].as<int>();
        std::string hash_do_banco = result[0][1].as<std::string>();

        if (!auth_->verify_password(password, hash_do_banco)) {
            return crow::response(401, R"({"error":"Credenciais invalidas"})");
        }

        return crow::response(200,
            R"({"message":"Login efetuado", "token":")" + auth_->generate_token(user_id) + R"("})");

    } catch (const std::exception& e) {
        return crow::response(500, R"({"error":"Erro interno"})");
    }
}

crow::response ApiRouter::handle_create_folder(const crow::request& req) {
    try {
        auto user_id_opt = authenticate_request(req);
        if (!user_id_opt) {
            return crow::response(401, R"({"error":"Token ausente ou invalido"})");
        }
        uint64_t user_id = *user_id_opt;

        auto body = crow::json::load(req.body);
        if (!body || !body.has("encrypted_name") || !body.has("name_hash")) {
            return crow::response(400, R"({"error":"JSON invalido"})");
        }

        std::string encrypted_name = body["encrypted_name"].s();
        std::string name_hash = body["name_hash"].s();

        std::optional<uint64_t> parent_id_opt;
        if (body.has("parent_id") && body["parent_id"].t() != crow::json::type::Null) {
            parent_id_opt = static_cast<uint64_t>(body["parent_id"].i());
        }

        uint64_t folder_id = folder_mgr_->create_folder(user_id, parent_id_opt, encrypted_name, name_hash);

        return crow::response(201,
            R"({"message":"Pasta criada", "folder_id":)" + std::to_string(folder_id) + "}");

    } catch (const pqxx::unique_violation& e) {
        return crow::response(409, R"({"error":"Pasta ja existe"})");
    } catch (const std::exception& e) {
        return crow::response(500, R"({"error":"Erro interno"})");
    }
}

std::optional<uint64_t> ApiRouter::authenticate_request(const crow::request& req) const {
    auto auth_header = req.get_header_value("Authorization");
    if (auth_header.empty() || auth_header.rfind("Bearer ", 0) != 0) {
        return std::nullopt;
    }
    std::string token = auth_header.substr(7); 
    return auth_->verify_token(token);
}

crow::response ApiRouter::handle_init_file_upload(const crow::request& req) {
    try {
        auto user_id_opt = authenticate_request(req);
        if (!user_id_opt) {
            return crow::response(401, R"({"error":"Token ausente ou invalido"})");
        }
        uint64_t user_id = *user_id_opt;

        auto body = crow::json::load(req.body);
        if (!body || !body.has("folder_id") || !body.has("encrypted_name") ||
            !body.has("name_hash") || !body.has("size_bytes") || !body.has("total_chunks")) {
            return crow::response(400, R"({"error":"JSON invalido"})");
        }

        uint64_t folder_id      = static_cast<uint64_t>(body["folder_id"].i());
        std::string enc_name    = body["encrypted_name"].s();
        std::string name_hash   = body["name_hash"].s();
        uint64_t size_bytes     = static_cast<uint64_t>(body["size_bytes"].i());
        int total_chunks        = static_cast<int>(body["total_chunks"].i());

        int file_id = file_mgr_->init_upload(user_id, folder_id, enc_name, name_hash, size_bytes, total_chunks);

        return crow::response(201, R"({"file_id":)" + std::to_string(file_id) + "}");

    } catch (const std::exception&) {
        return crow::response(500, R"({"error":"Erro interno"})");
    }
}

crow::response ApiRouter::handle_upload_chunk(const crow::request& req, int file_id) {
    try {
        auto user_id_opt = authenticate_request(req);
        if (!user_id_opt) {
            return crow::response(401, R"({"error":"Token ausente ou invalido"})");
        }
        uint64_t user_id = *user_id_opt;

        std::string chunk_index_str = req.get_header_value("X-Chunk-Index");
        if (chunk_index_str.empty()) {
            return crow::response(400, R"({"error":"Cabecalho X-Chunk-Index ausente"})");
        }
        int chunk_index = std::stoi(chunk_index_str);

        chunker_->write_chunk(static_cast<uint64_t>(file_id), chunk_index, req.body);
        
        file_mgr_->record_chunk_saved(file_id, chunk_index);

        int saved_chunks_count = file_mgr_->count_uploaded_chunks(static_cast<uint64_t>(file_id));
        int file_info_total_chunks = file_mgr_->get_total_chunks(static_cast<uint64_t>(file_id));

        if (saved_chunks_count == file_info_total_chunks) {
            file_mgr_->mark_upload_complete(static_cast<uint64_t>(file_id));
            return crow::response(200, R"({"status":"completed"})");
        }

        return crow::response(200, R"({"status":"uploading"})");

    } catch (const std::exception&) {
        return crow::response(500, R"({"error":"Erro interno"})");
    }
}

crow::response ApiRouter::handle_download_file(const crow::request& req, int file_id) {
    auto user_id_opt = authenticate_request(req);
    if (!user_id_opt) {
        return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    }
    uint64_t user_id = *user_id_opt;

    try {
        file_mgr_->can_user_download(static_cast<uint64_t>(file_id), user_id);
        std::string content = chunker_->read_entire_file(static_cast<uint64_t>(file_id));

        crow::response res(200, content);
        res.set_header("Content-Type", "application/octet-stream");
        return res;

    } catch (const std::exception& e) {
        std::string msg = e.what();
        if (msg.find("NOT_FOUND") != std::string::npos) {
            return crow::response(404, R"({"error":"Arquivo nao encontrado"})");
        }
        if (msg.find("INCOMPLETE") != std::string::npos) {
            return crow::response(400, R"({"error":"Upload incompleto"})");
        }
        return crow::response(500, R"({"error":"Erro interno"})");
    }
}

crow::response ApiRouter::handle_list_folder_contents(const crow::request& req, int folder_id) {
    auto user_id_opt = authenticate_request(req);
    if (!user_id_opt) {
        return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    }
    uint64_t user_id = *user_id_opt;

    try {
        auto contents = folder_mgr_->get_folder_contents(folder_id, static_cast<int>(user_id));
        crow::response res(200, contents.dump());
        res.set_header("Content-Type", "application/json");
        return res;
    } catch (const std::exception& e) {
        std::string msg = e.what();
        if (msg.find("NOT_FOUND") != std::string::npos) {
            return crow::response(404, R"({"error":"Pasta nao encontrada"})");
        }
        return crow::response(500, R"({"error":"Erro interno"})");
    }
}

crow::response ApiRouter::handle_get_tree(const crow::request& req) {
    auto user_id_opt = authenticate_request(req);
    if (!user_id_opt) {
        return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    }
    uint64_t user_id = *user_id_opt;

    char* limit_str = req.url_params.get("file_limit");
    char* offset_str = req.url_params.get("file_offset");

    if (!limit_str || !offset_str) {
        return crow::response(400, "Missing pagination parameters");
    }

    try {
        int limit = std::stoi(limit_str);
        int offset = std::stoi(offset_str);

        auto folders = folder_mgr_->get_all_folders(user_id);
        auto files = file_mgr_->get_user_files_paginated(user_id, limit, offset);

        crow::json::wvalue response;
        response["folders"] = std::move(folders);
        response["files"] = std::move(files);
        return crow::response(200, response);
    } catch (const std::exception& e) {
        return crow::response(400, "Invalid pagination parameters");
    }
}

crow::response ApiRouter::handle_get_uploaded_chunks(const crow::request& req, int file_id) {
    auto user_id_opt = authenticate_request(req);
    if (!user_id_opt) {
        return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    }
    uint64_t user_id = *user_id_opt;

    try {
        std::vector<int> chunks = file_mgr_->get_uploaded_chunks(file_id, user_id);
        crow::json::wvalue res;
        res["uploaded_chunks"] = chunks;
        return crow::response(200, res);

    } catch (const std::exception& e) {
        std::string msg = e.what();
        if (msg == "NOT_FOUND") {
            return crow::response(404, R"({"error":"Arquivo nao encontrado"})");
        } else if (msg == "ALREADY_COMPLETE") {
            return crow::response(400, R"({"error":"Upload ja finalizado"})");
        }
        return crow::response(500, R"({"error":"Erro interno"})");
    }
}

void ApiRouter::setup_routes(crow::SimpleApp& app) {
    CROW_ROUTE(app, "/health").methods(crow::HTTPMethod::Get)
    ([this]() {
        auto res = crow::response(handle_healthcheck());
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/register").methods(crow::HTTPMethod::Post)
    ([this](const crow::request& req) {
        auto res = handle_register(req);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/login").methods(crow::HTTPMethod::Post)
    ([this](const crow::request& req) {
        auto res = handle_login(req);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/folders").methods(crow::HTTPMethod::Post)
    ([this](const crow::request& req) {
        auto res = handle_create_folder(req);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/files").methods(crow::HTTPMethod::Post)
    ([this](const crow::request& req) {
        return handle_init_file_upload(req);
    });

    CROW_ROUTE(app, "/files/<int>/chunks").methods(crow::HTTPMethod::Post)
    ([this](const crow::request& req, int file_id) {
        auto res = handle_upload_chunk(req, file_id);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/files/<int>/download").methods(crow::HTTPMethod::Get)
    ([this](const crow::request& req, int file_id) {
        return handle_download_file(req, file_id);
    });

    CROW_ROUTE(app, "/folders/<int>/contents").methods(crow::HTTPMethod::Get)
    ([this](const crow::request& req, int folder_id) {
        return handle_list_folder_contents(req, folder_id);
    });

    CROW_ROUTE(app, "/tree").methods(crow::HTTPMethod::Get)
    ([this](const crow::request& req) {
        return handle_get_tree(req);
    });

    CROW_ROUTE(app, "/files/<int>/uploaded-chunks").methods(crow::HTTPMethod::Get)
    ([this](const crow::request& req, int file_id) {
        return handle_get_uploaded_chunks(req, file_id);
    });
}
