#include "database/DatabaseMigration.hpp"
#include <pqxx/pqxx>
#include <iostream>

bool DatabaseMigration::run(DatabasePool& pool) {
    try {
        auto conn_wrapper = pool.acquire_connection();
        pqxx::work w(*conn_wrapper);

        // TABELA DE USUÁRIOS
        w.exec(R"(
            CREATE TABLE IF NOT EXISTS users (
                id BIGSERIAL PRIMARY KEY,
                username VARCHAR(255) UNIQUE NOT NULL,
                email VARCHAR(255) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                is_email_verified BOOLEAN NOT NULL DEFAULT FALSE,
                verification_token VARCHAR(128) UNIQUE,
                token_expires_at TIMESTAMP WITH TIME ZONE,
                max_storage_bytes BIGINT DEFAULT 5368709120,
                used_storage_bytes BIGINT DEFAULT 0,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                registration_ip VARCHAR(45)
            );
        )");

        // TABELA DE PASTAS
        w.exec(R"(
            CREATE TABLE IF NOT EXISTS folders (
                id BIGSERIAL PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                parent_id BIGINT REFERENCES folders(id) ON DELETE CASCADE,
                encrypted_name TEXT NOT NULL,
                name_hash VARCHAR(128) NOT NULL,
                deleted_at TIMESTAMP NULL,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        )");

        // TABELA DE ARQUIVOS
        w.exec(R"(
            CREATE TABLE IF NOT EXISTS files (
                id BIGSERIAL PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                folder_id BIGINT REFERENCES folders(id) ON DELETE CASCADE,
                encrypted_name TEXT NOT NULL,
                name_hash VARCHAR(128) NOT NULL,
                physical_path TEXT UNIQUE,
                size_bytes BIGINT NOT NULL DEFAULT 0,
                total_chunks INTEGER NOT NULL DEFAULT 1,
                is_upload_complete BOOLEAN NOT NULL DEFAULT FALSE,
                deleted_at TIMESTAMP NULL,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        )");

        // LINKS COMPARTILHADOS
        w.exec(R"(
            CREATE TABLE IF NOT EXISTS shared_links (
                id SERIAL PRIMARY KEY,
                file_id BIGINT REFERENCES files(id) ON DELETE CASCADE,
                share_uuid VARCHAR(36) UNIQUE NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        )");

        // IPS BANIDOS
        w.exec(R"(
            CREATE TABLE IF NOT EXISTS banned_ips (
                ip VARCHAR(45) PRIMARY KEY,
                banned_until TIMESTAMP NOT NULL,
                reason VARCHAR(255)
            );
        )");

        // PASTAS
        w.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_folder_root_active ON folders (user_id, name_hash) WHERE parent_id IS NULL AND deleted_at IS NULL;");
        w.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_folder_sub_active ON folders (user_id, parent_id, name_hash) WHERE parent_id IS NOT NULL AND deleted_at IS NULL;");

        // ARQUIVOS
        w.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_file_root_active ON files (user_id, name_hash) WHERE folder_id IS NULL AND deleted_at IS NULL;");
        w.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_file_sub_active ON files (user_id, folder_id, name_hash) WHERE folder_id IS NOT NULL AND deleted_at IS NULL;");

        // ÍNDICES DE PERFORMANCE
        w.exec("CREATE INDEX IF NOT EXISTS idx_folders_user_parent ON folders(user_id, parent_id);");
        w.exec("CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folder_id);");
        w.commit();
        return true;
    } catch (const std::exception& e) {
        std::cerr << "[DB] Erro Crítico na Migração: " << e.what() << std::endl;
        return false;
    }
}