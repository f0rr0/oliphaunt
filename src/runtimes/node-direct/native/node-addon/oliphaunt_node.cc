#include <node_api.h>
#include "oliphaunt.h"

#include <atomic>
#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#if defined(OLIPHAUNT_NODE_ADDON_LIFECYCLE_TESTING) && \
    OLIPHAUNT_NODE_ADDON_LIFECYCLE_TESTING
#include <cstdlib>
#include <cstring>
#endif
#include <exception>
#include <limits>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <dlfcn.h>
#endif

namespace {

using InitFn = int32_t (*)(const OliphauntConfig *, OliphauntHandle **);
using ExecProtocolFn = int32_t (*)(OliphauntHandle *, const uint8_t *, size_t, OliphauntResponse *);
using ExecSimpleQueryFn = int32_t (*)(OliphauntHandle *, const char *, size_t, OliphauntResponse *);
using ExecProtocolRawStreamFn = decltype(&oliphaunt_exec_protocol_raw_stream);
using BackupFn = decltype(&oliphaunt_backup);
using RestoreFn = int32_t (*)(const OliphauntRestoreOptions *);
using CancelFn = int32_t (*)(OliphauntHandle *);
using DetachFn = int32_t (*)(OliphauntHandle *);
using LogicalGenerationFn = uint64_t (*)(OliphauntHandle *);
using CloseIfGenerationFn = int32_t (*)(uint64_t);
using CopyLastErrorFn = size_t (*)(OliphauntHandle *, char *, size_t);
using VersionFn = const char *(*)();
using FreeResponseFn = void (*)(OliphauntResponse *);

struct DynamicLibrary {
#if defined(_WIN32)
  HMODULE handle = nullptr;
#else
  void *handle = nullptr;
#endif
};

struct NativeLibrary {
  DynamicLibrary library;
  InitFn init = nullptr;
  ExecProtocolFn exec_protocol = nullptr;
  ExecSimpleQueryFn exec_simple_query = nullptr;
  ExecProtocolRawStreamFn exec_protocol_raw_stream = nullptr;
  BackupFn backup = nullptr;
  RestoreFn restore = nullptr;
  CancelFn cancel = nullptr;
  DetachFn detach = nullptr;
  LogicalGenerationFn logical_generation = nullptr;
  CloseIfGenerationFn close_if_generation = nullptr;
  CopyLastErrorFn copy_last_error = nullptr;
  VersionFn version = nullptr;
  FreeResponseFn free_response = nullptr;
  // JavaScript close is intentionally a logical detach so a direct backend can
  // be reopened. Keep its process-resident handle until the owning Node
  // environment performs the one terminal close.
  std::mutex lifecycle_mutex;
  OliphauntHandle *resident_handle = nullptr;
  uint64_t resident_generation = 0;
  napi_env owner_env = nullptr;
  bool detach_pending = false;
  bool terminally_closed = false;
};

struct NativeHandleBox {
  std::shared_ptr<NativeLibrary> library;
  OliphauntHandle *handle = nullptr;
  uint64_t generation = 0;
  bool detached = false;
};

constexpr uint64_t kForgottenHandleRecoveryTokenMagic =
    UINT64_C(0x4f4c495048524543);

struct ForgottenHandleRecoveryToken {
  uint64_t magic = kForgottenHandleRecoveryTokenMagic;
  std::shared_ptr<NativeLibrary> library;
  uint64_t generation = 0;
};

std::mutex g_libraries_mutex;
std::map<std::string, std::shared_ptr<NativeLibrary>> g_libraries;

struct EnvironmentOperation;

struct AddonEnvironment {
  napi_env env = nullptr;
  std::mutex mutex;
  std::condition_variable condition;
  size_t pending_operations = 0;
  size_t pending_native_call_entries = 0;
#if defined(OLIPHAUNT_NODE_ADDON_LIFECYCLE_TESTING) && \
    OLIPHAUNT_NODE_ADDON_LIFECYCLE_TESTING
  size_t cleanup_cancel_attempts = 0;
#endif
  bool shutting_down = false;
  bool quiesce_hook_registered = false;
  napi_async_cleanup_hook_handle async_cleanup_handle = nullptr;
  // Created by the async cleanup hook itself, after ordinary environment
  // resources have quiesced. The reaper uses it solely to finish cleanup on
  // Node's event-loop thread.
  napi_threadsafe_function cleanup_completion = nullptr;
  bool cleanup_completion_call_returned = false;
};

struct EnvironmentOperation {
  AddonEnvironment *environment = nullptr;
  std::atomic<bool> registered = false;
  std::atomic<bool> started = false;
  // Guarded by AddonEnvironment::mutex. Once set, cleanup must not issue its
  // cancellation attempt until this worker has crossed the native-call entry
  // boundary or retired the operation.
  bool native_call_entry_pending = false;
};

struct ThreadsafeBridge {
  napi_threadsafe_function function = nullptr;
  std::mutex release_mutex;
  std::condition_variable release_condition;
  size_t active_calls = 0;
  bool acquisition_released = false;
  std::atomic<bool> aborted = false;
};

std::mutex g_environments_mutex;
std::map<napi_env, AddonEnvironment *> g_environments;
std::mutex g_threadsafe_bridges_mutex;
std::map<AddonEnvironment *, std::vector<std::weak_ptr<ThreadsafeBridge>>>
    g_threadsafe_bridges;

void Throw(napi_env env, const std::string &message);
void QuiesceEnvironment(void *data);
void CompleteEnvironmentCleanup(
    napi_env env,
    napi_value callback,
    void *context,
    void *data);

AddonEnvironment *LookupEnvironment(napi_env env) {
  std::lock_guard<std::mutex> guard(g_environments_mutex);
  auto entry = g_environments.find(env);
  return entry == g_environments.end() ? nullptr : entry->second;
}

bool RegisterEnvironmentOperation(
    napi_env env,
    EnvironmentOperation *operation) {
  AddonEnvironment *environment = LookupEnvironment(env);
  if (environment == nullptr) {
    Throw(env, "Oliphaunt native environment is unavailable");
    return false;
  }
  std::lock_guard<std::mutex> guard(environment->mutex);
  if (environment->shutting_down) {
    Throw(env, "Oliphaunt native environment is shutting down");
    return false;
  }
  environment->pending_operations++;
  operation->environment = environment;
  operation->registered.store(true);
  return true;
}

void FinishEnvironmentOperation(EnvironmentOperation *operation) {
  if (operation == nullptr || !operation->registered.exchange(false)) {
    return;
  }
  AddonEnvironment *environment = operation->environment;
  std::lock_guard<std::mutex> guard(environment->mutex);
  if (operation->native_call_entry_pending) {
    operation->native_call_entry_pending = false;
    if (environment->pending_native_call_entries > 0) {
      environment->pending_native_call_entries--;
    }
  }
  if (environment->pending_operations > 0) {
    environment->pending_operations--;
  }
  environment->condition.notify_all();
}

void StartEnvironmentOperation(EnvironmentOperation *operation) {
  operation->started.store(true);
}

bool EnvironmentIsShuttingDown(const EnvironmentOperation *operation) {
  AddonEnvironment *environment = operation->environment;
  if (environment == nullptr) {
    return true;
  }
  std::lock_guard<std::mutex> guard(environment->mutex);
  return environment->shutting_down;
}

bool AdmitEnvironmentNativeCall(EnvironmentOperation *operation) {
  AddonEnvironment *environment = operation->environment;
  if (environment == nullptr) {
    return false;
  }
  std::lock_guard<std::mutex> guard(environment->mutex);
  if (environment->shutting_down) {
    return false;
  }
  operation->native_call_entry_pending = true;
  environment->pending_native_call_entries++;
  environment->condition.notify_all();
  return true;
}

void MarkEnvironmentNativeCallEntered(EnvironmentOperation *operation) {
  AddonEnvironment *environment = operation->environment;
  if (environment == nullptr) {
    return;
  }
  std::lock_guard<std::mutex> guard(environment->mutex);
  if (!operation->native_call_entry_pending) {
    return;
  }
  operation->native_call_entry_pending = false;
  if (environment->pending_native_call_entries > 0) {
    environment->pending_native_call_entries--;
  }
  environment->condition.notify_all();
}

#if defined(OLIPHAUNT_NODE_ADDON_LIFECYCLE_TESTING) && \
    OLIPHAUNT_NODE_ADDON_LIFECYCLE_TESTING
void PauseNativeCallEntryForCleanupTest(
    EnvironmentOperation *operation) {
  const char *pause =
      std::getenv("OLIPHAUNT_NODE_CLEANUP_TEST_PAUSE_NATIVE_CALL_ENTRY");
  if (pause == nullptr || std::strcmp(pause, "1") != 0) {
    return;
  }
  AddonEnvironment *environment = operation->environment;
  std::unique_lock<std::mutex> lock(environment->mutex);
  environment->condition.notify_all();
  environment->condition.wait(
      lock,
      [environment]() { return environment->shutting_down; });
}

void WaitForNativeCallEntryPauseForCleanupTest(
    EnvironmentOperation *operation) {
  const char *pause =
      std::getenv("OLIPHAUNT_NODE_CLEANUP_TEST_PAUSE_NATIVE_CALL_ENTRY");
  if (pause == nullptr || std::strcmp(pause, "1") != 0) {
    return;
  }
  AddonEnvironment *environment = operation->environment;
  std::unique_lock<std::mutex> lock(environment->mutex);
  environment->condition.wait(
      lock,
      [operation]() {
        return operation->native_call_entry_pending ||
            !operation->registered.load();
      });
}

void WaitForFirstCleanupCancelForTest(
    EnvironmentOperation *operation) {
  const char *pause =
      std::getenv("OLIPHAUNT_NODE_CLEANUP_TEST_PAUSE_NATIVE_CALL_ENTRY");
  if (pause == nullptr || std::strcmp(pause, "1") != 0) {
    return;
  }
  AddonEnvironment *environment = operation->environment;
  std::unique_lock<std::mutex> lock(environment->mutex);
  environment->condition.wait(
      lock,
      [environment, operation]() {
        return environment->cleanup_cancel_attempts > 0 ||
            !operation->registered.load();
      });
}
#endif

class EnvironmentOperationFinish {
 public:
  explicit EnvironmentOperationFinish(EnvironmentOperation *operation)
      : operation_(operation) {}
  ~EnvironmentOperationFinish() { FinishEnvironmentOperation(operation_); }

