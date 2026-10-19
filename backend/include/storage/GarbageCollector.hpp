#pragma once

class DatabasePool;
class FileChunker;
class GoogleDriveService;

class GarbageCollector {
public:
    GarbageCollector(DatabasePool& pool, FileChunker* chunker, GoogleDriveService* gdrive = nullptr);

    void run_cleanup();
    void cleanup_deleted_users();

private:
    DatabasePool& pool_;
    FileChunker* chunker_;
    GoogleDriveService* gdrive_;
};
