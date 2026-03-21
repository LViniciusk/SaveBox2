#include "controllers/ApiRouter.hpp"
#include "database/FolderManager.hpp"
#include "database/FileManager.hpp"
#include "storage/FileChunker.hpp"

#include <optional>

ApiRouter::ApiRouter(DatabasePool& pool, AuthService& auth, FolderManager& folder_mgr,
                     FileManager* file_mgr, FileChunker* chunker)
    : pool_(&pool), auth_(&auth), folder_mgr_(&folder_mgr),
            file_mgr_(file_mgr), chunker_(chunker) {
        auth_->set_database_pool(pool);
}

std::string ApiRouter::handle_healthcheck() const {
    return R"({"status":"online"})";
}

crow::response ApiRouter::handle_get_quota(const crow::request& req) {
    auto user_id_opt = authenticate_request(req);
    if (!user_id_opt) return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    uint64_t user_id = *user_id_opt;

    try {
        crow::json::wvalue res = file_mgr_->get_user_quota(user_id);
        return crow::response(200, res);
    } catch (const std::exception& e) {
        return crow::response(500, R"({"error":"Erro interno"})");
    }
}

crow::response ApiRouter::handle_register(const crow::request& req) {
    try {
        auto body = crow::json::load(req.body);
        if (!body) {
            return crow::response(400, R"({"error":"JSON invalido"})");
        }

        if (!body.has("username") || !body.has("email") || !body.has("password")) {
            return crow::response(400, R"({"error":"Campos obrigatorios ausentes"})");
        }

        std::string client_ip = req.remote_ip_address;
        std::string username = body["username"].s();
        std::string email = body["email"].s();
        std::string password = body["password"].s();

        auth_->register_user(username, email, password, client_ip);
        return crow::response(201, R"({"message":"Usuario criado. Verifique seu e-mail"})");

    } catch (const pqxx::unique_violation&) {
        return crow::response(409, R"({"error":"Usuario ja existe"})");
    } catch (const std::runtime_error& e) {
        std::string msg = e.what();
        if (msg == "USER_ALREADY_EXISTS") {
            return crow::response(409, R"({"error":"Usuario ja existe"})");
        }
        if (msg == "INVALID_EMAIL_FORMAT") {
            return crow::response(400, R"({"error":"Formato de e-mail invalido"})");
        }
        if (msg == "DISPOSABLE_EMAIL_LOCAL" || msg == "DISPOSABLE_EMAIL_API") {
            return crow::response(400, R"({"error":"E-mail descartavel nao permitido"})");
        }
        if (msg == "TOO_MANY_ACCOUNTS_FROM_IP") {
            return crow::response(429, R"({"error":"Muitas contas criadas por esta rede recentemente. Tente novamente amanha."})");
        }
        return crow::response(500, R"({"error":"Erro interno"})");

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
        int user_id = auth_->authenticate_user(username, password);

        return crow::response(200,
            R"({"message":"Login efetuado", "token":")" + auth_->generate_token(user_id) + R"("})");

    } catch (const std::runtime_error& e) {
        std::string msg = e.what();
        if (msg == "INVALID_CREDENTIALS") {
            return crow::response(401, R"({"error":"Credenciais invalidas"})");
        }
        if (msg == "EMAIL_NOT_VERIFIED") {
            return crow::response(403, R"({"error":"Conta nao verificada. Verifique seu e-mail"})");
        }
        return crow::response(500, R"({"error":"Erro interno"})");

    } catch (const std::exception& e) {
        return crow::response(500, R"({"error":"Erro interno"})");
    }
}