 private:
  EnvironmentOperation *operation_;
};

void RegisterThreadsafeBridge(
    AddonEnvironment *environment,
    const std::shared_ptr<ThreadsafeBridge> &bridge) {
  std::lock_guard<std::mutex> guard(g_threadsafe_bridges_mutex);
  auto &bridges = g_threadsafe_bridges[environment];
  bridges.erase(
      std::remove_if(
          bridges.begin(), bridges.end(),
          [](const auto &candidate) { return candidate.expired(); }),
      bridges.end());
  bridges.emplace_back(bridge);
}

void ReleaseThreadsafeAcquisition(
    const std::shared_ptr<ThreadsafeBridge> &bridge,
    napi_threadsafe_function_release_mode mode) {
  if (bridge == nullptr) {
    return;
  }
  std::unique_lock<std::mutex> lock(bridge->release_mutex);
  if (mode == napi_tsfn_abort) {
    bridge->aborted.store(true);
    bridge->release_condition.notify_all();
  }
  if (!bridge->acquisition_released && bridge->function != nullptr) {
    bridge->acquisition_released = true;
    // Keep bridge ownership serialized until Node-API has consumed the
    // acquisition. Otherwise environment cleanup could observe the flag,
    // destroy the Node 22 TSFN, and race this still-pending release call.
    (void)napi_release_threadsafe_function(bridge->function, mode);
  }
  if (mode == napi_tsfn_abort) {
    // Node 22 destroys TSFNs from its environment cleanup hook even when a
    // producer thread is still alive. Keep our earlier quiesce hook on the
    // event-loop stack until every producer has returned from Node-API, and
    // make shutdown the bridge's sole acquisition release. The worker observes
    // `aborted` and never touches the TSFN afterward.
    bridge->release_condition.wait(
        lock,
        [bridge]() { return bridge->active_calls == 0; });
  }
}

napi_status CallThreadsafeBridge(
    const std::shared_ptr<ThreadsafeBridge> &bridge,
    void *data,
    napi_threadsafe_function_call_mode mode) {
  if (bridge == nullptr) {
    return napi_closing;
  }
  napi_threadsafe_function function = nullptr;
  {
    std::lock_guard<std::mutex> guard(bridge->release_mutex);
    if (bridge->aborted.load() || bridge->function == nullptr) {
      return napi_closing;
    }
    bridge->active_calls++;
    function = bridge->function;
  }
  const napi_status status =
      napi_call_threadsafe_function(function, data, mode);
  {
    std::lock_guard<std::mutex> guard(bridge->release_mutex);
    if (status == napi_closing) {
      // Node-API consumes one thread acquisition when Push observes a closing
      // TSFN. Record that ownership transfer so the producer cannot release an
      // already-destroyed Node 22 bridge later in environment teardown.
      bridge->acquisition_released = true;
      bridge->aborted.store(true);
    }
    if (bridge->active_calls > 0) {
      bridge->active_calls--;
    }
    if (bridge->active_calls == 0) {
      bridge->release_condition.notify_all();
    }
  }
  return status;
}

using BackgroundOperation = void (*)(void *);
using BackgroundContextRelease = void (*)(void *);

template <typename Context>
void ReleaseBackgroundContext(void *data) {
  auto *context = static_cast<Context *>(data);
  if (context->lifetime_references.fetch_sub(1) == 1) {
    delete context;
  }
}

bool StartBackgroundOperation(
    napi_env env,
    EnvironmentOperation *operation,
    const std::shared_ptr<ThreadsafeBridge> &bridge,
    BackgroundOperation execute,
    BackgroundContextRelease release_context,
  void *data) {
  try {
    std::thread([operation, bridge, execute, release_context, data]() {
#if defined(OLIPHAUNT_NODE_ADDON_LIFECYCLE_TESTING) && \
    OLIPHAUNT_NODE_ADDON_LIFECYCLE_TESTING
      // The cleanup fixture holds this narrow internal seam long enough to
      // deterministically terminate an environment after registration but
      // before Execute begins. It is not a public scheduling option.
      const char *delay_start =
          std::getenv("OLIPHAUNT_NODE_CLEANUP_TEST_DELAY_OPERATION_START");
      if (delay_start != nullptr && std::strcmp(delay_start, "1") == 0) {
        std::this_thread::sleep_for(std::chrono::seconds(1));
      }
#endif
      StartEnvironmentOperation(operation);
      {
        EnvironmentOperationFinish finish(operation);
        execute(data);
      }
      // Releasing the TSFN acquisition schedules its finalizer on the Node
      // thread. Environment teardown may already have retired that
      // acquisition; this helper retires it exactly once and no environment
      // state is touched after the operation lease is retired above.
      ReleaseThreadsafeAcquisition(bridge, napi_tsfn_release);
      release_context(data);
    }).detach();
    return true;
  } catch (const std::exception &error) {
    Throw(env, std::string("start native background operation: ") + error.what());
  } catch (...) {
    Throw(env, "start native background operation failed");
  }
  return false;
}

void AbortBackgroundOperationSetup(
    EnvironmentOperation *operation,
    const std::shared_ptr<ThreadsafeBridge> &bridge) {
  FinishEnvironmentOperation(operation);
  ReleaseThreadsafeAcquisition(bridge, napi_tsfn_abort);
}

bool CanDeliverBackgroundCompletion(
    napi_env env,
    const EnvironmentOperation &operation,
    const std::shared_ptr<ThreadsafeBridge> &bridge) {
  return env != nullptr && operation.started.load() && bridge != nullptr &&
      !bridge->aborted.load();
}

void IgnoreBackgroundCompletion(napi_env, napi_value, void *, void *) {}

void Throw(napi_env env, const std::string &message) { napi_throw_error(env, nullptr, message.c_str()); }

#if defined(_WIN32)
bool Utf8ToWidePath(
    const std::string &path,
    std::wstring *wide_path,
    std::string *error) {
  if (path.size() > static_cast<size_t>(std::numeric_limits<int>::max())) {
    *error = "liboliphaunt path is too long to load on Windows";
    return false;
  }

  const int source_length = static_cast<int>(path.size());
  const int required_length =
      MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path.data(), source_length, nullptr, 0);
  if (required_length <= 0) {
    *error = "liboliphaunt path is not valid UTF-8";
    return false;
  }

  wide_path->resize(static_cast<size_t>(required_length));
  const int converted_length = MultiByteToWideChar(
      CP_UTF8, MB_ERR_INVALID_CHARS, path.data(), source_length, wide_path->data(), required_length);
  if (converted_length != required_length) {
    wide_path->clear();
    *error = "liboliphaunt path could not be converted for the Windows loader";
    return false;
  }
  return true;
}
#endif

bool Check(napi_env env, napi_status status, const char *message) {
  if (status == napi_ok) {
    return true;
  }
  Throw(env, message);
  return false;
}

bool RefreshEnvironmentQuiesceHook(
    napi_env env,
    AddonEnvironment *environment) {
  if (environment->quiesce_hook_registered) {
    if (!Check(
            env,
            napi_remove_env_cleanup_hook(
                env, QuiesceEnvironment, environment),
            "refresh native environment quiesce hook")) {
      return false;
    }
    environment->quiesce_hook_registered = false;
  }
  if (!Check(
          env,
          napi_add_env_cleanup_hook(env, QuiesceEnvironment, environment),
          "register native environment quiesce hook")) {
    return false;
  }
  environment->quiesce_hook_registered = true;
  return true;
}

bool ExceptionPending(napi_env env) {
  bool pending = false;
  return napi_is_exception_pending(env, &pending) == napi_ok && pending;
}

std::string LastError(NativeLibrary *library, OliphauntHandle *handle) {
  if (library == nullptr || library->copy_last_error == nullptr) {
    return "unknown error";
  }
  std::vector<char> message(1024, '\0');
  for (;;) {
    const size_t length =
        library->copy_last_error(handle, message.data(), message.size());
    if (length == 0 || message[0] == '\0') {
      return "unknown error";
    }
    if (length < message.size()) {
      return std::string(message.data(), length);
    }
    if (length == std::numeric_limits<size_t>::max()) {
      return "native liboliphaunt returned an invalid error length";
    }
    message.assign(length + 1, '\0');
  }
}

void *LoadSymbol(DynamicLibrary library, const char *name, std::string *error) {
#if defined(_WIN32)
  void *symbol = reinterpret_cast<void *>(GetProcAddress(library.handle, name));
#else
  void *symbol = dlsym(library.handle, name);
#endif
  if (symbol == nullptr) {
    if (error->empty()) {
      *error = std::string("liboliphaunt is missing required symbol ") + name;
    }
  }
  return symbol;
}

bool SameLoadedImage(DynamicLibrary left, DynamicLibrary right) {
  return left.handle != nullptr && left.handle == right.handle;
}

void ReleaseDynamicLibraryReference(DynamicLibrary library) {
  if (library.handle == nullptr) {
    return;
  }
#if defined(_WIN32)
  (void)FreeLibrary(library.handle);
#else
  (void)dlclose(library.handle);
#endif
}

std::shared_ptr<NativeLibrary> LoadNativeLibrary(
    const std::string &path,
    std::string *error) {
  if (path.empty()) {
    *error = "liboliphaunt path must not be empty";
    return nullptr;
  }
  if (path.find('\0') != std::string::npos) {
    *error = "liboliphaunt path must not contain a null byte";
    return nullptr;
  }

  std::lock_guard<std::mutex> guard(g_libraries_mutex);
  auto existing = g_libraries.find(path);
  if (existing != g_libraries.end()) {
    return existing->second;
  }

  DynamicLibrary dynamic;
#if defined(_WIN32)
  std::wstring wide_path;
  if (!Utf8ToWidePath(path, &wide_path, error)) {
    return nullptr;
  }
  dynamic.handle = LoadLibraryW(wide_path.c_str());
#else
  // liboliphaunt embeds PostgreSQL. PostgreSQL loads extension DSOs after the
  // engine starts, and those DSOs resolve backend globals from liboliphaunt.
  // Keep the engine's symbols in the process-global lookup scope just as the
  // Rust native loader does; RTLD_LOCAL makes contrib modules such as amcheck
  // fail with unresolved PostgreSQL symbols.
  dynamic.handle = dlopen(path.c_str(), RTLD_NOW | RTLD_GLOBAL);
#endif
  if (dynamic.handle == nullptr) {
#if defined(_WIN32)
    *error = "load liboliphaunt failed";
#else
    const char *message = dlerror();
    *error =
        std::string("load liboliphaunt failed: ") + (message == nullptr ? path : message);
#endif
    return nullptr;
  }

  // Equivalent path aliases can return the same loader image. They must share
  // one lifecycle record or environment cleanup could terminally close the
  // same resident OliphauntHandle more than once.
  for (const auto &entry : g_libraries) {
    if (SameLoadedImage(entry.second->library, dynamic)) {
      ReleaseDynamicLibraryReference(dynamic);
      g_libraries[path] = entry.second;
      return entry.second;
    }
  }

  auto library = std::make_shared<NativeLibrary>();
  library->library = dynamic;
  library->init = reinterpret_cast<InitFn>(LoadSymbol(dynamic, "oliphaunt_init", error));
  library->exec_protocol =
      reinterpret_cast<ExecProtocolFn>(LoadSymbol(dynamic, "oliphaunt_exec_protocol", error));
  library->exec_simple_query =
      reinterpret_cast<ExecSimpleQueryFn>(
          LoadSymbol(dynamic, "oliphaunt_exec_simple_query", error));
  library->exec_protocol_raw_stream = reinterpret_cast<ExecProtocolRawStreamFn>(
      LoadSymbol(dynamic, "oliphaunt_exec_protocol_raw_stream", error));
  library->backup =
      reinterpret_cast<BackupFn>(LoadSymbol(dynamic, "oliphaunt_backup", error));
  library->restore =
      reinterpret_cast<RestoreFn>(LoadSymbol(dynamic, "oliphaunt_restore", error));
  library->cancel =
      reinterpret_cast<CancelFn>(LoadSymbol(dynamic, "oliphaunt_cancel", error));
  library->detach =
      reinterpret_cast<DetachFn>(LoadSymbol(dynamic, "oliphaunt_detach", error));
  library->logical_generation = reinterpret_cast<LogicalGenerationFn>(
      LoadSymbol(dynamic, "oliphaunt_logical_generation", error));
  library->close_if_generation = reinterpret_cast<CloseIfGenerationFn>(
      LoadSymbol(dynamic, "oliphaunt_close_if_generation", error));
  library->copy_last_error = reinterpret_cast<CopyLastErrorFn>(
      LoadSymbol(dynamic, "oliphaunt_copy_last_error", error));
  library->version =
      reinterpret_cast<VersionFn>(LoadSymbol(dynamic, "oliphaunt_version", error));
  library->free_response =
      reinterpret_cast<FreeResponseFn>(LoadSymbol(dynamic, "oliphaunt_free_response", error));

  if (!error->empty()) {
    ReleaseDynamicLibraryReference(dynamic);
    return nullptr;
  }
  g_libraries[path] = library;
  return library;
}

