#pragma once

class DatabasePool;
class FileChunker;

class GarbageCollector {
public:
    GarbageCollector(DatabasePool& pool, FileChunker* chunker);

    void run_cleanup();

private:
    DatabasePool& pool_;
    FileChunker* chunker_;
};
