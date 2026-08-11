#include <catch2/catch_test_macros.hpp>
#include "storage/FileChunker.hpp"
#include <string>
#include <filesystem>
#include <cstdint>
#include <cstddef>
#include <fstream>
#include <unordered_set>

#include "database/DatabasePool.hpp"
#include "database/FileManager.hpp"
#include "test_helpers.hpp"


TEST_CASE("FileChunker - Escrita Cirurgica", "[storage][chunker]") {
    const std::string test_dir = "./test_storage_chunker/";
    const uint64_t fake_file_id = 999;
    const uint64_t MAX_CHUNK = 4 * 1024 * 1024;

    std::filesystem::remove_all(test_dir);
    FileChunker chunker(test_dir);

    auto file_path = std::filesystem::path(test_dir) / (std::to_string(fake_file_id) + ".dat");

    SECTION("Escrita Simples") {
        bool ok = chunker.write_chunk(fake_file_id, 0, "Hello");

        REQUIRE(ok == true);
        REQUIRE(std::filesystem::file_size(file_path) == 5);
    }

    SECTION("Trava de Seguranca") {
        std::string payload(MAX_CHUNK + 1, 'X');

        bool ok = chunker.write_chunk(fake_file_id, 0, payload);

        REQUIRE(ok == false);
    }

    SECTION("Salto com Offset (Sparse File)") {
        chunker.write_chunk(fake_file_id, 0, "Hello");
        chunker.write_chunk(fake_file_id, 1, "World");

        auto expected_size = MAX_CHUNK + 5;
        REQUIRE(std::filesystem::file_size(file_path) == expected_size);
    }

    SECTION("Idempotencia (Sobrescrita)") {
        chunker.write_chunk(fake_file_id, 0, "Test");
        chunker.write_chunk(fake_file_id, 0, "Test");

        REQUIRE(std::filesystem::file_size(file_path) == 4);
    }

    std::filesystem::remove_all(test_dir);
}

TEST_CASE("FileChunker - parser canonico ignora nomes nao exatos", "[storage][chunker][orphan]") {
    const std::string test_dir = "./test_storage_canonical_parser/";
    std::filesystem::remove_all(test_dir);
    FileChunker chunker(test_dir);
    const auto create = [&](const std::string& name) {
        std::ofstream(std::filesystem::path(test_dir) / name, std::ios::binary) << "data";
    };

    create("123.dat");
    create("123.proxy.dat");
    create("123evil.dat");
    create("abc123.dat");
    create("123.tmp");
    create("123evil.proxy.dat");
    create("184467440737095516160.dat");

    const auto candidates = chunker.snapshot_canonical_files();
    chunker.delete_orphaned_files(candidates, {});

    REQUIRE_FALSE(std::filesystem::exists(std::filesystem::path(test_dir) / "123.dat"));
    REQUIRE_FALSE(std::filesystem::exists(std::filesystem::path(test_dir) / "123.proxy.dat"));
    REQUIRE(std::filesystem::exists(std::filesystem::path(test_dir) / "123evil.dat"));
    REQUIRE(std::filesystem::exists(std::filesystem::path(test_dir) / "abc123.dat"));
    REQUIRE(std::filesystem::exists(std::filesystem::path(test_dir) / "123.tmp"));
    REQUIRE(std::filesystem::exists(std::filesystem::path(test_dir) / "123evil.proxy.dat"));
    REQUIRE(std::filesystem::exists(std::filesystem::path(test_dir) / "184467440737095516160.dat"));

    std::filesystem::remove_all(test_dir);
}