std::vector<std::shared_ptr<NativeLibrary>> SnapshotLibraries() {
  std::vector<std::shared_ptr<NativeLibrary>> libraries;
  {
    std::lock_guard<std::mutex> guard(g_libraries_mutex);
    libraries.reserve(g_libraries.size());
    for (const auto &entry : g_libraries) {
      libraries.push_back(entry.second);
    }
  }
  // Equivalent loader paths intentionally share one NativeLibrary record.
  // Collapse those aliases before lifecycle work so cancellation is invoked
  // exactly once for the resident backend rather than once per spelling.
  std::sort(libraries.begin(), libraries.end());
  libraries.erase(
      std::unique(libraries.begin(), libraries.end()), libraries.end());
  return libraries;
}

void CancelEnvironmentWork(AddonEnvironment *environment) {
  for (const auto &library : SnapshotLibraries()) {
    std::lock_guard<std::mutex> guard(library->lifecycle_mutex);
    if (library->owner_env == environment->env &&
        library->resident_handle != nullptr && !library->terminally_closed &&
        library->cancel != nullptr) {
      /* Cancellation is the supported cross-thread operation. It wakes a
       * query before the reaper waits for its background call to release the raw
       * handle, and is harmless when the operation already completed. */
      (void)library->cancel(library->resident_handle);
    }
  }
}

void CancelAndDrainEnvironmentWork(AddonEnvironment *environment) {
  {
    std::unique_lock<std::mutex> lock(environment->mutex);
    environment->condition.wait(
        lock,
        [environment]() {
          return environment->pending_native_call_entries == 0;
        });
    if (environment->pending_operations == 0) {
      return;
    }
  }

  // Cancellation can be consumed while PostgreSQL is still between commands,
  // immediately before an admitted worker enters its blocking native call.
  // Retry outside the environment lock until every admitted operation retires.
  // A standalone restore has no resident owner to cancel; the timed waits still
  // let it drain normally without spinning.
  while (true) {
    CancelEnvironmentWork(environment);
#if defined(OLIPHAUNT_NODE_ADDON_LIFECYCLE_TESTING) && \
    OLIPHAUNT_NODE_ADDON_LIFECYCLE_TESTING
    {
      std::lock_guard<std::mutex> guard(environment->mutex);
      environment->cleanup_cancel_attempts++;
      environment->condition.notify_all();
    }
#endif
    std::unique_lock<std::mutex> lock(environment->mutex);
    if (environment->condition.wait_for(
            lock,
            std::chrono::milliseconds(10),
            [environment]() {
              return environment->pending_operations == 0;
            })) {
      return;
    }
  }
}

void CloseEnvironmentLibraries(AddonEnvironment *environment) {
  for (const auto &library : SnapshotLibraries()) {
    std::lock_guard<std::mutex> guard(library->lifecycle_mutex);
    if (library->owner_env != environment->env || library->resident_handle == nullptr ||
        library->terminally_closed) {
      continue;
    }

    const uint64_t generation = library->resident_generation;
    // Node runs environment cleanup hooks before external finalizers. Publish
    // the local terminal state first so a later NativeHandleBox finalizer
    // cannot detach the generation being closed. A copied addon image has an
    // independent lifecycle map, so liboliphaunt must decide atomically whether
    // this image still owns the process-resident generation.
    library->terminally_closed = true;
    library->resident_handle = nullptr;
    library->resident_generation = 0;
    library->owner_env = nullptr;
    library->detach_pending = false;
    int32_t close_result = -1;
    if (library->close_if_generation != nullptr) {
      close_result = library->close_if_generation(generation);
    }
    if (close_result > 0) {
      // This cleanup record was stale. The current generation belongs to
      // another addon image/environment, so this image may be reused later.
      // Its old finalizers remain harmless because their generation no longer
      // matches any resident lifecycle recorded here.
      library->terminally_closed = false;
    }
  }
}

void BeginEnvironmentShutdown(AddonEnvironment *environment) {
  std::vector<std::shared_ptr<ThreadsafeBridge>> bridges;
  {
    std::lock_guard<std::mutex> guard(environment->mutex);
    environment->shutting_down = true;
    environment->quiesce_hook_registered = false;
    environment->condition.notify_all();
  }
  {
    std::lock_guard<std::mutex> guard(g_environments_mutex);
    auto entry = g_environments.find(environment->env);
    if (entry != g_environments.end() && entry->second == environment) {
      g_environments.erase(entry);
    }
  }
  {
    std::lock_guard<std::mutex> guard(g_threadsafe_bridges_mutex);
    auto entry = g_threadsafe_bridges.find(environment);
    if (entry != g_threadsafe_bridges.end()) {
      bridges.reserve(entry->second.size());
      for (const auto &candidate : entry->second) {
        if (auto bridge = candidate.lock()) {
          bridges.push_back(std::move(bridge));
        }
      }
      g_threadsafe_bridges.erase(entry);
    }
  }
  for (const auto &bridge : bridges) {
    /* A blocking TSFN producer cannot depend on an event loop that is already
     * tearing down. Aborting the bridge's sole acquisition wakes it and makes
     * shutdown, rather than the producer, own the final Node-API operation. */
    ReleaseThreadsafeAcquisition(bridge, napi_tsfn_abort);
  }
}

void QuiesceEnvironment(void *data) {
  auto *environment = static_cast<AddonEnvironment *>(data);
  if (environment == nullptr) {
    return;
  }
  BeginEnvironmentShutdown(environment);
  /* This synchronous hook only closes JS delivery bridges. Potentially
   * blocking cancellation and terminal close are owned by the asynchronous
   * reaper below, never by Node's environment teardown thread. */
}

void CleanupEnvironment(
    napi_async_cleanup_hook_handle cleanup_handle,
    void *data) {
  auto *environment = static_cast<AddonEnvironment *>(data);
  if (environment == nullptr) {
    (void)napi_remove_async_cleanup_hook(cleanup_handle);
    return;
  }

  BeginEnvironmentShutdown(environment);

  napi_handle_scope cleanup_scope = nullptr;
  napi_value cleanup_resource_name = nullptr;
  if (napi_open_handle_scope(environment->env, &cleanup_scope) != napi_ok ||
      napi_create_string_utf8(
          environment->env,
          "oliphaunt:environment-cleanup",
          NAPI_AUTO_LENGTH,
          &cleanup_resource_name) != napi_ok ||
      napi_create_threadsafe_function(
          environment->env,
          nullptr,
          nullptr,
          cleanup_resource_name,
          1,
          1,
          nullptr,
          nullptr,
          environment,
          CompleteEnvironmentCleanup,
          &environment->cleanup_completion) != napi_ok) {
    napi_fatal_error(
        "oliphaunt", NAPI_AUTO_LENGTH,
        "could not create asynchronous environment cleanup completion",
        NAPI_AUTO_LENGTH);
    return;
  }
  (void)napi_close_handle_scope(environment->env, cleanup_scope);

  try {
    std::thread([environment, cleanup_handle]() {
      CancelAndDrainEnvironmentWork(environment);
      CloseEnvironmentLibraries(environment);
      // napi_remove_async_cleanup_hook mutates Node environment state and must
      // run on its event-loop thread. Calling this freshly-created TSFN is the
      // only Node-API operation the background reaper performs.
      napi_threadsafe_function completion = environment->cleanup_completion;
      const napi_status status = napi_call_threadsafe_function(
          completion, cleanup_handle, napi_tsfn_nonblocking);
      {
        std::lock_guard<std::mutex> guard(environment->mutex);
        environment->cleanup_completion_call_returned = true;
        environment->condition.notify_all();
      }
      if (status != napi_ok) {
        // The async hook owns this referenced TSFN until the callback below, so
        // failure indicates an internal lifecycle violation. Removing the hook
        // from this reaper thread would race Node environment state, while
        // leaving it pending deadlocks teardown. Fail closed instead of silently
        // hanging worker.terminate() or process shutdown forever.
        napi_fatal_error(
            "oliphaunt", NAPI_AUTO_LENGTH,
            "could not queue asynchronous environment cleanup completion",
            NAPI_AUTO_LENGTH);
      }
    }).detach();
  } catch (...) {
    // There is no recoverable completion path once an async cleanup hook owns
    // the environment barrier. Never let a C++ thread-construction exception
    // escape across the Node-API callback boundary.
    napi_fatal_error(
        "oliphaunt", NAPI_AUTO_LENGTH,
        "could not start asynchronous environment cleanup reaper",
        NAPI_AUTO_LENGTH);
  }
}

void CompleteEnvironmentCleanup(
    napi_env,
    napi_value,
    void *context,
    void *data) {
  auto *environment = static_cast<AddonEnvironment *>(context);
  auto cleanup_handle =
      static_cast<napi_async_cleanup_hook_handle>(data);
  if (environment == nullptr || cleanup_handle == nullptr) {
    return;
  }
  {
    // A TSFN callback may overtake the producing thread immediately after its
    // queue insertion. Wait until the producer has returned from the Node-API
    // call before releasing the TSFN or deleting its context.
    std::unique_lock<std::mutex> lock(environment->mutex);
    environment->condition.wait(
        lock,
        [environment]() {
          return environment->cleanup_completion_call_returned;
        });
  }
  // This callback is dispatched by the environment's TSFN and therefore runs
  // on the owning event-loop thread, including when Node is tearing a Worker
  // down. Release the TSFN's producer reference before removing the hook: hook
  // removal lets teardown close TSFN resources immediately, so a later reaper-
  // thread release would race their destruction.
  (void)napi_release_threadsafe_function(
      environment->cleanup_completion, napi_tsfn_release);
  (void)napi_remove_async_cleanup_hook(cleanup_handle);
  delete environment;
}

bool HasNamedProperty(napi_env env, napi_value object, const char *name) {
  bool has_property = false;
  return napi_has_named_property(env, object, name, &has_property) == napi_ok && has_property;
}

napi_value GetNamed(napi_env env, napi_value object, const char *name) {
  napi_value value = nullptr;
  if (!Check(env, napi_get_named_property(env, object, name, &value), "read object property")) {
    return nullptr;
  }
  return value;
}

