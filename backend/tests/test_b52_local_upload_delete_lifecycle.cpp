#include <catch2/catch_test_macros.hpp>

#include "controllers/ApiRouter.hpp"
#include "database/DatabasePool.hpp"
#include "database/FileManager.hpp"
#include "database/FolderManager.hpp"
#include "Services/AuthService.hpp"
#include "storage/FileChunker.hpp"
#include "test_helpers.hpp"

#include <chrono>
#include <condition_variable>
#include <filesystem>
#include <memory>
#include <mutex>
#include <pqxx/pqxx>
#include <string>
#include <thread>
#include <vector>

namespace {

constexpr long long B52_TEST_GATE_KEY = 52052052;

struct UploadResult {
    int code = 0;
    std::string body;
    std::string error;
};

struct FileState {
    bool exists = false;
    bool deleted = false;
    bool complete = false;
    int chunks = 0;
    int uploaded_chunks_count = 0;
    uint64_t quota = 0;
    bool physical = false;
    uintmax_t physical_size = 0;
};

struct B52Scenario {
    const std::string conn_str;
    const uint64_t file_size;
    const int total_chunks;
    DatabasePool pool;
    MockEmailService email;
    AuthService auth;
    FolderManager folders;
    FileManager files;
    const std::filesystem::path storage_dir;
    FileChunker chunker;
    ApiRouter router;
    uint64_t user_id = 0;
    uint64_t file_id = 0;
    std::string token;
    std::vector<uint64_t> extra_user_ids;

    explicit B52Scenario(const std::string& suffix, uint64_t size = 1024, int chunks = 1)
        : conn_str(get_secure_conn_string()),
          file_size(size),
          total_chunks(chunks),
          pool(2, conn_str),
          email(),
          auth("B52_test_pepper", "B52_test_secret", &email),
          folders(pool),
          files(pool),
          storage_dir("./test_b52_local_upload_delete_" + suffix),
          chunker(storage_dir.string()),
          router(pool, auth, folders, &files, &chunker) {
        std::filesystem::remove_all(storage_dir);
        std::filesystem::create_directories(storage_dir);

        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DELETE FROM users WHERE username LIKE $1", pqxx::params{"b52_" + suffix + "_%"});
        user_id = txn.exec(
            "INSERT INTO users (username, email, password_hash, is_email_verified, "
            "max_storage_bytes, used_storage_bytes) VALUES ($1, $2, 'b52-hash', TRUE, $3, $4) RETURNING id",
            pqxx::params{"b52_" + suffix + "_user", "b52-" + suffix + "@test.com", file_size + 1000000, file_size})[0][0].as<uint64_t>();
        file_id = txn.exec(
            "INSERT INTO files (user_id, encrypted_name, name_hash, encrypted_fdk, size_bytes, total_chunks, "
            "is_upload_complete, storage_provider) VALUES ($1, 'b52-cipher', $2, 'b52-fdk', $3, $4, FALSE, 'local') RETURNING id",
            pqxx::params{user_id, "b52-" + suffix + "-hash", file_size, total_chunks})[0][0].as<uint64_t>();
        txn.commit();

        token = auth.generate_token(user_id);
    }

    ~B52Scenario() {
        try {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            for (const auto extra_user_id : extra_user_ids) {
                txn.exec("DELETE FROM users WHERE id = $1", pqxx::params{extra_user_id});
            }
            txn.exec("DELETE FROM users WHERE id = $1", pqxx::params{user_id});
            txn.commit();
        } catch (...) {
        }
        std::filesystem::remove_all(storage_dir);
    }

    UploadResult upload_chunk_as(const std::string& upload_token, uint64_t target_file_id,
                                 int chunk_index, size_t body_size) {
        crow::request request;
        request.add_header("Authorization", "Bearer " + upload_token);
        request.add_header("X-Chunk-Index", std::to_string(chunk_index));
        request.body = std::string(body_size, static_cast<char>(0xB2));

        try {
            const auto response = router.handle_upload_chunk(request, static_cast<int>(target_file_id));
            return {response.code, response.body, {}};
        } catch (const std::exception& error) {
            return {0, {}, error.what()};
        } catch (...) {
            return {0, {}, "unknown exception"};
        }
    }