TEST_CASE("B.31 micro freeze - stale owner snapshot cannot delete a live file", "[storage][chunker][orphan][b31-micro]") {
    DatabasePool pool(1, get_secure_conn_string());
    const std::string test_dir = "./test_storage_b31_stale_owner/";
    std::filesystem::remove_all(test_dir);
    FileChunker chunker(test_dir);

    uint64_t user_id;
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username='file_chunker_b31_stale_owner'");
        user_id = txn.exec(
            "INSERT INTO users(username,email,password_hash,is_email_verified) "
            "VALUES('file_chunker_b31_stale_owner','file_chunker_b31_stale_owner@example.com','hash',TRUE) RETURNING id"
        )[0][0].as<uint64_t>();
        txn.commit();
    }

    std::unordered_set<uint64_t> stale_valid_file_ids;
    {
        auto conn = pool.acquire_connection();
        pqxx::read_transaction txn(*conn);
        for (const auto& row : txn.exec("SELECT id FROM files")) {
            stale_valid_file_ids.insert(row[0].as<uint64_t>());
        }
        txn.commit();
    }
    const auto physical_candidates = chunker.snapshot_canonical_files();

    uint64_t file_id;
    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        file_id = txn.exec(
            "INSERT INTO files(user_id,encrypted_name,name_hash,encrypted_fdk,size_bytes,"
            "is_upload_complete,storage_provider,physical_path) "
            "VALUES($1,'cipher','file-chunker-b31-stale','fdk',9,TRUE,'local','stale-owner.dat') RETURNING id",
            pqxx::params{user_id})[0][0].as<uint64_t>();
        txn.commit();
    }
    REQUIRE(stale_valid_file_ids.find(file_id) == stale_valid_file_ids.end());
    REQUIRE(chunker.write_chunk(file_id, 0, "live-data"));

    chunker.delete_orphaned_files(physical_candidates, stale_valid_file_ids);

    {
        auto conn = pool.acquire_connection();
        pqxx::read_transaction txn(*conn);
        REQUIRE(txn.exec("SELECT COUNT(*) FROM files WHERE id=$1", pqxx::params{file_id})[0][0].as<int>() == 1);
        txn.commit();
    }
    REQUIRE(std::filesystem::exists(std::filesystem::path(test_dir) / (std::to_string(file_id) + ".dat")));

    auto cleanup_conn = pool.acquire_connection();
    pqxx::work cleanup_txn(*cleanup_conn);
    cleanup_txn.exec("DELETE FROM users WHERE id=$1", pqxx::params{user_id});
    cleanup_txn.commit();
    std::filesystem::remove_all(test_dir);
}

TEST_CASE("FileChunker - candidate snapshot defers new canonical files", "[storage][chunker][orphan][b31-micro]") {
    const std::string test_dir = "./test_storage_b31_candidate_first/";
    std::filesystem::remove_all(test_dir);
    FileChunker chunker(test_dir);
    const auto create = [&](const std::string& name) {
        std::ofstream(std::filesystem::path(test_dir) / name, std::ios::binary) << "data";
    };

    create("100.dat");
    create("101.dat");
    create("101.proxy.dat");
    const auto first_candidates = chunker.snapshot_canonical_files();
    chunker.delete_orphaned_files(first_candidates, {101});

    REQUIRE_FALSE(std::filesystem::exists(std::filesystem::path(test_dir) / "100.dat"));
    REQUIRE(std::filesystem::exists(std::filesystem::path(test_dir) / "101.dat"));
    REQUIRE(std::filesystem::exists(std::filesystem::path(test_dir) / "101.proxy.dat"));

    create("102.dat");
    create("103.proxy.dat");
    chunker.delete_orphaned_files(first_candidates, {});
    REQUIRE(std::filesystem::exists(std::filesystem::path(test_dir) / "102.dat"));
    REQUIRE(std::filesystem::exists(std::filesystem::path(test_dir) / "103.proxy.dat"));

    const auto second_candidates = chunker.snapshot_canonical_files();
    chunker.delete_orphaned_files(second_candidates, {});
    REQUIRE_FALSE(std::filesystem::exists(std::filesystem::path(test_dir) / "102.dat"));
    REQUIRE_FALSE(std::filesystem::exists(std::filesystem::path(test_dir) / "103.proxy.dat"));

    std::filesystem::remove_all(test_dir);
}