std::string ValueToString(napi_env env, napi_value value, const char *label) {
  size_t length = 0;
  if (!Check(env, napi_get_value_string_utf8(env, value, nullptr, 0, &length), label)) {
    return {};
  }
  std::vector<char> buffer(length + 1);
  if (!Check(env, napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(), &length),
             label)) {
    return {};
  }
  return std::string(buffer.data(), length);
}

std::string GetString(napi_env env, napi_value object, const char *name, bool required = true) {
  if (!HasNamedProperty(env, object, name)) {
    if (required) {
      Throw(env, std::string("missing required string property ") + name);
    }
    return {};
  }
  napi_value value = GetNamed(env, object, name);
  napi_valuetype type = napi_undefined;
  napi_typeof(env, value, &type);
  if (type == napi_null || type == napi_undefined) {
    return {};
  }
  std::string out = ValueToString(env, value, "read string value");
  if (required && out.empty()) {
    Throw(env, std::string("string property must not be empty: ") + name);
  }
  return out;
}

std::vector<std::string> GetStringArray(napi_env env, napi_value object, const char *name) {
  std::vector<std::string> out;
  if (!HasNamedProperty(env, object, name)) {
    return out;
  }
  napi_value value = GetNamed(env, object, name);
  bool is_array = false;
  if (!Check(env, napi_is_array(env, value, &is_array), "check string array")) {
    return out;
  }
  if (!is_array) {
    Throw(env, std::string("property must be a string array: ") + name);
    return out;
  }
  uint32_t length = 0;
  Check(env, napi_get_array_length(env, value, &length), "read string array length");
  out.reserve(length);
  for (uint32_t index = 0; index < length; ++index) {
    napi_value item = nullptr;
    Check(env, napi_get_element(env, value, index, &item), "read string array item");
    out.push_back(ValueToString(env, item, "read string item"));
  }
  return out;
}

std::vector<uint8_t> GetBytes(napi_env env, napi_value value) {
  bool is_typed_array = false;
  Check(env, napi_is_typedarray(env, value, &is_typed_array), "check typed array");
  if (!is_typed_array) {
    Throw(env, "expected Uint8Array");
    return {};
  }
  napi_typedarray_type type;
  size_t length = 0;
  void *data = nullptr;
  napi_value array_buffer = nullptr;
  size_t byte_offset = 0;
  Check(env,
        napi_get_typedarray_info(env, value, &type, &length, &data, &array_buffer, &byte_offset),
        "read typed array");
  if (type != napi_uint8_array) {
    Throw(env, "expected Uint8Array");
    return {};
  }
  const auto *bytes = static_cast<const uint8_t *>(data);
  return std::vector<uint8_t>(bytes, bytes + length);
}

napi_value MakeBytes(napi_env env, const uint8_t *data, size_t length) {
  void *out = nullptr;
  napi_value buffer = nullptr;
  if (!Check(env, napi_create_buffer_copy(env, length, data, &out, &buffer), "create response buffer")) {
    return nullptr;
  }
  return buffer;
}

napi_value MakeResponse(napi_env env, NativeLibrary *library, OliphauntResponse *response) {
  napi_value value = MakeBytes(env, response->data, response->len);
  library->free_response(response);
  response->data = nullptr;
  response->len = 0;
  return value;
}

napi_value MakeError(napi_env env, const std::string &message) {
  napi_value text = nullptr;
  napi_value error = nullptr;
  if (napi_create_string_utf8(env, message.c_str(), message.size(), &text) != napi_ok ||
      napi_create_error(env, nullptr, text, &error) != napi_ok) {
    return nullptr;
  }
  return error;
}

bool RejectPendingException(napi_env env, napi_deferred deferred) {
  if (!ExceptionPending(env)) {
    return false;
  }
  napi_value exception = nullptr;
  return napi_get_and_clear_last_exception(env, &exception) == napi_ok &&
      exception != nullptr &&
      napi_reject_deferred(env, deferred, exception) == napi_ok;
}

void RejectDeferred(napi_env env, napi_deferred deferred, const std::string &message) {
  napi_value error = MakeError(env, message);
  if (error != nullptr) {
    (void)napi_reject_deferred(env, deferred, error);
    return;
  }
  if (!RejectPendingException(env, deferred)) {
    Throw(env, message);
  }
}

void RejectResponseCreation(napi_env env, napi_deferred deferred) {
  if (!RejectPendingException(env, deferred)) {
    RejectDeferred(env, deferred, "native liboliphaunt could not create the JavaScript response");
  }
}

NativeHandleBox *GetHandleBox(napi_env env, napi_value value) {
  void *data = nullptr;
  if (!Check(env, napi_get_value_external(env, value, &data), "read native handle")) {
    return nullptr;
  }
  auto *box = static_cast<NativeHandleBox *>(data);
  if (box == nullptr || box->handle == nullptr || box->detached) {
    Throw(env, "Oliphaunt native handle is closed");
    return nullptr;
  }
  return box;
}

void FinalizeHandle(napi_env, void *data, void *) {
  auto *box = static_cast<NativeHandleBox *>(data);
  if (box != nullptr) {
    if (box->library != nullptr) {
      std::lock_guard<std::mutex> guard(box->library->lifecycle_mutex);
      if (!box->library->terminally_closed && !box->detached && box->handle != nullptr &&
          box->library->resident_handle == box->handle &&
          box->library->resident_generation == box->generation) {
        // A finalizer must never run DISCARD ALL or ROLLBACK on the JavaScript
        // thread. Preserve the resident owner for the next async open to
        // detach, or for environment cleanup to close terminally.
        box->library->detach_pending = true;
      }
    }
    delete box;
  }
}

void FinalizeForgottenHandleRecoveryToken(napi_env, void *data, void *) {
  delete static_cast<ForgottenHandleRecoveryToken *>(data);
}

std::vector<napi_value> Args(napi_env env, napi_callback_info info, size_t expected) {
  size_t argc = expected;
  std::vector<napi_value> args(expected);
  napi_value this_arg = nullptr;
  if (!Check(env, napi_get_cb_info(env, info, &argc, args.data(), &this_arg, nullptr), "read arguments")) {
    return {};
  }
  if (argc < expected) {
    Throw(env, "missing required argument");
  }
  return args;
}

napi_value CreateForgottenHandleRecoveryToken(
    napi_env env,
    napi_callback_info info) {
  auto args = Args(env, info, 1);
  if (args.empty()) return nullptr;
  NativeHandleBox *box = GetHandleBox(env, args[0]);
  if (box == nullptr) return nullptr;

  auto token = std::make_unique<ForgottenHandleRecoveryToken>();
  token->library = box->library;
  token->generation = box->generation;
  napi_value external = nullptr;
  if (!Check(
          env,
          napi_create_external(
              env,
              token.get(),
              FinalizeForgottenHandleRecoveryToken,
              nullptr,
              &external),
          "create forgotten-handle recovery token")) {
    return nullptr;
  }
  (void)token.release();
  return external;
}

napi_value QueueForgottenHandleRecovery(napi_env env, napi_callback_info info) {
  auto args = Args(env, info, 1);
  if (args.empty()) return nullptr;
  void *data = nullptr;
  if (!Check(
          env,
          napi_get_value_external(env, args[0], &data),
          "read forgotten-handle recovery token")) {
    return nullptr;
  }
  auto *token = static_cast<ForgottenHandleRecoveryToken *>(data);
  if (token == nullptr || token->magic != kForgottenHandleRecoveryTokenMagic ||
      token->library == nullptr || token->generation == 0) {
    Throw(env, "Oliphaunt forgotten-handle recovery token is invalid");
    return nullptr;
  }

  bool queued = false;
  {
    std::lock_guard<std::mutex> guard(token->library->lifecycle_mutex);
    if (!token->library->terminally_closed &&
        token->library->resident_handle != nullptr &&
        token->library->resident_generation == token->generation) {
      // This only records native work for the next asynchronous open. It does
      // not run PostgreSQL teardown on the JavaScript finalizer thread.
      token->library->detach_pending = true;
      queued = true;
    }
  }

  napi_value result = nullptr;
  if (!Check(env, napi_get_boolean(env, queued, &result),
             "create forgotten-handle recovery result")) {
    return nullptr;
  }
  return result;
}

napi_value Version(napi_env env, napi_callback_info info) {
  auto args = Args(env, info, 1);
  if (args.empty()) return nullptr;
  std::string library_path = ValueToString(env, args[0], "read library path");
  std::string error;
  auto library = LoadNativeLibrary(library_path, &error);
  if (library == nullptr) {
    Throw(env, error);
    return nullptr;
  }
  const char *version = library->version();
  napi_value out = nullptr;
  Check(env, napi_create_string_utf8(env, version == nullptr ? "unknown" : version, NAPI_AUTO_LENGTH, &out),
        "create version string");
  return out;
}

struct AsyncOpenContext {
  std::atomic<size_t> lifetime_references = 2;
  EnvironmentOperation environment_operation;
  std::shared_ptr<ThreadsafeBridge> completion_bridge;
  napi_deferred deferred = nullptr;
  napi_ref handle_ref = nullptr;
  NativeHandleBox *box = nullptr;
  std::shared_ptr<NativeLibrary> library;
  napi_env owner_env = nullptr;
  std::string library_path;
  std::string pgdata;
  std::string runtime_dir;
  std::string module_dir;
  std::string username;
  std::string database;
  std::vector<std::string> startup_args;
  OliphauntHandle *handle = nullptr;
  uint64_t generation = 0;
  std::string error;
  bool succeeded = false;
};

void ExecuteAsyncOpen(void *data) {
  auto *context = static_cast<AsyncOpenContext *>(data);
  if (EnvironmentIsShuttingDown(&context->environment_operation)) {
    context->error = "native liboliphaunt environment is shutting down";
    return;
  }
  context->library = LoadNativeLibrary(context->library_path, &context->error);
  if (context->library == nullptr) {
    return;
  }
  std::vector<const char *> startup_ptrs;
  startup_ptrs.reserve(context->startup_args.size());
  for (const auto &arg : context->startup_args) {
    startup_ptrs.push_back(arg.c_str());
  }

  OliphauntConfig native_config = {};
  native_config.abi_version = OLIPHAUNT_ABI_VERSION;
  native_config.pgdata = context->pgdata.c_str();
  native_config.runtime_dir = context->runtime_dir.empty() ? nullptr : context->runtime_dir.c_str();
  native_config.module_dir = context->module_dir.empty() ? nullptr : context->module_dir.c_str();
  native_config.username = context->username.c_str();
  native_config.database = context->database.c_str();
  native_config.flags = 0;
  native_config.startup_args = startup_ptrs.empty() ? nullptr : startup_ptrs.data();
  native_config.startup_arg_count = startup_ptrs.size();

  std::lock_guard<std::mutex> guard(context->library->lifecycle_mutex);
  if (context->library->terminally_closed) {
    context->error = "native liboliphaunt environment has already shut down";
    return;
  }
  if (context->library->detach_pending) {
    if (context->library->resident_handle == nullptr ||
        context->library->resident_generation == 0 || context->library->detach == nullptr) {
      context->error = "native liboliphaunt has an invalid pending detach owner";
      return;
    }
    const int32_t detach_rc = context->library->detach(context->library->resident_handle);
    if (detach_rc != 0) {
      context->error =
          "native liboliphaunt could not recover the previous logical handle: " +
          LastError(context->library.get(), context->library->resident_handle);
      return;
    }
    context->library->detach_pending = false;
  }

  const int32_t rc = context->library->init(&native_config, &context->handle);
  if (rc != 0) {
    context->error =
        "native liboliphaunt init failed: " + LastError(context->library.get(), nullptr);
    return;
  }
  if (context->handle == nullptr) {
    context->error = "native liboliphaunt init returned a null handle";
    return;
  }
  context->generation = context->library->logical_generation(context->handle);
  if (context->generation == 0) {
    // A zero generation means another cleanup owner invalidated the opaque
    // pointer. Do not pass that potentially stale pointer to any other ABI.
    context->library->terminally_closed = true;
    context->library->resident_handle = nullptr;
    context->library->resident_generation = 0;
    context->library->owner_env = nullptr;
    context->handle = nullptr;
    context->error = "native liboliphaunt init returned an invalid logical generation";
    return;
  }
  context->library->resident_handle = context->handle;
  context->library->resident_generation = context->generation;
  context->library->owner_env = context->owner_env;
  context->library->detach_pending = false;
  context->succeeded = true;
}

