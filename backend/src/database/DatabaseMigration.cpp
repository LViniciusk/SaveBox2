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
                password_hash VARCHAR(255) NULL,
                auth_provider VARCHAR(50) DEFAULT 'local',
                provider_id VARCHAR(255) NULL UNIQUE,
                full_name VARCHAR(255) NULL,
                avatar_url TEXT NULL,
                is_email_verified BOOLEAN NOT NULL DEFAULT FALSE,
                is_vault_initialized BOOLEAN NOT NULL DEFAULT FALSE,
                vault_verification TEXT NULL,
                verification_token VARCHAR(128) UNIQUE,
                token_expires_at TIMESTAMP WITH TIME ZONE,
                max_storage_bytes BIGINT DEFAULT 5368709120,
                used_storage_bytes BIGINT DEFAULT 0 CHECK (used_storage_bytes >= 0),
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                deleted_at TIMESTAMP NULL,
                registration_ip VARCHAR(45),
                token_version INT DEFAULT 1
        );
        )");

        // TABELA DE SESSÕES
        w.exec(R"(
            CREATE TABLE IF NOT EXISTS user_sessions (
                session_id VARCHAR(7) PRIMARY KEY,
                user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT unique_folder_name UNIQUE (user_id, parent_id, name_hash)
            );
        )");

        // TABELA DE ARMAZENAMENTO EXTERNO (Google Drive Multi-Account)
        w.exec(R"(
            CREATE TABLE IF NOT EXISTS user_external_storages (
                id BIGSERIAL PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                provider VARCHAR(20) NOT NULL DEFAULT 'google_drive',
                account_email VARCHAR(255) NULL,
                account_picture VARCHAR(255) NULL,
                refresh_token TEXT NOT NULL,
                root_folder_id VARCHAR(255) NULL,
                is_unlinking BOOLEAN DEFAULT FALSE,
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
                encrypted_fdk TEXT NOT NULL,
                physical_path TEXT UNIQUE,
                size_bytes BIGINT NOT NULL DEFAULT 0,
                total_chunks INTEGER NOT NULL DEFAULT 1,
                is_upload_complete BOOLEAN NOT NULL DEFAULT FALSE,
                is_hidden BOOLEAN NOT NULL DEFAULT FALSE,
                storage_provider VARCHAR(20) DEFAULT 'local',
                external_file_id VARCHAR(255) NULL,
                external_storage_id BIGINT REFERENCES user_external_storages(id) ON DELETE CASCADE,
                proxy_external_file_id VARCHAR(255) NULL,
                proxy_physical_path TEXT UNIQUE NULL,
                proxy_size_bytes BIGINT NULL,
                proxy_encrypted_fdk TEXT NULL,
                deleted_at TIMESTAMP NULL,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT unique_file_name UNIQUE (user_id, folder_id, name_hash)
            );
        )");

        // TABELA DE LINKS COMPARTILHADOS
        w.exec(R"(
            CREATE TABLE IF NOT EXISTS shared_links (
                id SERIAL PRIMARY KEY,
                file_id BIGINT UNIQUE REFERENCES files(id) ON DELETE CASCADE,
                share_uuid VARCHAR(7) UNIQUE NOT NULL,
                hourly_changes INT DEFAULT 1,
                last_changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        )");

        w.exec(R"(
            ALTER TABLE shared_links ADD COLUMN IF NOT EXISTS encrypted_name_fdk TEXT DEFAULT '';
        )");

        // TABELA DE CHUNKS ENVIADOS
        w.exec(R"(
            CREATE TABLE IF NOT EXISTS file_chunks (
                id SERIAL PRIMARY KEY,
                file_id BIGINT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
                chunk_index INTEGER NOT NULL,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(file_id, chunk_index)
            );
        )");

        // IPS BANIDOS
        w.exec(R"(
            CREATE TABLE IF NOT EXISTS banned_ips (
                ip VARCHAR(45) PRIMARY KEY,
                expires_at TIMESTAMP NOT NULL,
                reason VARCHAR(255)
            );
        )");

        // DELEÇÕES EXTERNAS PENDENTES (GC)
        w.exec(R"(
            CREATE TABLE IF NOT EXISTS pending_external_deletions (
                id SERIAL PRIMARY KEY,
                external_file_id VARCHAR(255) NOT NULL,
                external_storage_id BIGINT NOT NULL
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