    UploadResult upload_chunk(int chunk_index = 0, size_t body_size = 0) {
        const auto size = body_size == 0 ? static_cast<size_t>(file_size) : body_size;
        return upload_chunk_as(token, file_id, chunk_index, size);
    }

    FileState state_for(uint64_t target_file_id) {
        auto conn = pool.acquire_connection();
        pqxx::nontransaction txn(*conn);
        const auto row = txn.exec(
            "SELECT deleted_at IS NOT NULL, is_upload_complete, "
            "(SELECT COUNT(*) FROM file_chunks WHERE file_id = files.id), "
            "uploaded_chunks_count, "
            "(SELECT used_storage_bytes FROM users WHERE id = files.user_id) "
            "FROM files WHERE id = $1",
            pqxx::params{target_file_id});

        FileState result;
        if (!row.empty()) {
            result.exists = true;
            result.deleted = row[0][0].as<bool>();
            result.complete = row[0][1].as<bool>();
            result.chunks = row[0][2].as<int>();
            result.uploaded_chunks_count = row[0][3].as<int>();
            result.quota = row[0][4].as<uint64_t>();
        } else {
            result.quota = txn.exec(
                "SELECT used_storage_bytes FROM users WHERE id = $1",
                pqxx::params{user_id})[0][0].as<uint64_t>();
        }

        const auto physical_path = storage_dir / (std::to_string(target_file_id) + ".dat");
        result.physical = std::filesystem::exists(physical_path);
        if (result.physical) result.physical_size = std::filesystem::file_size(physical_path);
        return result;
    }

    FileState state() { return state_for(file_id); }

    uint64_t create_file(uint64_t size, int chunks, const std::string& label) {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        const auto id = txn.exec(
            "INSERT INTO files (user_id, encrypted_name, name_hash, encrypted_fdk, size_bytes, total_chunks, "
            "is_upload_complete, storage_provider) VALUES ($1, $2, $3, 'b52-fdk', $4, $5, FALSE, 'local') RETURNING id",
            pqxx::params{user_id, "b52-" + label, "b52-" + label + "-hash", size, chunks})[0][0].as<uint64_t>();
        txn.exec("UPDATE users SET used_storage_bytes = used_storage_bytes + $1 WHERE id = $2",
                 pqxx::params{size, user_id});
        txn.commit();
        return id;
    }

    std::string attacker_token() {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        const auto id = txn.exec(
            "INSERT INTO users (username, email, password_hash, is_email_verified) "
            "VALUES ($1, $2, 'b52-attacker-hash', TRUE) RETURNING id",
            pqxx::params{"b52-attacker-" + std::to_string(file_id),
                         "b52-attacker-" + std::to_string(file_id) + "@test.com"})[0][0].as<uint64_t>();
        txn.commit();
        extra_user_ids.push_back(id);
        return auth.generate_token(id);
    }

    void set_provider(const std::string& provider) {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("UPDATE files SET storage_provider = $1 WHERE id = $2", pqxx::params{provider, file_id});
        txn.commit();
    }
};

class B52ChunkInsertGate {
public:
    explicit B52ChunkInsertGate(B52Scenario& scenario, uint64_t target_file_id = 0, int target_chunk_index = 0)
        : scenario_(scenario),
          target_file_id_(target_file_id == 0 ? scenario.file_id : target_file_id),
          target_chunk_index_(target_chunk_index) {
        auto conn = scenario_.pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec("DROP TRIGGER IF EXISTS b52_chunk_insert_gate_trigger ON file_chunks");
        txn.exec("DROP FUNCTION IF EXISTS b52_chunk_insert_gate()");
        txn.exec(
            "CREATE FUNCTION b52_chunk_insert_gate() RETURNS trigger LANGUAGE plpgsql AS $$ "
            "BEGIN IF NEW.file_id = " + std::to_string(target_file_id_) +
            " AND NEW.chunk_index = " + std::to_string(target_chunk_index_) +
            " THEN PERFORM pg_advisory_xact_lock(52052052); END IF; "
            "RETURN NEW; END; $$");
        txn.exec(
            "CREATE TRIGGER b52_chunk_insert_gate_trigger BEFORE INSERT ON file_chunks "
            "FOR EACH ROW EXECUTE FUNCTION b52_chunk_insert_gate()");
        txn.commit();

        blocker_ = std::make_unique<pqxx::connection>(scenario_.conn_str);
        pqxx::nontransaction blocker(*blocker_);
        blocker.exec("SELECT pg_advisory_lock($1::bigint)", pqxx::params{B52_TEST_GATE_KEY});
        locked_ = true;
    }

