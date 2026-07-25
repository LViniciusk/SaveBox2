#include "controllers/ApiRouter.hpp"
#include "database/FolderManager.hpp"
#include "database/FileManager.hpp"
#include "database/UsersManager.hpp"
#include "storage/FileChunker.hpp"
#include "Services/GoogleDriveService.hpp"
#include "storage/GarbageCollector.hpp"
#include "utils.hpp"

#include <optional>
#include <unordered_set>
#include <fstream>
#include <sstream>
#include <thread>
#include <cpr/cpr.h>

ApiRouter::ApiRouter(DatabasePool& pool, AuthService& auth, FolderManager& folder_mgr,
                     FileManager* file_mgr, FileChunker* chunker,
                     GoogleDriveService* gdrive)
    : pool_(&pool), auth_(&auth), folder_mgr_(&folder_mgr),
            file_mgr_(file_mgr), chunker_(chunker), gdrive_(gdrive) {
        auth_->set_database_pool(pool);
}

std::string ApiRouter::handle_healthcheck() const {
    return R"({"status":"online"})";
}

void ApiRouter::trigger_async_gc_cleanup() {
    if (gdrive_ && pool_) {
        std::thread([this]() {
            try {
                GarbageCollector gc(*pool_, chunker_, gdrive_);
                gc.run_cleanup();
            } catch (const std::exception& e) {
                std::cerr << "[GC Async Trigger] Erro ao executar limpeza: " << e.what() << std::endl;
            }
        }).detach();
    }
}

crow::response ApiRouter::handle_init_vault(const crow::request& req) {
    auto user_id_opt = authenticate_request(req);
    if (!user_id_opt) return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    uint64_t user_id = *user_id_opt;

    try {
        auto body = crow::json::load(req.body);
        std::string vault_verification;
        if (body && body.has("vault_verification") && body["vault_verification"].t() == crow::json::type::String) {
            vault_verification = body["vault_verification"].s();
        }

        auto conn = pool_->acquire_connection();
        pqxx::work txn(*conn);
        if (!vault_verification.empty()) {
            txn.exec(
                "UPDATE users SET is_vault_initialized = TRUE, vault_verification = $2 WHERE id = $1",
                pqxx::params{user_id, vault_verification}
            );
        } else {
            txn.exec(
                "UPDATE users SET is_vault_initialized = TRUE WHERE id = $1",
                pqxx::params{user_id}
            );
        }
        txn.commit();
        return crow::response(204);
    } catch (const std::exception& e) {
        return crow::response(500, R"({"error":"Erro ao inicializar drive"})");
    }
}

crow::response ApiRouter::handle_get_vault_verification(const crow::request& req) {
    auto user_id_opt = authenticate_request(req);
    if (!user_id_opt) return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    uint64_t user_id = *user_id_opt;

    try {
        auto conn = pool_->acquire_connection();
        pqxx::nontransaction ntxn(*conn);
        auto result = ntxn.exec(
            "SELECT vault_verification FROM users WHERE id = " + ntxn.quote(user_id)
        );
        if (result.empty() || result[0][0].is_null()) {
            return crow::response(404, R"({"error":"Verificacao de drive nao configurada"})");
        }
        std::string verification = result[0][0].as<std::string>();
        crow::json::wvalue res;
        res["vault_verification"] = verification;
        return crow::response(200, res);
    } catch (const std::exception& e) {
        return crow::response(500, R"({"error":"Erro interno"})");
    }
}

crow::response ApiRouter::handle_update_profile(const crow::request& req) {
    auto user_id_opt = authenticate_request(req);
    if (!user_id_opt) return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    uint64_t user_id = *user_id_opt;

    auto body = crow::json::load(req.body);
    if (!body) return crow::response(400, R"({"error":"JSON invalido"})");

    std::string full_name = body.has("full_name") ? body["full_name"].s() : std::string("");
    std::string avatar_url = body.has("avatar_url") ? body["avatar_url"].s() : std::string("");

    try {
        auto conn = pool_->acquire_connection();
        pqxx::work txn(*conn);
        txn.exec(
            "UPDATE users SET full_name = $1, avatar_url = $2 WHERE id = $3",
            pqxx::params{full_name, avatar_url, user_id}
        );
        txn.commit();
        
        crow::json::wvalue res;
        res["status"] = "success";
        res["full_name"] = full_name;
        res["avatar_url"] = avatar_url;
        return crow::response(200, res);
    } catch (const std::exception& e) {
        return crow::response(500, R"({"error":"Erro ao atualizar perfil"})");
    }
}

crow::response ApiRouter::handle_get_quota(const crow::request& req) {
    auto user_id_opt = authenticate_request(req);
    if (!user_id_opt) return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    uint64_t user_id = *user_id_opt;

    try {
        crow::json::wvalue res = file_mgr_->get_user_quota(user_id);
        
        uint64_t gd_used = 0;
        uint64_t gd_max = 0;
        if (gdrive_) {
            auto q_pair = gdrive_->get_total_quota(user_id);
            gd_used = q_pair.first;
            gd_max = q_pair.second;
        }
        res["gdrive_used_bytes"] = gd_used;
        res["gdrive_max_bytes"] = gd_max;

        return crow::response(200, res);
    } catch (const std::exception& e) {
        return crow::response(500, R"({"error":"Erro interno"})");
    }
}