void FinalizeAsyncOpen(napi_env env, void *data, void *) {
  auto *context = static_cast<AsyncOpenContext *>(data);
  if (CanDeliverBackgroundCompletion(
          env, context->environment_operation, context->completion_bridge) &&
      !context->succeeded) {
    RejectDeferred(
        env,
        context->deferred,
        context->error);
  } else if (CanDeliverBackgroundCompletion(
                 env, context->environment_operation, context->completion_bridge)) {
    context->box->library = context->library;
    context->box->handle = context->handle;
    context->box->generation = context->generation;
    napi_value external = nullptr;
    if (napi_get_reference_value(env, context->handle_ref, &external) == napi_ok &&
        external != nullptr) {
      (void)napi_resolve_deferred(env, context->deferred, external);
    } else {
      RejectDeferred(env, context->deferred, "native liboliphaunt could not publish its handle");
    }
  }
  if (env != nullptr && context->handle_ref != nullptr) {
    (void)napi_delete_reference(env, context->handle_ref);
    context->handle_ref = nullptr;
  }
  ReleaseBackgroundContext<AsyncOpenContext>(context);
}

napi_value Open(napi_env env, napi_callback_info info) {
  auto args = Args(env, info, 1);
  if (args.empty()) return nullptr;
  napi_value config = args[0];
  auto context = std::make_unique<AsyncOpenContext>();
  context->library_path = GetString(env, config, "libraryPath");
  context->pgdata = GetString(env, config, "pgdata");
  context->runtime_dir = GetString(env, config, "runtimeDirectory", false);
  context->module_dir = GetString(env, config, "moduleDirectory", false);
  context->username = GetString(env, config, "username");
  context->database = GetString(env, config, "database");
  context->startup_args = GetStringArray(env, config, "startupArgs");
  if (ExceptionPending(env)) return nullptr;
  context->owner_env = env;
  context->box = new NativeHandleBox();
  context->completion_bridge = std::make_shared<ThreadsafeBridge>();

  napi_value promise = nullptr;
  napi_value external = nullptr;
  napi_value resource_name = nullptr;
  if (!Check(env, napi_create_promise(env, &context->deferred, &promise), "create open promise") ||
      !Check(env,
             napi_create_external(env, context->box, FinalizeHandle, nullptr, &external),
             "create native handle") ||
      !Check(env, napi_create_reference(env, external, 1, &context->handle_ref),
             "retain native handle during open") ||
      !Check(env,
             napi_create_string_utf8(
                 env, "oliphaunt.open", NAPI_AUTO_LENGTH, &resource_name),
             "create open resource name") ||
      !Check(env,
             napi_create_threadsafe_function(
                 env,
                 nullptr,
                 nullptr,
                 resource_name,
                 1,
                 1,
                 context.get(),
                 FinalizeAsyncOpen,
                 context.get(),
                 IgnoreBackgroundCompletion,
                 &context->completion_bridge->function),
             "create native open completion")) {
    if (context->handle_ref != nullptr) {
      (void)napi_delete_reference(env, context->handle_ref);
    } else if (external == nullptr) {
      delete context->box;
    }
    return nullptr;
  }
  AsyncOpenContext *raw_context = context.release();
  if (!RegisterEnvironmentOperation(env, &raw_context->environment_operation)) {
    AbortBackgroundOperationSetup(
        &raw_context->environment_operation, raw_context->completion_bridge);
    ReleaseBackgroundContext<AsyncOpenContext>(raw_context);
    return nullptr;
  }
  RegisterThreadsafeBridge(
      raw_context->environment_operation.environment, raw_context->completion_bridge);
  if (!RefreshEnvironmentQuiesceHook(
          env, raw_context->environment_operation.environment) ||
      !StartBackgroundOperation(
          env,
          &raw_context->environment_operation,
          raw_context->completion_bridge,
          ExecuteAsyncOpen,
          ReleaseBackgroundContext<AsyncOpenContext>,
          raw_context)) {
    AbortBackgroundOperationSetup(
        &raw_context->environment_operation, raw_context->completion_bridge);
    ReleaseBackgroundContext<AsyncOpenContext>(raw_context);
    return nullptr;
  }
  return promise;
}

enum class AsyncQueryKind { Protocol, Simple };

struct AsyncQueryContext {
  std::atomic<size_t> lifetime_references = 2;
  EnvironmentOperation environment_operation;
  std::shared_ptr<ThreadsafeBridge> completion_bridge;
  napi_deferred deferred = nullptr;
  napi_ref handle_ref = nullptr;
  std::shared_ptr<NativeLibrary> library;
  OliphauntHandle *handle = nullptr;
  AsyncQueryKind kind = AsyncQueryKind::Protocol;
  std::vector<uint8_t> request;
  std::string sql;
  OliphauntResponse response = {};
  int32_t result = -1;
  std::string error;

  ~AsyncQueryContext() {
    if (library != nullptr && (response.data != nullptr || response.len != 0)) {
      library->free_response(&response);
    }
  }
};

void ExecuteAsyncQuery(void *data) {
  auto *context = static_cast<AsyncQueryContext *>(data);
  if (!AdmitEnvironmentNativeCall(&context->environment_operation)) {
    context->error = "native liboliphaunt environment is shutting down";
    return;
  }
#if defined(OLIPHAUNT_NODE_ADDON_LIFECYCLE_TESTING) && \
    OLIPHAUNT_NODE_ADDON_LIFECYCLE_TESTING
  PauseNativeCallEntryForCleanupTest(&context->environment_operation);
#endif
  MarkEnvironmentNativeCallEntered(&context->environment_operation);
#if defined(OLIPHAUNT_NODE_ADDON_LIFECYCLE_TESTING) && \
    OLIPHAUNT_NODE_ADDON_LIFECYCLE_TESTING
  WaitForFirstCleanupCancelForTest(&context->environment_operation);
#endif
  if (context->kind == AsyncQueryKind::Protocol) {
    context->result = context->library->exec_protocol(
        context->handle,
        context->request.empty() ? nullptr : context->request.data(),
        context->request.size(),
        &context->response);
  } else {
    context->result = context->library->exec_simple_query(
        context->handle, context->sql.data(), context->sql.size(), &context->response);
  }
  if (context->result != 0) {
    context->error = LastError(context->library.get(), context->handle);
  }
}

void FinalizeAsyncQuery(napi_env env, void *data, void *) {
  auto *context = static_cast<AsyncQueryContext *>(data);
  const bool deliver = CanDeliverBackgroundCompletion(
      env, context->environment_operation, context->completion_bridge);
  if (env != nullptr && context->handle_ref != nullptr) {
    (void)napi_delete_reference(env, context->handle_ref);
    context->handle_ref = nullptr;
  }

  if (deliver && context->result != 0) {
    context->library->free_response(&context->response);
    context->response.data = nullptr;
    context->response.len = 0;
    const char *operation =
        context->kind == AsyncQueryKind::Protocol ? "protocol execution" : "simple query";
    RejectDeferred(
        env,
        context->deferred,
        std::string("native liboliphaunt ") + operation + " failed: " + context->error);
  } else if (deliver) {
    napi_value response = MakeResponse(env, context->library.get(), &context->response);
    if (response != nullptr) {
      (void)napi_resolve_deferred(env, context->deferred, response);
    } else {
      RejectResponseCreation(env, context->deferred);
    }
  }
  ReleaseBackgroundContext<AsyncQueryContext>(context);
}

napi_value QueueAsyncQuery(
    napi_env env,
    napi_value handle_value,
    NativeHandleBox *box,
    AsyncQueryKind kind,
    std::vector<uint8_t> request,
  std::string sql) {
  auto context = std::make_unique<AsyncQueryContext>();
  context->library = box->library;
  context->handle = box->handle;
  context->kind = kind;
  context->request = std::move(request);
  context->sql = std::move(sql);
  context->completion_bridge = std::make_shared<ThreadsafeBridge>();

  napi_value promise = nullptr;
  napi_value resource_name = nullptr;
  const char *resource = kind == AsyncQueryKind::Protocol
      ? "oliphaunt.execProtocolRaw"
      : "oliphaunt.execSimpleQuery";
  if (!Check(env, napi_create_promise(env, &context->deferred, &promise), "create query promise") ||
      !Check(env, napi_create_reference(env, handle_value, 1, &context->handle_ref),
             "retain native handle for query") ||
      !Check(env, napi_create_string_utf8(env, resource, NAPI_AUTO_LENGTH, &resource_name),
             "create query resource name") ||
      !Check(env,
             napi_create_threadsafe_function(
                 env,
                 nullptr,
                 nullptr,
                 resource_name,
                 1,
                 1,
                 context.get(),
                 FinalizeAsyncQuery,
                 context.get(),
                 IgnoreBackgroundCompletion,
                 &context->completion_bridge->function),
             "create native query completion")) {
    if (context->handle_ref != nullptr) {
      (void)napi_delete_reference(env, context->handle_ref);
    }
    return nullptr;
  }
  AsyncQueryContext *raw_context = context.release();
  if (!RegisterEnvironmentOperation(env, &raw_context->environment_operation)) {
    AbortBackgroundOperationSetup(
        &raw_context->environment_operation, raw_context->completion_bridge);
    ReleaseBackgroundContext<AsyncQueryContext>(raw_context);
    return nullptr;
  }
  RegisterThreadsafeBridge(
      raw_context->environment_operation.environment, raw_context->completion_bridge);
  if (!RefreshEnvironmentQuiesceHook(
          env, raw_context->environment_operation.environment) ||
      !StartBackgroundOperation(
          env,
          &raw_context->environment_operation,
          raw_context->completion_bridge,
          ExecuteAsyncQuery,
          ReleaseBackgroundContext<AsyncQueryContext>,
          raw_context)) {
    AbortBackgroundOperationSetup(
        &raw_context->environment_operation, raw_context->completion_bridge);
    ReleaseBackgroundContext<AsyncQueryContext>(raw_context);
    return nullptr;
  }
#if defined(OLIPHAUNT_NODE_ADDON_LIFECYCLE_TESTING) && \
    OLIPHAUNT_NODE_ADDON_LIFECYCLE_TESTING
  WaitForNativeCallEntryPauseForCleanupTest(&raw_context->environment_operation);
#endif
  return promise;
}

