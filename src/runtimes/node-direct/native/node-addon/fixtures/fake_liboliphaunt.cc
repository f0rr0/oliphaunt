#include "oliphaunt.h"

#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <condition_variable>
#include <chrono>
#include <mutex>
#include <thread>

struct OliphauntHandle {
  bool logical_active = false;
  bool terminally_closed = false;
  uint64_t logical_generation = 0;
};

namespace {

std::mutex g_mutex;
std::mutex g_log_mutex;
std::condition_variable g_query_condition;
OliphauntHandle g_handle;
char g_last_error[256] = "";
bool g_failed_detach_once = false;
bool g_query_cancelled = false;

void SetError(const char *message) {
  std::snprintf(g_last_error, sizeof(g_last_error), "%s", message);
}

void RecordEvent(const char *event) {
  std::lock_guard<std::mutex> guard(g_log_mutex);
  const char *path = std::getenv("OLIPHAUNT_NODE_CLEANUP_TEST_LOG");
  if (path == nullptr || path[0] == '\0') {
    std::abort();
  }
  std::FILE *stream = std::fopen(path, "ab");
  if (stream == nullptr) {
    std::abort();
  }
  if (std::fprintf(stream, "%s\n", event) < 0 || std::fflush(stream) != 0 ||
      std::fclose(stream) != 0) {
    std::abort();
  }
}

int32_t OpenFake(OliphauntHandle **out) {
  if (out == nullptr) {
    SetError("fake init received a null output pointer");
    return -1;
  }
  *out = nullptr;
  const char *block_open = std::getenv("OLIPHAUNT_NODE_CLEANUP_TEST_BLOCK_OPEN");
  if (block_open != nullptr && std::strcmp(block_open, "1") == 0) {
    RecordEvent("open-started");
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    RecordEvent("open-finished");
  }
  std::lock_guard<std::mutex> guard(g_mutex);
  if (g_handle.terminally_closed) {
    RecordEvent("init-after-close");
    SetError("fake runtime was already terminally closed");
    return -1;
  }
  if (g_handle.logical_active) {
    RecordEvent("init-while-active");
    SetError("fake runtime already has an active logical handle");
    return -1;
  }
  ++g_handle.logical_generation;
  if (g_handle.logical_generation == 0) {
    RecordEvent("generation-overflow");
    SetError("fake logical generation overflowed");
    return -1;
  }
  g_handle.logical_active = true;
  RecordEvent("init");
  *out = &g_handle;
  return 0;
}

int32_t UnsupportedResponse(OliphauntResponse *out) {
  if (out != nullptr) {
    out->data = nullptr;
    out->len = 0;
  }
  SetError("fake cleanup fixture does not implement query operations");
  return -1;
}

bool BlockArchiveOperation() {
  const char *block = std::getenv("OLIPHAUNT_NODE_CLEANUP_TEST_BLOCK_ARCHIVE");
  return block != nullptr && std::strcmp(block, "1") == 0;
}

int32_t InvokeObservedStreamCallback(
    OliphauntStreamCallback callback,
    void *context,
    const uint8_t *bytes,
    size_t length) {
  if (callback == nullptr) {
    return 1;
  }
  const char *observe = std::getenv(
      "OLIPHAUNT_NODE_CLEANUP_TEST_OBSERVE_BLOCKED_STREAM_CALLBACK");
  if (observe == nullptr || std::strcmp(observe, "1") != 0) {
    return callback(context, bytes, length);
  }

  std::atomic<bool> callback_returned = false;
  std::thread observer([&callback_returned]() {
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
    if (!callback_returned.load(std::memory_order_acquire)) {
      RecordEvent("stream-callback-blocked");
    }
  });
  const int32_t result = callback(context, bytes, length);
  callback_returned.store(true, std::memory_order_release);
  observer.join();
  return result;
}

}  // namespace

