#pragma once

#include <chrono>

class DatabasePool;
class FileChunker;
class GoogleDriveService;

class GarbageCollector {
public:
    GarbageCollector(DatabasePool& pool, FileChunker* chunker, GoogleDriveService* gdrive = nullptr);

    std::chrono::milliseconds next_wake_delay();
    void run_cleanup();

private:
    void process_cancelled_google_uploads();
    void process_pending_external_deletions();
    void process_pending_storage_move_reconciliations();

    DatabasePool& pool_;
    FileChunker* chunker_;
    GoogleDriveService* gdrive_;
};