TEST_CASE("FileChunker - staging atomico de movimentacao", "[storage][chunker][move]") {
    const std::string test_dir = "./test_storage_move_chunker/";
    const uint64_t file_id = 91;
    const uint64_t item_id = 501;
    const uint64_t proxy_item_id = 502;
    const uint64_t move_id = 77;
    std::filesystem::remove_all(test_dir);
    FileChunker chunker(test_dir);

    REQUIRE_FALSE(chunker.try_get_move_file_size(item_id).has_value());
    REQUIRE_FALSE(chunker.try_get_file_size(file_id).has_value());
    REQUIRE_FALSE(chunker.try_get_proxy_file_size(file_id).has_value());

    REQUIRE(chunker.write_move_chunk(item_id, 0, "ciphertext"));
    REQUIRE(chunker.write_move_chunk(proxy_item_id, 0, "proxy"));
    REQUIRE(chunker.get_move_file_size(item_id) == 10);

    chunker.promote_move_file(item_id, file_id);
    chunker.promote_move_proxy(proxy_item_id, file_id);
    REQUIRE(chunker.try_get_file_size(file_id) == std::optional<uint64_t>(10));
    REQUIRE(chunker.try_get_proxy_file_size(file_id) == std::optional<uint64_t>(5));
    REQUIRE(chunker.read_file_portion(file_id, 0, 10) == "ciphertext");
    REQUIRE(chunker.read_proxy_file_portion(file_id, 0, 5) == "proxy");

    SECTION("rollback devolve o destino ao staging") {
        chunker.demote_move_proxy(proxy_item_id, file_id);
        chunker.demote_move_file(item_id, file_id);
        REQUIRE(chunker.get_move_file_size(item_id) == 10);
        REQUIRE(chunker.get_move_file_size(proxy_item_id) == 5);
    }

    SECTION("origem em quarentena pode ser restaurada") {
        chunker.quarantine_file(file_id, move_id);
        chunker.quarantine_proxy(file_id, move_id);
        REQUIRE_THROWS(chunker.get_file_size(file_id));
        chunker.restore_quarantined_file(file_id, move_id);
        chunker.restore_quarantined_proxy(file_id, move_id);
        REQUIRE(chunker.read_file_portion(file_id, 0, 10) == "ciphertext");
        REQUIRE(chunker.read_proxy_file_portion(file_id, 0, 5) == "proxy");
    }

    std::filesystem::remove_all(test_dir);
}

TEST_CASE("FileChunker - quarantine possui recovery fechado", "[storage][chunker][quarantine]") {
    const std::string test_dir = "./test_storage_quarantine_chunker/";
    const uint64_t file_id = 92;
    const uint64_t move_id = 78;
    std::filesystem::remove_all(test_dir);
    FileChunker chunker(test_dir);

    REQUIRE(chunker.write_chunk(file_id, 0, "original"));
    {
        std::ofstream proxy(std::filesystem::path(test_dir) / (std::to_string(file_id) + ".proxy.dat"), std::ios::binary);
        proxy << "proxy";
    }
    REQUIRE_FALSE(chunker.try_get_quarantined_file_size(move_id).has_value());
    REQUIRE_FALSE(chunker.try_get_quarantined_proxy_size(move_id).has_value());

    chunker.quarantine_file(file_id, move_id);
    chunker.quarantine_proxy(file_id, move_id);
    REQUIRE(chunker.try_get_quarantined_file_size(move_id) == std::optional<uint64_t>(8));
    REQUIRE(chunker.try_get_quarantined_proxy_size(move_id) == std::optional<uint64_t>(5));
    REQUIRE_FALSE(chunker.try_get_file_size(file_id).has_value());
    REQUIRE_FALSE(chunker.try_get_proxy_file_size(file_id).has_value());

    chunker.restore_quarantined_file(file_id, move_id);
    chunker.restore_quarantined_proxy(file_id, move_id);
    REQUIRE(chunker.try_get_file_size(file_id) == std::optional<uint64_t>(8));
    REQUIRE(chunker.try_get_proxy_file_size(file_id) == std::optional<uint64_t>(5));
    REQUIRE_NOTHROW(chunker.restore_quarantined_file(file_id, move_id));
    REQUIRE_NOTHROW(chunker.restore_quarantined_proxy(file_id, move_id));

    chunker.quarantine_file(file_id, move_id);
    chunker.quarantine_proxy(file_id, move_id);
    REQUIRE(chunker.write_chunk(file_id, 0, "new"));
    {
        std::ofstream proxy(std::filesystem::path(test_dir) / (std::to_string(file_id) + ".proxy.dat"), std::ios::binary);
        proxy << "new";
    }
    REQUIRE_THROWS_AS(chunker.restore_quarantined_file(file_id, move_id), std::runtime_error);
    REQUIRE_THROWS_AS(chunker.restore_quarantined_proxy(file_id, move_id), std::runtime_error);

    std::filesystem::remove_all(test_dir);
}

