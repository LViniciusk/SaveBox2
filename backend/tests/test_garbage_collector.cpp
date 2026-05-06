#include <catch2/catch_test_macros.hpp>
#include "database/DatabasePool.hpp"
#include "storage/GarbageCollector.hpp"
#include "storage/FileChunker.hpp"
#include "test_helpers.hpp"
#include <filesystem>
#include <string>

TEST_CASE("Garbage Collector - Regras de Negocio", "[gc][cleanup]") {
    DatabasePool pool(1, get_secure_conn_string());
    
    std::string temp_vault = "./vault_gc_test/";
    std::filesystem::remove_all(temp_vault);
    std::filesystem::create_directories(temp_vault);
    
    FileChunker chunker(temp_vault);
    GarbageCollector gc(pool, &chunker);

    uint64_t user_id = 0;
    uint64_t default_folder_id = 0;

    {
        auto conn = pool.acquire_connection();
        pqxx::work W(*conn);

        W.exec("DELETE FROM users WHERE username LIKE 'gc_tester%';");
        std::string gc_username = "gc_tester_" + std::to_string(rand());
        
        auto res_u = W.exec("INSERT INTO users (username, email, password_hash, is_email_verified) VALUES ('" + gc_username + "', '" + gc_username + "@test.com', 'hash', true) RETURNING id;");

        user_id = res_u[0][0].as<uint64_t>();

        auto res_f = W.exec("INSERT INTO folders (user_id, encrypted_name, name_hash) VALUES (" + std::to_string(user_id) + ", 'gc_folder', 'hash') RETURNING id;");

        default_folder_id = res_f[0][0].as<uint64_t>();

        W.commit();
    }

    auto create_file = [&](bool is_complete, bool is_in_trash=false, uint64_t custom_folder_id=0) -> uint64_t {
        auto conn = pool.acquire_connection();
        pqxx::work W(*conn);
        uint64_t f_id = custom_folder_id == 0 ? default_folder_id : custom_folder_id;

        std::string del_val = is_in_trash ? "NOW()" : "NULL";

        std::string query = "INSERT INTO files (user_id, folder_id, encrypted_name, name_hash, encrypted_fdk, physical_path, size_bytes, is_upload_complete, deleted_at) VALUES (" + std::to_string(user_id) + ", " + std::to_string(f_id) + ", 'name', 'hash_" + std::to_string(rand()) + "', 'mock_fdk', 'dummy_path_" + std::to_string(rand()) + "', 1024, " + (is_complete ? "TRUE" : "FALSE") + ", " + del_val + ") RETURNING id;";

        auto res = W.exec(query);

        W.commit();

        uint64_t id = res[0][0].as<uint64_t>();
        chunker.write_chunk(id, 0, "dummy_data");

        return id;
    };

    auto create_folder = [&](bool is_in_trash=false) -> uint64_t {
        auto conn = pool.acquire_connection();
        pqxx::work W(*conn);
        std::string del_val = is_in_trash ? "NOW()" : "NULL";

        auto res = W.exec("INSERT INTO folders (user_id, encrypted_name, name_hash, deleted_at) VALUES (" + std::to_string(user_id) + ", 'sub_folder', 'hash2_" + std::to_string(rand()) + "', " + del_val + ") RETURNING id;");

        W.commit();

        return res[0][0].as<uint64_t>();
    };

    auto set_created_at = [&](uint64_t file_id, const std::string& interval) {
        auto conn = pool.acquire_connection();
        pqxx::work W(*conn);

        W.exec("UPDATE files SET created_at = NOW() - INTERVAL '" + interval + "' WHERE id = " + std::to_string(file_id) + ";");

        W.commit();
    };

    auto set_deleted_at = [&](uint64_t file_id, const std::string& interval) {
        auto conn = pool.acquire_connection();
        pqxx::work W(*conn);

        W.exec("UPDATE files SET deleted_at = NOW() - INTERVAL '" + interval + "' WHERE id = " + std::to_string(file_id) + ";");

        W.commit();
    };

    auto set_folder_deleted_at = [&](uint64_t f_id, const std::string& interval) {
        auto conn = pool.acquire_connection();
        pqxx::work W(*conn);

        W.exec("UPDATE folders SET deleted_at = NOW() - INTERVAL '" + interval + "' WHERE id = " + std::to_string(f_id) + ";");

        W.commit();
    };

    auto file_exists_in_db = [&](uint64_t file_id) -> bool {
        auto conn = pool.acquire_connection();
        pqxx::work W(*conn);

        auto res = W.exec("SELECT count(*) FROM files WHERE id = " + std::to_string(file_id) + ";");

        return res[0][0].as<int>() > 0;
    };

    auto folder_exists_in_db = [&](uint64_t f_id) -> bool {
        auto conn = pool.acquire_connection();
        pqxx::work W(*conn);

        auto res = W.exec("SELECT count(*) FROM folders WHERE id = " + std::to_string(f_id) + ";");

        return res[0][0].as<int>() > 0;
    };

    auto file_exists_on_disk = [&](uint64_t file_id) -> bool {
        return std::filesystem::exists(std::filesystem::path(temp_vault) / (std::to_string(file_id) + ".dat"));
    };

    SECTION("1. Regra de 4 Horas (Uploads Incompletos)") {
        SECTION("Exaustao 1 (Recente): Upload incompleto com 3 horas. GC NAO deve apagar.") {
            uint64_t id = create_file(false);
            set_created_at(id, "3 hours");

            gc.run_cleanup();

            REQUIRE(file_exists_in_db(id) == true);
            REQUIRE(file_exists_on_disk(id) == true);
        }

        SECTION("Exaustao 2 (Expirado): Upload incompleto com 5 horas. GC DEVE apagar.") {
            uint64_t id = create_file(false);
            set_created_at(id, "5 hours");

            gc.run_cleanup();

            REQUIRE(file_exists_in_db(id) == false);
            REQUIRE(file_exists_on_disk(id) == false);
        }

        SECTION("Exaustao 3 (Completo e Antigo): Upload COMPLETO com 5 horas. GC NAO deve apagar.") {
            uint64_t id = create_file(true);
            set_created_at(id, "5 hours");

            gc.run_cleanup();

            REQUIRE(file_exists_in_db(id) == true);
            REQUIRE(file_exists_on_disk(id) == true);
        }
    }

    SECTION("2. Regra de 30 Dias (Lixeira)") {
        SECTION("Exaustao 4 (Lixeira Recente): Arquivo na lixeira ha 29 dias. GC NAO deve apagar.") {
            uint64_t id = create_file(true, true);
            set_deleted_at(id, "29 days");

            gc.run_cleanup();

            REQUIRE(file_exists_in_db(id) == true);
            REQUIRE(file_exists_on_disk(id) == true);
        }

        SECTION("Exaustao 5 (Lixeira Expirada): Arquivo na lixeira ha 31 dias. GC DEVE apagar.") {
            uint64_t id = create_file(true, true);
            set_deleted_at(id, "31 days");

            gc.run_cleanup();

            REQUIRE(file_exists_in_db(id) == false);
            REQUIRE(file_exists_on_disk(id) == false);
        }

        SECTION("Exaustao 6 (Ativo e Antigo): Arquivo ativo criado ha 60 dias. GC NAO deve apagar.") {
            uint64_t id = create_file(true, false);
            set_created_at(id, "60 days");

            gc.run_cleanup();

            REQUIRE(file_exists_in_db(id) == true);
            REQUIRE(file_exists_on_disk(id) == true);
        }
    }

    SECTION("3. Cascata e Pastas na Lixeira") {
        SECTION("Exaustao 7 (Pasta Expirada): Pasta na lixeira ha 31 dias contendo um arquivo vazio/ativo.") {
            uint64_t folder_id = create_folder(true);
            set_folder_deleted_at(folder_id, "31 days");

            uint64_t file_id = create_file(true, true, folder_id);
            set_deleted_at(file_id, "31 days"); 

            gc.run_cleanup();

            REQUIRE(file_exists_in_db(file_id) == false);
            REQUIRE(folder_exists_in_db(folder_id) == false);
            REQUIRE(file_exists_on_disk(file_id) == false);
        }
    }

    SECTION("4. Limpeza Hibrida e Volume") {
        SECTION("Exaustao 8 (Mix de Lixo): Inserir 10 itens validos e 10 itens expirados.") {
            std::vector<uint64_t> valid_ids;
            std::vector<uint64_t> expired_ids;

            for(int i=0; i<5; i++) {
                uint64_t id1 = create_file(false);
                set_created_at(id1, "3 hours");
                valid_ids.push_back(id1);


                uint64_t id2 = create_file(true, true);
                set_deleted_at(id2, "29 days");
                valid_ids.push_back(id2);
                

                uint64_t id3 = create_file(false);
                set_created_at(id3, "5 hours");
                expired_ids.push_back(id3);


                uint64_t id4 = create_file(true, true);
                set_deleted_at(id4, "31 days");
                expired_ids.push_back(id4);
            }

            gc.run_cleanup();

            for(auto id : valid_ids) {
                REQUIRE(file_exists_in_db(id) == true);
                REQUIRE(file_exists_on_disk(id) == true);
            }

            for(auto id : expired_ids) {
                REQUIRE(file_exists_in_db(id) == false);
                REQUIRE(file_exists_on_disk(id) == false);
            }
        }
    }

    SECTION("5. Resiliencia a Falhas Fisicas (Orphaned DB Records)") {
        SECTION("Exaustao 9 (Falta de Sincronia): Arquivo expirado no DB, chunk ausente no disco.") {
            uint64_t id = create_file(false);
            set_created_at(id, "5 hours");

            chunker.delete_file(id);
            REQUIRE(file_exists_on_disk(id) == false);

            REQUIRE_NOTHROW(gc.run_cleanup());

            REQUIRE(file_exists_in_db(id) == false);
        }
    }

    {
        auto conn = pool.acquire_connection();
        pqxx::work W(*conn);
        W.exec("DELETE FROM users WHERE id = " + std::to_string(user_id) + ";");
        W.commit();
    }

    std::filesystem::remove_all(temp_vault);
}