    ~B52ChunkInsertGate() {
        try {
            release();
            auto conn = scenario_.pool.acquire_connection();
            pqxx::work txn(*conn);
            txn.exec("DROP TRIGGER IF EXISTS b52_chunk_insert_gate_trigger ON file_chunks");
            txn.exec("DROP FUNCTION IF EXISTS b52_chunk_insert_gate()");
            txn.commit();
        } catch (...) {
        }
    }

    void release() {
        if (!locked_) return;
        pqxx::nontransaction blocker(*blocker_);
        blocker.exec("SELECT pg_advisory_unlock($1::bigint)", pqxx::params{B52_TEST_GATE_KEY});
        locked_ = false;
    }

    B52ChunkInsertGate(const B52ChunkInsertGate&) = delete;
    B52ChunkInsertGate& operator=(const B52ChunkInsertGate&) = delete;

private:
    B52Scenario& scenario_;
    uint64_t target_file_id_;
    int target_chunk_index_;
    std::unique_ptr<pqxx::connection> blocker_;
    bool locked_ = false;
};

bool wait_for_query_lock(const std::string& conn_str, const std::string& query_fragment) {
    pqxx::connection observer_connection(conn_str);
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (std::chrono::steady_clock::now() < deadline) {
        pqxx::nontransaction observer(observer_connection);
        const auto waiting = observer.exec(
            "SELECT 1 FROM pg_stat_activity "
            "WHERE datname = current_database() AND pid <> pg_backend_pid() "
            "AND state = 'active' AND wait_event_type = 'Lock' "
            "AND query ILIKE $1 LIMIT 1", pqxx::params{"%" + query_fragment + "%"});
        if (!waiting.empty()) return true;
        std::this_thread::yield();
    }
    return false;
}

} // namespace

TEST_CASE("B.52 upload owns the row before delete can commit", "[api][files][b52]") {
    B52Scenario scenario("upload-first");
    B52ChunkInsertGate gate(scenario);
    UploadResult upload;
    std::string delete_error;

    std::thread uploader([&] { upload = scenario.upload_chunk(); });
    const bool insert_waiting = wait_for_query_lock(scenario.conn_str, "INSERT INTO file_chunks");

    std::thread deleter([&] {
        try {
            scenario.files.delete_file(scenario.file_id, scenario.user_id);
        } catch (const std::exception& error) {
            delete_error = error.what();
        }
    });
    const bool delete_waiting = wait_for_query_lock(scenario.conn_str, "UPDATE files SET deleted_at");

    gate.release();
    uploader.join();
    deleter.join();
    const auto final_state = scenario.state();

    REQUIRE(insert_waiting);
    REQUIRE(delete_waiting);
    REQUIRE(delete_error.empty());
    REQUIRE(upload.code == 200);
    REQUIRE(upload.body.find("completed") != std::string::npos);
    REQUIRE(upload.error.empty());
    REQUIRE(final_state.deleted);
    REQUIRE(final_state.complete);
    REQUIRE(final_state.chunks == 1);
    REQUIRE(final_state.physical);
    REQUIRE(final_state.physical_size == 1024);
    REQUIRE(final_state.quota == 1024);
}

TEST_CASE("B.52 delete first prevents a late local upload", "[api][files][b52]") {
    B52Scenario scenario("delete-first");
    scenario.files.delete_file(scenario.file_id, scenario.user_id);

    const auto upload = scenario.upload_chunk();
    const auto final_state = scenario.state();

    REQUIRE(upload.code == 404);
    REQUIRE(upload.body.find("Arquivo nao encontrado") != std::string::npos);
    REQUIRE(upload.error.empty());
    REQUIRE(final_state.exists);
    REQUIRE(final_state.deleted);
    REQUIRE_FALSE(final_state.complete);
    REQUIRE(final_state.chunks == 0);
    REQUIRE_FALSE(final_state.physical);
    REQUIRE(final_state.quota == 1024);
}