napi_value ExecProtocolRaw(napi_env env, napi_callback_info info) {
  auto args = Args(env, info, 2);
  if (args.empty()) return nullptr;
  NativeHandleBox *box = GetHandleBox(env, args[0]);
  if (box == nullptr) return nullptr;
  std::vector<uint8_t> request = GetBytes(env, args[1]);
  if (ExceptionPending(env)) return nullptr;
  return QueueAsyncQuery(
      env, args[0], box, AsyncQueryKind::Protocol, std::move(request), std::string());
}

napi_value ExecSimpleQuery(napi_env env, napi_callback_info info) {
  auto args = Args(env, info, 2);
  if (args.empty()) return nullptr;
  NativeHandleBox *box = GetHandleBox(env, args[0]);
  if (box == nullptr) return nullptr;
  std::string sql = ValueToString(env, args[1], "read SQL");
  if (ExceptionPending(env)) return nullptr;
  return QueueAsyncQuery(
      env, args[0], box, AsyncQueryKind::Simple, std::vector<uint8_t>(), std::move(sql));
}

struct AsyncStreamContext {
  std::atomic<size_t> lifetime_references = 2;
  EnvironmentOperation environment_operation;
  std::shared_ptr<ThreadsafeBridge> callback_bridge;
  napi_deferred deferred = nullptr;
  napi_ref handle_ref = nullptr;
  // Node-API versions before 10 cannot reference arbitrary primitive values.
  // Retain an Array holder so every JavaScript throw value, including
  // undefined and NaN, can be recovered without changing its identity.
  napi_ref callback_exception_holder = nullptr;
  std::shared_ptr<NativeLibrary> library;
  OliphauntHandle *handle = nullptr;
  std::vector<uint8_t> request;
  int32_t result = -1;
  std::atomic<bool> callback_failed = false;
  std::mutex error_mutex;
  std::string error;
};

struct StreamChunkDelivery {
  std::vector<uint8_t> bytes;
  std::shared_ptr<ThreadsafeBridge> bridge;
  std::atomic<bool> completed = false;
};

class StreamChunkDeliveryCompletion {
 public:
  explicit StreamChunkDeliveryCompletion(
      std::shared_ptr<StreamChunkDelivery> delivery)
      : delivery_(std::move(delivery)) {}

  ~StreamChunkDeliveryCompletion() {
    delivery_->completed.store(true, std::memory_order_release);
    delivery_->bridge->release_condition.notify_all();
  }

 private:
  std::shared_ptr<StreamChunkDelivery> delivery_;
};

void RecordStreamError(AsyncStreamContext *context, std::string error) {
  std::lock_guard<std::mutex> guard(context->error_mutex);
  if (context->error.empty()) {
    context->error = std::move(error);
  }
  context->callback_failed.store(true);
}

void RecordStreamException(
    napi_env env,
    AsyncStreamContext *context,
    napi_value exception,
    const char *fallback) {
  if (context->callback_exception_holder == nullptr && exception != nullptr) {
    napi_value holder = nullptr;
    if (napi_create_array_with_length(env, 1, &holder) == napi_ok &&
        napi_set_element(env, holder, 0, exception) == napi_ok &&
        napi_create_reference(
            env, holder, 1, &context->callback_exception_holder) == napi_ok) {
      context->callback_failed.store(true);
      return;
    }
  }
  RecordStreamError(context, fallback);
}

void RecordPendingStreamException(
    napi_env env,
    AsyncStreamContext *context,
    const char *fallback) {
  napi_value exception = nullptr;
  if (ExceptionPending(env) && napi_get_and_clear_last_exception(env, &exception) == napi_ok) {
    RecordStreamException(env, context, exception, fallback);
  } else {
    RecordStreamError(context, fallback);
  }
}

void CallStreamChunk(napi_env env, napi_value callback, void *data, void *chunk_data) {
  std::unique_ptr<std::shared_ptr<StreamChunkDelivery>> queued_delivery(
      static_cast<std::shared_ptr<StreamChunkDelivery> *>(chunk_data));
  if (queued_delivery == nullptr || *queued_delivery == nullptr) {
    return;
  }
  auto delivery = std::move(*queued_delivery);
  StreamChunkDeliveryCompletion completion(delivery);
  auto *context = static_cast<AsyncStreamContext *>(data);
  if (env == nullptr || callback == nullptr || context->callback_failed.load()) {
    return;
  }
  napi_handle_scope scope = nullptr;
  if (napi_open_handle_scope(env, &scope) != napi_ok) {
    RecordPendingStreamException(env, context, "open stream callback scope failed");
    return;
  }
  napi_value global = nullptr;
  napi_value chunk = nullptr;
  napi_value result = nullptr;
  napi_status status = napi_get_global(env, &global);
  if (status == napi_ok) {
    chunk = MakeBytes(env, delivery->bytes.data(), delivery->bytes.size());
    status = chunk == nullptr ? napi_generic_failure : napi_ok;
  }
  if (status == napi_ok) {
    status = napi_call_function(env, global, callback, 1, &chunk, &result);
  }
  if (status != napi_ok) {
    RecordPendingStreamException(env, context, "stream callback failed");
    (void)napi_close_handle_scope(env, scope);
    return;
  }

  napi_valuetype result_type = napi_undefined;
  if (napi_typeof(env, result, &result_type) != napi_ok) {
    RecordPendingStreamException(env, context, "inspect stream callback result failed");
  } else if (result_type == napi_object || result_type == napi_function) {
    bool has_then = false;
    napi_value then_value = nullptr;
    napi_valuetype then_type = napi_undefined;
    if (napi_has_named_property(env, result, "then", &has_then) != napi_ok ||
        (has_then && napi_get_named_property(env, result, "then", &then_value) != napi_ok) ||
        (has_then && napi_typeof(env, then_value, &then_type) != napi_ok)) {
      RecordPendingStreamException(env, context, "inspect stream callback thenable failed");
    } else if (has_then && then_type == napi_function) {
      constexpr const char *message =
          "raw protocol stream callback must complete synchronously and must not return a "
          "Promise or thenable";
      napi_value message_value = nullptr;
      napi_value exception = nullptr;
      if (napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &message_value) == napi_ok &&
          napi_create_type_error(env, nullptr, message_value, &exception) == napi_ok) {
        RecordStreamException(env, context, exception, message);
      } else {
        RecordPendingStreamException(env, context, message);
      }
    }
  }
  (void)napi_close_handle_scope(env, scope);
}

#if defined(OLIPHAUNT_NODE_ADDON_LIFECYCLE_TESTING) && \
    OLIPHAUNT_NODE_ADDON_LIFECYCLE_TESTING
bool PrefillStreamQueueForCleanupTest(
    napi_env env,
    AsyncStreamContext *context) {
  const char *prefill =
      std::getenv("OLIPHAUNT_NODE_CLEANUP_TEST_PREFILL_STREAM_QUEUE");
  if (prefill == nullptr || std::strcmp(prefill, "1") != 0) {
    return true;
  }

  // Keep one delivery queued while the fixture blocks its Worker event loop.
  // The real stream producer then blocks inside napi_call_threadsafe_function,
  // giving teardown a deterministic in-flight producer to abort.
  auto delivery = std::make_shared<StreamChunkDelivery>();
  delivery->bridge = context->callback_bridge;
  auto queued_delivery =
      std::make_unique<std::shared_ptr<StreamChunkDelivery>>(delivery);
  const napi_status status = CallThreadsafeBridge(
      context->callback_bridge, queued_delivery.get(), napi_tsfn_nonblocking);
  if (status != napi_ok) {
    Throw(env, "prefill native stream callback queue for cleanup test");
    return false;
  }
  (void)queued_delivery.release();
  return true;
}
#endif

int32_t StreamChunk(void *data, const uint8_t *bytes, size_t length) {
  auto *context = static_cast<AsyncStreamContext *>(data);
  if (context->callback_failed.load()) {
    return 1;
  }
  if (bytes == nullptr && length != 0) {
    RecordStreamError(context, "native liboliphaunt stream returned null bytes");
    return 1;
  }
  auto delivery = std::make_shared<StreamChunkDelivery>();
  delivery->bridge = context->callback_bridge;
  if (length != 0) {
    delivery->bytes.assign(bytes, bytes + length);
  }
  auto queued_delivery =
      std::make_unique<std::shared_ptr<StreamChunkDelivery>>(delivery);
  const napi_status status = CallThreadsafeBridge(
      context->callback_bridge, queued_delivery.get(), napi_tsfn_blocking);
  if (status != napi_ok) {
    RecordStreamError(context, "queue stream callback failed");
    return 1;
  }
  (void)queued_delivery.release();

  // `napi_tsfn_blocking` waits only for queue admission, not for the JavaScript
  // callback to finish. The native stream callback must return the actual
  // synchronous consumer result so liboliphaunt can stop delivery and drain to
  // ReadyForQuery. Environment abort wakes this wait even if Node can no longer
  // invoke JavaScript; the queued shared owner keeps the delivery alive until
  // Node calls `CallStreamChunk` with a null environment to discard it.
  bool aborted = false;
  {
    std::unique_lock<std::mutex> lock(context->callback_bridge->release_mutex);
    context->callback_bridge->release_condition.wait(
        lock,
        [&]() {
          return delivery->completed.load(std::memory_order_acquire) ||
              context->callback_bridge->aborted.load();
        });
    aborted = context->callback_bridge->aborted.load();
  }
  return aborted || context->callback_failed.load() ? 1 : 0;
}

enum class AsyncStreamCompletion {
  Success,
  RecoveredCallbackFailure,
  NativeFailure,
  AdapterMismatch,
};

AsyncStreamCompletion ClassifyAsyncStreamCompletion(
    int32_t result,
    bool callback_failed) {
  // This is the complete native-result/callback-state truth table:
  //
  //   result == 0                         false -> success
  //   result == 0                         true  -> adapter/ABI mismatch
  //   result == CALLBACK_ABORTED          true  -> recovered callback failure
  //   result == CALLBACK_ABORTED          false -> native/ABI failure
  //   every negative or unknown positive  either -> native/recovery failure
  //
  // Only the exact recovered-abort status is allowed to preserve a callback
  // throw. Every other non-success result is authoritative native state.
  if (result == 0) {
    return callback_failed ? AsyncStreamCompletion::AdapterMismatch
                           : AsyncStreamCompletion::Success;
  }
  if (result == OLIPHAUNT_STREAM_CALLBACK_ABORTED && callback_failed) {
    return AsyncStreamCompletion::RecoveredCallbackFailure;
  }
  return AsyncStreamCompletion::NativeFailure;
}

