#include "oliphaunt.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>

struct OliphauntHandle {
  bool logical_active = false;
  bool terminally_closed = false;
  uint64_t logical_generation = 0;
};

namespace {

std::mutex g_mutex;
OliphauntHandle g_handle;
char g_last_error[256] = "";

void SetError(const char *message) {
  std::snprintf(g_last_error, sizeof(g_last_error), "%s", message);
}

void RecordEvent(const char *event) {
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

}  // namespace

extern "C" {

OLIPHAUNT_API int32_t oliphaunt_init(
    const OliphauntConfig *,
    OliphauntHandle **out) {
  return OpenFake(out);
}

OLIPHAUNT_API int32_t oliphaunt_init_ex(
    const OliphauntConfig *,
    const OliphauntInitOptions *,
    OliphauntHandle **out) {
  return OpenFake(out);
}

OLIPHAUNT_API int32_t oliphaunt_exec_protocol(
    OliphauntHandle *,
    const uint8_t *,
    size_t,
    OliphauntResponse *out) {
  return UnsupportedResponse(out);
}

OLIPHAUNT_API int32_t oliphaunt_exec_simple_query(
    OliphauntHandle *,
    const char *,
    size_t,
    OliphauntResponse *out) {
  return UnsupportedResponse(out);
}

OLIPHAUNT_API int32_t oliphaunt_exec_protocol_stream(
    OliphauntHandle *,
    const uint8_t *,
    size_t,
    OliphauntStreamCallback,
    void *) {
  SetError("fake cleanup fixture does not implement protocol streaming");
  return -1;
}

OLIPHAUNT_API int32_t oliphaunt_backup(
    OliphauntHandle *,
    uint32_t,
    OliphauntResponse *out) {
  return UnsupportedResponse(out);
}

OLIPHAUNT_API int32_t oliphaunt_backup_ex(
    OliphauntHandle *,
    const OliphauntBackupOptions *,
    OliphauntResponse *out) {
  return UnsupportedResponse(out);
}

OLIPHAUNT_API int32_t oliphaunt_restore(const OliphauntRestoreOptions *) {
  return 0;
}

OLIPHAUNT_API int32_t oliphaunt_cancel(OliphauntHandle *) {
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

OLIPHAUNT_API const char *oliphaunt_version(void) {
  return "cleanup-fixture";
}

OLIPHAUNT_API uint64_t oliphaunt_capabilities(void) {
  return OLIPHAUNT_CAP_LOGICAL_REOPEN;
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