TEST_CASE("FileChunker - orphan cleanup aceita somente artefatos exatos", "[storage][chunker][orphan]") {
    const std::string test_dir = "./test_storage_orphan_parser/";
    std::filesystem::remove_all(test_dir);
    FileChunker chunker(test_dir);
    const auto move_dir = std::filesystem::path(test_dir) / "storage-moves";
    std::filesystem::create_directories(move_dir);
    const auto create = [&](const std::string& name) {
        std::ofstream(move_dir / name, std::ios::binary) << "ciphertext";
    };

    create("item-11.part");
    create("item-12.part");
    create("cleanup-21.dat");
    create("cleanup-22.proxy.dat");
    create("cleanup-42evil.dat");
    create("item-31garbage.part");
    create("cleanup-43.tmp");

    chunker.delete_orphaned_move_files(chunker.snapshot_move_artifacts(), {11}, {21});

    REQUIRE(std::filesystem::exists(move_dir / "item-11.part"));
    REQUIRE(std::filesystem::exists(move_dir / "cleanup-21.dat"));
    REQUIRE_FALSE(std::filesystem::exists(move_dir / "item-12.part"));
    REQUIRE_FALSE(std::filesystem::exists(move_dir / "cleanup-22.proxy.dat"));
    REQUIRE(std::filesystem::exists(move_dir / "cleanup-42evil.dat"));
    REQUIRE(std::filesystem::exists(move_dir / "item-31garbage.part"));
    REQUIRE(std::filesystem::exists(move_dir / "cleanup-43.tmp"));

    std::filesystem::remove_all(test_dir);
}

TEST_CASE("B.93 move orphan cleanup defers artifacts absent from its candidate snapshot",
          "[storage][chunker][orphan][b93][b93-snapshot]") {
    const std::string test_dir = "./test_storage_b93_snapshot/";
    std::filesystem::remove_all(test_dir);
    FileChunker chunker(test_dir);
    const auto move_dir = std::filesystem::path(test_dir) / "storage-moves";
    std::filesystem::create_directories(move_dir);
    const auto create = [&](const std::string& name) { std::ofstream(move_dir / name) << "synthetic"; };
    create("item-100.part");
    create("cleanup-200.dat");
    // These are the exact physical candidates at the current cycle's boundary.
    const auto candidates = chunker.snapshot_move_artifacts();
    create("item-101.part");
    create("cleanup-201.proxy.dat");
    chunker.delete_orphaned_move_files(candidates, {}, {});
    CHECK_FALSE(std::filesystem::exists(move_dir / "item-100.part"));
    CHECK_FALSE(std::filesystem::exists(move_dir / "cleanup-200.dat"));
    CHECK(std::filesystem::exists(move_dir / "item-101.part"));
    CHECK(std::filesystem::exists(move_dir / "cleanup-201.proxy.dat"));
    chunker.delete_orphaned_move_files(chunker.snapshot_move_artifacts(), {}, {});
    CHECK_FALSE(std::filesystem::exists(move_dir / "item-101.part"));
    CHECK_FALSE(std::filesystem::exists(move_dir / "cleanup-201.proxy.dat"));
    std::filesystem::remove_all(test_dir);
}

TEST_CASE("B.93 move snapshots preserve exact owners and reject non-basename candidates",
          "[storage][chunker][orphan][b93]") {
    const std::string test_dir = "./test_storage_b93_exact_candidates/";
    std::filesystem::remove_all(test_dir);
    FileChunker chunker(test_dir);
    const auto move_dir = std::filesystem::path(test_dir) / "storage-moves";
    std::filesystem::create_directories(move_dir / "nested");
    const std::vector<std::string> owned{"item-300.part", "cleanup-400.dat", "cleanup-400.proxy.dat"};
    const std::vector<std::string> ignored{"item-31garbage.part", "cleanup-42evil.dat", "cleanup-43.tmp",
        "item--1.part", "item-+1.part", "item-18446744073709551616.part"};
    for (const auto& name : owned) std::ofstream(move_dir / name) << "owned";
    for (const auto& name : ignored) std::ofstream(move_dir / name) << "ignored";
    std::ofstream(std::filesystem::path(test_dir) / "item-777.part") << "outside-move-root";
    std::ofstream(move_dir / "nested" / "item-778.part") << "nested";
    auto candidates = chunker.snapshot_move_artifacts();
    CHECK(candidates.size() == owned.size());
    candidates.insert(candidates.end(), {"../item-777.part", "..\\item-777.part", "nested/item-778.part"});
    chunker.delete_orphaned_move_files(candidates, {300}, {400});
    for (const auto& name : owned) CHECK(std::filesystem::exists(move_dir / name));
    for (const auto& name : ignored) CHECK(std::filesystem::exists(move_dir / name));
    CHECK(std::filesystem::exists(std::filesystem::path(test_dir) / "item-777.part"));
    CHECK(std::filesystem::exists(move_dir / "nested" / "item-778.part"));
    chunker.delete_orphaned_move_files(chunker.snapshot_move_artifacts(), {}, {});
    for (const auto& name : owned) CHECK_FALSE(std::filesystem::exists(move_dir / name));
    for (const auto& name : ignored) CHECK(std::filesystem::exists(move_dir / name));
    std::filesystem::remove_all(test_dir);
}