void ReleaseStreamEnvironmentReferences(
    napi_env env,
    AsyncStreamContext *context) {
  if (env == nullptr) {
    return;
  }
  if (context->callback_exception_holder != nullptr) {
    (void)napi_delete_reference(env, context->callback_exception_holder);
    context->callback_exception_holder = nullptr;
  }
  if (context->handle_ref != nullptr) {
    (void)napi_delete_reference(env, context->handle_ref);
    context->handle_ref = nullptr;
  }
}

bool RejectRecordedStreamException(
    napi_env env,
    AsyncStreamContext *context) {
  if (context->callback_exception_holder == nullptr) {
    return false;
  }
  napi_value holder = nullptr;
  napi_value exception = nullptr;
  return napi_get_reference_value(
             env, context->callback_exception_holder, &holder) == napi_ok &&
      holder != nullptr &&
      napi_get_element(env, holder, 0, &exception) == napi_ok &&
      exception != nullptr &&
      napi_reject_deferred(env, context->deferred, exception) == napi_ok;
}

void FinishAsyncStream(napi_env env, AsyncStreamContext *context) {
  const AsyncStreamCompletion completion = ClassifyAsyncStreamCompletion(
      context->result, context->callback_failed.load());
  switch (completion) {
    case AsyncStreamCompletion::Success: {
      napi_value out = nullptr;
      if (napi_get_undefined(env, &out) == napi_ok) {
        (void)napi_resolve_deferred(env, context->deferred, out);
      } else {
        RejectDeferred(
            env,
            context->deferred,
            "native liboliphaunt could not complete streaming");
      }
      break;
    }
    case AsyncStreamCompletion::RecoveredCallbackFailure: {
      if (!RejectRecordedStreamException(env, context)) {
        std::lock_guard<std::mutex> guard(context->error_mutex);
        RejectDeferred(
            env,
            context->deferred,
            context->error.empty() ? "stream callback failed" : context->error);
      }
      break;
    }
    case AsyncStreamCompletion::NativeFailure:
      RejectDeferred(
          env,
          context->deferred,
          "native liboliphaunt protocol streaming failed: " + context->error);
      break;
    case AsyncStreamCompletion::AdapterMismatch:
      RejectDeferred(
          env,
          context->deferred,
          "native liboliphaunt protocol streaming reported success after the callback failed");
      break;
  }
  ReleaseStreamEnvironmentReferences(env, context);
}

void FinalizeStreamCallback(napi_env env, void *data, void *) {
  auto *context = static_cast<AsyncStreamContext *>(data);
  if (CanDeliverBackgroundCompletion(
          env, context->environment_operation, context->callback_bridge)) {
    FinishAsyncStream(env, context);
  } else if (env != nullptr) {
    ReleaseStreamEnvironmentReferences(env, context);
  }
  ReleaseBackgroundContext<AsyncStreamContext>(context);
}

void ExecuteAsyncStream(void *data) {
  auto *context = static_cast<AsyncStreamContext *>(data);
  if (!AdmitEnvironmentNativeCall(&context->environment_operation)) {
    context->error = "native liboliphaunt environment is shutting down";
    return;
  }
#if defined(OLIPHAUNT_NODE_ADDON_LIFECYCLE_TESTING) && \
    OLIPHAUNT_NODE_ADDON_LIFECYCLE_TESTING
  PauseNativeCallEntryForCleanupTest(&context->environment_operation);
#endif
  MarkEnvironmentNativeCallEntered(&context->environment_operation);
#if defined(OLIPHAUNT_NODE_ADDON_LIFECYCLE_TESTING) && \
    OLIPHAUNT_NODE_ADDON_LIFECYCLE_TESTING
  WaitForFirstCleanupCancelForTest(&context->environment_operation);
#endif
  context->result = context->library->exec_protocol_raw_stream(
      context->handle,
      context->request.empty() ? nullptr : context->request.data(),
      context->request.size(),
      StreamChunk,
      context);
  if (ClassifyAsyncStreamCompletion(
          context->result,
          context->callback_failed.load()) == AsyncStreamCompletion::NativeFailure) {
    std::lock_guard<std::mutex> guard(context->error_mutex);
    context->error = LastError(context->library.get(), context->handle);
  }
}

napi_value ExecProtocolRawStream(napi_env env, napi_callback_info info) {
  auto args = Args(env, info, 3);
  if (args.empty()) return nullptr;
  NativeHandleBox *box = GetHandleBox(env, args[0]);
  if (box == nullptr) return nullptr;
  auto context = std::make_unique<AsyncStreamContext>();
  context->library = box->library;
  context->handle = box->handle;
  context->callback_bridge = std::make_shared<ThreadsafeBridge>();
  context->request = GetBytes(env, args[1]);
  if (ExceptionPending(env)) return nullptr;

  napi_value promise = nullptr;
  napi_value resource_name = nullptr;
  bool setup_ok =
      Check(env, napi_create_promise(env, &context->deferred, &promise), "create stream promise") &&
      Check(env, napi_create_reference(env, args[0], 1, &context->handle_ref),
            "retain native handle for stream") &&
      Check(env,
            napi_create_string_utf8(
                env, "oliphaunt.execProtocolRawStream", NAPI_AUTO_LENGTH, &resource_name),
            "create stream resource name") &&
      Check(env,
            napi_create_threadsafe_function(
                env,
                args[2],
                nullptr,
                resource_name,
                1,
                1,
                context.get(),
                FinalizeStreamCallback,
                context.get(),
                CallStreamChunk,
                &context->callback_bridge->function),
            "create stream callback bridge");
  if (!setup_ok) {
    if (context->handle_ref != nullptr) {
      (void)napi_delete_reference(env, context->handle_ref);
    }
    return nullptr;
  }
  AsyncStreamContext *raw_context = context.release();
  if (!RegisterEnvironmentOperation(env, &raw_context->environment_operation)) {
    AbortBackgroundOperationSetup(
        &raw_context->environment_operation, raw_context->callback_bridge);
    ReleaseBackgroundContext<AsyncStreamContext>(raw_context);
    return nullptr;
  }
  RegisterThreadsafeBridge(
      raw_context->environment_operation.environment,
      raw_context->callback_bridge);
  if (!RefreshEnvironmentQuiesceHook(
          env, raw_context->environment_operation.environment) ||
#if defined(OLIPHAUNT_NODE_ADDON_LIFECYCLE_TESTING) && \
    OLIPHAUNT_NODE_ADDON_LIFECYCLE_TESTING
      !PrefillStreamQueueForCleanupTest(env, raw_context) ||
#endif
      !StartBackgroundOperation(
          env,
          &raw_context->environment_operation,
          raw_context->callback_bridge,
          ExecuteAsyncStream,
          ReleaseBackgroundContext<AsyncStreamContext>,
          raw_context)) {
    AbortBackgroundOperationSetup(
        &raw_context->environment_operation, raw_context->callback_bridge);
    ReleaseBackgroundContext<AsyncStreamContext>(raw_context);
    return nullptr;
  }
  return promise;
}

enum class AsyncArchiveKind { Backup, Restore };

struct AsyncArchiveContext {
  std::atomic<size_t> lifetime_references = 2;
  EnvironmentOperation environment_operation;
  std::shared_ptr<ThreadsafeBridge> completion_bridge;
  napi_deferred deferred = nullptr;
  napi_ref handle_ref = nullptr;
  std::shared_ptr<NativeLibrary> library;
  std::string library_path;
  OliphauntHandle *handle = nullptr;
  AsyncArchiveKind kind = AsyncArchiveKind::Backup;
  std::string destination;
  std::vector<uint8_t> bytes;
  OliphauntResponse response = {};
  int32_t result = -1;
  std::string error;

  ~AsyncArchiveContext() {
    if (kind == AsyncArchiveKind::Backup && library != nullptr &&
        (response.data != nullptr || response.len != 0)) {
      library->free_response(&response);
    }
  }
};

void ExecuteAsyncArchive(void *data) {
  auto *context = static_cast<AsyncArchiveContext *>(data);
  if (EnvironmentIsShuttingDown(&context->environment_operation)) {
    context->error = "native liboliphaunt environment is shutting down";
    return;
  }
  if (context->library == nullptr) {
    context->library = LoadNativeLibrary(context->library_path, &context->error);
    if (context->library == nullptr) {
      return;
    }
  }
  if (!AdmitEnvironmentNativeCall(&context->environment_operation)) {
    context->error = "native liboliphaunt environment is shutting down";
    return;
  }
#if defined(OLIPHAUNT_NODE_ADDON_LIFECYCLE_TESTING) && \
    OLIPHAUNT_NODE_ADDON_LIFECYCLE_TESTING
  PauseNativeCallEntryForCleanupTest(&context->environment_operation);
#endif
  MarkEnvironmentNativeCallEntered(&context->environment_operation);
#if defined(OLIPHAUNT_NODE_ADDON_LIFECYCLE_TESTING) && \
    OLIPHAUNT_NODE_ADDON_LIFECYCLE_TESTING
  WaitForFirstCleanupCancelForTest(&context->environment_operation);
#endif
  if (context->kind == AsyncArchiveKind::Backup) {
    context->result = context->library->backup(context->handle, &context->response);
  } else {
    OliphauntRestoreOptions options = {};
    options.abi_version = OLIPHAUNT_ABI_VERSION;
    options.destination = context->destination.c_str();
    options.data = context->bytes.empty() ? nullptr : context->bytes.data();
    options.len = context->bytes.size();
    context->result = context->library->restore(&options);
  }
  if (context->result != 0) {
    context->error = LastError(context->library.get(), context->handle);
  }
}

void FinalizeAsyncArchive(napi_env env, void *data, void *) {
  auto *context = static_cast<AsyncArchiveContext *>(data);
  const bool deliver = CanDeliverBackgroundCompletion(
      env, context->environment_operation, context->completion_bridge);
  if (env != nullptr && context->handle_ref != nullptr) {
    (void)napi_delete_reference(env, context->handle_ref);
    context->handle_ref = nullptr;
  }

  if (deliver && context->result != 0) {
    if (context->kind == AsyncArchiveKind::Backup) {
      context->library->free_response(&context->response);
      context->response.data = nullptr;
      context->response.len = 0;
    }
    const char *operation = context->kind == AsyncArchiveKind::Backup ? "backup" : "restore";
    RejectDeferred(
        env,
        context->deferred,
        std::string("native liboliphaunt ") + operation + " failed: " + context->error);
  } else if (deliver && context->kind == AsyncArchiveKind::Backup) {
    napi_value response = MakeResponse(env, context->library.get(), &context->response);
    if (response != nullptr) {
      (void)napi_resolve_deferred(env, context->deferred, response);
    } else {
      RejectResponseCreation(env, context->deferred);
    }
  } else if (deliver) {
    napi_value out = nullptr;
    if (napi_get_undefined(env, &out) == napi_ok) {
      (void)napi_resolve_deferred(env, context->deferred, out);
    } else {
      RejectDeferred(env, context->deferred, "native liboliphaunt could not complete restore");
    }
  }
  ReleaseBackgroundContext<AsyncArchiveContext>(context);
}