TEST_CASE("B.52 upload soft-delete hard-delete has no resurrection", "[api][files][b52][race][regression]") {
    B52Scenario scenario("soft-hard");
    B52ChunkInsertGate gate(scenario);
    UploadResult upload;
    std::string delete_error;

    std::thread uploader([&] { upload = scenario.upload_chunk(); });
    const bool insert_waiting = wait_for_query_lock(scenario.conn_str, "INSERT INTO file_chunks");

    std::thread deleter([&] {
        try {
            scenario.files.delete_file(scenario.file_id, scenario.user_id);
        } catch (const std::exception& error) {
            delete_error = error.what();
        }
    });
    const bool delete_waiting = wait_for_query_lock(scenario.conn_str, "UPDATE files SET deleted_at");

    gate.release();
    uploader.join();
    deleter.join();

    const auto soft_deleted = scenario.state();
    std::string hard_delete_error;
    try {
        scenario.files.hard_delete_file(scenario.file_id, scenario.user_id, &scenario.chunker);
    } catch (const std::exception& error) {
        hard_delete_error = error.what();
    }
    const auto after_delete = scenario.state();
    const auto late_upload = scenario.upload_chunk();
    const auto final_state = scenario.state();

    REQUIRE(insert_waiting);
    REQUIRE(delete_waiting);
    REQUIRE(delete_error.empty());
    REQUIRE(upload.error.empty());
    REQUIRE(upload.code == 200);
    REQUIRE(soft_deleted.deleted);
    REQUIRE(soft_deleted.complete);
    REQUIRE(soft_deleted.chunks == 1);
    REQUIRE(soft_deleted.physical);
    REQUIRE(hard_delete_error.empty());
    REQUIRE_FALSE(after_delete.exists);
    REQUIRE(after_delete.chunks == 0);
    REQUIRE_FALSE(after_delete.physical);
    REQUIRE(after_delete.quota == 0);
    REQUIRE(late_upload.code == 404);
    REQUIRE(late_upload.body.find("Arquivo nao encontrado") != std::string::npos);
    REQUIRE(late_upload.error.empty());
    REQUIRE_FALSE(final_state.exists);
    REQUIRE(final_state.chunks == 0);
    REQUIRE_FALSE(final_state.physical);
    REQUIRE(final_state.quota == 0);
}

TEST_CASE("B.52 same-file chunk uploads serialize causally", "[api][files][b52][race][regression]") {
    const auto chunk_size = FileChunker::MAX_CHUNK_SIZE;
    B52Scenario scenario("concurrent", 2 * chunk_size, 2);
    B52ChunkInsertGate gate(scenario);
    UploadResult first;
    UploadResult second;

    std::thread first_uploader([&] { first = scenario.upload_chunk(0, chunk_size); });
    const bool first_waiting = wait_for_query_lock(scenario.conn_str, "INSERT INTO file_chunks");

    std::thread second_uploader([&] { second = scenario.upload_chunk(1, chunk_size); });
    const bool second_waiting = wait_for_query_lock(scenario.conn_str, "SELECT storage_provider");

    gate.release();
    first_uploader.join();
    second_uploader.join();

    const auto final_state = scenario.state();
    const bool first_completed = first.body.find("completed") != std::string::npos;
    const bool second_completed = second.body.find("completed") != std::string::npos;

    REQUIRE(first_waiting);
    REQUIRE(second_waiting);
    REQUIRE(first.error.empty());
    REQUIRE(second.error.empty());
    REQUIRE(first.code == 200);
    REQUIRE(second.code == 200);
    REQUIRE(first.body.find("uploading") != std::string::npos);
    REQUIRE(second.body.find("completed") != std::string::npos);
    REQUIRE_FALSE((first_completed && second_completed));
    REQUIRE(final_state.complete);
    REQUIRE(final_state.chunks == 2);
    REQUIRE(final_state.uploaded_chunks_count == 2);
    REQUIRE(final_state.physical);
    REQUIRE(final_state.physical_size == 2 * chunk_size);
}

