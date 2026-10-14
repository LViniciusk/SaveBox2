#pragma once

#include <sodium.h>
#include <string>

namespace AuthDetail {
#ifdef NANIKA_TESTING
// Observe only while the buffer is still alive; absent from production builds.
inline thread_local void (*wipe_observer)(const void*, size_t) noexcept = nullptr;
#endif

class ScopedMemoryWipe final {
public:
    ScopedMemoryWipe(void* data, size_t size) noexcept : data_(data), size_(size) {}
    explicit ScopedMemoryWipe(std::string& value) noexcept
        : ScopedMemoryWipe(value.data(), value.size()) {}
    ~ScopedMemoryWipe() noexcept {
        sodium_memzero(data_, size_);
#ifdef NANIKA_TESTING
        if (wipe_observer) wipe_observer(data_, size_);
#endif
    }
    ScopedMemoryWipe(const ScopedMemoryWipe&) = delete;
    ScopedMemoryWipe& operator=(const ScopedMemoryWipe&) = delete;

private:
    void* data_;
    size_t size_;
};
}