extern "C" {

OLIPHAUNT_API int32_t oliphaunt_init(
    const OliphauntConfig *,
    OliphauntHandle **out) {
  return OpenFake(out);
}

OLIPHAUNT_API int32_t oliphaunt_exec_protocol(
    OliphauntHandle *,
    const uint8_t *,
    size_t,
    OliphauntResponse *out) {
  const char *block_query = std::getenv("OLIPHAUNT_NODE_CLEANUP_TEST_BLOCK_QUERY");
  if (block_query != nullptr && std::strcmp(block_query, "1") == 0) {
    if (out != nullptr) {
      out->data = nullptr;
      out->len = 0;
    }
    std::unique_lock<std::mutex> guard(g_mutex);
    RecordEvent("query-started");
    g_query_condition.wait(guard, [] { return g_query_cancelled; });
    RecordEvent("query-cancelled");
    SetError("fake query was cancelled");
    return -1;
  }
  return UnsupportedResponse(out);
}

OLIPHAUNT_API int32_t oliphaunt_exec_simple_query(
    OliphauntHandle *,
    const char *,
    size_t,
    OliphauntResponse *out) {
  return UnsupportedResponse(out);
}

OLIPHAUNT_API int32_t oliphaunt_exec_protocol_raw_stream(
    OliphauntHandle *,
    const uint8_t *,
    size_t,
    OliphauntStreamCallback callback,
    void *context) {
  const char *block_stream = std::getenv("OLIPHAUNT_NODE_CLEANUP_TEST_BLOCK_STREAM");
  if (block_stream != nullptr && std::strcmp(block_stream, "1") == 0) {
    RecordEvent("stream-started");
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    const char *abort_without_callback =
        std::getenv("OLIPHAUNT_NODE_CLEANUP_TEST_STREAM_ABORT_WITHOUT_CALLBACK");
    if (abort_without_callback != nullptr &&
        std::strcmp(abort_without_callback, "1") == 0) {
      RecordEvent("stream-abort-without-callback");
      SetError("fake stream reported callback abort without callback failure");
      return OLIPHAUNT_STREAM_CALLBACK_ABORTED;
    }
    const char *failure_without_callback =
        std::getenv("OLIPHAUNT_NODE_CLEANUP_TEST_STREAM_FAILURE_WITHOUT_CALLBACK");
    if (failure_without_callback != nullptr &&
        std::strcmp(failure_without_callback, "1") == 0) {
      RecordEvent("stream-failure-without-callback");
      SetError("fake stream failed before callback delivery");
      return -1;
    }
    const char *unknown_without_callback =
        std::getenv("OLIPHAUNT_NODE_CLEANUP_TEST_STREAM_UNKNOWN_WITHOUT_CALLBACK");
    if (unknown_without_callback != nullptr &&
        std::strcmp(unknown_without_callback, "1") == 0) {
      RecordEvent("stream-unknown-without-callback");
      SetError("fake stream returned an unknown status before callback delivery");
      return 2;
    }
    const uint8_t chunks[][2] = {{1, 2}, {3, 4}, {5, 6}};
    const char *single_chunk =
        std::getenv("OLIPHAUNT_NODE_CLEANUP_TEST_SINGLE_STREAM_CHUNK");
    const size_t chunk_count =
        single_chunk != nullptr && std::strcmp(single_chunk, "1") == 0
        ? 1
        : sizeof(chunks) / sizeof(chunks[0]);
    for (size_t index = 0; index < chunk_count; index++) {
      const auto &chunk = chunks[index];
      if (InvokeObservedStreamCallback(
              callback, context, chunk, sizeof(chunk)) != 0) {
        RecordEvent("stream-aborted");
        const char *success_after_callback_abort =
            std::getenv("OLIPHAUNT_NODE_CLEANUP_TEST_STREAM_SUCCESS_AFTER_CALLBACK_ABORT");
        if (success_after_callback_abort != nullptr &&
            std::strcmp(success_after_callback_abort, "1") == 0) {
          RecordEvent("stream-success-after-callback-abort");
          return 0;
        }
        const char *fail_recovery =
            std::getenv("OLIPHAUNT_NODE_CLEANUP_TEST_FAIL_STREAM_RECOVERY");
        if (fail_recovery != nullptr && std::strcmp(fail_recovery, "1") == 0) {
          RecordEvent("stream-recovery-failed");
          SetError("fake stream recovery failed after callback abort");
          return -1;
        }
        const char *unknown_status =
            std::getenv("OLIPHAUNT_NODE_CLEANUP_TEST_UNKNOWN_STREAM_STATUS");
        if (unknown_status != nullptr && std::strcmp(unknown_status, "1") == 0) {
          RecordEvent("stream-unknown-status");
          SetError("fake stream returned an unknown positive status");
          return 2;
        }
        SetError("fake stream callback aborted execution");
        return OLIPHAUNT_STREAM_CALLBACK_ABORTED;
      }
    }
    RecordEvent("stream-finished");
    return 0;
  }
  SetError("fake cleanup fixture does not implement protocol streaming");
  return -1;
}

OLIPHAUNT_API int32_t oliphaunt_backup(
    OliphauntHandle *,
    OliphauntResponse *out) {
  if (BlockArchiveOperation()) {
    RecordEvent("backup-started");
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    if (out == nullptr) {
      SetError("fake backup received a null response");
      return -1;
    }
    out->data = static_cast<uint8_t *>(std::malloc(3));
    if (out->data == nullptr) {
      SetError("fake backup allocation failed");
      return -1;
    }
    out->data[0] = 1;
    out->data[1] = 2;
    out->data[2] = 3;
    out->len = 3;
    RecordEvent("backup-finished");
    return 0;
  }
  return UnsupportedResponse(out);
}

OLIPHAUNT_API int32_t oliphaunt_restore(const OliphauntRestoreOptions *) {
  if (BlockArchiveOperation()) {
    RecordEvent("restore-started");
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    RecordEvent("restore-finished");
  }
  return 0;
}

OLIPHAUNT_API int32_t oliphaunt_cancel(OliphauntHandle *) {
  const char *block_query = std::getenv("OLIPHAUNT_NODE_CLEANUP_TEST_BLOCK_QUERY");
  if (block_query != nullptr && std::strcmp(block_query, "1") == 0) {
    std::lock_guard<std::mutex> guard(g_mutex);
    if (!g_query_cancelled) {
      RecordEvent("cancel");
      g_query_cancelled = true;
      g_query_condition.notify_all();
    } else {
      const char *record_repeat = std::getenv(
          "OLIPHAUNT_NODE_CLEANUP_TEST_RECORD_REPEAT_CANCEL");
      if (record_repeat != nullptr && std::strcmp(record_repeat, "1") == 0) {
        RecordEvent("cancel-repeat");
      }
    }
  }
  return 0;
}

OLIPHAUNT_API int32_t oliphaunt_detach(OliphauntHandle *handle) {
  std::lock_guard<std::mutex> guard(g_mutex);
  if (handle != &g_handle) {
    RecordEvent("detach-invalid-handle");
    SetError("fake detach received an invalid handle");
    return -1;
  }
  if (g_handle.terminally_closed) {
    RecordEvent("detach-after-close");
    SetError("fake detach ran after terminal close");
    return -1;
  }
  const char *fail_once = std::getenv("OLIPHAUNT_NODE_CLEANUP_TEST_FAIL_DETACH_ONCE");
  if (!g_failed_detach_once && fail_once != nullptr && std::strcmp(fail_once, "1") == 0) {
    g_failed_detach_once = true;
    RecordEvent("detach-failed");
    SetError("injected fake detach failure");
    return -1;
  }
  const char *block_detach = std::getenv("OLIPHAUNT_NODE_CLEANUP_TEST_BLOCK_DETACH");
  if (block_detach != nullptr && std::strcmp(block_detach, "1") == 0) {
    RecordEvent("detach-started");
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    RecordEvent("detach-finished");
  }
  RecordEvent("detach");
  g_handle.logical_active = false;
  return 0;
}

OLIPHAUNT_API int32_t oliphaunt_close(OliphauntHandle *handle) {
  std::lock_guard<std::mutex> guard(g_mutex);
  if (handle != &g_handle) {
    RecordEvent("close-invalid-handle");
    SetError("fake close received an invalid handle");
    return -1;
  }
  if (g_handle.terminally_closed) {
    RecordEvent("close-after-close");
    SetError("fake terminal close ran more than once");
    return -1;
  }
  RecordEvent("close-unguarded");
  g_handle.logical_active = false;
  g_handle.terminally_closed = true;
  return 0;
}

OLIPHAUNT_API uint64_t oliphaunt_logical_generation(OliphauntHandle *handle) {
  std::lock_guard<std::mutex> guard(g_mutex);
  if (handle != &g_handle) {
    SetError("fake logical generation received an invalid handle");
    return 0;
  }
  const char *simulate_close =
      std::getenv("OLIPHAUNT_NODE_CLEANUP_TEST_CLOSE_BEFORE_GENERATION");
  if (simulate_close != nullptr && std::strcmp(simulate_close, "1") == 0) {
    RecordEvent("close-before-generation");
    g_handle.logical_active = false;
    g_handle.terminally_closed = true;
    return 0;
  }
  return g_handle.logical_generation;
}

OLIPHAUNT_API int32_t oliphaunt_close_if_generation(uint64_t generation) {
  std::lock_guard<std::mutex> guard(g_mutex);
  if (generation == 0) {
    RecordEvent("close-guard-invalid");
    SetError("fake guarded close received an invalid argument");
    return -1;
  }
  if (g_handle.terminally_closed) {
    return 0;
  }
  if (generation != g_handle.logical_generation) {
    RecordEvent("close-stale");
    return 1;
  }
  RecordEvent("close");
  g_handle.logical_active = false;
  g_handle.terminally_closed = true;
  return 0;
}

OLIPHAUNT_API int32_t oliphaunt_register_static_extensions(
    const OliphauntStaticExtension *,
    size_t) {
  return 0;
}

OLIPHAUNT_API const char *oliphaunt_last_error(OliphauntHandle *) {
  return g_last_error;
}

OLIPHAUNT_API size_t oliphaunt_copy_last_error(
    OliphauntHandle *,
    char *out,
    size_t capacity) {
  std::lock_guard<std::mutex> guard(g_mutex);
  const size_t length = std::strlen(g_last_error);
  if (capacity != 0 && out != nullptr) {
    const size_t copied = length < capacity - 1 ? length : capacity - 1;
    std::memcpy(out, g_last_error, copied);
    out[copied] = '\0';
  }
  return length;
}

OLIPHAUNT_API const char *oliphaunt_version(void) {
  return "cleanup-fixture";
}

OLIPHAUNT_API void oliphaunt_free_response(OliphauntResponse *response) {
  if (response == nullptr) {
    return;
  }
  std::free(response->data);
  response->data = nullptr;
  response->len = 0;
}

}  // extern "C"