#ifdef __linux__
TEST_CASE("B.63 FileChunker nao confirma escrita rejeitada pelo filesystem",
          "[storage][chunker][write][b63]") {
    const std::string test_dir = "./test_storage_b63_write_truth/";
    const uint64_t file_id = 63001;

    std::filesystem::remove_all(test_dir);
    std::filesystem::create_directories(test_dir);
    FileChunker chunker(test_dir);

    const auto file_path = std::filesystem::path(test_dir) /
                           (std::to_string(file_id) + ".dat");
    std::error_code symlink_error;
    std::filesystem::create_symlink("/dev/full", file_path, symlink_error);
    REQUIRE_FALSE(symlink_error);
    REQUIRE(std::filesystem::is_symlink(file_path));

    CHECK_FALSE(chunker.write_chunk(file_id, 0, "ciphertext"));

    std::filesystem::remove_all(test_dir);
}

TEST_CASE("B.63 falha fisica de chunk nao produz ACK no banco",
          "[database][file][upload][storage][b63]") {
    DatabasePool pool(1, get_secure_conn_string());
    FileManager manager(pool);
    const std::string storage_dir = "./test_storage_b63_db_truth/";
    const std::string username = "b63_db_truth_user";
    const std::string email = "b63-db-truth@test.com";
    FileChunker chunker(storage_dir);

    struct Cleanup {
        DatabasePool& pool;
        std::filesystem::path storage_dir;
        uint64_t user_id = 0;

        ~Cleanup() {
            std::filesystem::remove_all(storage_dir);
            if (user_id == 0) return;
            try {
                auto conn = pool.acquire_connection();
                pqxx::work txn(*conn);
                txn.exec("DELETE FROM users WHERE id = $1", pqxx::params{user_id});
                txn.commit();
            } catch (...) {
            }
        }
    } cleanup{pool, storage_dir};

    std::filesystem::remove_all(storage_dir);
    std::filesystem::create_directories(storage_dir);

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username = $1", pqxx::params{username});
        cleanup.user_id = txn.exec(
            "INSERT INTO users(username,email,password_hash,is_email_verified,max_storage_bytes,used_storage_bytes) "
            "VALUES($1,$2,'b63-hash',TRUE,1000000,0) RETURNING id",
            pqxx::params{username, email})[0][0].as<uint64_t>();
        txn.commit();
    }

    const std::string payload = "ciphertext";
    const auto file_id = manager.init_upload(
        cleanup.user_id, std::nullopt, "b63-encrypted-name", "b63-name-hash",
        "b63-encrypted-fdk", payload.size(), 1);
    const auto file_path = std::filesystem::path(storage_dir) /
                           (std::to_string(file_id) + ".dat");
    std::error_code symlink_error;
    std::filesystem::create_symlink("/dev/full", file_path, symlink_error);
    REQUIRE_FALSE(symlink_error);

    std::string error;
    bool completed = false;
    try {
        completed = manager.store_local_chunk(
            file_id, cleanup.user_id, 0, payload, chunker);
    } catch (const std::runtime_error& exception) {
        error = exception.what();
    }

    CHECK(error == "CHUNK_WRITE_FAILED");
    CHECK_FALSE(completed);

    {
        auto conn = pool.acquire_connection();
        pqxx::read_transaction txn(*conn);
        CHECK(txn.exec(
            "SELECT COUNT(*) FROM file_chunks WHERE file_id = $1",
            pqxx::params{file_id})[0][0].as<int>() == 0);
        const auto progress = txn.exec(
            "SELECT uploaded_chunks_count, is_upload_complete FROM files WHERE id = $1",
            pqxx::params{file_id});
        CHECK(progress[0][0].as<int>() == 0);
        CHECK_FALSE(progress[0][1].as<bool>());
        txn.commit();
    }
}
#endif