TEST_CASE("B.52 different files retain parallel upload progress", "[api][files][b52][race][regression]") {
    B52Scenario scenario("different-files");
    const auto second_file_id = scenario.create_file(1024, 1, "different-files-b");
    B52ChunkInsertGate gate(scenario);
    UploadResult first;
    UploadResult second;
    std::mutex second_mutex;
    std::condition_variable second_done_cv;
    bool second_done = false;

    std::thread first_uploader([&] { first = scenario.upload_chunk(); });
    const bool first_waiting = wait_for_query_lock(scenario.conn_str, "INSERT INTO file_chunks");
    std::thread second_uploader([&] {
        second = scenario.upload_chunk_as(scenario.token, second_file_id, 0, 1024);
        {
            std::lock_guard<std::mutex> lock(second_mutex);
            second_done = true;
        }
        second_done_cv.notify_one();
    });

    std::unique_lock<std::mutex> lock(second_mutex);
    const bool second_completed_before_release = second_done_cv.wait_for(
        lock, std::chrono::seconds(5), [&] { return second_done; });
    lock.unlock();

    gate.release();
    first_uploader.join();
    second_uploader.join();
    const auto first_state = scenario.state_for(scenario.file_id);
    const auto second_state = scenario.state_for(second_file_id);

    REQUIRE(first_waiting);
    REQUIRE(second_completed_before_release);
    REQUIRE(first.error.empty());
    REQUIRE(second.error.empty());
    REQUIRE(first.code == 200);
    REQUIRE(second.code == 200);
    REQUIRE(first.body.find("completed") != std::string::npos);
    REQUIRE(second.body.find("completed") != std::string::npos);
    REQUIRE(first_state.complete);
    REQUIRE(second_state.complete);
    REQUIRE(first_state.chunks == 1);
    REQUIRE(second_state.chunks == 1);
    REQUIRE(first_state.quota == 2048);
    REQUIRE(second_state.quota == 2048);
}

TEST_CASE("B.69 concurrent duplicate chunk increments cardinality once",
          "[api][files][b69][cardinality][race]") {
    const auto chunk_size = FileChunker::MAX_CHUNK_SIZE;
    B52Scenario scenario("same-index-race", 2 * chunk_size, 2);
    B52ChunkInsertGate gate(scenario);
    UploadResult first;
    UploadResult second;

    std::thread first_uploader([&] { first = scenario.upload_chunk(0, chunk_size); });
    const bool first_waiting = wait_for_query_lock(scenario.conn_str, "INSERT INTO file_chunks");
    std::thread second_uploader([&] { second = scenario.upload_chunk(0, chunk_size); });
    const bool second_waiting = wait_for_query_lock(scenario.conn_str, "SELECT storage_provider");

    gate.release();
    first_uploader.join();
    second_uploader.join();

    const auto after_duplicate = scenario.state();
    REQUIRE(first_waiting);
    REQUIRE(second_waiting);
    REQUIRE(first.code == 200);
    REQUIRE(second.code == 200);
    REQUIRE(first.error.empty());
    REQUIRE(second.error.empty());
    REQUIRE(first.body.find("uploading") != std::string::npos);
    REQUIRE(second.body.find("uploading") != std::string::npos);
    REQUIRE(after_duplicate.chunks == 1);
    REQUIRE(after_duplicate.uploaded_chunks_count == 1);
    REQUIRE_FALSE(after_duplicate.complete);

    const auto final = scenario.upload_chunk(1, chunk_size);
    const auto final_state = scenario.state();
    REQUIRE(final.code == 200);
    REQUIRE(final.body.find("completed") != std::string::npos);
    REQUIRE(final_state.chunks == 2);
    REQUIRE(final_state.uploaded_chunks_count == 2);
    REQUIRE(final_state.complete);
}

