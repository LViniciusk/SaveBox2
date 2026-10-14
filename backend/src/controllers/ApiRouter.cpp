#include "controllers/ApiRouter.hpp"
#include "database/FolderManager.hpp"
#include "database/FileManager.hpp"
#include "database/UsersManager.hpp"
#include "storage/FileChunker.hpp"
#include "Services/GoogleDriveService.hpp"
#include "utils/ClientIp.hpp"
#include "utils.hpp"

#include <optional>
#include <charconv>
#include <system_error>
#include <string_view>
#include <unordered_set>
#include <unordered_map>
#include <fstream>
#include <sstream>
#include <cpr/cpr.h>
#include <algorithm>

#ifdef NANIKA_TESTING
#include <mutex>
#endif

namespace {
constexpr int AUTH_COOKIE_MAX_AGE_SECONDS = 86400;
constexpr long PROFILE_IMAGE_UPLOAD_TIMEOUT_MS = 30'000;

#ifdef NANIKA_TESTING
std::mutex profile_image_upload_test_mutex;
ApiRouter::ProfileImageUploadTestHook profile_image_upload_test_hook;
#endif

void apply_sensitive_response_headers(crow::response& response) {
    response.set_header("Cache-Control", "no-store");
    response.set_header("Pragma", "no-cache");
}

void apply_docs_response_headers(crow::response& response) {
    response.set_header("X-Content-Type-Options", "nosniff");
    response.set_header("Referrer-Policy", "no-referrer");
    response.set_header("X-Frame-Options", "DENY");
    response.set_header("Cache-Control", "no-store");
}

// Callers supply only literal whitelisted paths, never request data.
crow::response read_docs_file(const char* file, const char* mime) {
    std::ifstream input(std::string("./docs/") + file, std::ios::binary);
    if (!input.is_open()) {
        input.clear();
        input.open(std::string("../../docs/") + file, std::ios::binary);
    }
    crow::response response(503, "Service Unavailable");
    response.set_header("Content-Type", "text/plain; charset=utf-8");
    if (input.is_open() && input.good()) {
        std::stringstream buffer;
        buffer << input.rdbuf();
        if (!input.bad() && !buffer.fail()) {
            response = crow::response(buffer.str());
            response.set_header("Content-Type", mime);
        }
    }
    apply_docs_response_headers(response);
    return response;
}

std::string make_auth_cookie(const std::string& token, int max_age, bool secure) {
    std::string cookie = "jwt=" + token + "; HttpOnly; Path=/; Max-Age=" +
        std::to_string(max_age) + "; SameSite=Lax";
    if (secure) cookie += "; Secure";
    return cookie;
}

std::string make_session_cookie(const std::string& token, bool secure) {
    return make_auth_cookie(token, AUTH_COOKIE_MAX_AGE_SECONDS, secure);
}

std::string make_clearing_session_cookie(bool secure) {
    return make_auth_cookie("", 0, secure);
}

std::optional<uint64_t> parse_uint64_strict(std::string_view value) {
    if (value.empty()) return std::nullopt;
    uint64_t parsed = 0;
    const auto result = std::from_chars(value.data(), value.data() + value.size(), parsed, 10);
    if (result.ec != std::errc{} || result.ptr != value.data() + value.size()) return std::nullopt;
    return parsed;
}

crow::response range_not_satisfiable(uint64_t total) {
    crow::response response(416);
    response.set_header("Content-Range", "bytes */" + std::to_string(total));
    response.set_header("Accept-Ranges", "bytes");
    response.set_header("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges");
    return response;
}

crow::response storage_move_error(const std::exception& error) {
    const std::string raw_code = error.what();
    static const std::unordered_set<std::string> safe_codes{
        "STORAGE_MOVE_NOT_FOUND", "NOT_FOUND", "ACTIVE_PUBLIC_SHARE", "STORAGE_MOVE_ALREADY_ACTIVE",
        "SAME_STORAGE_TARGET", "STORAGE_MOVE_INVALID_STATE", "STORAGE_MOVE_TARGET_CONFLICT",
        "STORAGE_MOVE_TARGET_INCOMPLETE", "STORAGE_MOVE_INVALID_FAILURE", "STORAGE_MOVE_CLEANUP_PENDING",
        "STORAGE_TARGET_NOT_FOUND", "STORAGE_TARGET_UNAVAILABLE", "GOOGLE_SESSION_FAILED", "STORAGE_MOVE_RECONCILE_FAILED"
    };
    const std::string code = safe_codes.find(raw_code) != safe_codes.end()
        ? raw_code : "STORAGE_MOVE_OPERATION_FAILED";
    int status = 500;
    if (code == "STORAGE_MOVE_NOT_FOUND" || code == "NOT_FOUND" || code == "STORAGE_TARGET_NOT_FOUND") status = 404;
    else if (code == "ACTIVE_PUBLIC_SHARE" || code == "STORAGE_MOVE_ALREADY_ACTIVE" || code == "SAME_STORAGE_TARGET" ||
             code == "STORAGE_MOVE_INVALID_STATE" || code == "STORAGE_MOVE_TARGET_CONFLICT" ||
             code == "STORAGE_MOVE_TARGET_INCOMPLETE" ||
             code == "STORAGE_MOVE_INVALID_FAILURE" || code == "STORAGE_MOVE_CLEANUP_PENDING") status = 409;
    else if (code == "STORAGE_TARGET_UNAVAILABLE" || code == "GOOGLE_SESSION_FAILED" || code == "STORAGE_MOVE_RECONCILE_FAILED") status = 502;
    crow::json::wvalue body;
    body["error_code"] = code;
    body["error"] = "Operacao de armazenamento nao concluida";
    return crow::response(status, body);
}
}

#ifdef NANIKA_TESTING
void ApiRouter::set_profile_image_upload_test_hook(ProfileImageUploadTestHook hook) {
    std::lock_guard<std::mutex> lock(profile_image_upload_test_mutex);
    profile_image_upload_test_hook = std::move(hook);
}

void ApiRouter::clear_profile_image_upload_test_hook() {
    std::lock_guard<std::mutex> lock(profile_image_upload_test_mutex);
    profile_image_upload_test_hook = nullptr;
}
#endif

bool AuthHttpPolicy::secure_cookie_for_origin(std::string_view configured_origin) {
    return configured_origin.rfind("https://", 0) == 0;
}

ApiRouter::ApiRouter(DatabasePool& pool, AuthService& auth, FolderManager& folder_mgr,
                     FileManager* file_mgr, FileChunker* chunker,
                     GoogleDriveService* gdrive, std::function<void()> cleanup_trigger,
                     bool trust_forwarded, std::string auth_cookie_origin)
    : pool_(&pool), auth_(&auth), folder_mgr_(&folder_mgr),
            file_mgr_(file_mgr), chunker_(chunker), gdrive_(gdrive),
            cleanup_trigger_(std::move(cleanup_trigger)), trust_forwarded_(trust_forwarded),
            auth_cookie_origin_(auth_cookie_origin.empty()
                ? Utils::get().get_var("CORS_ORIGIN", "http://localhost:3000")
                : std::move(auth_cookie_origin)) {
        auth_->set_database_pool(pool);
}

std::string ApiRouter::handle_healthcheck() const {
    return R"({"status":"online"})";
}

void ApiRouter::trigger_gc_cleanup() {
    if (cleanup_trigger_) cleanup_trigger_();
}

crow::response ApiRouter::handle_init_vault(const crow::request& req) {
    auto user_id_opt = authenticate_request(req);
    if (!user_id_opt) return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    uint64_t user_id = *user_id_opt;

    try {
        auto body = crow::json::load(req.body);
        if (!body || body.t() != crow::json::type::Object ||
            !body.has("vault_verification") ||
            body["vault_verification"].t() != crow::json::type::String ||
            body["vault_verification"].s().size() == 0 ||
            body["vault_verification"].s().size() > 16 * 1024) {
            return crow::response(400, R"({"error_code":"VAULT_VERIFICATION_INVALID","error":"vault_verification invalido"})");
        }
        const std::string vault_verification = body["vault_verification"].s();

        auto conn = pool_->acquire_connection();
        pqxx::work txn(*conn);
        txn.exec(
            "UPDATE users SET is_vault_initialized = TRUE, vault_verification = $2 WHERE id = $1",
            pqxx::params{user_id, vault_verification}
        );
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
            auto response = crow::response(404, R"({"error":"Verificacao de drive nao configurada"})");
            apply_sensitive_response_headers(response);
            return response;
        }
        std::string verification = result[0][0].as<std::string>();
        crow::json::wvalue res;
        res["vault_verification"] = verification;
        auto response = crow::response(200, res);
        apply_sensitive_response_headers(response);
        return response;
    } catch (const std::exception& e) {
        auto response = crow::response(500, R"({"error":"Erro interno"})");
        apply_sensitive_response_headers(response);
        return response;
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
        trigger_gc_cleanup();
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

        const std::string client_ip = ClientIp::resolve(req, trust_forwarded_);
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
        if (msg == "DISPOSABLE_EMAIL_LOCAL") {
            return crow::response(400, R"({"error":"E-mail descartavel nao permitido"})");
        }
        if (msg == "EMAIL_VALIDATION_REJECTED") {
            return crow::response(400, R"({"error_code":"EMAIL_VALIDATION_REJECTED","error":"E-mail nao aceito pela validacao"})");
        }
        if (msg == "TOO_MANY_ACCOUNTS_FROM_IP") {
            return crow::response(429, R"({"error":"Muitas contas criadas por esta rede recentemente. Tente novamente amanha."})");
        }
        if (msg == "VERIFICATION_EMAIL_DELIVERY_FAILED") {
            return crow::response(503, R"({"error_code":"VERIFICATION_EMAIL_DELIVERY_FAILED","error":"Nao foi possivel enviar o e-mail de verificacao. Tente novamente."})");
        }
        if (msg == "VERIFICATION_EMAIL_RECOVERY_FAILED") {
            return crow::response(500, R"({"error":"Erro interno"})");
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
        res.set_header("Set-Cookie", make_session_cookie(
            token, AuthHttpPolicy::secure_cookie_for_origin(auth_cookie_origin_)));
        apply_sensitive_response_headers(res);
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

    try {
        if (!jti.empty()) {
            auth_->logout_local(jti);
        }

        crow::response res(200, R"({"message":"Logout local realizado com sucesso"})");
        res.set_header("Set-Cookie", make_clearing_session_cookie(
            AuthHttpPolicy::secure_cookie_for_origin(auth_cookie_origin_)));
        apply_sensitive_response_headers(res);
        return res;
    } catch (const std::exception&) {
        return crow::response(500, R"({"error":"Erro interno"})");
    }
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
        res.set_header("Set-Cookie", make_clearing_session_cookie(
            AuthHttpPolicy::secure_cookie_for_origin(auth_cookie_origin_)));
        apply_sensitive_response_headers(res);
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
        res.set_header("Set-Cookie", make_session_cookie(
            jwt_token, AuthHttpPolicy::secure_cookie_for_origin(auth_cookie_origin_)));
        apply_sensitive_response_headers(res);
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
        
        std::cerr << "[Google Login Error] Falha interna durante o login." << std::endl;
        return crow::response(500, R"({"error": "Erro interno durante a autenticacao."})");
    }
}