crow::response ApiRouter::handle_delete_user(const crow::request& req) {
    auto user_id_opt = authenticate_request(req);
    if (!user_id_opt) return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    uint64_t user_id = *user_id_opt;

    try {
        UsersManager users_mgr(*pool_);
        users_mgr.delete_user(user_id);
        return crow::response(200, R"({"message":"Conta encerrada com sucesso"})");
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

        std::string client_ip = req.get_header_value("CF-Connecting-IP");
        if (client_ip.empty()) {
            client_ip = req.remote_ip_address.empty() ? "unknown" : req.remote_ip_address;
        }
        std::string username;
        std::string email;
        std::string password;

        try {
            username = body["username"].s();
            email = body["email"].s();
            password = body["password"].s();
        } catch (const std::runtime_error&) {
            return crow::response(400, R"({"error":"Tipos de dados invalidos no JSON"})");
        }

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

        std::string username;
        std::string password;

        try {
            username = body["username"].s();
            password = body["password"].s();
        } catch (const std::runtime_error&) {
            return crow::response(400, R"({"error":"Tipos de dados invalidos no JSON"})");
        }
        int user_id = auth_->authenticate_user(username, password);

        std::string token = auth_->generate_token(user_id);
        crow::response res(200, R"({"message":"Login efetuado", "token":")" + token + R"("})");
        res.set_header("Set-Cookie", "jwt=" + token + "; HttpOnly; Path=/; Max-Age=86400; SameSite=Lax");
        return res;

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

crow::response ApiRouter::handle_logout(const crow::request& req) {
    auto user_id_opt = authenticate_request(req);
    if (!user_id_opt) {
        return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    }

    auto auth_header = req.get_header_value("Authorization");
    std::string token = auth_header.substr(7);
    std::string jti = auth_->extract_jti(token);

    if (!jti.empty()) {
        auth_->logout_local(jti);
    }

    crow::response res(200, R"({"message":"Logout local realizado com sucesso"})");
    res.set_header("Set-Cookie", "jwt=; HttpOnly; Path=/; Max-Age=0");
    return res;
}

crow::response ApiRouter::handle_logout_global(const crow::request& req) {
    auto user_id_opt = authenticate_request(req);
    if (!user_id_opt) {
        return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    }
    uint64_t user_id = *user_id_opt;

    try {
        auto conn = pool_->acquire_connection();
        pqxx::work txn(*conn);
        txn.exec(
            "UPDATE users SET token_version = token_version + 1 WHERE id = $1",
            pqxx::params{user_id}
        );
        txn.commit();

        crow::response res(200, R"({"message":"Logout global realizado com sucesso"})");
        res.set_header("Set-Cookie", "jwt=; HttpOnly; Path=/; Max-Age=0");
        return res;
    } catch (const std::exception& e) {
        return crow::response(500, R"({"error":"Erro interno ao realizar logout global"})");
    }
}

crow::response ApiRouter::handle_google_login(const crow::request& req) {
    auto req_json = crow::json::load(req.body);
    if (!req_json) {
        return crow::response(400, R"({"error": "JSON Invalido"})");
    }

    if (!req_json.has("id_token") || req_json["id_token"].t() != crow::json::type::String) {
        return crow::response(400, R"({"error": "id_token obrigatorio e deve ser uma string"})");
    }

    if (!req_json.has("nonce") || req_json["nonce"].t() != crow::json::type::String) {
        return crow::response(400, R"({"error": "nonce obrigatorio e deve ser uma string"})");
    }

    std::string id_token = req_json["id_token"].s();
    std::string nonce = req_json["nonce"].s();

    try {
        int user_id = auth_->handle_google_login(id_token, nonce);
        std::string jwt_token = auth_->generate_token(user_id);
        
        crow::json::wvalue res_body;
        res_body["token"] = jwt_token;
        crow::response res(200, res_body);
        res.set_header("Set-Cookie", "jwt=" + jwt_token + "; HttpOnly; Path=/; Max-Age=86400; SameSite=Lax");
        return res;
    } catch (const std::invalid_argument& e) {
        return crow::response(400, R"({"error": "Falha na autenticacao com o provedor."})");
    } catch (const std::runtime_error& e) {
        std::string err_msg = e.what();
        if (err_msg == "GOOGLE_API_UNAVAILABLE") {
            return crow::response(502, R"({"error": "Servico de autenticacao indisponivel no momento."})");
        } else if (err_msg == "ACCOUNT_EXISTS_WITH_DIFFERENT_PROVIDER") {
            return crow::response(409, R"({"error": "Erro interno."})");
        }
        
        std::cerr << "[Google Login Error] " << err_msg << std::endl;
        return crow::response(500, R"({"error": "Erro interno durante a autenticacao."})");
    }
}

crow::response ApiRouter::handle_refresh(const crow::request& req) {
    auto cookie_header = req.get_header_value("Cookie");
    std::string token_from_cookie;
    
    size_t pos = cookie_header.find("jwt=");
    if (pos != std::string::npos) {
        size_t end_pos = cookie_header.find(";", pos);
        if (end_pos == std::string::npos) {
            token_from_cookie = cookie_header.substr(pos + 4);
        } else {
            token_from_cookie = cookie_header.substr(pos + 4, end_pos - pos - 4);
        }
    }
    
    if (token_from_cookie.empty()) {
        return crow::response(401, R"({"error": "Sessao invalida ou expirada."})");
    }
    
    auto user_id_opt = auth_->verify_token(token_from_cookie);
    if (!user_id_opt) {
        return crow::response(401, R"({"error": "Sessao invalida ou expirada."})");
    }
    
    std::string new_token = auth_->generate_token(*user_id_opt);
    
    crow::json::wvalue res_body;
    res_body["token"] = new_token;
    crow::response res(200, res_body);
    res.set_header("Set-Cookie", "jwt=" + new_token + "; HttpOnly; Path=/; Max-Age=86400; SameSite=Lax");
    return res;
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

crow::response ApiRouter::handle_update_profile_pic(const crow::request& req) {
    try {
        auto user_id_opt = authenticate_request(req);
        if (!user_id_opt) {
            return crow::response(401, R"({"error":"Token ausente ou invalido"})");
        }
        uint64_t user_id = *user_id_opt;

        std::string content_type = req.get_header_value("Content-Type");
        if (content_type.find("multipart/form-data") == std::string::npos) {
            return crow::response(400, R"({"error":"Apenas multipart/form-data eh suportado"})");
        }

        crow::multipart::message msg(req);
        std::string image_data;
        bool found_image = false;

        for (const auto& part : msg.parts) {
            std::cout << "Parsed multipart part. Headers:" << std::endl;
            for (const auto& h : part.headers) {
                std::cout << "  " << h.first << ": " << h.second.value << std::endl;
                for (const auto& p : h.second.params) {
                    std::cout << "    Param " << p.first << " = " << p.second << std::endl;
                }
            }

            auto it = part.headers.find("Content-Disposition");
            if (it == part.headers.end()) {
                it = part.headers.find("content-disposition");
            }

            if (it != part.headers.end()) {
                auto name_it = it->second.params.find("name");
                if (name_it != it->second.params.end() && name_it->second == "image") {
                    image_data = part.body;
                    found_image = true;
                    break;
                }
            }
        }

        if (!found_image || image_data.empty()) {
            return crow::response(400, R"({"error":"Arquivo de imagem nao encontrado"})");
        }

        std::string client_id = DotEnv::get_imgur_client_id();

        cpr::Response r = cpr::Post(
            cpr::Url{"https://api.imgur.com/3/image"},
            cpr::Header{{"Authorization", "Client-ID " + client_id}},
            cpr::Multipart{{"image", cpr::Buffer{image_data.begin(), image_data.end(), "avatar.png"}}}
        );

        if (r.status_code != 200) {
            std::cerr << "Imgur Upload Failed: " << r.text << std::endl;
            return crow::response(500, R"({"error":"Falha ao fazer upload para o Imgur"})");
        }

        auto json_val = crow::json::load(r.text);
        if (!json_val) {
            return crow::response(500, R"({"error":"Resposta invalida do Imgur"})");
        }

        if (!json_val.has("success") || json_val["success"].t() != crow::json::type::True) {
            return crow::response(500, R"({"error":"Falha ao fazer upload da imagem"})");
        }

        if (!json_val.has("data") || json_val["data"].t() != crow::json::type::Object) {
            return crow::response(500, R"({"error":"Resposta invalida do Imgur"})");
        }

        auto data_obj = json_val["data"];
        if (!data_obj.has("link") || data_obj["link"].t() != crow::json::type::String) {
            return crow::response(500, R"({"error":"Link nao encontrado na resposta"})");
        }

        std::string avatar_url = json_val["data"]["link"].s();

        try {
            auto conn = pool_->acquire_connection();
            pqxx::work txn(*conn);
            txn.exec("UPDATE users SET avatar_url = $1 WHERE id = $2", pqxx::params{avatar_url, user_id});
            txn.commit();
        } catch (const std::exception& e) {
            std::cerr << "Erro ao atualizar avatar no banco: " << e.what() << std::endl;
            return crow::response(500, R"({"error":"Erro ao salvar a url da imagem"})");
        }

        crow::json::wvalue res;
        res["status"] = "success";
        res["avatar_url"] = avatar_url;
        return crow::response(200, res);
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

        std::string encrypted_name;
        std::string name_hash;
        std::optional<uint64_t> parent_id_opt;

        try {
            encrypted_name = body["encrypted_name"].s();
            name_hash = body["name_hash"].s();

            if (body.has("parent_id") && body["parent_id"].t() != crow::json::type::Null) {
                parent_id_opt = static_cast<uint64_t>(body["parent_id"].i());
            }
        } catch (const std::runtime_error&) {
            return crow::response(400, R"({"error":"Tipos de dados invalidos no JSON"})");
        }

        uint64_t folder_id = folder_mgr_->create_folder(user_id, parent_id_opt, encrypted_name, name_hash);

        return crow::response(201,
            R"({"message":"Pasta criada", "id":)" + std::to_string(folder_id) + "}");

    } catch (const pqxx::unique_violation& e) {
        return crow::response(409, R"({"error":"Pasta ja existe"})");
    } catch (const std::exception& e) {
        std::string msg = e.what();
        if (msg == "FORBIDDEN") {
            return crow::response(403, R"({"error":"Proibido"})");
        }
        if (msg == "FOLDER_ALREADY_EXISTS") {
            return crow::response(409, R"({"error":"Uma pasta com este nome ja existe neste diretorio"})");
        }
        return crow::response(500, R"({"error":"Erro interno"})");
    }
}

crow::response ApiRouter::handle_get_pinned_folders(const crow::request& req) {
    auto user_id_opt = authenticate_request(req);
    if (!user_id_opt) return crow::response(401, R"({"error":"Token ausente ou invalido"})");

    try {
        crow::json::wvalue body;
        std::vector<crow::json::wvalue> folders;
        for (const auto& pin : folder_mgr_->get_pinned_folders(*user_id_opt)) {
            crow::json::wvalue item;
            item["folder_id"] = pin.folder_id;
            item["position"] = pin.position;
            folders.push_back(std::move(item));
        }
        body["folders"] = std::move(folders);
        return crow::response(200, body);
    } catch (const std::exception&) {
        return crow::response(500, R"({"error":"Erro interno"})");
    }
}

crow::response ApiRouter::handle_pin_folder(const crow::request& req, int folder_id) {
    auto user_id_opt = authenticate_request(req);
    if (!user_id_opt) return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    if (folder_id <= 0) return crow::response(404, R"({"error":"Pasta nao encontrada"})");

    try {
        folder_mgr_->pin_folder(static_cast<uint64_t>(folder_id), *user_id_opt);
        return crow::response(204);
    } catch (const std::exception& e) {
        const std::string msg = e.what();
        if (msg == "FORBIDDEN") return crow::response(403, R"({"error":"Proibido"})");
        if (msg == "NOT_FOUND") return crow::response(404, R"({"error":"Pasta nao encontrada"})");
        return crow::response(500, R"({"error":"Erro interno"})");
    }
}

crow::response ApiRouter::handle_unpin_folder(const crow::request& req, int folder_id) {
    auto user_id_opt = authenticate_request(req);
    if (!user_id_opt) return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    if (folder_id <= 0) return crow::response(404, R"({"error":"Pasta nao encontrada"})");

    try {
        folder_mgr_->unpin_folder(static_cast<uint64_t>(folder_id), *user_id_opt);
        return crow::response(204);
    } catch (const std::exception& e) {
        const std::string msg = e.what();
        if (msg == "FORBIDDEN") return crow::response(403, R"({"error":"Proibido"})");
        if (msg == "NOT_FOUND") return crow::response(404, R"({"error":"Pasta nao encontrada"})");
        return crow::response(500, R"({"error":"Erro interno"})");
    }
}

crow::response ApiRouter::handle_reorder_pinned_folders(const crow::request& req) {
    auto user_id_opt = authenticate_request(req);
    if (!user_id_opt) return crow::response(401, R"({"error":"Token ausente ou invalido"})");

    auto body = crow::json::load(req.body);
    if (!body || !body.has("folder_ids") || body["folder_ids"].t() != crow::json::type::List) {
        return crow::response(400, R"({"error":"folder_ids deve ser um array"})");
    }

    std::vector<uint64_t> folder_ids;
    std::unordered_set<uint64_t> seen;
    try {
        for (const auto& item : body["folder_ids"]) {
            if (item.t() != crow::json::type::Number || item.i() <= 0) {
                return crow::response(400, R"({"error":"folder_ids contem tipo invalido"})");
            }
            const auto folder_id = static_cast<uint64_t>(item.i());
            if (!seen.insert(folder_id).second) {
                return crow::response(400, R"({"error":"folder_ids nao pode conter duplicados"})");
            }
            folder_ids.push_back(folder_id);
        }
        folder_mgr_->reorder_pinned_folders(*user_id_opt, folder_ids);
        return crow::response(204);
    } catch (const std::exception& e) {
        if (std::string(e.what()) == "BAD_REQUEST") {
            return crow::response(400, R"({"error":"A ordem deve representar exatamente as pastas fixadas"})");
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
            !body.has("name_hash") || !body.has("encrypted_fdk") || !body.has("size_bytes")) {
            return crow::response(400, R"({"error":"JSON invalido"})");
        }

        std::optional<uint64_t> folder_id = std::nullopt;
        std::string enc_name;
        std::string name_hash;
        std::string encrypted_fdk;
        int64_t raw_size_bytes;
        std::string storage_provider = "local";

        std::optional<std::string> proxy_external_file_id = std::nullopt;
        std::optional<uint64_t> proxy_size_bytes = std::nullopt;
        std::optional<std::string> proxy_encrypted_fdk = std::nullopt;
        bool is_hidden = false;
        
        int64_t raw_total_chunks = 0;
        bool has_total_chunks = false;

        try {
            if (body.has("folder_id") && body["folder_id"].t() != crow::json::type::Null) {
                folder_id = static_cast<uint64_t>(body["folder_id"].i());
            }
            enc_name    = body["encrypted_name"].s();
            name_hash   = body["name_hash"].s();
            encrypted_fdk = body["encrypted_fdk"].s();
            raw_size_bytes = body["size_bytes"].i();

            if (body.has("storage_provider") && body["storage_provider"].t() == crow::json::type::String) {
                storage_provider = body["storage_provider"].s();
            }

            if (body.has("proxy_external_file_id") && body["proxy_external_file_id"].t() == crow::json::type::String) {
                proxy_external_file_id = body["proxy_external_file_id"].s();
            }
            if (body.has("proxy_size_bytes")) {
                int64_t proxy_size = body["proxy_size_bytes"].i();
                if (proxy_size >= 0) proxy_size_bytes = static_cast<uint64_t>(proxy_size);
            }
            if (body.has("proxy_encrypted_fdk") && body["proxy_encrypted_fdk"].t() == crow::json::type::String) {
                proxy_encrypted_fdk = body["proxy_encrypted_fdk"].s();
            }
            if (body.has("is_hidden") && body["is_hidden"].t() == crow::json::type::True) {
                is_hidden = true;
            }
            if (body.has("is_hidden") && body["is_hidden"].t() == crow::json::type::False) {
                is_hidden = false;
            }

            if (body.has("total_chunks")) {
                has_total_chunks = true;
                raw_total_chunks = body["total_chunks"].i();
            }

        } catch (const std::runtime_error&) {
            return crow::response(400, R"({"error":"Tipos de dados invalidos no JSON"})");
        }

        if (raw_size_bytes < 0) {
            return crow::response(400, R"({"error":"Valores numericos invalidos"})");
        }

        uint64_t size_bytes = static_cast<uint64_t>(raw_size_bytes);

        if (storage_provider == "google_drive") {
            if (!gdrive_ || !gdrive_->is_linked(user_id)) {
                return crow::response(400, R"({"error":"Conta Google Drive nao vinculada"})");
            }

            std::string access_token;
            std::string root_folder_id;
            uint64_t best_storage_id = gdrive_->select_best_storage(user_id, size_bytes, access_token, root_folder_id);
            
            if (best_storage_id == 0) {
                return crow::response(507, R"({"error":"Espaço insuficiente nas contas vinculadas"})");
            }

            int file_id = file_mgr_->init_external_upload(
                user_id, folder_id, enc_name, name_hash, encrypted_fdk, size_bytes, storage_provider, best_storage_id,
                proxy_external_file_id, proxy_size_bytes, proxy_encrypted_fdk, is_hidden
            );

            crow::json::wvalue res_body;
            res_body["file_id"] = file_id;
            res_body["storage_provider"] = "google_drive";
            res_body["access_token"] = access_token;
            res_body["root_folder_id"] = root_folder_id;
            res_body["name_hash"] = name_hash;
            return crow::response(201, res_body);
        }

        if (!has_total_chunks) {
            return crow::response(400, R"({"error":"JSON invalido"})");
        }

        if (raw_total_chunks <= 0) {
            return crow::response(400, R"({"error":"Valores numericos invalidos"})");
        }

        int total_chunks = static_cast<int>(raw_total_chunks);

        constexpr uint64_t CHUNK_SIZE = 4ULL * 1024 * 1024;
        int expected_chunks = static_cast<int>((size_bytes + CHUNK_SIZE - 1) / CHUNK_SIZE);
        if (expected_chunks == 0) expected_chunks = 1;
        if (total_chunks != expected_chunks) {
            return crow::response(400, R"({"error":"Quantidade de chunks incompativel com o tamanho do arquivo"})");
        }

        int file_id = file_mgr_->init_upload(user_id, folder_id, enc_name, name_hash, encrypted_fdk, size_bytes, total_chunks,
                                             proxy_external_file_id, proxy_size_bytes, proxy_encrypted_fdk, is_hidden);

        return crow::response(201, R"({"file_id":)" + std::to_string(file_id) + "}");

    } catch (const std::exception& e) {
        std::string msg = e.what();
        if (msg == "FORBIDDEN") {
            return crow::response(403, R"({"error":"Proibido"})");
        }
        if (msg == "QUOTA_EXCEEDED") {
            return crow::response(402, R"({"error":"Payment Required - Quota Exceeded"})");
        }
        if (msg == "FILE_ALREADY_EXISTS") {
            return crow::response(409, R"({"error":"Um arquivo com este nome ja existe nesta pasta"})");
        }
        if (msg == "GOOGLE_DRIVE_NOT_LINKED") {
            return crow::response(400, R"({"error":"Conta Google Drive nao vinculada"})");
        }
        if (msg == "GOOGLE_TOKEN_REFRESH_FAILED") {
            return crow::response(502, R"({"error":"Falha ao obter token do Google Drive"})");
        }
        return crow::response(500, R"({"error":"Erro interno"})");
    }
}

crow::response ApiRouter::handle_batch_init_uploads(const crow::request& req) {
    try {
        auto user_id_opt = authenticate_request(req);
        if (!user_id_opt) {
            return crow::response(401, R"({"error":"Token ausente ou invalido"})");
        }
        uint64_t user_id = *user_id_opt;

        auto body = crow::json::load(req.body);
        if (!body || !body.has("files") || body["files"].t() != crow::json::type::List) {
            return crow::response(400, R"({"error":"JSON invalido ou ausente array 'files'"})");
        }

        auto files_json = body["files"];
        if (files_json.size() == 0 || files_json.size() > 100) {
            return crow::response(400, R"({"error":"Lote deve ter entre 1 e 100 arquivos"})");
        }

        std::vector<BatchInitItem> batch_items;
        std::map<std::string, std::pair<std::string, std::string>> gdrive_tokens; // root_folder_id, access_token

        constexpr uint64_t CHUNK_SIZE = 4ULL * 1024 * 1024;

        for (const auto& item : files_json) {
            if (!item.has("encrypted_name") || !item.has("name_hash") || 
                !item.has("encrypted_fdk") || !item.has("size_bytes")) {
                return crow::response(400, R"({"error":"Metadados incompletos no lote"})");
            }

            BatchInitItem b_item;
            try {
                if (item.has("folder_id") && item["folder_id"].t() != crow::json::type::Null) {
                    b_item.folder_id = static_cast<uint64_t>(item["folder_id"].i());
                }
                b_item.enc_name = item["encrypted_name"].s();
                b_item.name_hash = item["name_hash"].s();
                b_item.encrypted_fdk = item["encrypted_fdk"].s();
                
                int64_t raw_size = item["size_bytes"].i();
                if (raw_size < 0) return crow::response(400, R"({"error":"Valores numericos invalidos"})");
                b_item.size_bytes = static_cast<uint64_t>(raw_size);

                b_item.storage_provider = "local";
                if (item.has("storage_provider") && item["storage_provider"].t() == crow::json::type::String) {
                    b_item.storage_provider = item["storage_provider"].s();
                }

                if (b_item.storage_provider == "local") {
                    if (!item.has("total_chunks")) return crow::response(400, R"({"error":"Arquivos locais precisam de total_chunks"})");
                    int64_t raw_chunks = item["total_chunks"].i();
                    if (raw_chunks <= 0) return crow::response(400, R"({"error":"total_chunks invalido"})");
                    b_item.total_chunks = static_cast<int>(raw_chunks);

                    int expected_chunks = static_cast<int>((b_item.size_bytes + CHUNK_SIZE - 1) / CHUNK_SIZE);
                    if (expected_chunks == 0) expected_chunks = 1;
                    if (b_item.total_chunks != expected_chunks) {
                        return crow::response(400, R"({"error":"Quantidade de chunks incompativel"})");
                    }
                } else if (b_item.storage_provider == "google_drive") {
                    if (!gdrive_ || !gdrive_->is_linked(user_id)) {
                        return crow::response(400, R"({"error":"Conta Google Drive nao vinculada"})");
                    }
                    std::string access_token;
                    std::string root_folder_id;
                    uint64_t best_storage_id = gdrive_->select_best_storage(user_id, b_item.size_bytes, access_token, root_folder_id);
                    if (best_storage_id == 0) {
                        return crow::response(507, R"({"error":"Espaço insuficiente nas contas vinculadas"})");
                    }
                    b_item.external_storage_id = best_storage_id;
                    gdrive_tokens[b_item.name_hash] = {root_folder_id, access_token};
                } else {
                    return crow::response(400, R"({"error":"storage_provider invalido"})");
                }

                if (item.has("proxy_external_file_id") && item["proxy_external_file_id"].t() == crow::json::type::String) {
                    b_item.proxy_external_file_id = item["proxy_external_file_id"].s();
                }
                if (item.has("proxy_size_bytes")) {
                    int64_t proxy_size = item["proxy_size_bytes"].i();
                    if (proxy_size >= 0) {
                        b_item.proxy_size_bytes = static_cast<uint64_t>(proxy_size);
                    }
                }
                if (item.has("proxy_encrypted_fdk") && item["proxy_encrypted_fdk"].t() == crow::json::type::String) {
                    b_item.proxy_encrypted_fdk = item["proxy_encrypted_fdk"].s();
                }
                if (item.has("is_hidden") && item["is_hidden"].t() == crow::json::type::True) {
                    b_item.is_hidden = true;
                }
                if (item.has("is_hidden") && item["is_hidden"].t() == crow::json::type::False) {
                    b_item.is_hidden = false;
                }

            } catch (const std::runtime_error&) {
                return crow::response(400, R"({"error":"Tipos de dados invalidos no JSON"})");
            }
            batch_items.push_back(b_item);
        }

        auto db_results = file_mgr_->batch_init_uploads(user_id, batch_items);

        std::vector<crow::json::wvalue> res_array;
        for (const auto& r : db_results) {
            crow::json::wvalue item_res;
            item_res["file_id"] = r.file_id;
            item_res["name_hash"] = r.name_hash;
            item_res["storage_provider"] = r.storage_provider;
            
            if (r.storage_provider == "google_drive") {
                auto it = gdrive_tokens.find(r.name_hash);
                if (it != gdrive_tokens.end()) {
                    item_res["root_folder_id"] = it->second.first;
                    item_res["access_token"] = it->second.second;
                }
            }
            res_array.push_back(std::move(item_res));
        }

        crow::json::wvalue res_body;
        res_body["files"] = std::move(res_array);
        return crow::response(201, res_body);

    } catch (const std::exception& e) {
        std::string msg = e.what();
        if (msg == "FORBIDDEN_FOLDER") return crow::response(403, R"({"error":"Proibido acesso a pasta"})");
        if (msg == "QUOTA_EXCEEDED") return crow::response(402, R"({"error":"Payment Required - Quota Exceeded"})");
        if (msg == "FILE_ALREADY_EXISTS") return crow::response(409, R"({"error":"Colisao de arquivos detectada"})");
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

        std::string provider = file_mgr_->get_storage_provider(static_cast<uint64_t>(file_id), user_id);
        if (provider != "local") {
            return crow::response(400, R"({"error":"Operacao de chunks nao suportada para armazenamento externo"})");
        }

        if (file_mgr_->is_upload_complete(static_cast<uint64_t>(file_id), user_id)) {
            return crow::response(400, R"({"error":"Upload ja finalizado"})");
        }

        std::string chunk_index_str = req.get_header_value("X-Chunk-Index");
        if (chunk_index_str.empty()) {
            return crow::response(400, R"({"error":"Cabecalho X-Chunk-Index ausente"})");
        }
        int chunk_index = std::stoi(chunk_index_str);

        int total_chunks = file_mgr_->get_total_chunks(static_cast<uint64_t>(file_id), user_id);
        if (chunk_index < 0 || chunk_index >= total_chunks) {
            return crow::response(400, R"({"error":"Indice de chunk invalido ou fora dos limites"})");
        }

        if (!chunker_->write_chunk(static_cast<uint64_t>(file_id), chunk_index, req.body)) {
            return crow::response(500, R"({"error":"Falha ao gravar no disco"})");
        }
        
        file_mgr_->record_chunk_saved(file_id, chunk_index);

        int saved_chunks_count = file_mgr_->count_uploaded_chunks(static_cast<uint64_t>(file_id));
        int file_info_total_chunks = file_mgr_->get_total_chunks(static_cast<uint64_t>(file_id), user_id);

        if (saved_chunks_count == file_info_total_chunks) {
            file_mgr_->mark_upload_complete(static_cast<uint64_t>(file_id), user_id);
            return crow::response(200, R"({"status":"completed"})");
        }

        return crow::response(200, R"({"status":"uploading"})");

    } catch (const std::exception& e) {
        std::string msg = e.what();
        if (msg == "NOT_FOUND") {
            return crow::response(404, R"({"error":"Arquivo nao encontrado"})");
        }
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
        std::string provider = file_mgr_->get_storage_provider(static_cast<uint64_t>(file_id), user_id);
        if (provider == "google_drive") {
            file_mgr_->can_user_download(static_cast<uint64_t>(file_id), user_id);
            auto conn = pool_->acquire_connection();
            pqxx::work txn(*conn);
            auto result = txn.exec(
                "SELECT external_file_id, external_storage_id, is_upload_complete FROM files WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
                pqxx::params{file_id, user_id}
            );
            txn.commit();

            bool is_upload_complete = false;
            if (!result.empty()) {
                is_upload_complete = result[0][2].as<bool>();
            }

            if (is_upload_complete) {
                if (result.empty() || result[0][0].is_null()) {
                    return crow::response(404, R"({"error":"Arquivo externo nao encontrado"})");
                }

                std::string external_file_id = result[0][0].as<std::string>();
                std::string access_token;
                
                if (!result[0][1].is_null()) {
                    uint64_t storage_id = result[0][1].as<uint64_t>();
                    access_token = gdrive_->get_access_token_for_storage(storage_id);
                } else {
                    return crow::response(500, R"({"error":"Storage externo nao encontrado para este arquivo"})");
                }

                crow::json::wvalue res_body;
                res_body["storage_provider"] = "google_drive";
                res_body["external_file_id"] = external_file_id;
                res_body["access_token"] = access_token;

                crow::response res(200, res_body);
                res.set_header("Content-Type", "application/json");
                return res;
            }
        }
    } catch (const std::exception& e) {
        std::string msg = e.what();
        if (msg == "NOT_FOUND") return crow::response(404, R"({"error":"Arquivo nao encontrado"})");
        if (msg == "INCOMPLETE") return crow::response(400, R"({"error":"Upload incompleto"})");
        if (msg == "GOOGLE_DRIVE_NOT_LINKED") return crow::response(400, R"({"error":"Conta Google Drive nao vinculada"})");
        if (msg == "GOOGLE_TOKEN_REFRESH_FAILED") return crow::response(502, R"({"error":"Falha ao obter token do Google Drive"})");
        return crow::response(500, R"({"error":"Erro interno"})");
    }

    auto sanitize_header_filename = [](const std::string& name) {
        std::string safe_name = name;
        for (char& c : safe_name) {
            if (c == '\r' || c == '\n' || c == '"' || static_cast<unsigned char>(c) < 32 || static_cast<unsigned char>(c) == 127) {
                c = '_';
            }
        }
        return safe_name;
    };

    const std::string cors_origin = Utils::get().get_var("CORS_ORIGIN", "http://localhost:3000");
    auto set_streaming_headers = [&cors_origin, &sanitize_header_filename](crow::response& res, size_t content_length, size_t total_size, const std::string& file_name) {
        res.set_header("Content-Type", "application/octet-stream");
        res.set_header("Accept-Ranges", "bytes");
        res.set_header("Content-Length", std::to_string(content_length));
        res.set_header("Access-Control-Allow-Origin", cors_origin);
        res.set_header("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges, Content-Disposition");
        std::string safe_name = sanitize_header_filename(file_name);
        res.set_header("Content-Disposition", "attachment; filename=\"" + safe_name + "\"");
    };

    try {
        file_mgr_->can_user_download(static_cast<uint64_t>(file_id), user_id);
        
        size_t total_size = chunker_->get_file_size(file_id);
        std::string range_header = req.get_header_value("Range");

        constexpr size_t MAX_FULL_DOWNLOAD_SIZE = 4 * 1024 * 1024; // 4MB

        std::string file_name = file_mgr_->get_file_name(file_id, user_id);

        if (range_header.empty()) {
            if (total_size > MAX_FULL_DOWNLOAD_SIZE) {
                return crow::response(400, R"({"error":"Arquivo muito grande para download sincrono. Use Range requests."})");
            }
            std::string content = chunker_->read_entire_file(static_cast<uint64_t>(file_id));
            crow::response res(200, content);
            set_streaming_headers(res, content.size(), total_size, file_name);
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
        size_t end = total_size - 1;

        // "bytes=500-999" -> start=500, end=999
        // "bytes=500-"    -> start=500, end=total_size-1
        // "bytes=-500"    -> ultimos 500 bytes
        try {
            if (start_str.empty() && !end_str.empty()) {

                size_t suffix_length = std::stoull(end_str);

                if (suffix_length == 0) {
                    crow::response res(416);
                    res.set_header("Content-Range", "bytes */" + std::to_string(total_size));
                    return res;
                }
                if (suffix_length >= total_size) {
                    start = 0;
                    end = total_size - 1;
                } else {
                    start = total_size - suffix_length;
                    end = total_size - 1;
                }
            } else if (!start_str.empty()) {
                start = std::stoull(start_str);
                if (!end_str.empty()) {
                    end = std::stoull(end_str);
                }
            }
        } catch (const std::exception&) {
            crow::response res(416);
            res.set_header("Content-Range", "bytes */" + std::to_string(total_size));
            return res;
        }

        if (start >= total_size) {
            crow::response res(416);
            res.set_header("Content-Range", "bytes */" + std::to_string(total_size));
            return res;
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
        if (length > 4194320) {
            return crow::response(400, R"({"error":"Range solicitado excede o limite de 4.194.320 bytes por requisicao."})");
        }
        std::string data = chunker_->read_file_portion(file_id, start, length);

        crow::response res(206, data);
        res.set_header("Content-Range", "bytes " + std::to_string(start) + "-" + std::to_string(end) + "/" + std::to_string(total_size));
        set_streaming_headers(res, data.size(), total_size, file_name);

        return res;

    } catch (const std::exception& e) {
        std::string msg = e.what();
        if (msg.find("NOT_FOUND") != std::string::npos) {
            return crow::response(404, R"({"error":"Arquivo nao encontrado"})");
        }
        if (msg.find("INCOMPLETE") != std::string::npos) {
            return crow::response(400, R"({"error":"Upload incompleto"})");
        }
        if (msg.find("IO_RESOURCE_EXHAUSTED") != std::string::npos) {
            return crow::response(503, R"({"error":"Service Unavailable - IO Resource Exhausted"})");
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

        if (limit > 100) {
            limit = 100;
        }
        if (limit < 1) {
            limit = 50;
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

crow::response ApiRouter::handle_get_pending_uploads(const crow::request& req) {
    auto user_id_opt = authenticate_request(req);
    if (!user_id_opt) {
        return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    }
    uint64_t user_id = *user_id_opt;

    try {
        auto pending = file_mgr_->get_pending_uploads(user_id);
        crow::json::wvalue res;
        res["pending_uploads"] = std::move(pending);
        return crow::response(200, res);
    } catch (const std::exception& e) {
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

crow::response ApiRouter::handle_batch_delete(const crow::request& req) {
    auto user_id_opt = authenticate_request(req);
    if (!user_id_opt) {
        return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    }
    uint64_t user_id = *user_id_opt;

    auto req_body = crow::json::load(req.body);
    if (!req_body || !req_body.has("file_ids") || req_body["file_ids"].t() != crow::json::type::List) {
        return crow::response(400, R"({"error":"Corpo da requisicao invalido, esperado array file_ids"})");
    }

    std::vector<int> file_ids;
    for (const auto& item : req_body["file_ids"]) {
        if (item.t() == crow::json::type::Number) {
            file_ids.push_back(item.i());
        }
    }

    if (file_ids.empty()) {
        return crow::response(400, R"({"error":"Array file_ids nao pode estar vazio"})");
    }

    if (file_ids.size() > 100) {
        return crow::response(400, R"({"error":"Limite maximo de 100 arquivos por lote excedido"})");
    }

    try {
        int affected = file_mgr_->batch_delete_files(user_id, file_ids);
        
        crow::json::wvalue res;
        res["message"] = "Arquivos movidos para a lixeira";
        res["deleted_count"] = affected;
        return crow::response(200, res);
        
    } catch (const std::exception& e) {
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
        std::vector<std::string> ext_files = folder_mgr_->delete_folder(static_cast<uint64_t>(folder_id), user_id);
        crow::json::wvalue res;
        res["message"] = "Pasta enviada para a lixeira";
        res["external_files"] = ext_files;
        return crow::response(200, res);
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
        auto ext_file = file_mgr_->delete_file(static_cast<uint64_t>(file_id), user_id);
        crow::json::wvalue res;
        res["message"] = "Arquivo enviado para a lixeira";
        std::vector<std::string> ext_files;
        if (ext_file.has_value()) ext_files.push_back(*ext_file);
        res["external_files"] = ext_files;
        return crow::response(200, res);
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
        std::vector<std::string> ext_files = folder_mgr_->restore_folder(static_cast<uint64_t>(folder_id), user_id);
        crow::json::wvalue res;
        res["message"] = "Pasta restaurada com sucesso";
        res["external_files"] = ext_files;
        return crow::response(200, res);
    } catch (const std::exception& e) {
        std::string msg = e.what();
        if (msg == "NOT_FOUND")
            return crow::response(404, R"({"error":"Pasta nao encontrada na lixeira"})");

        if (msg == "FOLDER_ALREADY_EXISTS" || msg == "FILE_ALREADY_EXISTS") {
            return crow::response(409, R"({"error":"Item ja existe no destino"})");
        }

        return crow::response(500, R"({"error":"Erro interno no servidor"})");
    }
}

crow::response ApiRouter::handle_restore_file(const crow::request& req, int file_id) {
    auto user_id_opt = authenticate_request(req);
    if (!user_id_opt) return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    uint64_t user_id = *user_id_opt;

    try {
        auto ext_file = file_mgr_->restore_file(static_cast<uint64_t>(file_id), user_id);
        crow::json::wvalue res;
        res["message"] = "Arquivo restaurado com sucesso";
        std::vector<std::string> ext_files;
        if (ext_file.has_value()) ext_files.push_back(*ext_file);
        res["external_files"] = ext_files;
        return crow::response(200, res);
    } catch (const std::exception& e) {
        std::string msg = e.what();
        if (msg == "NOT_FOUND") return crow::response(404, R"({"error":"Arquivo nao encontrado na lixeira"})");
        if (msg == "FILE_ALREADY_EXISTS" || msg == "FOLDER_ALREADY_EXISTS") return crow::response(409, R"({"error":"Item ja existe no destino"})");
        return crow::response(500, R"({"error":"Erro interno no servidor"})");
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
        std::vector<std::string> ext_files = file_mgr_->empty_trash(user_id, chunker_);
        trigger_async_gc_cleanup();
        crow::json::wvalue res;
        res["message"] = "Lixeira esvaziada com sucesso";
        res["external_files"] = ext_files;
        return crow::response(200, res);
    } catch (const std::exception& e) {
        return crow::response(500, R"({"error":"Erro interno"})");
    }
}

crow::response ApiRouter::handle_hard_delete_file(const crow::request& req, int file_id) {
    auto user_id_opt = authenticate_request(req);
    if (!user_id_opt) return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    uint64_t user_id = *user_id_opt;

    try {
        auto ext_file = file_mgr_->hard_delete_file(static_cast<uint64_t>(file_id), user_id, chunker_);
        trigger_async_gc_cleanup();
        crow::json::wvalue res;
        res["message"] = "Arquivo deletado permanentemente";
        std::vector<std::string> ext_files;
        if (ext_file.has_value()) ext_files.push_back(*ext_file);
        res["external_files"] = ext_files;
        return crow::response(200, res);
    } catch (const std::exception& e) {
        std::string msg = e.what();
        if (msg == "NOT_FOUND") return crow::response(404, R"({"error":"Arquivo nao encontrado na lixeira"})");
        return crow::response(500, R"({"error":"Erro interno"})");
    }
}

crow::response ApiRouter::handle_batch_hard_delete(const crow::request& req) {
    auto user_id_opt = authenticate_request(req);
    if (!user_id_opt) return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    uint64_t user_id = *user_id_opt;

    auto req_body = crow::json::load(req.body);
    if (!req_body || !req_body.has("file_ids") || req_body["file_ids"].t() != crow::json::type::List) {
        return crow::response(400, R"({"error":"Corpo da requisicao invalido, esperado array file_ids"})");
    }

    std::vector<int> file_ids;
    for (const auto& item : req_body["file_ids"]) {
        if (item.t() == crow::json::type::Number) {
            file_ids.push_back(item.i());
        }
    }

    if (file_ids.empty()) return crow::response(400, R"({"error":"Array file_ids nao pode estar vazio"})");
    if (file_ids.size() > 100) return crow::response(400, R"({"error":"Limite maximo de 100 arquivos por lote excedido"})");

    try {
        auto result = file_mgr_->batch_hard_delete_files(user_id, file_ids, chunker_);
        trigger_async_gc_cleanup();
        crow::json::wvalue res;
        res["message"] = "Arquivos deletados permanentemente";
        res["deleted_count"] = result.deleted_count;
        res["external_files"] = result.external_files;
        return crow::response(200, res);
    } catch (const std::exception& e) {
        return crow::response(500, R"({"error":"Erro interno ao deletar arquivos"})");
    }
}

crow::response ApiRouter::handle_batch_delete_folders(const crow::request& req) {
    auto user_id_opt = authenticate_request(req);
    if (!user_id_opt) return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    uint64_t user_id = *user_id_opt;

    auto req_body = crow::json::load(req.body);
    if (!req_body || !req_body.has("folder_ids") || req_body["folder_ids"].t() != crow::json::type::List) {
        return crow::response(400, R"({"error":"Corpo da requisicao invalido, esperado array folder_ids"})");
    }

    std::vector<int> folder_ids;
    for (const auto& item : req_body["folder_ids"]) {
        if (item.t() == crow::json::type::Number) {
            folder_ids.push_back(item.i());
        }
    }

    if (folder_ids.empty()) return crow::response(400, R"({"error":"Array folder_ids nao pode estar vazio"})");
    if (folder_ids.size() > 100) return crow::response(400, R"({"error":"Limite maximo de 100 pastas por lote excedido"})");

    try {
        auto result = folder_mgr_->batch_delete_folders(user_id, folder_ids);
        crow::json::wvalue res;
        res["message"] = "Pastas enviadas para lixeira";
        res["deleted_count"] = result.deleted_count;
        res["external_files"] = result.external_files;
        return crow::response(200, res);
    } catch (const std::exception& e) {
        return crow::response(500, R"({"error":"Erro interno ao deletar pastas"})");
    }
}

crow::response ApiRouter::handle_batch_hard_delete_folders(const crow::request& req) {
    auto user_id_opt = authenticate_request(req);
    if (!user_id_opt) return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    uint64_t user_id = *user_id_opt;

    auto req_body = crow::json::load(req.body);
    if (!req_body || !req_body.has("folder_ids") || req_body["folder_ids"].t() != crow::json::type::List) {
        return crow::response(400, R"({"error":"Corpo da requisicao invalido, esperado array folder_ids"})");
    }

    std::vector<int> folder_ids;
    for (const auto& item : req_body["folder_ids"]) {
        if (item.t() == crow::json::type::Number) {
            folder_ids.push_back(item.i());
        }
    }

    if (folder_ids.empty()) return crow::response(400, R"({"error":"Array folder_ids nao pode estar vazio"})");
    if (folder_ids.size() > 100) return crow::response(400, R"({"error":"Limite maximo de 100 pastas por lote excedido"})");

    try {
        auto result = folder_mgr_->batch_hard_delete_folders(user_id, folder_ids, chunker_);
        trigger_async_gc_cleanup();
        crow::json::wvalue res;
        res["message"] = "Pastas deletadas permanentemente";
        res["deleted_count"] = result.deleted_count;
        res["external_files"] = result.external_files;
        return crow::response(200, res);
    } catch (const std::exception& e) {
        return crow::response(500, R"({"error":"Erro interno ao deletar pastas"})");
    }
}


crow::response ApiRouter::handle_hard_delete_folder(const crow::request& req, int folder_id) {
    auto user_id_opt = authenticate_request(req);
    if (!user_id_opt) return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    uint64_t user_id = *user_id_opt;

    try {
        std::vector<std::string> ext_files = folder_mgr_->hard_delete_folder(static_cast<uint64_t>(folder_id), user_id, chunker_);
        trigger_async_gc_cleanup();
        crow::json::wvalue res;
        res["message"] = "Pasta deletada permanentemente";
        res["external_files"] = ext_files;
        return crow::response(200, res);
    } catch (const std::exception& e) {
        std::string msg = e.what();
        if (msg == "NOT_FOUND") return crow::response(404, R"({"error":"Pasta nao encontrada na lixeira"})");
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

    try {
        if (body.has("encrypted_name")) enc_name = body["encrypted_name"].s();
        if (body.has("name_hash")) name_hash = body["name_hash"].s();
        if (body.has("folder_id")) {
            if (body["folder_id"].t() == crow::json::type::Null) {
                folder_id = 0; // 0 significa "Mover para a Raiz"
            } else {
                folder_id = static_cast<uint64_t>(body["folder_id"].i());
            }
        }

        crow::json::wvalue updated_json = file_mgr_->update_file(static_cast<uint64_t>(file_id), user_id, enc_name, name_hash, folder_id);
        return crow::response(200, updated_json);
    } catch (const std::exception& e) {
        std::string msg = e.what();
        if (msg == "NOT_FOUND") return crow::response(404, R"({"error":"Nao encontrado"})");
        if (msg == "FORBIDDEN") return crow::response(403, R"({"error":"Proibido"})");
        if (msg == "BAD_REQUEST") return crow::response(400, R"({"error":"Requisicao invalida"})");
        if (msg == "FILE_ALREADY_EXISTS") return crow::response(409, R"({"error":"Um arquivo com este nome ja existe nesta pasta"})");
        
        if (msg.find("type is not") != std::string::npos || msg.find("value is not") != std::string::npos || msg.find("json") != std::string::npos) {
            return crow::response(400, R"({"error":"Tipagem JSON invalida"})");
        }
        
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

    try {
        if (body.has("encrypted_name")) enc_name = body["encrypted_name"].s();
        if (body.has("name_hash")) name_hash = body["name_hash"].s();
        if (body.has("parent_id")) {
            if (body["parent_id"].t() == crow::json::type::Null) {
                parent_id = 0; // 0 significa "Mover para a Raiz"
            } else {
                parent_id = static_cast<uint64_t>(body["parent_id"].i());
            }
        }

        crow::json::wvalue updated_json = folder_mgr_->update_folder(static_cast<uint64_t>(folder_id), user_id, enc_name, name_hash, parent_id);
        return crow::response(200, updated_json);
    } catch (const std::exception& e) {
        std::string msg = e.what();
        if (msg == "NOT_FOUND") return crow::response(404, R"({"error":"Nao encontrado"})");
        if (msg == "FORBIDDEN") return crow::response(403, R"({"error":"Proibido"})");
        if (msg == "BAD_REQUEST") return crow::response(400, R"({"error":"Requisicao invalida"})");
        
        if (msg.find("type is not") != std::string::npos || msg.find("value is not") != std::string::npos || msg.find("json") != std::string::npos) {
            return crow::response(400, R"({"error":"Tipagem JSON invalida"})");
        }
        
        return crow::response(500, R"({"error":"Erro interno"})");
    }
}

crow::response ApiRouter::handle_share_file(const crow::request& req, int file_id) {
    auto user_id_opt = authenticate_request(req);
    if (!user_id_opt) return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    uint64_t user_id = *user_id_opt;

    std::string encrypted_name_fdk = "";
    if (!req.body.empty()) {
        try {
            auto body = crow::json::load(req.body);
            if (body && body.has("encrypted_name_fdk")) {
                encrypted_name_fdk = body["encrypted_name_fdk"].s();
            }
        } catch (...) {
            // Se falhar o parse (ex: corpo vazio ou malformado), prossegue sem erro para compatibilidade
        }
    }

    try {
        if (gdrive_) {
            try {
                auto [provider, ext_id] = file_mgr_->get_file_storage_info(static_cast<uint64_t>(file_id), user_id);
                if (provider == "google_drive" && !ext_id.empty()) {
                    gdrive_->make_file_public(user_id, ext_id);
                }
            } catch (...) {}
        }

        std::string uuid = file_mgr_->share_file(static_cast<uint64_t>(file_id), user_id, encrypted_name_fdk);
        crow::json::wvalue res;
        res["share_uuid"] = uuid;
        res["uuid"] = uuid;
        return crow::response(200, res);
    } catch (const std::exception& e) {
        std::string msg = e.what();
        if (msg == "NOT_FOUND") return crow::response(404, R"({"error":"Arquivo nao encontrado"})");
        if (msg == "TOO_MANY_REQUESTS") return crow::response(429, R"({"error":"Muitas alteracoes de compartilhamento. Tente novamente mais tarde."})");
        std::cerr << "Exception in handle_share_file: " << msg << std::endl;
        return crow::response(500, R"({"error":"Erro interno"})");
    }
}

crow::response ApiRouter::handle_list_shares(const crow::request& req, int file_id) {
    auto user_id_opt = authenticate_request(req);
    if (!user_id_opt) return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    uint64_t user_id = *user_id_opt;

    try {
        auto shares = file_mgr_->list_shares(static_cast<uint64_t>(file_id), user_id);
        crow::json::wvalue res = std::move(shares);
        return crow::response(200, res);
    } catch (const std::exception& e) {
        std::string msg = e.what();
        if (msg == "NOT_FOUND") return crow::response(404, R"({"error":"Arquivo nao encontrado"})");
        return crow::response(500, R"({"error":"Erro interno"})");
    }
}

crow::response ApiRouter::handle_revoke_share(const crow::request& req, const std::string& uuid) {
    auto user_id_opt = authenticate_request(req);
    if (!user_id_opt) return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    uint64_t user_id = *user_id_opt;

    try {
        if (gdrive_) {
            try {
                auto [provider, ext_id] = file_mgr_->get_share_storage_info(uuid, user_id);
                if (provider == "google_drive" && !ext_id.empty()) {
                    gdrive_->revoke_file_public(user_id, ext_id);
                }
            } catch (...) {}
        }

        file_mgr_->revoke_share(uuid, user_id);
        return crow::response(200, R"({"success":true})");
    } catch (const std::exception& e) {
        std::string msg = e.what();
        if (msg == "NOT_FOUND") return crow::response(404, R"({"error":"Link nao encontrado ou nao pertence ao utilizador"})");
        return crow::response(500, R"({"error":"Erro interno"})");
    }
}

crow::response ApiRouter::handle_get_share_metadata(const crow::request& req, const std::string& uuid) {
    try {
        auto meta = file_mgr_->get_shared_file_metadata(uuid);
        return crow::response(200, meta);
    } catch (const std::exception& e) {
        std::string msg = e.what();
        if (msg == "NOT_FOUND") return crow::response(404, R"({"error":"Link de compartilhamento expirado ou inexistente"})");
        return crow::response(500, R"({"error":"Erro interno"})");
    }
}

crow::response ApiRouter::handle_get_shared_file(const crow::request& req, const std::string& uuid) {
    auto sanitize_header_filename = [](const std::string& name) {
        std::string safe_name = name;
        for (char& c : safe_name) {
            if (c == '\r' || c == '\n' || c == '"' || static_cast<unsigned char>(c) < 32 || static_cast<unsigned char>(c) == 127) {
                c = '_';
            }
        }
        return safe_name;
    };

    const std::string cors_origin = Utils::get().get_var("CORS_ORIGIN", "http://localhost:3000");
    auto set_share_headers = [&cors_origin, &sanitize_header_filename](crow::response& res, const std::string& encrypted_name, size_t content_length, size_t total_size) {
        res.set_header("Content-Type", "application/octet-stream");
        res.set_header("Accept-Ranges", "bytes");
        res.set_header("Content-Length", std::to_string(content_length));
        res.set_header("X-Encrypted-Name", encrypted_name);
        res.set_header("Access-Control-Allow-Origin", cors_origin);
        res.set_header("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges, X-Encrypted-Name, Content-Disposition");
        
        std::string safe_name = sanitize_header_filename(encrypted_name);
        res.set_header("Content-Disposition", "attachment; filename=\"" + safe_name + "\"");
    };

    try {
        auto info = file_mgr_->get_shared_file_info(uuid);
        size_t total_size = (info.storage_provider == "google_drive") ? info.size_bytes : chunker_->get_file_size(info.file_id);

        if (info.storage_provider == "google_drive" && !info.external_file_id.empty()) {
            if (!gdrive_) {
                return crow::response(500, R"({"error":"Servico do Google Drive nao disponivel"})");
            }
            std::string range_header = req.get_header_value("Range");
            std::string content = gdrive_->fetch_file_media(info.file_id, info.external_file_id, range_header);
            
            if (!range_header.empty()) {
                size_t start = 0;
                size_t end = total_size > 0 ? (total_size - 1) : 0;
                std::string prefix = "bytes=";
                if (range_header.find(prefix) == 0) {
                    std::string range_val = range_header.substr(prefix.length());
                    size_t dash_pos = range_val.find('-');
                    if (dash_pos != std::string::npos) {
                        std::string s_str = range_val.substr(0, dash_pos);
                        std::string e_str = range_val.substr(dash_pos + 1);
                        if (!s_str.empty()) start = std::stoull(s_str);
                        if (!e_str.empty()) end = std::stoull(e_str);
                    }
                }
                crow::response res(206, content);
                res.set_header("Content-Range", "bytes " + std::to_string(start) + "-" + std::to_string(end) + "/" + std::to_string(total_size));
                set_share_headers(res, info.encrypted_name, content.size(), total_size);
                return res;
            } else {
                crow::response res(200, content);
                set_share_headers(res, info.encrypted_name, content.size(), total_size);
                return res;
            }
        }

        uint64_t file_id = info.file_id;
        std::string encrypted_name = info.encrypted_name;

        std::string range_header = req.get_header_value("Range");

        constexpr size_t MAX_FULL_DOWNLOAD_SIZE = 4 * 1024 * 1024; // 4MB

        if (range_header.empty()) {
            if (total_size > MAX_FULL_DOWNLOAD_SIZE) {
                return crow::response(400, R"({"error":"Arquivo muito grande para download sincrono. Use Range requests."})");
            }
            std::string content = chunker_->read_entire_file(static_cast<uint64_t>(file_id));
            crow::response res(200, content);
            set_share_headers(res, encrypted_name, content.size(), total_size);
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
        size_t end = total_size - 1;

        try {
            if (start_str.empty() && !end_str.empty()) {
                size_t suffix_length = std::stoull(end_str);
                if (suffix_length == 0) {
                    crow::response res(416);
                    res.set_header("Content-Range", "bytes */" + std::to_string(total_size));
                    return res;
                }
                if (suffix_length >= total_size) {
                    start = 0;
                    end = total_size - 1;
                } else {
                    start = total_size - suffix_length;
                    end = total_size - 1;
                }
            } else if (!start_str.empty()) {
                start = std::stoull(start_str);
                if (!end_str.empty()) {
                    end = std::stoull(end_str);
                }
            }
        } catch (const std::exception&) {
            crow::response res(416);
            res.set_header("Content-Range", "bytes */" + std::to_string(total_size));
            return res;
        }

        if (start >= total_size) {
            crow::response res(416);
            res.set_header("Content-Range", "bytes */" + std::to_string(total_size));
            return res;
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
        if (length > 4194320) {
            return crow::response(400, R"({"error":"Range solicitado excede o limite de 4.194.320 bytes por requisicao."})");
        }
        std::string data = chunker_->read_file_portion(file_id, start, length);

        crow::response res(206, data);
        res.set_header("Content-Range", "bytes " + std::to_string(start) + "-" + std::to_string(end) + "/" + std::to_string(total_size));
        set_share_headers(res, encrypted_name, data.size(), total_size);

        return res;

    } catch (const std::exception& e) {
        std::string msg = e.what();
        if (msg == "NOT_FOUND" || msg == "NOT_FOUND_ON_DISK") {
            return crow::response(404, R"({"error":"Link invalido ou arquivo nao encontrado no armazenamento"})");
        }
        if (msg.find("IO_RESOURCE_EXHAUSTED") != std::string::npos) {
            return crow::response(503, R"({"error":"Service Unavailable - IO Resource Exhausted"})");
        }
        return crow::response(500, R"({"error":"Erro interno"})");
    }
}


crow::response ApiRouter::handle_link_google_drive(const crow::request& req) {
    auto user_id_opt = authenticate_request(req);
    if (!user_id_opt) return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    uint64_t user_id = *user_id_opt;

    auto body = crow::json::load(req.body);
    if (!body || !body.has("auth_code") || !body.has("state")) {
        return crow::response(400, R"({"error":"JSON invalido, auth_code e state obrigatorios"})");
    }

    if (!gdrive_) {
        return crow::response(500, R"({"error":"Servico Google Drive nao configurado"})");
    }

    try {
        std::string auth_code = body["auth_code"].s();
        std::string state = body["state"].s();
        auto result = gdrive_->link_account(user_id, auth_code, state);

        crow::json::wvalue res;
        res["message"] = "Conta vinculada com sucesso";
        res["root_folder_id"] = result.root_folder_id;
        return crow::response(200, res);

    } catch (const std::invalid_argument& e) {
        std::string msg = e.what();
        if (msg == "INVALID_OAUTH_STATE") return crow::response(400, R"({"error":"State invalido ou expirado"})");
        return crow::response(400, R"({"error":"Parametros invalidos"})");
    } catch (const std::exception& e) {
        std::string msg = e.what();
        if (msg == "ALREADY_LINKED") return crow::response(409, R"({"error":"Conta ja vinculada"})");
        if (msg == "GOOGLE_DRIVE_NOT_CONFIGURED") return crow::response(501, R"({"error":"Integracao nao configurada"})");
        if (msg == "GOOGLE_TOKEN_EXCHANGE_FAILED") return crow::response(400, R"({"error":"Falha ao trocar o codigo de autorizacao"})");
        if (msg == "GOOGLE_EMAIL_SCOPE_MISSING") return crow::response(400, R"({"error":"Escopo userinfo.email faltando"})");
        return crow::response(500, R"({"error":"Erro interno"})");
    }
}

crow::response ApiRouter::handle_generate_google_state(const crow::request& req) {
    auto user_id_opt = authenticate_request(req);
    if (!user_id_opt) return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    uint64_t user_id = *user_id_opt;

    if (!gdrive_) {
        return crow::response(500, R"({"error":"Servico Google Drive nao configurado"})");
    }

    std::string state = gdrive_->generate_oauth_state(user_id);
    crow::json::wvalue res;
    res["state"] = state;
    return crow::response(200, res);
}

crow::response ApiRouter::handle_get_google_accounts(const crow::request& req) {
    auto user_id_opt = authenticate_request(req);
    if (!user_id_opt) return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    uint64_t user_id = *user_id_opt;

    if (!gdrive_) {
        return crow::response(500, R"({"error":"Servico Google Drive nao configurado"})");
    }

    try {
        auto accounts = gdrive_->get_linked_accounts(user_id);
        
        crow::json::wvalue res;
        std::vector<crow::json::wvalue> acc_list;
        for (const auto& acc : accounts) {
            crow::json::wvalue acc_json;
            acc_json["id"] = acc.id;
            acc_json["account_email"] = acc.account_email;
            acc_json["account_picture"] = acc.account_picture;
            acc_json["root_folder_id"] = acc.root_folder_id;
            acc_list.push_back(std::move(acc_json));
        }
        res["accounts"] = std::move(acc_list);
        
        return crow::response(200, res);

    } catch (const std::exception& e) {
        std::string msg = e.what();
        if (msg == "GOOGLE_DRIVE_NOT_LINKED") return crow::response(404, R"({"error":"Conta nao vinculada"})");
        if (msg == "GOOGLE_TOKEN_REFRESH_FAILED") return crow::response(502, R"({"error":"Falha ao atualizar o token"})");
        return crow::response(500, R"({"error":"Erro interno"})");
    }
}

crow::response ApiRouter::handle_unlink_google_account(const crow::request& req, int account_id) {
    auto user_id_opt = authenticate_request(req);
    if (!user_id_opt) return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    uint64_t user_id = *user_id_opt;

    if (!gdrive_) {
        return crow::response(500, R"({"error":"Servico Google Drive nao configurado"})");
    }

    try {
        gdrive_->unlink_account(user_id, account_id);
        trigger_async_gc_cleanup();
        
        crow::json::wvalue res;
        res["message"] = "Conta desvinculada com sucesso";
        return crow::response(200, res);

    } catch (const std::exception& e) {
        std::string msg = e.what();
        if (msg == "GOOGLE_DRIVE_NOT_LINKED") return crow::response(404, R"({"error":"Conta nao encontrada ou nao pertence ao usuario"})");
        return crow::response(500, R"({"error":"Erro interno"})");
    }
}

crow::response ApiRouter::handle_finalize_external_upload(const crow::request& req, int file_id) {
    auto user_id_opt = authenticate_request(req);
    if (!user_id_opt) return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    uint64_t user_id = *user_id_opt;

    auto body = crow::json::load(req.body);
    if (!body || !body.has("external_file_id")) {
        return crow::response(400, R"({"error":"JSON invalido ou external_file_id ausente"})");
    }

    try {
        std::string external_file_id = body["external_file_id"].s();
        file_mgr_->finalize_external_upload(file_id, user_id, external_file_id);

        return crow::response(200, R"({"message":"Upload externo finalizado com sucesso"})");

    } catch (const std::exception& e) {
        std::string msg = e.what();
        if (msg == "NOT_FOUND") return crow::response(404, R"({"error":"Arquivo nao encontrado"})");
        if (msg == "FORBIDDEN") return crow::response(403, R"({"error":"Sem permissao"})");
        if (msg == "INVALID_STORAGE_PROVIDER") return crow::response(400, R"({"error":"Arquivo nao configurado para armazenamento externo"})");
        if (msg == "ALREADY_COMPLETE") return crow::response(409, R"({"error":"Upload ja concluido"})");
        return crow::response(500, R"({"error":"Erro interno"})");
    }
}

crow::response ApiRouter::handle_get_google_sync_map(const crow::request& req, int account_id) {
    auto user_id_opt = authenticate_request(req);
    if (!user_id_opt) return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    uint64_t user_id = *user_id_opt;

    if (!gdrive_) {
        return crow::response(500, R"({"error":"Servico Google Drive nao configurado"})");
    }

    try {
        auto map = file_mgr_->get_external_sync_map(user_id, static_cast<uint64_t>(account_id));
        
        crow::json::wvalue res;
        std::vector<crow::json::wvalue> file_list;
        for (const auto& file : map) {
            crow::json::wvalue f_json;
            f_json["id"] = file.id;
            f_json["external_file_id"] = file.external_file_id;
            file_list.push_back(std::move(f_json));
        }
        res["files"] = std::move(file_list);
        
        return crow::response(200, res);

    } catch (const std::exception& e) {
        return crow::response(500, R"({"error":"Erro interno"})");
    }
}

crow::response ApiRouter::handle_google_sync_cleanup(const crow::request& req, int account_id) {
    auto user_id_opt = authenticate_request(req);
    if (!user_id_opt) return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    uint64_t user_id = *user_id_opt;

    auto body = crow::json::load(req.body);
    if (!body || !body.has("missing_external_ids") || body["missing_external_ids"].t() != crow::json::type::List) {
        return crow::response(400, R"({"error":"JSON invalido, missing_external_ids obrigatorio e deve ser uma lista"})");
    }

    std::vector<std::string> missing_ids;
    for (const auto& item : body["missing_external_ids"]) {
        if (item.t() == crow::json::type::String) {
            missing_ids.push_back(item.s());
        }
    }

    if (!gdrive_) {
        return crow::response(500, R"({"error":"Servico Google Drive nao configurado"})");
    }

    try {
        file_mgr_->cleanup_external_sync(user_id, static_cast<uint64_t>(account_id), missing_ids);
        return crow::response(200, R"({"message":"Sincronizacao concluida com sucesso"})");
    } catch (const std::exception& e) {
        return crow::response(500, R"({"error":"Erro interno"})");
    }
}

void ApiRouter::setup_routes(crow::App<CustomCorsMiddleware, RateLimitMiddleware>& app) {

    CROW_ROUTE(app, "/api/docs")
    ([]() {
        std::string html = R"(
        <!DOCTYPE html>
        <html lang="pt-br">
        <head>
            <meta charset="UTF-8">
            <title>Nanika API Docs</title>
            <link rel="stylesheet" type="text/css" href="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/4.15.5/swagger-ui.css" >
        </head>
        <body>
            <div id="swagger-ui"></div>
            <script src="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/4.15.5/swagger-ui-bundle.js"></script>
            <script>
            window.onload = function() {
                window.ui = SwaggerUIBundle({
                    url: "/api/docs/swagger.yaml",
                    dom_id: '#swagger-ui',
                    deepLinking: true,
                    presets: [ SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset ],
                    layout: "BaseLayout"
                });
            }
            </script>
        </body>
        </html>
        )";
        
        auto res = crow::response(html);
        res.set_header("Content-Type", "text/html");
        return res;
    });

    CROW_ROUTE(app, "/api/docs/swagger.yaml")
    ([]() {
        std::ifstream ifs("./docs/swagger.yaml");
    
        if (!ifs.is_open()) {
            ifs.open("../../docs/swagger.yaml");
        }

        if (!ifs.is_open() || !ifs.good()) {
            CROW_LOG_ERROR << "ERRO: swagger.yaml nao encontrado ou IO Resource Exhausted!";
            return crow::response(503, "Service Unavailable - IO Resource Exhausted");
        }
        
        std::stringstream buffer;
        buffer << ifs.rdbuf();

        if (ifs.fail() && !ifs.eof()) {
            return crow::response(503, "Service Unavailable - IO Resource Exhausted");
        }
        
        auto res = crow::response(buffer.str());
        res.set_header("Content-Type", "text/yaml");
        return res;
    });

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

    CROW_ROUTE(app, "/users/me").methods(crow::HTTPMethod::Delete)
    ([this](const crow::request& req) {
        auto res = handle_delete_user(req);
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

    CROW_ROUTE(app, "/logout").methods(crow::HTTPMethod::Post)
    ([this](const crow::request& req) {
        auto res = handle_logout(req);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/logout/global").methods(crow::HTTPMethod::Post)
    ([this](const crow::request& req) {
        auto res = handle_logout_global(req);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/api/auth/google").methods(crow::HTTPMethod::Post)
    ([this](const crow::request& req) {
        auto res = handle_google_login(req);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/api/auth/refresh").methods(crow::HTTPMethod::Get)
    ([this](const crow::request& req) {
        auto res = handle_refresh(req);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/verify").methods(crow::HTTPMethod::Get)
    ([this](const crow::request& req) {
        auto res = handle_verify_email(req);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/users/me/profile-pic").methods(crow::HTTPMethod::Post)
    ([this](const crow::request& req) {
        auto res = handle_update_profile_pic(req);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/folders").methods(crow::HTTPMethod::Post)
    ([this](const crow::request& req) {
        auto res = handle_create_folder(req);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/folders/pinned").methods(crow::HTTPMethod::Get)
    ([this](const crow::request& req) {
        auto res = handle_get_pinned_folders(req);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/folders/pinned/order").methods(crow::HTTPMethod::Put)
    ([this](const crow::request& req) {
        auto res = handle_reorder_pinned_folders(req);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/folders/<int>/pin").methods(crow::HTTPMethod::Put)
    ([this](const crow::request& req, int folder_id) {
        return handle_pin_folder(req, folder_id);
    });

    CROW_ROUTE(app, "/folders/<int>/pin").methods(crow::HTTPMethod::Delete)
    ([this](const crow::request& req, int folder_id) {
        return handle_unpin_folder(req, folder_id);
    });

    CROW_ROUTE(app, "/files").methods(crow::HTTPMethod::Post)
    ([this](const crow::request& req) {
        auto res = handle_init_file_upload(req);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/files/batch-init").methods(crow::HTTPMethod::Post)
    ([this](const crow::request& req) {
        auto res = handle_batch_init_uploads(req);
        res.set_header("Content-Type", "application/json");
        return res;
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
        auto res = handle_list_folder_contents(req, folder_id);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/tree").methods(crow::HTTPMethod::Get)
    ([this](const crow::request& req) {
        auto res = handle_get_tree(req);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/files/<int>/uploaded-chunks").methods(crow::HTTPMethod::Get)
    ([this](const crow::request& req, int file_id) {
        auto res = handle_get_uploaded_chunks(req, file_id);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/pending-uploads").methods(crow::HTTPMethod::Get)
    ([this](const crow::request& req) {
        auto res = handle_get_pending_uploads(req);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/files/batch-delete").methods(crow::HTTPMethod::Delete)
    ([this](const crow::request& req) {
        auto res = handle_batch_delete(req);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/files/<int>").methods(crow::HTTPMethod::Delete)
    ([this](const crow::request& req, int file_id) {
        auto res = handle_delete_file(req, file_id);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/folders/batch-delete").methods(crow::HTTPMethod::Delete)
    ([this](const crow::request& req) {
        auto res = handle_batch_delete_folders(req);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/folders/<int>").methods(crow::HTTPMethod::Delete)
    ([this](const crow::request& req, int folder_id) {
        auto res = handle_delete_folder(req, folder_id);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/files/<int>").methods(crow::HTTPMethod::Put)
    ([this](const crow::request& req, int file_id) {
        auto res = handle_update_file(req, file_id);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/folders/<int>").methods(crow::HTTPMethod::Put)
    ([this](const crow::request& req, int folder_id) {
        auto res = handle_update_folder(req, folder_id);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/files/<int>/share").methods(crow::HTTPMethod::Post)
    ([this](const crow::request& req, int file_id) {
        auto res = handle_share_file(req, file_id);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/api/files/<int>/share").methods(crow::HTTPMethod::Post)
    ([this](const crow::request& req, int file_id) {
        auto res = handle_share_file(req, file_id);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/files/<int>/shares").methods(crow::HTTPMethod::Get)
    ([this](const crow::request& req, int file_id) {
        auto res = handle_list_shares(req, file_id);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/api/files/<int>/shares").methods(crow::HTTPMethod::Get)
    ([this](const crow::request& req, int file_id) {
        auto res = handle_list_shares(req, file_id);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/shares/<string>").methods(crow::HTTPMethod::Delete)
    ([this](const crow::request& req, std::string uuid) {
        auto res = handle_revoke_share(req, uuid);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/api/shares/<string>").methods(crow::HTTPMethod::Delete)
    ([this](const crow::request& req, std::string uuid) {
        auto res = handle_revoke_share(req, uuid);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/api/files/<int>/share/<string>").methods(crow::HTTPMethod::Delete)
    ([this](const crow::request& req, int file_id, std::string uuid) {
        auto res = handle_revoke_share(req, uuid);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/share/<string>").methods(crow::HTTPMethod::Get)
    ([this](const crow::request& req, std::string uuid) {
        auto res = handle_get_share_metadata(req, uuid);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/api/share/<string>").methods(crow::HTTPMethod::Get)
    ([this](const crow::request& req, std::string uuid) {
        auto res = handle_get_share_metadata(req, uuid);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/share/<string>/metadata").methods(crow::HTTPMethod::Get)
    ([this](const crow::request& req, std::string uuid) {
        auto res = handle_get_share_metadata(req, uuid);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/api/share/<string>/metadata").methods(crow::HTTPMethod::Get)
    ([this](const crow::request& req, std::string uuid) {
        auto res = handle_get_share_metadata(req, uuid);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/share/<string>/download").methods(crow::HTTPMethod::Get)
    ([this](const crow::request& req, std::string uuid) {
        auto res = handle_get_shared_file(req, uuid);
        return res;
    });

    CROW_ROUTE(app, "/api/share/<string>/download").methods(crow::HTTPMethod::Get)
    ([this](const crow::request& req, std::string uuid) {
        auto res = handle_get_shared_file(req, uuid);
        return res;
    });

    CROW_ROUTE(app, "/trash").methods(crow::HTTPMethod::Get)
    ([this](const crow::request& req) {
        auto res = handle_get_trash(req);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/trash/empty").methods(crow::HTTPMethod::Delete)
    ([this](const crow::request& req) {
        auto res = handle_empty_trash(req);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/files/<int>/restore").methods(crow::HTTPMethod::Post)
    ([this](const crow::request& req, int file_id) {
        auto res = handle_restore_file(req, file_id);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/folders/<int>/restore").methods(crow::HTTPMethod::Post)
    ([this](const crow::request& req, int folder_id) {
        auto res = handle_restore_folder(req, folder_id);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/trash/files/batch-delete").methods(crow::HTTPMethod::Delete)
    ([this](const crow::request& req) {
        auto res = handle_batch_hard_delete(req);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/trash/folders/batch-delete").methods(crow::HTTPMethod::Delete)
    ([this](const crow::request& req) {
        auto res = handle_batch_hard_delete_folders(req);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/trash/files/<int>").methods(crow::HTTPMethod::Delete)
    ([this](const crow::request& req, int file_id) {
        auto res = handle_hard_delete_file(req, file_id);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/trash/folders/<int>").methods(crow::HTTPMethod::Delete)
    ([this](const crow::request& req, int folder_id) {
        auto res = handle_hard_delete_folder(req, folder_id);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/api/storage/google/generate-state").methods(crow::HTTPMethod::Get)
    ([this](const crow::request& req) {
        auto res = handle_generate_google_state(req);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/api/storage/google/link").methods(crow::HTTPMethod::Post)
    ([this](const crow::request& req) {
        auto res = handle_link_google_drive(req);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/api/storage/google/accounts").methods(crow::HTTPMethod::Get)
    ([this](const crow::request& req) {
        auto res = handle_get_google_accounts(req);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/api/storage/google/accounts/<int>").methods(crow::HTTPMethod::Delete)
    ([this](const crow::request& req, int account_id) {
        auto res = handle_unlink_google_account(req, account_id);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/files/<int>/finalize-external").methods(crow::HTTPMethod::Post)
    ([this](const crow::request& req, int file_id) {
        auto res = handle_finalize_external_upload(req, file_id);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/api/storage/google/accounts/<int>/sync-map").methods(crow::HTTPMethod::Get)
    ([this](const crow::request& req, int account_id) {
        auto res = handle_get_google_sync_map(req, account_id);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/api/storage/google/accounts/<int>/sync-cleanup").methods(crow::HTTPMethod::Post)
    ([this](const crow::request& req, int account_id) {
        auto res = handle_google_sync_cleanup(req, account_id);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/api/vault/init").methods(crow::HTTPMethod::Post)
    ([this](const crow::request& req) {
        auto res = handle_init_vault(req);
        return res;
    });

    CROW_ROUTE(app, "/api/vault/verification").methods(crow::HTTPMethod::Get)
    ([this](const crow::request& req) {
        auto res = handle_get_vault_verification(req);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/users/me/profile").methods(crow::HTTPMethod::Put)
    ([this](const crow::request& req) {
        auto res = handle_update_profile(req);
        res.set_header("Content-Type", "application/json");
        return res;
    });
}




