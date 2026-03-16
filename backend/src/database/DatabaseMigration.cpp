#include "database/DatabaseMigration.hpp"

#include <pqxx/pqxx>
#include <iostream>

bool DatabaseMigration::run(DatabasePool& pool) {
    try {
        // Adquire uma conexão do pool
        auto conn_wrapper = pool.acquire_connection();

        if (!conn_wrapper.is_valid()) {
            std::cerr << "Erro: Conexão inválida ao tentar rodar migrations." << std::endl;
            return false;
        }

        // Inicia uma transação
        pqxx::work w(*conn_wrapper);

        // Tabela de Usuários
        w.exec(R"(
            CREATE TABLE IF NOT EXISTS users (
                id BIGSERIAL PRIMARY KEY,
                username VARCHAR(255) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                master_key_salt VARCHAR(255),
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        )");

        // Tabela de Pastas
        w.exec(R"(
            CREATE TABLE IF NOT EXISTS folders (
                id BIGSERIAL PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                parent_id BIGINT REFERENCES folders(id) ON DELETE CASCADE,
                encrypted_name TEXT NOT NULL, 
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        )");

        // Tabela de Arquivos
        w.exec(R"(
            CREATE TABLE IF NOT EXISTS files (
                id BIGSERIAL PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                folder_id BIGINT REFERENCES folders(id) ON DELETE CASCADE,
                encrypted_name TEXT NOT NULL,
                physical_path TEXT NOT NULL UNIQUE,
                size_bytes BIGINT NOT NULL DEFAULT 0,
                is_upload_complete BOOLEAN NOT NULL DEFAULT FALSE,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        )");

        // Índices
        w.exec("CREATE INDEX IF NOT EXISTS idx_folders_user_parent ON folders(user_id, parent_id);");
        w.exec("CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folder_id);");
        w.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_unique_name ON folders(user_id, COALESCE(parent_id, 0), encrypted_name);");

        // Confirma a transação
        w.commit();
        return true;
    } catch (const pqxx::sql_error& e) {
        std::cerr << "Erro SQL na migração: " << e.what() << "\nQuery: " << e.query() << std::endl;
        return false;
    } catch (const std::exception& e) {
        std::cerr << "Erro geral na migração: " << e.what() << std::endl;
        return false;
    }
}