napi_value QueueAsyncArchive(
    napi_env env,
    AsyncArchiveKind kind,
    std::shared_ptr<NativeLibrary> library,
    std::string library_path,
    OliphauntHandle *handle,
    napi_value handle_value,
    std::string destination,
    std::vector<uint8_t> bytes) {
  auto context = std::make_unique<AsyncArchiveContext>();
  context->library = std::move(library);
  context->library_path = std::move(library_path);
  context->handle = handle;
  context->kind = kind;
  context->destination = std::move(destination);
  context->bytes = std::move(bytes);
  context->completion_bridge = std::make_shared<ThreadsafeBridge>();

  napi_value promise = nullptr;
  napi_value resource_name = nullptr;
  const char *resource = kind == AsyncArchiveKind::Backup
      ? "oliphaunt.backup"
      : "oliphaunt.restore";
  if (!Check(env, napi_create_promise(env, &context->deferred, &promise), "create archive promise")) {
    return nullptr;
  }
  if (handle_value != nullptr &&
      !Check(env, napi_create_reference(env, handle_value, 1, &context->handle_ref),
             "retain native handle for archive operation")) {
    return nullptr;
  }
  if (!Check(env, napi_create_string_utf8(env, resource, NAPI_AUTO_LENGTH, &resource_name),
             "create archive resource name") ||
      !Check(env,
             napi_create_threadsafe_function(
                 env,
                 nullptr,
                 nullptr,
                 resource_name,
                 1,
                 1,
                 context.get(),
                 FinalizeAsyncArchive,
                 context.get(),
                 IgnoreBackgroundCompletion,
                 &context->completion_bridge->function),
             "create native archive completion")) {
    if (context->handle_ref != nullptr) {
      (void)napi_delete_reference(env, context->handle_ref);
    }
    return nullptr;
  }
  AsyncArchiveContext *raw_context = context.release();
  if (!RegisterEnvironmentOperation(env, &raw_context->environment_operation)) {
    AbortBackgroundOperationSetup(
        &raw_context->environment_operation, raw_context->completion_bridge);
    ReleaseBackgroundContext<AsyncArchiveContext>(raw_context);
    return nullptr;
  }
  RegisterThreadsafeBridge(
      raw_context->environment_operation.environment, raw_context->completion_bridge);
  if (!RefreshEnvironmentQuiesceHook(
          env, raw_context->environment_operation.environment) ||
      !StartBackgroundOperation(
          env,
          &raw_context->environment_operation,
          raw_context->completion_bridge,
          ExecuteAsyncArchive,
          ReleaseBackgroundContext<AsyncArchiveContext>,
          raw_context)) {
    AbortBackgroundOperationSetup(
        &raw_context->environment_operation, raw_context->completion_bridge);
    ReleaseBackgroundContext<AsyncArchiveContext>(raw_context);
    return nullptr;
  }
  return promise;
}

napi_value Backup(napi_env env, napi_callback_info info) {
  auto args = Args(env, info, 1);
  if (args.empty()) return nullptr;
  NativeHandleBox *box = GetHandleBox(env, args[0]);
  if (box == nullptr) return nullptr;
  return QueueAsyncArchive(
      env,
      AsyncArchiveKind::Backup,
      box->library,
      std::string(),
      box->handle,
      args[0],
      std::string(),
      std::vector<uint8_t>());
}

napi_value Restore(napi_env env, napi_callback_info info) {
  auto args = Args(env, info, 1);
  if (args.empty()) return nullptr;
  napi_value options = args[0];
  std::string library_path = GetString(env, options, "libraryPath");
  std::string destination = GetString(env, options, "destination");
  std::vector<uint8_t> bytes = GetBytes(env, GetNamed(env, options, "bytes"));
  if (ExceptionPending(env)) return nullptr;
  return QueueAsyncArchive(
      env,
      AsyncArchiveKind::Restore,
      nullptr,
      std::move(library_path),
      nullptr,
      nullptr,
      std::move(destination),
      std::move(bytes));
}

napi_value Cancel(napi_env env, napi_callback_info info) {
  auto args = Args(env, info, 1);
  if (args.empty()) return nullptr;
  NativeHandleBox *box = GetHandleBox(env, args[0]);
  if (box == nullptr) return nullptr;
  int32_t rc = box->library->cancel(box->handle);
  if (rc != 0) {
    Throw(env, "native liboliphaunt cancel failed: " + LastError(box->library.get(), box->handle));
    return nullptr;
  }
  napi_value out = nullptr;
  Check(env, napi_get_undefined(env, &out), "create undefined");
  return out;
}

struct AsyncDetachContext {
  std::atomic<size_t> lifetime_references = 2;
  EnvironmentOperation environment_operation;
  std::shared_ptr<ThreadsafeBridge> completion_bridge;
  napi_deferred deferred = nullptr;
  napi_ref handle_ref = nullptr;
  NativeHandleBox *box = nullptr;
  std::shared_ptr<NativeLibrary> library;
  OliphauntHandle *handle = nullptr;
  uint64_t generation = 0;
  int32_t result = -1;
  bool stale = false;
  std::string error;
};

void ExecuteAsyncDetach(void *data) {
  auto *context = static_cast<AsyncDetachContext *>(data);
  if (EnvironmentIsShuttingDown(&context->environment_operation)) {
    context->stale = true;
    context->error = "native liboliphaunt environment is shutting down";
    return;
  }
  std::lock_guard<std::mutex> guard(context->library->lifecycle_mutex);
  if (context->library->terminally_closed ||
      context->library->resident_handle != context->handle ||
      context->library->resident_generation != context->generation) {
    context->stale = true;
    context->error = "native liboliphaunt environment has already shut down";
    return;
  }
  context->result = context->library->detach(context->handle);
  if (context->result != 0) {
    context->library->detach_pending = true;
    context->error =
        "native liboliphaunt detach failed: " +
        LastError(context->library.get(), context->handle);
    return;
  }
  context->library->detach_pending = false;
}

void FinalizeAsyncDetach(napi_env env, void *data, void *) {
  auto *context = static_cast<AsyncDetachContext *>(data);
  const bool deliver = CanDeliverBackgroundCompletion(
      env, context->environment_operation, context->completion_bridge);
  if (deliver && (context->result == 0 || context->stale)) {
    // From the logical owner's perspective an exact-generation handle that is
    // already terminally unavailable is closed, not retryable. NativeBinding
    // reserves detach rejection for failures that leave this handle active.
    context->box->handle = nullptr;
    napi_value out = nullptr;
    if (napi_get_undefined(env, &out) == napi_ok) {
      (void)napi_resolve_deferred(env, context->deferred, out);
    }
    // Logical detach already succeeded. Failure to materialize its JavaScript
    // completion cannot safely be reported as a retryable native rejection.
  } else if (deliver) {
    // A failed logical detach remains retryable through Database.close().
    context->box->detached = false;
    RejectDeferred(
        env,
        context->deferred,
        context->error);
  }
  if (env != nullptr && context->handle_ref != nullptr) {
    (void)napi_delete_reference(env, context->handle_ref);
    context->handle_ref = nullptr;
  }
  ReleaseBackgroundContext<AsyncDetachContext>(context);
}

napi_value Detach(napi_env env, napi_callback_info info) {
  auto args = Args(env, info, 1);
  if (args.empty()) return nullptr;
  NativeHandleBox *box = GetHandleBox(env, args[0]);
  if (box == nullptr) return nullptr;
  auto context = std::make_unique<AsyncDetachContext>();
  context->box = box;
  context->library = box->library;
  context->handle = box->handle;
  context->generation = box->generation;
  context->completion_bridge = std::make_shared<ThreadsafeBridge>();

  napi_value promise = nullptr;
  napi_value resource_name = nullptr;
  if (!Check(env, napi_create_promise(env, &context->deferred, &promise), "create detach promise") ||
      !Check(env, napi_create_reference(env, args[0], 1, &context->handle_ref),
             "retain native handle during detach") ||
      !Check(env,
             napi_create_string_utf8(
                 env, "oliphaunt.detach", NAPI_AUTO_LENGTH, &resource_name),
             "create detach resource name") ||
      !Check(env,
             napi_create_threadsafe_function(
                 env,
                 nullptr,
                 nullptr,
                 resource_name,
                 1,
                 1,
                 context.get(),
                 FinalizeAsyncDetach,
                 context.get(),
                 IgnoreBackgroundCompletion,
                 &context->completion_bridge->function),
             "create native detach completion")) {
    if (context->handle_ref != nullptr) {
      (void)napi_delete_reference(env, context->handle_ref);
    }
    return nullptr;
  }
  AsyncDetachContext *raw_context = context.release();
  if (!RegisterEnvironmentOperation(env, &raw_context->environment_operation)) {
    AbortBackgroundOperationSetup(
        &raw_context->environment_operation, raw_context->completion_bridge);
    ReleaseBackgroundContext<AsyncDetachContext>(raw_context);
    return nullptr;
  }
  RegisterThreadsafeBridge(
      raw_context->environment_operation.environment, raw_context->completion_bridge);
  if (!RefreshEnvironmentQuiesceHook(
          env, raw_context->environment_operation.environment) ||
      !StartBackgroundOperation(
          env,
          &raw_context->environment_operation,
          raw_context->completion_bridge,
          ExecuteAsyncDetach,
          ReleaseBackgroundContext<AsyncDetachContext>,
          raw_context)) {
    AbortBackgroundOperationSetup(
        &raw_context->environment_operation, raw_context->completion_bridge);
    ReleaseBackgroundContext<AsyncDetachContext>(raw_context);
    return nullptr;
  }
  // Reject new work immediately while the native detach runs. On failure the
  // completion callback restores the retryable logical handle.
  box->detached = true;
  return promise;
}

napi_value Init(napi_env env, napi_value exports) {
  auto *environment = new AddonEnvironment{env};
  // Node-API 8 pairs asynchronous registration with removal through the
  // returned opaque handle. Retain that handle explicitly; the addon never
  // relies on a null output pointer being accepted by a particular Node build.
  if (!Check(
          env,
          napi_add_async_cleanup_hook(
              env,
              CleanupEnvironment,
              environment,
              &environment->async_cleanup_handle),
          "register asynchronous native environment cleanup")) {
    delete environment;
    return nullptr;
  }
  {
    std::lock_guard<std::mutex> guard(g_environments_mutex);
    g_environments[env] = environment;
  }
  if (!RefreshEnvironmentQuiesceHook(env, environment)) {
    (void)napi_remove_async_cleanup_hook(environment->async_cleanup_handle);
    {
      std::lock_guard<std::mutex> guard(g_environments_mutex);
      g_environments.erase(env);
    }
    delete environment;
    return nullptr;
  }
  const napi_property_descriptor descriptors[] = {
      {"version", nullptr, Version, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"open", nullptr, Open, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"execProtocolRaw", nullptr, ExecProtocolRaw, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"execSimpleQuery", nullptr, ExecSimpleQuery, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"execProtocolRawStream", nullptr, ExecProtocolRawStream, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"backup", nullptr, Backup, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"restore", nullptr, Restore, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"cancel", nullptr, Cancel, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"detach", nullptr, Detach, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"createForgottenHandleRecoveryToken", nullptr,
       CreateForgottenHandleRecoveryToken, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"queueForgottenHandleRecovery", nullptr, QueueForgottenHandleRecovery,
       nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  Check(env, napi_define_properties(env, exports, sizeof(descriptors) / sizeof(descriptors[0]), descriptors),
        "define exports");
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