crow::response ApiRouter::handle_verify_email(const crow::request& req) {
    try {
        char* token_raw = req.url_params.get("token");
        if (token_raw == nullptr || std::string(token_raw).empty()) {
            return crow::response(400, R"({"error":"Token ausente"})");
        }

        auth_->verify_email(token_raw);
        return crow::response(200, R"({"message":"Conta ativada"})");
    } catch (const std::runtime_error& e) {
        std::string msg = e.what();
        if (msg == "INVALID_OR_EXPIRED_TOKEN") {
            return crow::response(400, R"({"error":"Token invalido ou expirado"})");
        }
        return crow::response(500, R"({"error":"Erro interno"})");
    } catch (const std::exception&) {
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
            R"({"message":"Pasta criada", "id":)" + std::to_string(folder_id) + "}");

    } catch (const pqxx::unique_violation& e) {
        return crow::response(409, R"({"error":"Pasta ja existe"})");
    } catch (const std::exception& e) {
        std::string msg = e.what();
        if (msg == "FOLDER_ALREADY_EXISTS") {
            return crow::response(409, R"({"error":"Uma pasta com este nome ja existe neste diretorio"})");
        }
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

        std::optional<uint64_t> folder_id = std::nullopt;
        if (body.has("folder_id") && body["folder_id"].t() != crow::json::type::Null) {
            folder_id = static_cast<uint64_t>(body["folder_id"].i());
        }
        std::string enc_name    = body["encrypted_name"].s();
        std::string name_hash   = body["name_hash"].s();
        uint64_t size_bytes     = static_cast<uint64_t>(body["size_bytes"].i());
        int total_chunks        = static_cast<int>(body["total_chunks"].i());

        int file_id = file_mgr_->init_upload(user_id, folder_id, enc_name, name_hash, size_bytes, total_chunks);

        return crow::response(201, R"({"file_id":)" + std::to_string(file_id) + "}");

    } catch (const std::exception& e) {
        std::string msg = e.what();
        if (msg == "QUOTA_EXCEEDED") {
            return crow::response(402, R"({"error":"Payment Required - Quota Exceeded"})");
        }
        if (msg == "FILE_ALREADY_EXISTS") {
            return crow::response(409, R"({"error":"Um arquivo com este nome ja existe nesta pasta"})");
        }
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
        
        size_t total_size = chunker_->get_file_size(file_id);
        std::string range_header = req.get_header_value("Range");

        if (range_header.empty()) {
            std::string content = chunker_->read_entire_file(static_cast<uint64_t>(file_id));
            crow::response res(200, content);
            res.set_header("Content-Type", "application/octet-stream");
            res.set_header("Accept-Ranges", "bytes");
            return res;
        }

        std::string prefix = "bytes=";
        if (range_header.find(prefix) != 0) {
            return crow::response(416);
        }

        std::string range_val = range_header.substr(prefix.length());
        size_t dash_pos = range_val.find('-');
        if (dash_pos == std::string::npos) {
            return crow::response(416);
        }

        std::string start_str = range_val.substr(0, dash_pos);
        std::string end_str = range_val.substr(dash_pos + 1);

        size_t start = 0;
        if (!start_str.empty()) {
            start = std::stoull(start_str);
        }

        if (start >= total_size) {
            crow::response res(416);
            res.set_header("Content-Range", "bytes */" + std::to_string(total_size));
            return res;
        }

        size_t end = total_size - 1;
        if (!end_str.empty()) {
            end = std::stoull(end_str);
        }

        if (end >= total_size) {
            end = total_size - 1;
        }

        if (start > end) {
            crow::response res(416);
            res.set_header("Content-Range", "bytes */" + std::to_string(total_size));
            return res;
        }

        size_t length = end - start + 1;
        std::string data = chunker_->read_file_portion(file_id, start, length);

        crow::response res(206, data);
        res.set_header("Content-Range", "bytes " + std::to_string(start) + "-" + std::to_string(end) + "/" + std::to_string(total_size));
        res.set_header("Content-Type", "application/octet-stream");
        res.set_header("Accept-Ranges", "bytes");

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

    int limit = 50;  
    int offset = 0;  

    char* limit_str = req.url_params.get("file_limit");
    char* offset_str = req.url_params.get("file_offset");

    try {
        if (limit_str != nullptr && std::string(limit_str) != "") {
            limit = std::stoi(limit_str);
        }
        if (offset_str != nullptr && std::string(offset_str) != "") {
            offset = std::stoi(offset_str);
        }

        auto folders = folder_mgr_->get_all_folders(user_id);
        auto files = file_mgr_->get_user_files_paginated(user_id, limit, offset);

        crow::json::wvalue response;
        response["folders"] = std::move(folders);
        response["files"] = std::move(files);
        return crow::response(200, response);
    } catch (const std::exception& e) {
        return crow::response(400, R"({"error":"Parametros de paginacao invalidos"})");
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

crow::response ApiRouter::handle_delete_file(const crow::request& req, int file_id) {
    auto user_id_opt = authenticate_request(req);
    if (!user_id_opt) {
        return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    }
    uint64_t user_id = *user_id_opt;

    try {
        file_mgr_->delete_file(static_cast<uint64_t>(file_id), user_id);
        
        return crow::response(200, R"({"message":"Arquivo movido para a lixeira"})");
        
    } catch (const std::exception& e) {
        std::string msg = e.what();
        if (msg == "NOT_FOUND") {
            return crow::response(404, R"({"error":"Arquivo nao encontrado"})");
        }
        return crow::response(500, R"({"error":"Erro interno"})");
    }
}

crow::response ApiRouter::handle_delete_folder(const crow::request& req, int folder_id) {
    auto user_id_opt = authenticate_request(req);
    if (!user_id_opt) {
        return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    }
    uint64_t user_id = *user_id_opt;

    try {
        folder_mgr_->delete_folder(static_cast<uint64_t>(folder_id), user_id);
        
        return crow::response(200, R"({"message":"Pasta movida para a lixeira"})");
        
    } catch (const std::exception& e) {
        std::string msg = e.what();
        if (msg == "NOT_FOUND") return crow::response(404, R"({"error":"Pasta nao encontrada"})");
        if (msg == "FORBIDDEN") return crow::response(403, R"({"error":"Proibido"})");
        return crow::response(500, R"({"error":"Erro interno"})");
    }
}

crow::response ApiRouter::handle_trash_folder(const crow::request& req, int folder_id) {
    auto user_id_opt = authenticate_request(req);
    if (!user_id_opt) return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    uint64_t user_id = *user_id_opt;

    try {
        folder_mgr_->delete_folder(static_cast<uint64_t>(folder_id), user_id);
        return crow::response(200, R"({"message":"Pasta enviada para a lixeira"})");
    } catch (const std::exception& e) {
        std::string msg = e.what();
        if (msg == "NOT_FOUND") return crow::response(404, R"({"error":"Pasta nao encontrada"})");
        return crow::response(500, R"({"error":"Erro interno"})");
    }
}

crow::response ApiRouter::handle_trash_file(const crow::request& req, int file_id) {
    auto user_id_opt = authenticate_request(req);
    if (!user_id_opt) return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    uint64_t user_id = *user_id_opt;

    try {
        file_mgr_->delete_file(static_cast<uint64_t>(file_id), user_id);
        return crow::response(200, R"({"message":"Arquivo enviado para a lixeira"})");
    } catch (const std::exception& e) {
        std::string msg = e.what();
        if (msg == "NOT_FOUND") return crow::response(404, R"({"error":"Arquivo nao encontrado"})");
        return crow::response(500, R"({"error":"Erro interno"})");
    }
}

crow::response ApiRouter::handle_restore_folder(const crow::request& req, int folder_id) {
    auto user_id_opt = authenticate_request(req);
    if (!user_id_opt) return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    uint64_t user_id = *user_id_opt;

    try {
        folder_mgr_->restore_folder(static_cast<uint64_t>(folder_id), user_id);
        return crow::response(200, R"({"message":"Pasta restaurada com sucesso"})");
    } catch (const std::exception& e) {
        std::string msg = e.what();
        if (msg == "NOT_FOUND")
            return crow::response(404, R"({"error":"Pasta nao encontrada na lixeira"})");

        if (msg == "FOLDER_ALREADY_EXISTS" || msg == "FILE_ALREADY_EXISTS") {
            return crow::response(409, R"({"error":"Item ja existe no destino"})");
        }

        return crow::response(500, R"({"error":"Erro interno: "})" + msg);
    }
}

crow::response ApiRouter::handle_restore_file(const crow::request& req, int file_id) {
    auto user_id_opt = authenticate_request(req);
    if (!user_id_opt) return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    uint64_t user_id = *user_id_opt;

    try {
        file_mgr_->restore_file(static_cast<uint64_t>(file_id), user_id);
        return crow::response(200, R"({"message":"Arquivo restaurado com sucesso"})");
    } catch (const std::exception& e) {
        std::string msg = e.what();
        if (msg == "NOT_FOUND") return crow::response(404, R"({"error":"Arquivo nao encontrado na lixeira"})");
        if (msg == "FILE_ALREADY_EXISTS" || msg == "FOLDER_ALREADY_EXISTS") return crow::response(409, R"({"error":"Item ja existe no destino"})");
        return crow::response(500, R"({"error":"Erro interno: "})" + msg);
    }
}

crow::response ApiRouter::handle_get_trash(const crow::request& req) {
    auto user_id_opt = authenticate_request(req);
    if (!user_id_opt) return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    uint64_t user_id = *user_id_opt;

    try {
        auto trash_contents = file_mgr_->get_trash(user_id);
        crow::response res(200, trash_contents.dump());
        res.set_header("Content-Type", "application/json");
        return res;
    } catch (const std::exception& e) {
        return crow::response(500, R"({"error":"Erro interno"})");
    }
}

crow::response ApiRouter::handle_empty_trash(const crow::request& req) {
    auto user_id_opt = authenticate_request(req);
    if (!user_id_opt) return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    uint64_t user_id = *user_id_opt;

    try {
        file_mgr_->empty_trash(user_id, chunker_);
        return crow::response(200, R"({"message":"Lixeira esvaziada com sucesso"})");
    } catch (const std::exception& e) {
        return crow::response(500, R"({"error":"Erro interno"})");
    }
}

crow::response ApiRouter::handle_update_file(const crow::request& req, int file_id) {
    auto user_id_opt = authenticate_request(req);
    if (!user_id_opt) return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    uint64_t user_id = *user_id_opt;

    auto body = crow::json::load(req.body);
    if (!body) return crow::response(400, R"({"error":"JSON invalido"})");

    std::optional<std::string> enc_name;
    std::optional<std::string> name_hash;
    std::optional<uint64_t> folder_id;

    if (body.has("encrypted_name")) enc_name = body["encrypted_name"].s();
    if (body.has("name_hash")) name_hash = body["name_hash"].s();
    if (body.has("folder_id")) {
        if (body["folder_id"].t() == crow::json::type::Null) {
            folder_id = 0; // 0 significa "Mover para a Raiz"
        } else {
            folder_id = static_cast<uint64_t>(body["folder_id"].i());
        }
    }

    try {
        crow::json::wvalue updated_json = file_mgr_->update_file(static_cast<uint64_t>(file_id), user_id, enc_name, name_hash, folder_id);
        return crow::response(200, updated_json);
    } catch (const std::exception& e) {
        std::string msg = e.what();
        if (msg == "NOT_FOUND") return crow::response(404, R"({"error":"Nao encontrado"})");
        if (msg == "FORBIDDEN") return crow::response(403, R"({"error":"Proibido"})");
        if (msg == "BAD_REQUEST") return crow::response(400, R"({"error":"Requisicao invalida"})");
        if (msg == "FILE_ALREADY_EXISTS") return crow::response(409, R"({"error":"Um arquivo com este nome ja existe nesta pasta"})");
        return crow::response(500, R"({"error":"Erro interno"})");
    }
}

crow::response ApiRouter::handle_update_folder(const crow::request& req, int folder_id) {
    auto user_id_opt = authenticate_request(req);
    if (!user_id_opt) return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    uint64_t user_id = *user_id_opt;

    auto body = crow::json::load(req.body);
    if (!body) return crow::response(400, R"({"error":"JSON invalido"})");

    std::optional<std::string> enc_name;
    std::optional<std::string> name_hash;
    std::optional<uint64_t> parent_id;

    if (body.has("encrypted_name")) enc_name = body["encrypted_name"].s();
    if (body.has("name_hash")) name_hash = body["name_hash"].s();
    if (body.has("parent_id")) {
        if (body["parent_id"].t() == crow::json::type::Null) {
            parent_id = 0; // 0 significa "Mover para a Raiz"
        } else {
            parent_id = static_cast<uint64_t>(body["parent_id"].i());
        }
    }

    try {
        crow::json::wvalue updated_json = folder_mgr_->update_folder(static_cast<uint64_t>(folder_id), user_id, enc_name, name_hash, parent_id);
        return crow::response(200, updated_json);
    } catch (const std::exception& e) {
        std::string msg = e.what();
        if (msg == "NOT_FOUND") return crow::response(404, R"({"error":"Nao encontrado"})");
        if (msg == "FORBIDDEN") return crow::response(403, R"({"error":"Proibido"})");
        if (msg == "BAD_REQUEST") return crow::response(400, R"({"error":"Requisicao invalida"})");
        return crow::response(500, R"({"error":"Erro interno"})");
    }
}

crow::response ApiRouter::handle_share_file(const crow::request& req, int file_id) {
    auto user_id_opt = authenticate_request(req);
    if (!user_id_opt) return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    uint64_t user_id = *user_id_opt;

    try {
        std::string uuid = file_mgr_->share_file(static_cast<uint64_t>(file_id), user_id);
        crow::json::wvalue res;
        res["share_uuid"] = uuid;
        return crow::response(200, res);
    } catch (const std::exception& e) {
        std::string msg = e.what();
        if (msg == "NOT_FOUND") return crow::response(404, R"({"error":"Nao encontrado ou acesso negado"})");
        return crow::response(500, R"({"error":"Erro interno"})");
    }
}

crow::response ApiRouter::handle_get_shared_file(const crow::request& req, const std::string& uuid) {
    try {
        auto [file_id, encrypted_name] = file_mgr_->get_shared_file_info(uuid);
        
        std::string content = chunker_->read_entire_file(file_id);
        
        crow::response res(200, content);
        res.set_header("Content-Type", "application/octet-stream");
        res.add_header("X-Encrypted-Name", encrypted_name);
        
        return res;
    } catch (const std::exception& e) {
        std::string msg = e.what();
        if (msg == "NOT_FOUND") return crow::response(404, R"({"error":"Link invalido ou expirado"})");
        return crow::response(500, R"({"error":"Erro interno"})");
    }
}




void ApiRouter::setup_routes(crow::App<crow::CORSHandler, RateLimitMiddleware>& app) {
    auto& cors = app.get_middleware<crow::CORSHandler>();
    cors.global()
        .headers("Origin", "Content-Type", "Accept", "Authorization", "X-Encrypted-Name")
        .methods("POST"_method, "GET"_method, "PUT"_method, "DELETE"_method, "OPTIONS"_method)
        .origin("*");

    CROW_ROUTE(app, "/health").methods(crow::HTTPMethod::Get)
    ([this]() {
        auto res = crow::response(handle_healthcheck());
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/users/me/quota").methods(crow::HTTPMethod::Get)
    ([this](const crow::request& req) {
        auto res = handle_get_quota(req);
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

    CROW_ROUTE(app, "/verify").methods(crow::HTTPMethod::Get)
    ([this](const crow::request& req) {
        auto res = handle_verify_email(req);
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

    CROW_ROUTE(app, "/files/<int>").methods(crow::HTTPMethod::Delete)
    ([this](const crow::request& req, int file_id) {
        return handle_delete_file(req, file_id);
    });

    CROW_ROUTE(app, "/folders/<int>").methods(crow::HTTPMethod::Delete)
    ([this](const crow::request& req, int folder_id) {
        return handle_delete_folder(req, folder_id);
    });

    CROW_ROUTE(app, "/files/<int>").methods(crow::HTTPMethod::Put)
    ([this](const crow::request& req, int file_id) {
        return handle_update_file(req, file_id);
    });

    CROW_ROUTE(app, "/folders/<int>").methods(crow::HTTPMethod::Put)
    ([this](const crow::request& req, int folder_id) {
        return handle_update_folder(req, folder_id);
    });

    CROW_ROUTE(app, "/files/<int>/share").methods(crow::HTTPMethod::Post)
    ([this](const crow::request& req, int file_id) {
        auto res = handle_share_file(req, file_id);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/share/<string>").methods(crow::HTTPMethod::Get)
    ([this](const crow::request& req, std::string uuid) {
        return handle_get_shared_file(req, uuid);
    });

    CROW_ROUTE(app, "/trash").methods(crow::HTTPMethod::Get)
    ([this](const crow::request& req) {
        return handle_get_trash(req);
    });

    CROW_ROUTE(app, "/trash/empty").methods(crow::HTTPMethod::Delete)
    ([this](const crow::request& req) {
        return handle_empty_trash(req);
    });

    CROW_ROUTE(app, "/files/<int>/restore").methods(crow::HTTPMethod::Post)
    ([this](const crow::request& req, int file_id) {
        return handle_restore_file(req, file_id);
    });

    CROW_ROUTE(app, "/folders/<int>/restore").methods(crow::HTTPMethod::Post)
    ([this](const crow::request& req, int folder_id) {
        return handle_restore_folder(req, folder_id);
    });
}




