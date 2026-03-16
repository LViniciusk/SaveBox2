#include <catch2/catch_test_macros.hpp>
#include "database/DatabasePool.hpp"
#include "storage/GarbageCollector.hpp"
#include "test_helpers.hpp"
#include <filesystem>
#include <fstream>




TEST_CASE("Garbage Collector - Limpeza de Uploads Fantasmas", "[gc][cleanup][integration]") {
    DatabasePool pool(1, get_secure_conn_string());
    
    std::string temp_dir = "pasta_teste_gc/";
    GarbageCollector gc(pool, temp_dir);

    std::filesystem::remove_all(temp_dir);
    std::filesystem::create_directories(temp_dir);

    SECTION("Se a pasta estiver vazia, retorna 0 pacatamente") {
        size_t bytes_freed = gc.cleanup_abandoned_uploads(24);

        REQUIRE(bytes_freed == 0);
    }

    SECTION("Deve apagar arquivos físicos e registros no DB mais velhos que X horas") {
        uint64_t fake_user_id = 0;
        uint64_t fake_folder_id = 0;
        std::string fake_file_path = temp_dir + "abandonado.bin";

        {
            auto conn = pool.acquire_connection();
            pqxx::work W(*conn);

            auto res_u = W.exec("INSERT INTO users (username, password_hash) VALUES ('fantasma_gc', 'hash') RETURNING id;");
            fake_user_id = res_u[0][0].as<uint64_t>();

            auto res_f = W.exec_params("INSERT INTO folders (user_id, encrypted_name) VALUES ($1, 'pasta_fantasma') RETURNING id;", fake_user_id);
            fake_folder_id = res_f[0][0].as<uint64_t>();

            W.exec_params(
                "INSERT INTO files (user_id, folder_id, encrypted_name, physical_path, size_bytes, is_upload_complete, created_at) "
                "VALUES ($1, $2, 'arquivo_cripto', $3, 1024, FALSE, NOW() - INTERVAL '48 hours');",
                fake_user_id, fake_folder_id, fake_file_path
            );
            W.commit();
        }

        {
            std::ofstream out(fake_file_path, std::ios::binary);
            out << "DADOS_FALSOS_DO_ARQUIVO_QUE_VAI_SER_DELETADO";
            out.close();
        }

        REQUIRE(std::filesystem::exists(fake_file_path) == true);

        size_t bytes_freed = gc.cleanup_abandoned_uploads(24);

        REQUIRE(bytes_freed > 0);
        REQUIRE(std::filesystem::exists(fake_file_path) == false);

        {
            auto conn = pool.acquire_connection();
            pqxx::work W(*conn);
            auto res = W.exec_params("SELECT count(*) FROM files WHERE physical_path = $1;", fake_file_path);

            REQUIRE(res[0][0].as<int>() == 0);

            W.exec_params("DELETE FROM users WHERE id = $1;", fake_user_id);
            W.commit();
        }
    }

    std::filesystem::remove_all(temp_dir);
}