crow::response ApiRouter::handle_refresh(const crow::request& req) {
    try {
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

        const auto refreshed = auth_->refresh_token(token_from_cookie);
        if (!refreshed) {
            return crow::response(401, R"({"error": "Sessao invalida ou expirada."})");
        }

        crow::json::wvalue res_body;
        res_body["token"] = *refreshed;
        crow::response res(200, res_body);
        res.set_header("Set-Cookie", make_session_cookie(
            *refreshed, AuthHttpPolicy::secure_cookie_for_origin(auth_cookie_origin_)));
        apply_sensitive_response_headers(res);
        return res;
    } catch (const std::exception&) {
        return crow::response(500, R"({"error": "Erro interno"})");
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

#ifdef NANIKA_TESTING
        ProfileImageUploadTestHook hook;
        {
            std::lock_guard<std::mutex> lock(profile_image_upload_test_mutex);
            hook = profile_image_upload_test_hook;
        }
#endif
        cpr::Response r =
#ifdef NANIKA_TESTING
            hook ? hook() :
#endif
            cpr::Post(
            cpr::Url{"https://api.imgur.com/3/image"},
            cpr::Header{{"Authorization", "Client-ID " + client_id}},
            cpr::Multipart{{"image", cpr::Buffer{image_data.begin(), image_data.end(), "avatar.png"}}},
            cpr::Timeout{PROFILE_IMAGE_UPLOAD_TIMEOUT_MS}
        );

        if (r.error.code != cpr::ErrorCode::OK || r.status_code != 200) {
            std::cerr << "Imgur Upload Failed. Status=" << r.status_code << std::endl;
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

crow::response ApiRouter::handle_batch_create_folders(const crow::request& req) {
    auto user_id_opt = authenticate_request(req);
    if (!user_id_opt) return crow::response(401, R"({"error":"Token ausente ou invalido"})");

    try {
        auto body = crow::json::load(req.body);
        if (!body || !body.has("root_parent_id") || !body.has("folders") || body["folders"].t() != crow::json::type::List) {
            return crow::response(400, R"({"error":"JSON invalido"})");
        }

        std::optional<uint64_t> root_parent_id;
        if (body.has("root_parent_id") && body["root_parent_id"].t() != crow::json::type::Null) {
            if (body["root_parent_id"].t() != crow::json::type::Number || body["root_parent_id"].i() <= 0) {
                return crow::response(400, R"({"error":"root_parent_id invalido"})");
            }
            root_parent_id = static_cast<uint64_t>(body["root_parent_id"].i());
        }

        std::vector<BatchCreateFolderItem> folders;
        auto folder_nodes = body["folders"];
        for (const auto& item : folder_nodes.lo()) {
            if (item.t() != crow::json::type::Object ||
                !item.has("client_ref") || !item.has("parent_client_ref") ||
                !item.has("encrypted_name") || !item.has("name_hash") ||
                item["client_ref"].t() != crow::json::type::String ||
                item["encrypted_name"].t() != crow::json::type::String ||
                item["name_hash"].t() != crow::json::type::String) {
                return crow::response(400, R"({"error":"Item de pasta invalido"})");
            }

            BatchCreateFolderItem folder;
            folder.client_ref = item["client_ref"].s();
            folder.encrypted_name = item["encrypted_name"].s();
            folder.name_hash = item["name_hash"].s();
            if (item["parent_client_ref"].t() != crow::json::type::Null) {
                if (item["parent_client_ref"].t() != crow::json::type::String) {
                    return crow::response(400, R"({"error":"parent_client_ref invalido"})");
                }
                folder.parent_client_ref = item["parent_client_ref"].s();
            }
            folders.push_back(std::move(folder));
        }

        const auto created = folder_mgr_->batch_create_folders(*user_id_opt, root_parent_id, folders);
        crow::json::wvalue response;
        std::vector<crow::json::wvalue> result_items;
        result_items.reserve(created.size());
        for (const auto& folder : created) {
            crow::json::wvalue item{
                {"client_ref", folder.client_ref},
                {"folder_id", folder.folder_id},
                {"created", folder.created}
            };
            result_items.push_back(std::move(item));
        }
        response["folders"] = std::move(result_items);
        return crow::response(200, response);
    } catch (const pqxx::unique_violation&) {
        return crow::response(409, R"({"error":"Uma pasta com este nome ja existe neste diretorio"})");
    } catch (const std::exception& e) {
        const std::string message = e.what();
        if (message == "FORBIDDEN") return crow::response(403, R"({"error":"Proibido"})");
        if (message == "NOT_FOUND") return crow::response(404, R"({"error":"Pasta nao encontrada"})");
        if (message == "FOLDER_ALREADY_EXISTS") return crow::response(409, R"({"error":"Uma pasta com este nome ja existe neste diretorio"})");
        if (message == "BAD_REQUEST") return crow::response(400, R"({"error":"Estrutura de pastas invalida"})");
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
            crow::response response(201, res_body);
            apply_sensitive_response_headers(response);
            return response;
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
        if (msg == "EXTERNAL_UPLOAD_INIT_CONFLICT") {
            return crow::response(409, R"({"error_code":"EXTERNAL_UPLOAD_INIT_CONFLICT","error":"Armazenamento externo indisponivel para iniciar upload"})");
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

        struct RequestContext {
            std::string client_ref;
            std::optional<uint64_t> folder_id;
            std::string name_hash;
            std::string storage_provider;
            std::optional<GoogleDriveService::BatchUploadTarget> google_target;
        };

        std::vector<BatchInitItem> batch_items;
        std::vector<RequestContext> request_contexts;
        std::unordered_set<std::string> client_refs;

        constexpr uint64_t CHUNK_SIZE = 4ULL * 1024 * 1024;

        for (const auto& item : files_json) {
            if (!item.has("client_ref") || item["client_ref"].t() != crow::json::type::String
                || item["client_ref"].s().size() == 0 || item["client_ref"].s().size() > 128
                || !item.has("encrypted_name") || !item.has("name_hash") ||
                !item.has("encrypted_fdk") || !item.has("size_bytes")) {
                return crow::response(400, R"({"error":"Metadados incompletos no lote"})");
            }

            BatchInitItem b_item;
            RequestContext context;
            try {
                context.client_ref = item["client_ref"].s();
                if (!client_refs.insert(context.client_ref).second) {
                    return crow::response(409, R"({"error":"client_ref duplicado"})");
                }
                if (item.has("folder_id") && item["folder_id"].t() != crow::json::type::Null) {
                    b_item.folder_id = static_cast<uint64_t>(item["folder_id"].i());
                }
                context.folder_id = b_item.folder_id;
                b_item.enc_name = item["encrypted_name"].s();
                b_item.name_hash = item["name_hash"].s();
                b_item.encrypted_fdk = item["encrypted_fdk"].s();
                context.name_hash = b_item.name_hash;
                
                int64_t raw_size = item["size_bytes"].i();
                if (raw_size < 0) return crow::response(400, R"({"error":"Valores numericos invalidos"})");
                b_item.size_bytes = static_cast<uint64_t>(raw_size);

                b_item.storage_provider = "local";
                if (item.has("storage_provider") && item["storage_provider"].t() == crow::json::type::String) {
                    b_item.storage_provider = item["storage_provider"].s();
                }
                context.storage_provider = b_item.storage_provider;

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
                } else if (b_item.storage_provider != "google_drive") {
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
            request_contexts.push_back(std::move(context));
        }

        for (size_t i = 0; i < batch_items.size(); ++i) {
            for (size_t j = i + 1; j < batch_items.size(); ++j) {
                if (batch_items[i].folder_id == batch_items[j].folder_id
                    && batch_items[i].name_hash == batch_items[j].name_hash) {
                    return crow::response(409, R"({"error":"Colisao de arquivos detectada"})");
                }
            }
        }

        std::vector<size_t> google_indices;
        std::vector<uint64_t> google_sizes;
        for (size_t i = 0; i < batch_items.size(); ++i) {
            if (batch_items[i].storage_provider == "google_drive") {
                google_indices.push_back(i);
                google_sizes.push_back(batch_items[i].size_bytes);
            }
        }
        if (!google_indices.empty()) {
            if (!gdrive_ || !gdrive_->is_linked(user_id)) {
                return crow::response(400, R"({"error":"Conta Google Drive nao vinculada"})");
            }
            const auto assignments = gdrive_->select_batch_storages(user_id, google_sizes);
            if (assignments.size() != google_indices.size()) {
                return crow::response(507, R"({"error":"Espaço insuficiente nas contas vinculadas"})");
            }
            for (size_t i = 0; i < google_indices.size(); ++i) {
                const auto index = google_indices[i];
                batch_items[index].external_storage_id = assignments[i].storage_id;
                request_contexts[index].google_target = assignments[i];
            }
        }

        auto db_results = file_mgr_->batch_init_uploads(user_id, batch_items);

        std::vector<crow::json::wvalue> res_array;
        for (const auto& r : db_results) {
            crow::json::wvalue item_res;
            const auto context = std::find_if(request_contexts.begin(), request_contexts.end(),
                [&r](const RequestContext& candidate) {
                    return candidate.folder_id == r.folder_id
                        && candidate.name_hash == r.name_hash
                        && candidate.storage_provider == r.storage_provider;
                });
            if (context == request_contexts.end()) {
                throw std::runtime_error("BATCH_RESPONSE_MISMATCH");
            }
            item_res["client_ref"] = context->client_ref;
            item_res["file_id"] = r.file_id;
            item_res["name_hash"] = r.name_hash;
            item_res["storage_provider"] = r.storage_provider;
            
            if (r.storage_provider == "google_drive") {
                if (!context->google_target.has_value()) {
                    throw std::runtime_error("BATCH_RESPONSE_MISMATCH");
                }
            }
            res_array.push_back(std::move(item_res));
        }

        crow::json::wvalue res_body;
        res_body["files"] = std::move(res_array);
        crow::response response(201, res_body);
        apply_sensitive_response_headers(response);
        return response;

    } catch (const std::exception& e) {
        std::string msg = e.what();
        if (msg == "FORBIDDEN_FOLDER") return crow::response(403, R"({"error":"Proibido acesso a pasta"})");
        if (msg == "QUOTA_EXCEEDED") return crow::response(402, R"({"error":"Payment Required - Quota Exceeded"})");
        if (msg == "FILE_ALREADY_EXISTS") return crow::response(409, R"({"error":"Colisao de arquivos detectada"})");
        if (msg == "EXTERNAL_UPLOAD_INIT_CONFLICT") return crow::response(409, R"({"error_code":"EXTERNAL_UPLOAD_INIT_CONFLICT","error":"Armazenamento externo indisponivel para iniciar upload"})");
        if (msg == "BATCH_RESPONSE_MISMATCH") return crow::response(500, R"({"error":"Erro interno"})");
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
        const bool completed = file_mgr_->store_local_chunk(
            static_cast<uint64_t>(file_id), user_id, chunk_index, req.body, *chunker_);
        if (completed) {
            return crow::response(200, R"({"status":"completed"})");
        }

        return crow::response(200, R"({"status":"uploading"})");

    } catch (const std::exception& e) {
        std::string msg = e.what();
        if (msg == "NOT_FOUND") {
            return crow::response(404, R"({"error":"Arquivo nao encontrado"})");
        }
        if (msg == "INVALID_STORAGE_PROVIDER") {
            return crow::response(400, R"({"error":"Operacao de chunks nao suportada para armazenamento externo"})");
        }
        if (msg == "UPLOAD_ALREADY_COMPLETE") {
            return crow::response(400, R"({"error":"Upload ja finalizado"})");
        }
        if (msg == "INVALID_CHUNK_INDEX") {
            return crow::response(400, R"({"error":"Indice de chunk invalido ou fora dos limites"})");
        }
        if (msg == "INVALID_CHUNK_SIZE") {
            return crow::response(400, R"({"error":"Tamanho do chunk incompatível com o tamanho reservado"})");
        }
        if (msg == "CHUNK_WRITE_FAILED") {
            return crow::response(500, R"({"error":"Falha ao gravar no disco"})");
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
            bool is_upload_complete = false;
            std::optional<std::string> external_file_id;
            std::optional<uint64_t> storage_id;
            {
                auto conn = pool_->acquire_connection();
                pqxx::work txn(*conn);
                auto result = txn.exec(
                    "SELECT external_file_id, external_storage_id, is_upload_complete FROM files WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
                    pqxx::params{file_id, user_id}
                );

                if (!result.empty()) {
                    is_upload_complete = result[0][2].as<bool>();
                    if (!result[0][0].is_null()) {
                        external_file_id = result[0][0].as<std::string>();
                    }
                    if (!result[0][1].is_null()) {
                        storage_id = result[0][1].as<uint64_t>();
                    }
                }
                txn.commit();
            }

            if (is_upload_complete) {
                if (!external_file_id.has_value()) {
                    return crow::response(404, R"({"error":"Arquivo externo nao encontrado"})");
                }

                std::string access_token;
                
                if (storage_id.has_value()) {
                    access_token = gdrive_->get_access_token_for_storage(*storage_id);
                } else {
                    return crow::response(500, R"({"error":"Storage externo nao encontrado para este arquivo"})");
                }

                crow::json::wvalue res_body;
                res_body["storage_provider"] = "google_drive";
                res_body["external_file_id"] = *external_file_id;
                res_body["access_token"] = access_token;

                crow::response res(200, res_body);
                res.set_header("Content-Type", "application/json");
                apply_sensitive_response_headers(res);
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
    auto set_streaming_headers = [&cors_origin, &sanitize_header_filename](crow::response& res, size_t content_length, const std::string& file_name) {
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
            set_streaming_headers(res, content.size(), file_name);
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
        set_streaming_headers(res, data.size(), file_name);

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
    bool include_folders = true;

    char* limit_str = req.url_params.get("file_limit");
    char* offset_str = req.url_params.get("file_offset");
    char* include_folders_str = req.url_params.get("include_folders");

    try {
        if (limit_str != nullptr && std::string(limit_str) != "") {
            limit = std::stoi(limit_str);
        }
        if (offset_str != nullptr && std::string(offset_str) != "") {
            offset = std::stoi(offset_str);
        }
        if (include_folders_str != nullptr) {
            const std::string value(include_folders_str);
            if (value == "true") {
                include_folders = true;
            } else if (value == "false") {
                include_folders = false;
            } else {
                throw std::invalid_argument("include_folders invalido");
            }
        }

        if (limit > 100) {
            limit = 100;
        }
        if (limit < 1) {
            limit = 50;
        }

        std::vector<crow::json::wvalue> folders;
        if (include_folders) {
            folders = folder_mgr_->get_all_folders(user_id);
        }

        auto files = file_mgr_->get_user_files_paginated(user_id, limit + 1, offset);
        const bool has_more = files.size() > static_cast<std::size_t>(limit);
        if (has_more) {
            files.pop_back();
        }

        crow::json::wvalue response;
        response["folders"] = std::move(folders);
        response["files"] = std::move(files);
        response["has_more"] = has_more;
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
        trigger_gc_cleanup();
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
        trigger_gc_cleanup();
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
        trigger_gc_cleanup();
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
        trigger_gc_cleanup();
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
        trigger_gc_cleanup();
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

    try {
        auto body = crow::json::load(req.body);
        if (!body || !body.has("encrypted_name_fdk") ||
            body["encrypted_name_fdk"].t() != crow::json::type::String ||
            std::string(body["encrypted_name_fdk"].s()).empty()) {
            return crow::response(400, R"({"error":"encrypted_name_fdk e obrigatorio"})");
        }

        std::string uuid = file_mgr_->share_file(
            static_cast<uint64_t>(file_id), user_id, body["encrypted_name_fdk"].s());
        crow::json::wvalue res;
        res["share_uuid"] = uuid;
        return crow::response(200, res);
    } catch (const std::exception& e) {
        std::string msg = e.what();
        if (msg == "NOT_FOUND") return crow::response(404, R"({"error":"Arquivo nao encontrado"})");
        if (msg == "TOO_MANY_REQUESTS") return crow::response(429, R"({"error":"Muitas alteracoes de compartilhamento. Tente novamente mais tarde."})");
        if (msg == "SHARING_UNSUPPORTED_PROVIDER") {
            return crow::response(422, R"({"error":"Compartilhamento publico nao esta disponivel para arquivos armazenados no Google Drive.","code":"GOOGLE_DRIVE_SHARING_UNSUPPORTED"})");
        }
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
        file_mgr_->revoke_share(uuid, user_id);
        return crow::response(200, R"({"success":true})");
    } catch (const std::exception& e) {
        std::string msg = e.what();
        if (msg == "NOT_FOUND") return crow::response(404, R"({"error":"Link nao encontrado ou nao pertence ao utilizador"})");
        return crow::response(500, R"({"error":"Erro interno"})");
    }
}

crow::response ApiRouter::handle_get_share_metadata(const crow::request&, const std::string& uuid) {
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
    auto set_share_headers = [&cors_origin, &sanitize_header_filename](crow::response& res, const std::string& encrypted_name, size_t content_length) {
        res.set_header("Content-Type", "application/octet-stream");
        res.set_header("Accept-Ranges", "bytes");
        res.set_header("Content-Length", std::to_string(content_length));
        res.set_header("Access-Control-Allow-Origin", cors_origin);
        res.set_header("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges, Content-Disposition");
        
        std::string safe_name = sanitize_header_filename(encrypted_name);
        res.set_header("Content-Disposition", "attachment; filename=\"" + safe_name + "\"");
    };

    try {
        auto info = file_mgr_->get_shared_file_info(uuid);

        size_t total_size = chunker_->get_file_size(info.file_id);

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
            set_share_headers(res, encrypted_name, content.size());
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
        set_share_headers(res, encrypted_name, data.size());

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
        if (msg == "LINK_IN_PROGRESS") return crow::response(409, R"({"error":"Vinculacao ja em andamento"})");
        if (msg == "LINK_CLAIM_LOST") return crow::response(409, R"({"error":"Autoridade da vinculacao expirada"})");
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
            acc_json["status"] = acc.is_unlinking ? "unlinking" : "ready";
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

crow::response ApiRouter::handle_get_storage_targets(const crow::request& req) {
    auto user_id_opt = authenticate_request(req);
    if (!user_id_opt) return crow::response(401, R"({"error":"Token ausente ou invalido"})");

    try {
        uint64_t local_used = 0;
        uint64_t local_max = 0;
        {
            auto conn = pool_->acquire_connection();
            pqxx::work txn(*conn);
            const auto local = txn.exec(
                "SELECT used_storage_bytes, max_storage_bytes FROM users WHERE id = $1",
                pqxx::params{*user_id_opt});
            if (local.empty()) return crow::response(404, R"({"error":"Usuario nao encontrado"})");
            local_used = local[0][0].as<uint64_t>();
            local_max = local[0][1].as<uint64_t>();
            txn.commit();
        }

        std::vector<crow::json::wvalue> targets;
        crow::json::wvalue local_target;
        local_target["key"] = "local";
        local_target["provider"] = "local";
        local_target["label"] = "Local";
        local_target["external_storage_id"] = nullptr;
        local_target["used_bytes"] = local_used;
        local_target["max_bytes"] = local_max;
        local_target["available_bytes"] = local_max > local_used ? local_max - local_used : 0;
        local_target["nanika_used_bytes"] = local_used;
        local_target["status"] = "ready";
        targets.push_back(std::move(local_target));

        if (gdrive_) {
            for (const auto& storage : gdrive_->get_storage_targets(*user_id_opt)) {
                crow::json::wvalue target;
                target["key"] = "google:" + std::to_string(storage.id);
                target["provider"] = "google_drive";
                target["label"] = storage.account_email.empty() ? "Google Drive" : storage.account_email;
                target["external_storage_id"] = storage.id;
                target["account_email"] = storage.account_email;
                if (!storage.account_picture.empty()) target["account_picture"] = storage.account_picture;
                target["used_bytes"] = storage.used_bytes.has_value()
                    ? crow::json::wvalue(*storage.used_bytes) : crow::json::wvalue(nullptr);
                target["max_bytes"] = storage.max_bytes.has_value()
                    ? crow::json::wvalue(*storage.max_bytes) : crow::json::wvalue(nullptr);
                target["available_bytes"] = storage.available_bytes.has_value()
                    ? crow::json::wvalue(*storage.available_bytes) : crow::json::wvalue(nullptr);
                target["nanika_used_bytes"] = storage.nanika_used_bytes;
                target["status"] = storage.status;
                targets.push_back(std::move(target));
            }
        }

        crow::json::wvalue response;
        response["targets"] = std::move(targets);
        return crow::response(200, response);
    } catch (const std::exception&) {
        return crow::response(500, R"({"error":"Erro ao listar armazenamentos"})");
    }
}

crow::response ApiRouter::handle_get_storage_tree(const crow::request& req) {
    auto user_id_opt = authenticate_request(req);
    if (!user_id_opt) return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    const char* provider_param = req.url_params.get("provider");
    if (!provider_param) return crow::response(400, R"({"error":"provider obrigatorio"})");

    try {
        std::optional<uint64_t> storage_id;
        std::optional<uint64_t> folder_id;
        if (const char* value = req.url_params.get("external_storage_id")) {
            const long long parsed = std::stoll(value);
            if (parsed <= 0) throw std::invalid_argument("INVALID_STORAGE_ID");
            storage_id = static_cast<uint64_t>(parsed);
        }
        if (const char* value = req.url_params.get("folder_id")) {
            const long long parsed = std::stoll(value);
            if (parsed <= 0) throw std::invalid_argument("INVALID_FOLDER_ID");
            folder_id = static_cast<uint64_t>(parsed);
        }
        int limit = req.url_params.get("file_limit") ? std::stoi(req.url_params.get("file_limit")) : 50;
        int offset = req.url_params.get("file_offset") ? std::stoi(req.url_params.get("file_offset")) : 0;
        auto response = file_mgr_->get_storage_tree(*user_id_opt, provider_param, storage_id, folder_id, limit, offset);
        return crow::response(200, response);
    } catch (const std::invalid_argument&) {
        return crow::response(400, R"({"error":"Parametros invalidos"})");
    } catch (const std::exception& error) {
        const std::string message = error.what();
        if (message == "STORAGE_NOT_FOUND" || message == "FOLDER_NOT_FOUND") {
            return crow::response(404, R"({"error":"Recurso nao encontrado"})");
        }
        return crow::response(500, R"({"error":"Erro ao listar armazenamento"})");
    }
}

crow::response ApiRouter::handle_start_storage_move(const crow::request& req, int file_id) {
    auto user = authenticate_request(req);
    if (!user) return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    if (file_id <= 0) return crow::response(400, R"({"error_code":"STORAGE_MOVE_NOT_FOUND"})");
    auto body = crow::json::load(req.body);
    if (!body || !body.has("target_provider") || body["target_provider"].t() != crow::json::type::String) {
        return crow::response(400, R"({"error":"JSON invalido"})");
    }
    try {
        const std::string provider = body["target_provider"].s();
        std::optional<uint64_t> storage_id;
        std::optional<uint64_t> available;
        if (body.has("target_external_storage_id")) {
            const int64_t value = body["target_external_storage_id"].i();
            if (value <= 0) throw std::invalid_argument("STORAGE_TARGET_NOT_FOUND");
            storage_id = static_cast<uint64_t>(value);
        }
        if (provider == "google_drive") {
            if (!gdrive_ || !storage_id.has_value()) throw std::runtime_error("STORAGE_TARGET_NOT_FOUND");
            const auto targets = gdrive_->get_storage_targets(*user);
            auto target = std::find_if(targets.begin(), targets.end(), [&](const auto& item) { return item.id == *storage_id; });
            if (target == targets.end()) throw std::runtime_error("STORAGE_TARGET_NOT_FOUND");
            if (target->status != "ready") throw std::runtime_error("STORAGE_TARGET_UNAVAILABLE");
            available = target->available_bytes;
        }
        auto result = file_mgr_->start_storage_move(*user, static_cast<uint64_t>(file_id), provider, storage_id, available);
        return crow::response(201, result);
    } catch (const std::exception& error) {
        if (std::string(error.what()).find("idx_storage_move_one_active_file") != std::string::npos) {
            return storage_move_error(std::runtime_error("STORAGE_MOVE_ALREADY_ACTIVE"));
        }
        return storage_move_error(error);
    }
}

crow::response ApiRouter::handle_get_active_storage_moves(const crow::request& req) {
    auto user = authenticate_request(req);
    if (!user) return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    try { return crow::response(200, file_mgr_->get_active_storage_moves(*user)); }
    catch (const std::exception& error) { return storage_move_error(error); }
}

crow::response ApiRouter::handle_get_storage_move(const crow::request& req, int move_id) {
    auto user = authenticate_request(req);
    if (!user) return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    if (move_id <= 0) return crow::response(400);
    try { return crow::response(200, file_mgr_->get_storage_move(*user, static_cast<uint64_t>(move_id))); }
    catch (const std::exception& error) { return storage_move_error(error); }
}

crow::response ApiRouter::handle_pause_storage_move(const crow::request& req, int move_id) {
    auto user = authenticate_request(req);
    if (!user) return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    try {
        file_mgr_->set_storage_move_status(*user, move_id, "paused");
        return crow::response(200, file_mgr_->get_storage_move(*user, move_id));
    } catch (const std::exception& error) { return storage_move_error(error); }
}

crow::response ApiRouter::handle_resume_storage_move(const crow::request& req, int move_id) {
    auto user = authenticate_request(req);
    if (!user) return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    try {
        file_mgr_->set_storage_move_status(*user, move_id, "resume");
        return crow::response(200, file_mgr_->get_storage_move(*user, move_id));
    } catch (const std::exception& error) { return storage_move_error(error); }
}

crow::response ApiRouter::handle_cancel_storage_move(const crow::request& req, int move_id) {
    auto user = authenticate_request(req);
    if (!user) return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    try {
        std::vector<std::string> additional_targets;
        struct Target { uint64_t item_id; uint64_t total_bytes; std::string role; std::string external_id; };
        std::vector<Target> targets;
        uint64_t target_storage_id = 0;
        auto body = crow::json::load(req.body.empty() ? "{}" : req.body);
        if (body && body.has("items")) {
            if (body["items"].t() != crow::json::type::List) return crow::response(400, R"({"error_code":"STORAGE_MOVE_INVALID_STATE"})");
            {
                auto conn = pool_->acquire_connection();
                pqxx::read_transaction txn(*conn);
                auto job = txn.exec("SELECT target_provider,target_external_storage_id FROM storage_move_jobs WHERE id=$1 AND user_id=$2",pqxx::params{move_id,*user});
                if (job.empty()) throw std::runtime_error("STORAGE_MOVE_NOT_FOUND");
                if (job[0][0].as<std::string>() == "google_drive" && !job[0][1].is_null()) {
                    for (const auto& value : body["items"]) {
                        if (!value.has("item_id") || !value.has("target_external_file_id") ||
                            value["item_id"].t() != crow::json::type::Number || value["target_external_file_id"].t() != crow::json::type::String) {
                            throw std::invalid_argument("STORAGE_MOVE_INVALID_STATE");
                        }
                        const uint64_t item_id = value["item_id"].i();
                        auto item = txn.exec("SELECT role,total_bytes FROM storage_move_items WHERE id=$1 AND move_job_id=$2",pqxx::params{item_id,move_id});
                        if (item.empty() || !gdrive_) throw std::runtime_error("STORAGE_MOVE_NOT_FOUND");
                        targets.push_back({item_id,item[0][1].as<uint64_t>(),item[0][0].as<std::string>(),value["target_external_file_id"].s()});
                    }
                    target_storage_id = job[0][1].as<uint64_t>();
                } else if (body["items"].size() > 0) {
                    throw std::invalid_argument("STORAGE_MOVE_INVALID_STATE");
                }
                txn.commit();
            }
        }
        for (const auto& target : targets) {
            if (!gdrive_ || gdrive_->validate_external_target(*user,target_storage_id,target.external_id,move_id,target.item_id,target.role) != target.total_bytes) {
                throw std::runtime_error("STORAGE_MOVE_TARGET_INCOMPLETE");
            }
            additional_targets.push_back(target.external_id);
        }
        auto result = file_mgr_->cancel_storage_move(*user, move_id, additional_targets, chunker_);
        trigger_gc_cleanup();
        return crow::response(200, result);
    } catch (const std::exception& error) { return storage_move_error(error); }
}

crow::response ApiRouter::handle_get_external_upload_recovery_context(const crow::request& req, int file_id) {
    auto user_id_opt = authenticate_request(req);
    if (!user_id_opt) return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    if (!file_mgr_) return crow::response(500, R"({"error":"Servico de armazenamento nao configurado"})");

    try {
        const auto file = file_mgr_->get_pending_google_recovery_file(static_cast<uint64_t>(file_id), *user_id_opt);
        crow::json::wvalue body;
        body["storage_provider"] = "google_drive";
        body["external_storage_id"] = static_cast<int64_t>(file.external_storage_id);
        body["name_hash"] = file.name_hash;
        auto response = crow::response(200, body);
        apply_sensitive_response_headers(response);
        return response;
    } catch (const std::exception& error) {
        const std::string code = error.what();
        if (code == "NOT_FOUND") return crow::response(404, R"({"error":"Arquivo nao encontrado"})");
        if (code == "UPLOAD_COMPLETE") return crow::response(409, R"({"error":"Upload ja finalizado"})");
        if (code == "STORAGE_PROVIDER_MISMATCH") return crow::response(400, R"({"error":"Arquivo nao pertence ao Google Drive"})");
        if (code == "STORAGE_NOT_FOUND") return crow::response(409, R"({"error":"Conta Google Drive indisponivel"})");
        return crow::response(500, R"({"error":"Erro interno"})");
    }
}

crow::response ApiRouter::handle_create_external_upload_session(const crow::request& req, int file_id) {
    auto user_id_opt = authenticate_request(req);
    if (!user_id_opt) return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    if (!file_mgr_ || !gdrive_) return crow::response(500, R"({"error":"Servico de armazenamento nao configurado"})");

    try {
        const auto file = file_mgr_->get_pending_google_recovery_file(static_cast<uint64_t>(file_id), *user_id_opt);
        const auto origin = req.get_header_value("Origin");
        if (!origin.empty() && !CustomCorsMiddleware::origin_allowed(origin)) {
            return crow::response(403, R"({"error":"Origem nao permitida"})");
        }
        const auto matches = gdrive_->find_external_upload_targets(
            *user_id_opt, file.external_storage_id, static_cast<uint64_t>(file_id), file.size_bytes);
        if (matches.size() > 1) {
            return crow::response(409, R"({"error_code":"GOOGLE_UPLOAD_RECONCILIATION_AMBIGUOUS","error":"Mais de um upload externo valido foi encontrado"})");
        }

        crow::json::wvalue body;
        if (matches.size() == 1) {
            body["status"] = "completed";
            body["external_file_id"] = matches.front();
        } else {
            const auto session = gdrive_->create_upload_resumable_session(
                *user_id_opt, file.external_storage_id, static_cast<uint64_t>(file_id),
                file.size_bytes, file.name_hash, origin);
            body["status"] = "upload";
            body["session_uri"] = session.session_uri;
            body["access_token"] = session.access_token;
        }
        crow::response response(200, body);
        apply_sensitive_response_headers(response);
        return response;
    } catch (const std::exception& error) {
        const std::string code = error.what();
        if (code == "NOT_FOUND") return crow::response(404, R"({"error":"Arquivo nao encontrado"})");
        if (code == "UPLOAD_COMPLETE") return crow::response(409, R"({"error":"Upload ja finalizado"})");
        if (code == "STORAGE_PROVIDER_MISMATCH") return crow::response(400, R"({"error":"Arquivo nao pertence ao Google Drive"})");
        if (code == "STORAGE_NOT_FOUND" || code == "STORAGE_TARGET_NOT_FOUND" || code == "STORAGE_TARGET_UNAVAILABLE") {
            return crow::response(409, R"({"error":"Conta Google Drive indisponivel"})");
        }
        if (code == "GOOGLE_RECONCILIATION_FAILED") return crow::response(502, R"({"error":"Falha ao reconciliar upload no Google Drive"})");
        if (code == "GOOGLE_TOKEN_REFRESH_FAILED" || code == "GOOGLE_SESSION_FAILED") {
            return crow::response(502, R"({"error":"Falha ao criar sessao no Google Drive"})");
        }
        return crow::response(500, R"({"error":"Erro interno"})");
    }
}

crow::response ApiRouter::handle_cancel_external_upload(const crow::request& req, int file_id) {
    const auto user_id_opt = authenticate_request(req);
    if (!user_id_opt) return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    if (!file_mgr_) return crow::response(500, R"({"error":"Servico de armazenamento nao configurado"})");

    try {
        file_mgr_->mark_pending_google_upload_cancelled(static_cast<uint64_t>(file_id), *user_id_opt);
        trigger_gc_cleanup();
        crow::json::wvalue body;
        body["status"] = "cleanup_pending";
        crow::response response(202, body);
        apply_sensitive_response_headers(response);
        return response;
    } catch (const std::exception& error) {
        const std::string code = error.what();
        if (code == "NOT_FOUND") return crow::response(404, R"({"error":"Arquivo nao encontrado"})");
        if (code == "STORAGE_PROVIDER_MISMATCH") return crow::response(400, R"({"error":"Arquivo nao pertence ao Google Drive"})");
        if (code == "UPLOAD_COMPLETE" || code == "EXTERNAL_UPLOAD_ALREADY_FINALIZED") {
            return crow::response(409, R"({"error":"Upload externo ja finalizado"})");
        }
        if (code == "STORAGE_NOT_FOUND") return crow::response(409, R"({"error":"Conta Google Drive indisponivel"})");
        return crow::response(500, R"({"error":"Erro interno"})");
    }
}

crow::response ApiRouter::handle_get_pending_upload_recovery_prefix(const crow::request& req, int file_id) {
    auto user_id_opt = authenticate_request(req);
    if (!user_id_opt) return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    if (!file_mgr_ || !chunker_) return crow::response(500, R"({"error":"Servico de armazenamento nao configurado"})");

    try {
        file_mgr_->require_pending_local_recovery_file(static_cast<uint64_t>(file_id), *user_id_opt);

        const std::string range = req.get_header_value("Range");
        if (range.empty()) return crow::response(400, R"({"error":"Cabecalho Range obrigatorio"})");
        constexpr std::string_view prefix = "bytes=";
        if (range.rfind(prefix, 0) != 0) return range_not_satisfiable(0);

        const std::string_view value(range.data() + prefix.size(), range.size() - prefix.size());
        const size_t dash = value.find('-');
        if (dash == std::string_view::npos || value.find('-', dash + 1) != std::string_view::npos) {
            return range_not_satisfiable(0);
        }
        const auto start = parse_uint64_strict(value.substr(0, dash));
        const auto end = parse_uint64_strict(value.substr(dash + 1));
        if (!start || !end || *start != 0 || *end >= FileChunker::MAX_CHUNK_SIZE) {
            return range_not_satisfiable(0);
        }

        const uint64_t physical_size = chunker_->get_file_size(static_cast<uint64_t>(file_id));
        if (physical_size == 0) throw std::runtime_error("NOT_FOUND_ON_DISK");
        const uint64_t physical_end = std::min(*end, physical_size - 1);
        const size_t requested_length = static_cast<size_t>(physical_end + 1);
        const std::string content = chunker_->read_file_portion(
            static_cast<uint64_t>(file_id), 0, requested_length);
        if (content.empty()) throw std::runtime_error("NOT_FOUND_ON_DISK");

        crow::response response(206, content);
        response.set_header("Content-Type", "application/octet-stream");
        response.set_header("Accept-Ranges", "bytes");
        response.set_header("Content-Length", std::to_string(content.size()));
        response.set_header("Content-Range", "bytes 0-" + std::to_string(content.size() - 1) + "/" +
                            std::to_string(physical_size));
        response.set_header("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges");
        apply_sensitive_response_headers(response);
        return response;
    } catch (const std::exception& error) {
        const std::string code = error.what();
        if (code == "NOT_FOUND") return crow::response(404, R"({"error":"Arquivo nao encontrado"})");
        if (code == "UPLOAD_COMPLETE") return crow::response(409, R"({"error":"Upload ja finalizado"})");
        if (code == "STORAGE_PROVIDER_MISMATCH") {
            return crow::response(400, R"({"error":"Arquivo nao pertence ao armazenamento local"})");
        }
        if (code == "RECOVERY_CHUNK_ZERO_MISSING" || code == "NOT_FOUND_ON_DISK") {
            return crow::response(409, R"({"error":"Contexto de recovery indisponivel"})");
        }
        if (code == "IO_RESOURCE_EXHAUSTED") {
            return crow::response(503, R"({"error":"Recurso de armazenamento indisponivel"})");
        }
        return crow::response(500, R"({"error":"Erro interno"})");
    }
}

crow::response ApiRouter::handle_clear_storage_move(const crow::request& req, int move_id) {
    auto user = authenticate_request(req);
    if (!user) return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    try {
        file_mgr_->clear_storage_move(*user, move_id);
        return crow::response(204);
    } catch (const std::exception& error) { return storage_move_error(error); }
}

crow::response ApiRouter::handle_storage_move_failure(const crow::request& req, int move_id) {
    auto user = authenticate_request(req);
    if (!user) return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    auto body = crow::json::load(req.body);
    if (!body || !body.has("error_code") || !body.has("stage") || !body.has("retryable") ||
        body["error_code"].t() != crow::json::type::String || body["stage"].t() != crow::json::type::String ||
        (body["retryable"].t() != crow::json::type::True && body["retryable"].t() != crow::json::type::False)) {
        return crow::response(400, R"({"error_code":"STORAGE_MOVE_INVALID_FAILURE"})");
    }
    try {
        std::vector<std::string> additional_targets;
        struct Target { uint64_t item_id; uint64_t total_bytes; std::string role; std::string external_id; };
        std::vector<Target> targets;
        uint64_t storage_id = 0;
        if (body.has("items")) {
            if (body["items"].t() != crow::json::type::List) throw std::invalid_argument("STORAGE_MOVE_INVALID_FAILURE");
            {
                auto conn = pool_->acquire_connection();
                pqxx::read_transaction txn(*conn);
                auto job = txn.exec("SELECT target_provider,target_external_storage_id FROM storage_move_jobs WHERE id=$1 AND user_id=$2",
                                    pqxx::params{move_id,*user});
                if (job.empty()) throw std::runtime_error("STORAGE_MOVE_NOT_FOUND");
                if (job[0][0].as<std::string>() != "google_drive" || job[0][1].is_null()) {
                    throw std::invalid_argument("STORAGE_MOVE_INVALID_FAILURE");
                }
                for (const auto& value : body["items"]) {
                    if (!value.has("item_id") || !value.has("target_external_file_id") ||
                        value["item_id"].t() != crow::json::type::Number ||
                        value["target_external_file_id"].t() != crow::json::type::String) {
                        throw std::invalid_argument("STORAGE_MOVE_INVALID_FAILURE");
                    }
                    const uint64_t item_id = value["item_id"].i();
                    auto item = txn.exec("SELECT role,total_bytes FROM storage_move_items WHERE id=$1 AND move_job_id=$2",
                                         pqxx::params{item_id,move_id});
                    if (item.empty()) throw std::runtime_error("STORAGE_MOVE_NOT_FOUND");
                    targets.push_back({item_id,item[0][1].as<uint64_t>(),item[0][0].as<std::string>(),value["target_external_file_id"].s()});
                }
                storage_id = job[0][1].as<uint64_t>();
                txn.commit();
            }
        }
        if (!body["retryable"].b()) {
            if (!targets.empty() && !gdrive_) throw std::runtime_error("STORAGE_MOVE_RECONCILE_FAILED");
            for (const auto& target : targets) {
                if (gdrive_->validate_external_target(*user,storage_id,target.external_id,move_id,target.item_id,target.role) != target.total_bytes) {
                    throw std::runtime_error("STORAGE_MOVE_TARGET_INCOMPLETE");
                }
                additional_targets.push_back(target.external_id);
            }
        }
        file_mgr_->record_storage_move_failure(*user,move_id,body["error_code"].s(),body["stage"].s(),body["retryable"].b(),additional_targets,chunker_);
        trigger_gc_cleanup();
        return crow::response(200,file_mgr_->get_storage_move(*user,move_id));
    } catch (const std::exception& error) { return storage_move_error(error); }
}

crow::response ApiRouter::handle_storage_move_progress(const crow::request& req, int move_id) {
    auto user = authenticate_request(req);
    if (!user) return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    auto body = crow::json::load(req.body);
    if (!body || !body.has("item_id") || !body.has("transferred_bytes")) return crow::response(400, R"({"error":"JSON invalido"})");
    try {
        const int64_t item_id = body["item_id"].i();
        const int64_t bytes = body["transferred_bytes"].i();
        if (item_id <= 0 || bytes < 0) throw std::invalid_argument("STORAGE_MOVE_INVALID_STATE");
        file_mgr_->update_storage_move_progress(*user, move_id, item_id, bytes);
        return crow::response(200, file_mgr_->get_storage_move(*user, move_id));
    } catch (const std::exception& error) { return storage_move_error(error); }
}

crow::response ApiRouter::handle_upload_storage_move_chunk(const crow::request& req, int move_id, int item_id, int chunk_index) {
    auto user = authenticate_request(req);
    if (!user) return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    if (!chunker_ || move_id <= 0 || item_id <= 0 || chunk_index < 0 || !chunker_->validate_chunk_size(req.body.size())) return crow::response(400);
    try {
        {
            auto conn = pool_->acquire_connection();
            pqxx::work txn(*conn);
            auto valid = txn.exec(
                "SELECT i.total_bytes,j.status FROM storage_move_items i JOIN storage_move_jobs j ON j.id=i.move_job_id "
                "WHERE i.id=$1 AND j.id=$2 AND j.user_id=$3 AND j.target_provider='local'",
                pqxx::params{item_id,move_id,*user});
            if (valid.empty()) throw std::runtime_error("STORAGE_MOVE_NOT_FOUND");
            const uint64_t offset = static_cast<uint64_t>(chunk_index) * FileChunker::MAX_CHUNK_SIZE;
            const uint64_t total = valid[0][0].as<uint64_t>();
            if (valid[0][1].as<std::string>() == "paused" || offset > total || req.body.size() > total-offset) throw std::runtime_error("STORAGE_MOVE_INVALID_STATE");
            txn.commit();
        }
        if (!chunker_->write_move_chunk(item_id,chunk_index,req.body)) throw std::runtime_error("STORAGE_MOVE_TARGET_INCOMPLETE");
        const uint64_t transferred = file_mgr_->record_storage_move_chunk(*user,move_id,item_id,chunk_index,req.body.size());
        crow::json::wvalue response;
        response["transferred_bytes"] = transferred;
        return crow::response(200,response);
    } catch (const std::exception& error) { return storage_move_error(error); }
}

crow::response ApiRouter::handle_get_storage_move_chunks(const crow::request& req, int move_id, int item_id) {
    auto user = authenticate_request(req);
    if (!user) return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    try {
        auto conn = pool_->acquire_connection();
        pqxx::work txn(*conn);
        auto owned = txn.exec("SELECT 1 FROM storage_move_items i JOIN storage_move_jobs j ON j.id=i.move_job_id WHERE i.id=$1 AND j.id=$2 AND j.user_id=$3",pqxx::params{item_id,move_id,*user});
        if (owned.empty()) throw std::runtime_error("STORAGE_MOVE_NOT_FOUND");
        auto rows = txn.exec("SELECT chunk_index FROM storage_move_chunks WHERE move_item_id=$1 ORDER BY chunk_index",pqxx::params{item_id});
        std::vector<int> chunks;
        for (const auto& row : rows) chunks.push_back(row[0].as<int>());
        crow::json::wvalue response;
        response["uploaded_chunks"] = std::move(chunks);
        txn.commit();
        return crow::response(200,response);
    } catch (const std::exception& error) { return storage_move_error(error); }
}

crow::response ApiRouter::handle_get_storage_move_source(const crow::request& req, int move_id, int item_id) {
    auto user = authenticate_request(req);
    if (!user) return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    try {
        std::string provider;
        std::optional<uint64_t> source_storage_id;
        std::string source_external_file_id;
        uint64_t file_id = 0;
        std::string role;
        uint64_t total = 0;
        {
            auto conn = pool_->acquire_connection();
            pqxx::work txn(*conn);
            auto rows = txn.exec(
                "SELECT j.source_provider,j.source_external_storage_id,i.source_external_file_id,i.file_id,i.role,i.total_bytes "
                "FROM storage_move_items i JOIN storage_move_jobs j ON j.id=i.move_job_id WHERE j.id=$1 AND i.id=$2 AND j.user_id=$3",
                pqxx::params{move_id,item_id,*user});
            if (rows.empty()) throw std::runtime_error("STORAGE_MOVE_NOT_FOUND");
            provider = rows[0][0].as<std::string>();
            if (!rows[0][1].is_null()) source_storage_id = rows[0][1].as<uint64_t>();
            if (!rows[0][2].is_null()) source_external_file_id = rows[0][2].as<std::string>();
            file_id = rows[0][3].as<uint64_t>();
            role = rows[0][4].as<std::string>();
            total = rows[0][5].as<uint64_t>();
            txn.commit();
        }
        if (provider == "google_drive") {
            if (!gdrive_ || !source_storage_id || source_external_file_id.empty()) throw std::runtime_error("STORAGE_MOVE_TARGET_INCOMPLETE");
            crow::json::wvalue response;
            response["provider"] = "google_drive";
            response["external_file_id"] = source_external_file_id;
            response["external_storage_id"] = static_cast<int64_t>(*source_storage_id);
            response["access_token"] = gdrive_->get_access_token_for_storage(*source_storage_id);
            response["size_bytes"] = static_cast<int64_t>(total);
            crow::response result(200, response);
            apply_sensitive_response_headers(result);
            return result;
        }
        if (!chunker_) throw std::runtime_error("STORAGE_MOVE_TARGET_INCOMPLETE");
        const std::string range = req.get_header_value("Range");
        if (range.empty()) return crow::response(400,R"({"error":"Range obrigatorio"})");
        if (range.rfind("bytes=",0) != 0) return range_not_satisfiable(total);
        const auto dash = range.find('-',6);
        if (dash == std::string::npos || range.find(',',6) != std::string::npos || range.find('-',dash + 1) != std::string::npos) {
            return range_not_satisfiable(total);
        }
        const auto start = parse_uint64_strict(std::string_view(range).substr(6,dash-6));
        const auto requested_end = parse_uint64_strict(std::string_view(range).substr(dash + 1));
        if (!start || !requested_end || total == 0 || *start > *requested_end || *start >= total) {
            return range_not_satisfiable(total);
        }
        uint64_t end = *requested_end;
        end = std::min(end,total-1);
        const uint64_t length = end-*start+1;
        if (length > FileChunker::MAX_CHUNK_SIZE) return range_not_satisfiable(total);
        const std::string data = role == "proxy"
            ? chunker_->read_proxy_file_portion(file_id,*start,length)
            : chunker_->read_file_portion(file_id,*start,length);
        crow::response response(206,data);
        response.set_header("Content-Type","application/octet-stream");
        response.set_header("Accept-Ranges","bytes");
        response.set_header("Content-Length",std::to_string(data.size()));
        response.set_header("Content-Range","bytes "+std::to_string(*start)+"-"+std::to_string(*start+data.size()-1)+"/"+std::to_string(total));
        response.set_header("Access-Control-Expose-Headers","Content-Range, Content-Length, Accept-Ranges");
        return response;
    } catch (const std::exception& error) { return storage_move_error(error); }
}

crow::response ApiRouter::handle_storage_move_target_uploaded(const crow::request& req, int move_id, int item_id) {
    auto user = authenticate_request(req);
    if (!user) return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    auto body = crow::json::load(req.body.empty() ? "{}" : req.body);
    try {
        std::string provider;
        std::optional<uint64_t> target_storage_id;
        std::string job_status;
        std::string role;
        uint64_t total_bytes = 0;
        std::string item_status;
        std::optional<std::string> existing_external_id;
        {
            auto conn = pool_->acquire_connection();
            pqxx::read_transaction txn(*conn);
            auto rows = txn.exec(
                "SELECT j.target_provider,j.target_external_storage_id,j.status,i.role,i.total_bytes,i.status,i.target_external_file_id "
                "FROM storage_move_items i JOIN storage_move_jobs j ON j.id=i.move_job_id "
                "WHERE i.id=$1 AND j.id=$2 AND j.user_id=$3",
                pqxx::params{item_id,move_id,*user});
            if (rows.empty()) throw std::runtime_error("STORAGE_MOVE_NOT_FOUND");
            provider = rows[0][0].as<std::string>();
            if (!rows[0][1].is_null()) target_storage_id = rows[0][1].as<uint64_t>();
            job_status = rows[0][2].as<std::string>();
            role = rows[0][3].as<std::string>();
            total_bytes = rows[0][4].as<uint64_t>();
            item_status = rows[0][5].as<std::string>();
            if (!rows[0][6].is_null()) existing_external_id = rows[0][6].as<std::string>();
            txn.commit();
        }
        if (job_status == "cancelled" || job_status == "failed") {
            throw std::runtime_error("STORAGE_MOVE_INVALID_STATE");
        }
        std::optional<std::string> external_id;
        if (provider == "google_drive") {
            if (!body || !body.has("target_external_file_id") || body["target_external_file_id"].t() != crow::json::type::String || std::string(body["target_external_file_id"].s()).empty()) {
                throw std::invalid_argument("STORAGE_MOVE_TARGET_INCOMPLETE");
            }
            external_id = body["target_external_file_id"].s();
            if (item_status == "target_uploaded" || item_status == "completed") {
                if (!existing_external_id || *existing_external_id != *external_id) throw std::runtime_error("STORAGE_MOVE_TARGET_CONFLICT");
                file_mgr_->mark_storage_move_item_uploaded(*user,move_id,item_id,external_id);
                return crow::response(200,file_mgr_->get_storage_move(*user,move_id));
            }
            if (job_status == "completed" || job_status == "cleanup_pending" || job_status == "committing") throw std::runtime_error("STORAGE_MOVE_INVALID_STATE");
            if (!gdrive_ || !target_storage_id || gdrive_->validate_external_target(*user,*target_storage_id,*external_id,move_id,item_id,role) != total_bytes) {
                throw std::runtime_error("STORAGE_MOVE_TARGET_INCOMPLETE");
            }
        } else {
            if (!body || body.t() != crow::json::type::Object || body.has("target_external_file_id")) throw std::invalid_argument("STORAGE_MOVE_TARGET_INCOMPLETE");
            if (item_status == "target_uploaded" || item_status == "completed") {
                file_mgr_->mark_storage_move_item_uploaded(*user,move_id,item_id,std::nullopt);
                return crow::response(200,file_mgr_->get_storage_move(*user,move_id));
            }
            if (job_status == "completed" || job_status == "cleanup_pending" || job_status == "committing") throw std::runtime_error("STORAGE_MOVE_INVALID_STATE");
            if (!chunker_ || chunker_->get_move_file_size(item_id) != total_bytes) throw std::runtime_error("STORAGE_MOVE_TARGET_INCOMPLETE");
        }
        file_mgr_->mark_storage_move_item_uploaded(*user,move_id,item_id,external_id);
        return crow::response(200,file_mgr_->get_storage_move(*user,move_id));
    } catch (const std::exception& error) { return storage_move_error(error); }
}

crow::response ApiRouter::handle_reconcile_storage_move(const crow::request& req, int move_id) {
    auto user = authenticate_request(req);
    if (!user) return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    try {
        struct Item { uint64_t id; std::string role; uint64_t total_bytes; std::string status; };
        std::vector<Item> items;
        uint64_t target_storage_id = 0;
        {
            auto conn = pool_->acquire_connection();
            pqxx::read_transaction txn(*conn);
            auto job = txn.exec("SELECT target_provider,target_external_storage_id,status FROM storage_move_jobs WHERE id=$1 AND user_id=$2",pqxx::params{move_id,*user});
            if (job.empty()) throw std::runtime_error("STORAGE_MOVE_NOT_FOUND");
            if (job[0][0].as<std::string>() != "google_drive" || job[0][1].is_null()) throw std::runtime_error("STORAGE_MOVE_INVALID_STATE");
            const std::string job_status = job[0][2].as<std::string>();
            if (job_status == "cancelled" || job_status == "failed" || job_status == "completed" || job_status == "cleanup_pending" || job_status == "committing") throw std::runtime_error("STORAGE_MOVE_INVALID_STATE");
            target_storage_id = job[0][1].as<uint64_t>();
            for (const auto& row : txn.exec("SELECT id,role,total_bytes,status FROM storage_move_items WHERE move_job_id=$1 ORDER BY id",pqxx::params{move_id})) {
                items.push_back({row[0].as<uint64_t>(),row[1].as<std::string>(),row[2].as<uint64_t>(),row[3].as<std::string>()});
            }
            txn.commit();
        }
        for (const auto& item : items) {
            if (item.status == "target_uploaded" || item.status == "completed") continue;
            if (!gdrive_) throw std::runtime_error("STORAGE_MOVE_RECONCILE_FAILED");
            const auto matches = gdrive_->find_external_targets(*user,target_storage_id,move_id,item.id,item.role,item.total_bytes);
            if (matches.empty()) continue;
            for (size_t index = 1; index < matches.size(); ++index) {
                auto cleanup = pool_->acquire_connection();
                pqxx::work cleanup_txn(*cleanup);
                cleanup_txn.exec("INSERT INTO pending_external_deletions(external_file_id,external_storage_id,move_job_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",pqxx::params{matches[index],target_storage_id,move_id});
                cleanup_txn.commit();
                trigger_gc_cleanup();
            }
            file_mgr_->mark_storage_move_item_uploaded(*user,move_id,item.id,matches.front());
        }
        return crow::response(200,file_mgr_->get_storage_move(*user,move_id));
    } catch (const std::exception& error) { return storage_move_error(error); }
}

crow::response ApiRouter::handle_create_storage_move_google_session(const crow::request& req, int move_id, int item_id) {
    auto user = authenticate_request(req);
    if (!user) return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    try {
        if (!gdrive_) throw std::runtime_error("GOOGLE_SESSION_FAILED");
        uint64_t storage_id = 0;
        uint64_t size = 0;
        std::string status;
        std::string role;
        {
            auto conn = pool_->acquire_connection();
            pqxx::work txn(*conn);
            auto rows = txn.exec(
                "SELECT j.target_external_storage_id,i.total_bytes,j.status,i.role FROM storage_move_items i JOIN storage_move_jobs j ON j.id=i.move_job_id "
                "WHERE j.id=$1 AND i.id=$2 AND j.user_id=$3 AND j.target_provider='google_drive'",
                pqxx::params{move_id,item_id,*user});
            if (rows.empty() || rows[0][0].is_null()) throw std::runtime_error("STORAGE_MOVE_NOT_FOUND");
            storage_id = rows[0][0].as<uint64_t>();
            size = rows[0][1].as<uint64_t>();
            status = rows[0][2].as<std::string>();
            role = rows[0][3].as<std::string>();
            txn.commit();
        }
        if (status == "paused" || status == "cancelled" || status == "completed" || status == "cleanup_pending" || status == "committing" || status == "target_uploaded") throw std::runtime_error("STORAGE_MOVE_INVALID_STATE");
        const std::string origin = req.get_header_value("Origin");
        if (!origin.empty() && !CustomCorsMiddleware::origin_allowed(origin)) {
            throw std::runtime_error("CORS_ORIGIN_NOT_ALLOWED");
        }
        auto session = gdrive_->create_resumable_session(*user,storage_id,size,move_id,item_id,role,origin);
        crow::json::wvalue response;
        response["session_uri"] = session.session_uri;
        response["access_token"] = session.access_token;
        crow::response result(200, response);
        apply_sensitive_response_headers(result);
        return result;
    } catch (const std::exception& error) { return storage_move_error(error); }
}

crow::response ApiRouter::handle_complete_storage_move(const crow::request& req, int move_id) {
    auto user = authenticate_request(req);
    if (!user) return crow::response(401, R"({"error":"Token ausente ou invalido"})");
    try {
        if (!chunker_) throw std::runtime_error("STORAGE_MOVE_TARGET_INCOMPLETE");
        if (!req.body.empty()) {
            auto body = crow::json::load(req.body);
            if (!body || body.t() != crow::json::type::Object || body.size() != 0) {
                return crow::response(400, R"({"error_code":"STORAGE_MOVE_INVALID_STATE"})");
            }
        }
        struct Item { bool has_external_id; };
        std::string status;
        std::string provider;
        std::vector<Item> items;
        {
            auto conn = pool_->acquire_connection();
            pqxx::work txn(*conn);
            auto jobs = txn.exec("SELECT status,target_provider,target_external_storage_id FROM storage_move_jobs WHERE id=$1 AND user_id=$2",pqxx::params{move_id,*user});
            if (jobs.empty()) throw std::runtime_error("STORAGE_MOVE_NOT_FOUND");
            status = jobs[0][0].as<std::string>();
            provider = jobs[0][1].as<std::string>();
            if (status != "completed" && status != "cleanup_pending") {
                for (const auto& row : txn.exec("SELECT target_external_file_id FROM storage_move_items WHERE move_job_id=$1 AND status='target_uploaded' ORDER BY id",pqxx::params{move_id})) {
                    items.push_back({!row[0].is_null()});
                }
            }
            txn.commit();
        }
        if (status == "completed") {
            return crow::response(200,file_mgr_->complete_storage_move(*user,move_id,*chunker_));
        }
        if (status == "cleanup_pending") {
            trigger_gc_cleanup();
            return crow::response(200,file_mgr_->complete_storage_move(*user,move_id,*chunker_));
        }
        for (const auto& item : items) {
            if (provider == "google_drive") {
                if (!item.has_external_id) {
                    throw std::runtime_error("STORAGE_MOVE_TARGET_INCOMPLETE");
                }
            }
        }
        auto result = file_mgr_->complete_storage_move(*user,move_id,*chunker_);
        trigger_gc_cleanup();
        return crow::response(200,result);
    } catch (const std::exception& error) { return storage_move_error(error); }
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
        trigger_gc_cleanup();
        
        crow::json::wvalue res;
        res["message"] = "Conta desvinculada com sucesso";
        return crow::response(200, res);

    } catch (const std::exception& e) {
        std::string msg = e.what();
        if (msg == "GOOGLE_DRIVE_NOT_LINKED") return crow::response(404, R"({"error":"Conta nao encontrada ou nao pertence ao usuario"})");
        if (msg == "ACCOUNT_HAS_ACTIVE_STORAGE_MOVES") return crow::response(409, R"({"error_code":"ACCOUNT_HAS_ACTIVE_STORAGE_MOVES","error":"A conta possui transferencias de armazenamento ativas"})");
        if (msg == "ACCOUNT_HAS_PENDING_UPLOADS") return crow::response(409, R"({"error_code":"ACCOUNT_HAS_PENDING_UPLOADS","error":"A conta possui uploads pendentes"})");
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
        if (msg == "EXTERNAL_STORAGE_UNAVAILABLE" || msg == "FINALIZE_CONFLICT") {
            return crow::response(409, R"({"error_code":"EXTERNAL_UPLOAD_FINALIZE_CONFLICT","error":"O upload externo nao pode mais ser finalizado neste estado"})");
        }
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

void ApiRouter::setup_routes(NanikaCrowApp& app) {

    const auto docs_html = [](bool trailing_slash) {
        const std::string assets = trailing_slash ? "assets/" : "docs/assets/";
        const std::string html =
            "<!DOCTYPE html><html lang=\"pt-br\"><head>"
            "<meta charset=\"UTF-8\"><title>Nanika API Docs</title>"
            "<link rel=\"stylesheet\" href=\"" + assets + "swagger-ui.css\">"
            "</head><body><div id=\"swagger-ui\"></div>"
            "<script src=\"" + assets + "swagger-ui-bundle.js\" defer></script>"
            "<script src=\"" + assets + "swagger-init.js\" defer></script>"
            "</body></html>";
        auto response = crow::response(html);
        response.set_header("Content-Type", "text/html; charset=utf-8");
        response.set_header("Content-Security-Policy",
            "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
            "font-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'; "
            "frame-ancestors 'none'; form-action 'none';");
        apply_docs_response_headers(response);
        return response;
    };
    CROW_ROUTE(app, "/api/docs").methods(crow::HTTPMethod::Get)
    ([docs_html]() { return docs_html(false); });

    CROW_ROUTE(app, "/api/docs/swagger.yaml").methods(crow::HTTPMethod::Get)
    ([]() { return read_docs_file("swagger.yaml", "text/yaml; charset=utf-8"); });
    CROW_ROUTE(app, "/api/docs/assets/swagger-ui.css").methods(crow::HTTPMethod::Get)
    ([]() { return read_docs_file("swagger-ui/swagger-ui.css", "text/css; charset=utf-8"); });
    CROW_ROUTE(app, "/api/docs/assets/swagger-ui-bundle.js").methods(crow::HTTPMethod::Get)
    ([]() { return read_docs_file("swagger-ui/swagger-ui-bundle.js", "application/javascript; charset=utf-8"); });
    CROW_ROUTE(app, "/api/docs/assets/swagger-init.js").methods(crow::HTTPMethod::Get)
    ([]() { return read_docs_file("swagger-ui/swagger-init.js", "application/javascript; charset=utf-8"); });

    // Crow selects the first matching route; keep this slash-only alias after the whitelist.
    CROW_ROUTE(app, "/api/docs<path>").methods(crow::HTTPMethod::Get)
    ([docs_html](const std::string& suffix) {
        if (suffix != "/") return crow::response(404);
        return docs_html(true);
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

    CROW_ROUTE(app, "/folders/batch-create").methods(crow::HTTPMethod::Post)
    ([this](const crow::request& req) {
        auto res = handle_batch_create_folders(req);
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

    CROW_ROUTE(app, "/files/<int>/external-upload-recovery-context").methods(crow::HTTPMethod::Get)
    ([this](const crow::request& req, int file_id) {
        auto res = handle_get_external_upload_recovery_context(req, file_id);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/files/<int>/external-upload-session").methods(crow::HTTPMethod::Post)
    ([this](const crow::request& req, int file_id) {
        auto res = handle_create_external_upload_session(req, file_id);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/files/<int>/external-upload-cancel").methods(crow::HTTPMethod::Post)
    ([this](const crow::request& req, int file_id) {
        auto res = handle_cancel_external_upload(req, file_id);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/files/<int>/pending-upload-recovery-prefix").methods(crow::HTTPMethod::Get)
    ([this](const crow::request& req, int file_id) {
        return handle_get_pending_upload_recovery_prefix(req, file_id);
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

    CROW_ROUTE(app, "/files/<int>/shares").methods(crow::HTTPMethod::Get)
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

    CROW_ROUTE(app, "/share/<string>").methods(crow::HTTPMethod::Get)
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

    CROW_ROUTE(app, "/api/storage/targets").methods(crow::HTTPMethod::Get)
    ([this](const crow::request& req) {
        auto res = handle_get_storage_targets(req);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/api/storage/tree").methods(crow::HTTPMethod::Get)
    ([this](const crow::request& req) {
        auto res = handle_get_storage_tree(req);
        res.set_header("Content-Type", "application/json");
        return res;
    });

    CROW_ROUTE(app, "/files/<int>/storage-moves").methods(crow::HTTPMethod::Post)
    ([this](const crow::request& req, int file_id) { return handle_start_storage_move(req,file_id); });

    CROW_ROUTE(app, "/storage-moves/active").methods(crow::HTTPMethod::Get)
    ([this](const crow::request& req) { return handle_get_active_storage_moves(req); });

    CROW_ROUTE(app, "/storage-moves/<int>").methods(crow::HTTPMethod::Get)
    ([this](const crow::request& req, int move_id) { return handle_get_storage_move(req,move_id); });

    CROW_ROUTE(app, "/storage-moves/<int>/pause").methods(crow::HTTPMethod::Post)
    ([this](const crow::request& req, int move_id) { return handle_pause_storage_move(req,move_id); });

    CROW_ROUTE(app, "/storage-moves/<int>/resume").methods(crow::HTTPMethod::Post)
    ([this](const crow::request& req, int move_id) { return handle_resume_storage_move(req,move_id); });

    CROW_ROUTE(app, "/storage-moves/<int>").methods(crow::HTTPMethod::Delete)
    ([this](const crow::request& req, int move_id) { return handle_cancel_storage_move(req,move_id); });

    CROW_ROUTE(app, "/storage-moves/<int>/clear").methods(crow::HTTPMethod::Delete)
    ([this](const crow::request& req, int move_id) { return handle_clear_storage_move(req,move_id); });

    CROW_ROUTE(app, "/storage-moves/<int>/failure").methods(crow::HTTPMethod::Post)
    ([this](const crow::request& req, int move_id) { return handle_storage_move_failure(req,move_id); });

    CROW_ROUTE(app, "/storage-moves/<int>/progress").methods(crow::HTTPMethod::Post)
    ([this](const crow::request& req, int move_id) { return handle_storage_move_progress(req,move_id); });

    CROW_ROUTE(app, "/storage-moves/<int>/items/<int>/chunks/<int>").methods(crow::HTTPMethod::Put)
    ([this](const crow::request& req, int move_id, int item_id, int chunk_index) { return handle_upload_storage_move_chunk(req,move_id,item_id,chunk_index); });

    CROW_ROUTE(app, "/storage-moves/<int>/items/<int>/uploaded-chunks").methods(crow::HTTPMethod::Get)
    ([this](const crow::request& req, int move_id, int item_id) { return handle_get_storage_move_chunks(req,move_id,item_id); });

    CROW_ROUTE(app, "/storage-moves/<int>/items/<int>/source").methods(crow::HTTPMethod::Get)
    ([this](const crow::request& req, int move_id, int item_id) { return handle_get_storage_move_source(req,move_id,item_id); });

    CROW_ROUTE(app, "/storage-moves/<int>/items/<int>/target-uploaded").methods(crow::HTTPMethod::Post)
    ([this](const crow::request& req, int move_id, int item_id) { return handle_storage_move_target_uploaded(req,move_id,item_id); });

    CROW_ROUTE(app, "/storage-moves/<int>/reconcile").methods(crow::HTTPMethod::Post)
    ([this](const crow::request& req, int move_id) { return handle_reconcile_storage_move(req,move_id); });

    CROW_ROUTE(app, "/storage-moves/<int>/items/<int>/google-session").methods(crow::HTTPMethod::Post)
    ([this](const crow::request& req, int move_id, int item_id) { return handle_create_storage_move_google_session(req,move_id,item_id); });

    CROW_ROUTE(app, "/storage-moves/<int>/complete").methods(crow::HTTPMethod::Post)
    ([this](const crow::request& req, int move_id) { return handle_complete_storage_move(req,move_id); });

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




