#include <catch2/catch_test_macros.hpp>
#include "controllers/ApiRouter.hpp"
#include "database/DatabasePool.hpp"
#include "Services/AuthService.hpp"
#include "database/FolderManager.hpp"
#include "database/FileManager.hpp"
#include "storage/FileChunker.hpp"
#include "storage/GarbageCollector.hpp"
#include "test_helpers.hpp"
#include <crow_all.h>
#include <filesystem>
#include <string>

TEST_CASE("REST API - Storage Quotas", "[api][quotas]") {
    std::string conn_str = get_secure_conn_string();
    DatabasePool pool(2, conn_str);
    MockEmailService mock_email;
    AuthService auth("Em_cada_esquina_que_passei_te", "deixei_rimas_que_nunca_cantei_pra_ti", &mock_email);
    FolderManager folder_mgr(pool);
    FileManager file_mgr(pool);
    
    std::string temp_vault = "./vault_quotas_test/";
    std::filesystem::remove_all(temp_vault);
    std::filesystem::create_directories(temp_vault);
    FileChunker chunker(temp_vault);
    GarbageCollector gc(pool, &chunker);

    ApiRouter router(pool, auth, folder_mgr, &file_mgr, &chunker);

    int user_id = 0;
    int folder_id = 0;

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username = 'quota_user'");
        
        auto res_u = txn.exec("INSERT INTO users (username, email, password_hash, is_email_verified) VALUES ('quota_user', 'quota_user@test.com', 'hash', true) RETURNING id");
        user_id = res_u[0][0].as<int>();

        auto res_f = txn.exec("INSERT INTO folders (user_id, encrypted_name, name_hash) VALUES (" + std::to_string(user_id) + ", 'root_enc', 'rhash') RETURNING id");
        folder_id = res_f[0][0].as<int>();

        txn.commit();
    }

    std::string token = auth.generate_token(static_cast<uint64_t>(user_id));

    auto set_max_quota = [&](uint64_t max_bytes) {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("UPDATE users SET max_storage_bytes = " + std::to_string(max_bytes) + " WHERE id = " + std::to_string(user_id));
        txn.commit();
    };

    auto set_used_quota = [&](uint64_t used_bytes) {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("UPDATE users SET used_storage_bytes = " + std::to_string(used_bytes) + " WHERE id = " + std::to_string(user_id));
        txn.commit();
    };

    auto get_used_quota = [&]() -> uint64_t {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        auto res = txn.exec("SELECT used_storage_bytes FROM users WHERE id = " + std::to_string(user_id));
        return res[0][0].as<uint64_t>();
    };

    auto get_max_quota = [&]() -> uint64_t {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        auto res = txn.exec("SELECT max_storage_bytes FROM users WHERE id = " + std::to_string(user_id));
        return res[0][0].as<uint64_t>();
    };

    SECTION("1. Inicializacao e Endpoint de Quota") {
        crow::request req;
        req.url = "/users/me/quota";
        req.add_header("Authorization", "Bearer " + token);
        
        crow::response res = router.handle_get_quota(req);
        
        REQUIRE(res.code == 200);
        auto body = crow::json::load(res.body);
        REQUIRE(body.has("used_bytes"));
        REQUIRE(body.has("max_bytes"));
        REQUIRE(body["used_bytes"].i() == 0);
        REQUIRE(body["max_bytes"].i() == 5368709120LL);
    }

    SECTION("2. Init Upload - Limites e Barreiras") {
        SECTION("Aprovacao Clara: Init Upload de 1MB com cota limpa.") {
            crow::request req;
            req.url = "/files";
            req.add_header("Authorization", "Bearer " + token);
            
            crow::json::wvalue init_body;
            init_body["folder_id"] = folder_id;
            init_body["encrypted_name"] = "test.txt";
            init_body["name_hash"] = "thash_" + std::to_string(rand());
            init_body["encrypted_fdk"] = "mock_fdk";
            init_body["size_bytes"] = 1048576; 
            init_body["total_chunks"] = 1;
            
            req.body = init_body.dump();
            
            crow::response res = router.handle_init_file_upload(req);
            
            REQUIRE(res.code == 201);
            REQUIRE(get_used_quota() == 1048576ULL);
        }

        SECTION("Aprovacao na Tampa (Edge Case): Max 10MB, uploadeando 9MB (ja tem 1MB do teste isolado se cota nao reseta, mas isolado).") {
            set_max_quota(10 * 1024 * 1024); 
            set_used_quota(1 * 1024 * 1024); 
            
            crow::request req;
            req.url = "/files";
            req.add_header("Authorization", "Bearer " + token);
            
            crow::json::wvalue init_body;
            init_body["folder_id"] = folder_id;
            init_body["encrypted_name"] = "test2.txt";
            init_body["name_hash"] = "thash2_" + std::to_string(rand());
            init_body["encrypted_fdk"] = "mock_fdk";
            init_body["size_bytes"] = 9 * 1024 * 1024; 
            init_body["total_chunks"] = 2;
            
            req.body = init_body.dump();
            
            crow::response res = router.handle_init_file_upload(req);
            
            REQUIRE(res.code == 201);
            REQUIRE(get_used_quota() == 10 * 1024 * 1024ULL);
        }

        SECTION("Rejeicao por 1 Byte: Limite 10MB e Uso 10MB. 1 byte -> 402 Payment Required.") {
            set_max_quota(10 * 1024 * 1024); 
            set_used_quota(10 * 1024 * 1024); 
            
            crow::request req;
            req.url = "/files";
            req.add_header("Authorization", "Bearer " + token);
            
            crow::json::wvalue init_body;
            init_body["folder_id"] = folder_id;
            init_body["encrypted_name"] = "test3.txt";
            init_body["name_hash"] = "thash3_" + std::to_string(rand());
            init_body["encrypted_fdk"] = "mock_fdk";
            init_body["size_bytes"] = 1; 
            init_body["total_chunks"] = 1;
            
            req.body = init_body.dump();
            
            crow::response res = router.handle_init_file_upload(req);
            
            REQUIRE((res.code == 402 || res.code == 403 || res.code == 400));
            REQUIRE(get_used_quota() == 10 * 1024 * 1024ULL); 
        }

        SECTION("Rejeicao Massiva: 0/5GB, tentando upar 10TB.") {
            set_used_quota(0);
            set_max_quota(5368709120LL);

            crow::request req;
            req.url = "/files";
            req.add_header("Authorization", "Bearer " + token);
            
            crow::json::wvalue init_body;
            init_body["folder_id"] = folder_id;
            init_body["encrypted_name"] = "test4.txt";
            init_body["name_hash"] = "thash4_" + std::to_string(rand());
            init_body["encrypted_fdk"] = "mock_fdk";
            init_body["size_bytes"] = 10000000000000ULL; 
            init_body["total_chunks"] = 1;
            
            req.body = init_body.dump();
            
            crow::response res = router.handle_init_file_upload(req);
            
            REQUIRE((res.code == 402 || res.code == 403 || res.code == 400));
            REQUIRE(get_used_quota() == 0ULL); 
        }
    }

    SECTION("3. O Ciclo de Vida do Espaco (Lixeira e Restauracao)") {
        set_used_quota(1024 * 1024 * 1024);

        int file_id = 0;
        {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            std::string q = "INSERT INTO files (user_id, folder_id, encrypted_name, name_hash, encrypted_fdk, physical_path, size_bytes, total_chunks, is_upload_complete) VALUES ($1, $2, 'f', 'h', 'mock_fdk', 'p', $3, 1, TRUE) RETURNING id";
            auto res = txn.exec(q, pqxx::params{user_id, folder_id, 500 * 1024 * 1024});
            file_id = res[0][0].as<int>();
            txn.commit();
        }

        SECTION("Soft Delete nao libera espaco em disco.") {
            crow::request req_del;
            req_del.url = "/files/" + std::to_string(file_id) + "/trash"; 

            req_del.add_header("Authorization", "Bearer " + token);
            
            crow::response res_del = router.handle_delete_file(req_del, file_id);
            REQUIRE(res_del.code == 200);

            REQUIRE(get_used_quota() == 1024 * 1024 * 1024ULL); 

            SECTION("Restauração continua nao alterando espaco.") {
                crow::request req_res;
                req_res.url = "/files/" + std::to_string(file_id) + "/restore";
                req_res.add_header("Authorization", "Bearer " + token);
                
                crow::response res_restore = router.handle_restore_file(req_res, file_id);
                REQUIRE(res_restore.code == 200);

                REQUIRE(get_used_quota() == 1024 * 1024 * 1024ULL); 
            }
        }
    }

    SECTION("4. Hard Delete e Liberacao de Cota") {
        set_used_quota(1024 * 1024 * 1024);

        int file_id = 0;
        {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            std::string q = "INSERT INTO files (user_id, folder_id, encrypted_name, name_hash, encrypted_fdk, physical_path, size_bytes, total_chunks, is_upload_complete, deleted_at) VALUES ($1, $2, 'f', 'h', 'mock_fdk', 'p_test1', $3, 1, TRUE, NOW()) RETURNING id";
            auto res = txn.exec(q, pqxx::params{user_id, folder_id, 500 * 1024 * 1024});
            file_id = res[0][0].as<int>();
            txn.commit();
        }

        SECTION("Esvaziar Lixeira reduz a cota.") {
            crow::request req_empty;
            req_empty.add_header("Authorization", "Bearer " + token);
            crow::response res = router.handle_empty_trash(req_empty);
            REQUIRE(res.code == 200);

            REQUIRE(get_used_quota() == (1024 * 1024 * 1024ULL - 500 * 1024 * 1024ULL));
        }

        SECTION("Exclusao de Pasta em cascata esvaziando lixeira.") {
            set_used_quota(1024 * 1024 * 1024);

            int sub_folder = 0;
            int file2 = 0;
            {
                auto conn = pool.acquire_connection();
                pqxx::work txn(*conn);
                auto res_f = txn.exec("INSERT INTO folders (user_id, encrypted_name, name_hash) VALUES (" + std::to_string(user_id) + ", 'f_enc2', 'hash_f2') RETURNING id");
                sub_folder = res_f[0][0].as<int>();

                std::string q = "INSERT INTO files (user_id, folder_id, encrypted_name, name_hash, encrypted_fdk, physical_path, size_bytes, total_chunks, is_upload_complete) VALUES ($1, $2, 'f2', 'h2', 'mock_fdk', 'p_test2', $3, 1, TRUE) RETURNING id";
                auto res_f2 = txn.exec(q, pqxx::params{user_id, sub_folder, 100 * 1024 * 1024});
                file2 = res_f2[0][0].as<int>();
                txn.commit();
            }

            crow::request req_del_f;
            req_del_f.add_header("Authorization", "Bearer " + token);
            crow::response res_del_f = router.handle_delete_folder(req_del_f, sub_folder);
            REQUIRE(res_del_f.code == 200);

            crow::request req_empty;
            req_empty.add_header("Authorization", "Bearer " + token);
            crow::response res_empty = router.handle_empty_trash(req_empty);
            REQUIRE(res_empty.code == 200);

            REQUIRE(get_used_quota() == (1024 * 1024 * 1024ULL - 600 * 1024 * 1024ULL));
        }
    }

    SECTION("5. Garbage Collector Integrado") {
        set_used_quota(1000000ULL); 

        int file_id = 0;
        {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            std::string q = "INSERT INTO files (user_id, folder_id, encrypted_name, name_hash, encrypted_fdk, physical_path, size_bytes, total_chunks, is_upload_complete, deleted_at) VALUES ($1, $2, 'f', 'h', 'mock_fdk', 'p_testgc', $3, 1, TRUE, NOW() - INTERVAL '31 days') RETURNING id";
            auto res = txn.exec(q, pqxx::params{user_id, folder_id, 200000ULL});
            file_id = res[0][0].as<int>();
            txn.commit();
        }

        REQUIRE(get_used_quota() == 1000000ULL);

        gc.run_cleanup();

        REQUIRE(get_used_quota() == 800000ULL);
    }

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username = 'quota_user'");
        txn.commit();
    }
    
    std::filesystem::remove_all(temp_vault);
}
