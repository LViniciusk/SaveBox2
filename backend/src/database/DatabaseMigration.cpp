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

        // TABELA DE PASTAS FIXADAS: somente associação e posição; nomes permanecem no cliente.
        w.exec(R"(
            CREATE TABLE IF NOT EXISTS pinned_folders (
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                folder_id BIGINT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
                position INTEGER NOT NULL,
                created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, folder_id)
            );
        )");
        w.exec("CREATE INDEX IF NOT EXISTS idx_pinned_folders_user_position ON pinned_folders(user_id, position);");

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
                storage_provider VARCHAR(20) NOT NULL DEFAULT 'local' CHECK (storage_provider IN ('local', 'google_drive')),
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
                file_id BIGINT UNIQUE NOT NULL REFERENCES files(id) ON DELETE CASCADE,
                share_uuid VARCHAR(7) UNIQUE NOT NULL,
                encrypted_name_fdk TEXT NOT NULL CHECK (encrypted_name_fdk <> ''),
                hourly_changes INT NOT NULL DEFAULT 1,
                last_changed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
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

        w.exec(R"(
            CREATE TABLE IF NOT EXISTS storage_move_jobs (
                id BIGSERIAL PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                file_id BIGINT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
                status VARCHAR(24) NOT NULL DEFAULT 'prepared' CHECK (status IN (
                    'prepared', 'transferring', 'paused', 'target_uploaded', 'committing',
                    'cleanup_pending', 'completed', 'cancelled', 'failed'
                )),
                source_provider VARCHAR(20) NOT NULL CHECK (source_provider IN ('local', 'google_drive')),
                source_external_storage_id BIGINT REFERENCES user_external_storages(id),
                target_provider VARCHAR(20) NOT NULL CHECK (target_provider IN ('local', 'google_drive')),
                target_external_storage_id BIGINT REFERENCES user_external_storages(id),
                total_bytes BIGINT NOT NULL CHECK (total_bytes >= 0),
                transferred_bytes BIGINT NOT NULL DEFAULT 0 CHECK (transferred_bytes >= 0),
                reserved_bytes BIGINT NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
                error_code VARCHAR(64),
                error_detail VARCHAR(255),
                created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
                completed_at TIMESTAMP WITH TIME ZONE
            );
        )");
        w.exec(R"(
            CREATE TABLE IF NOT EXISTS storage_move_items (
                id BIGSERIAL PRIMARY KEY,
                move_job_id BIGINT NOT NULL REFERENCES storage_move_jobs(id) ON DELETE CASCADE,
                file_id BIGINT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
                role VARCHAR(16) NOT NULL CHECK (role IN ('original', 'proxy')),
                source_external_file_id VARCHAR(255),
                target_external_file_id VARCHAR(255),
                total_bytes BIGINT NOT NULL CHECK (total_bytes >= 0),
                transferred_bytes BIGINT NOT NULL DEFAULT 0 CHECK (transferred_bytes >= 0),
                status VARCHAR(24) NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared', 'transferring', 'target_uploaded', 'completed', 'cancelled', 'failed')),
                UNIQUE(move_job_id, role)
            );
        )");
        w.exec(R"(
            CREATE TABLE IF NOT EXISTS storage_move_chunks (
                move_item_id BIGINT NOT NULL REFERENCES storage_move_items(id) ON DELETE CASCADE,
                chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
                size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
                PRIMARY KEY(move_item_id, chunk_index)
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
                external_storage_id BIGINT NOT NULL,
                move_job_id BIGINT REFERENCES storage_move_jobs(id) ON DELETE CASCADE,
                attempts INTEGER NOT NULL DEFAULT 0,
                next_retry_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
                last_error VARCHAR(255),
                created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(external_file_id, external_storage_id)
            );
        )");

        w.exec(R"(
            CREATE TABLE IF NOT EXISTS pending_local_deletions (
                id BIGSERIAL PRIMARY KEY,
                move_job_id BIGINT NOT NULL REFERENCES storage_move_jobs(id) ON DELETE CASCADE,
                attempts INTEGER NOT NULL DEFAULT 0,
                next_retry_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
                last_error VARCHAR(255),
                UNIQUE(move_job_id)
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
        w.exec("CREATE INDEX IF NOT EXISTS idx_files_storage_projection ON files(user_id, storage_provider, external_storage_id, folder_id, id) WHERE deleted_at IS NULL AND is_upload_complete = TRUE AND is_hidden = FALSE;");
        w.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_storage_move_one_active_file ON storage_move_jobs(file_id) WHERE status IN ('prepared', 'transferring', 'paused', 'target_uploaded', 'committing', 'cleanup_pending');");
        w.exec("CREATE INDEX IF NOT EXISTS idx_storage_move_active_user ON storage_move_jobs(user_id, updated_at) WHERE status IN ('prepared', 'transferring', 'paused', 'target_uploaded', 'committing', 'cleanup_pending');");
        w.exec("CREATE INDEX IF NOT EXISTS idx_storage_move_target_account ON storage_move_jobs(target_external_storage_id, status);");
        w.commit();
        return true;
    } catch (const std::exception& e) {
        std::cerr << "[DB] Erro Crítico na Migração: " << e.what() << std::endl;
        return false;
    }
}