TEST_CASE("B.52 same-chunk retry does not duplicate bookkeeping", "[api][files][b52][regression]") {
    const auto chunk_size = FileChunker::MAX_CHUNK_SIZE;
    B52Scenario scenario("retry", 2 * chunk_size, 2);

    const auto first = scenario.upload_chunk(0, chunk_size);
    const auto after_first = scenario.state();
    const auto retry = scenario.upload_chunk(0, chunk_size);
    const auto after_retry = scenario.state();
    const auto second = scenario.upload_chunk(1, chunk_size);
    const auto final_state = scenario.state();

    REQUIRE(first.code == 200);
    REQUIRE(first.body.find("uploading") != std::string::npos);
    REQUIRE(retry.code == 200);
    REQUIRE(retry.body.find("uploading") != std::string::npos);
    REQUIRE(after_first.chunks == 1);
    REQUIRE(after_first.uploaded_chunks_count == 1);
    REQUIRE_FALSE(after_first.complete);
    REQUIRE(after_first.quota == 2 * chunk_size);
    REQUIRE(after_retry.chunks == 1);
    REQUIRE(after_retry.uploaded_chunks_count == 1);
    REQUIRE_FALSE(after_retry.complete);
    REQUIRE(after_retry.physical_size == chunk_size);
    REQUIRE(retry.error.empty());
    REQUIRE(second.code == 200);
    REQUIRE(second.body.find("completed") != std::string::npos);
    REQUIRE(final_state.chunks == 2);
    REQUIRE(final_state.uploaded_chunks_count == 2);
    REQUIRE(final_state.complete);
    REQUIRE(final_state.physical_size == 2 * chunk_size);
    REQUIRE(final_state.quota == 2 * chunk_size);
}

TEST_CASE("B.52 out-of-order chunks complete without sequencing requirement", "[api][files][b52][regression]") {
    const auto chunk_size = FileChunker::MAX_CHUNK_SIZE;
    B52Scenario scenario("out-of-order", 2 * chunk_size, 2);

    const auto later = scenario.upload_chunk(1, chunk_size);
    const auto after_later = scenario.state();
    const auto first = scenario.upload_chunk(0, chunk_size);
    const auto final_state = scenario.state();

    REQUIRE(later.code == 200);
    REQUIRE(later.body.find("uploading") != std::string::npos);
    REQUIRE(after_later.chunks == 1);
    REQUIRE(after_later.uploaded_chunks_count == 1);
    REQUIRE_FALSE(after_later.complete);
    REQUIRE(first.code == 200);
    REQUIRE(first.body.find("completed") != std::string::npos);
    REQUIRE(final_state.chunks == 2);
    REQUIRE(final_state.uploaded_chunks_count == 2);
    REQUIRE(final_state.complete);
    REQUIRE(final_state.physical_size == 2 * chunk_size);
    REQUIRE(final_state.quota == 2 * chunk_size);
}

TEST_CASE("B.52 IDOR cannot write another user's local file", "[api][files][b52][regression]") {
    B52Scenario scenario("idor");
    const auto before = scenario.state();
    const auto attacker = scenario.upload_chunk_as(
        scenario.attacker_token(), scenario.file_id, 0, 1024);
    const auto after = scenario.state();

    REQUIRE(attacker.code == 404);
    REQUIRE(attacker.body.find("Arquivo nao encontrado") != std::string::npos);
    REQUIRE(attacker.error.empty());
    REQUIRE(after.complete == before.complete);
    REQUIRE(after.chunks == before.chunks);
    REQUIRE(after.physical == before.physical);
    REQUIRE(after.quota == before.quota);
}

TEST_CASE("B.52 external provider rejects local chunk writes", "[api][files][b52][regression]") {
    B52Scenario scenario("google-negative");
    scenario.set_provider("google_drive");
    const auto response = scenario.upload_chunk();
    const auto final_state = scenario.state();

    REQUIRE(response.code == 400);
    REQUIRE(response.body.find("Operacao de chunks nao suportada para armazenamento externo") != std::string::npos);
    REQUIRE(response.error.empty());
    REQUIRE_FALSE(final_state.complete);
    REQUIRE(final_state.chunks == 0);
    REQUIRE_FALSE(final_state.physical);
    REQUIRE(final_state.quota == 1024);
}

TEST_CASE("B.52 completed local file rejects overwrite", "[api][files][b52][regression]") {
    B52Scenario scenario("complete");
    REQUIRE(scenario.upload_chunk().code == 200);
    const auto before = scenario.state();
    const auto response = scenario.upload_chunk();
    const auto after = scenario.state();

    REQUIRE(response.code == 400);
    REQUIRE(response.body.find("Upload ja finalizado") != std::string::npos);
    REQUIRE(response.error.empty());
    REQUIRE(after.complete);
    REQUIRE(after.chunks == before.chunks);
    REQUIRE(after.physical_size == before.physical_size);
    REQUIRE(after.quota == before.quota);
}
