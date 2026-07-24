#include <node_api.h>
#include "oliphaunt.h"

#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <map>
#include <memory>
#include <mutex>
#include <string>
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
using InitExFn = int32_t (*)(
    const OliphauntConfig *, const OliphauntInitOptions *, OliphauntHandle **);
using ExecProtocolFn = int32_t (*)(OliphauntHandle *, const uint8_t *, size_t, OliphauntResponse *);
using ExecSimpleQueryFn = int32_t (*)(OliphauntHandle *, const char *, size_t, OliphauntResponse *);
using ExecProtocolStreamFn = int32_t (*)(
    OliphauntHandle *, const uint8_t *, size_t, OliphauntStreamCallback, void *);
using BackupFn = int32_t (*)(OliphauntHandle *, uint32_t, OliphauntResponse *);
using RestoreFn = int32_t (*)(const OliphauntRestoreOptions *);
using CancelFn = int32_t (*)(OliphauntHandle *);
using DetachFn = int32_t (*)(OliphauntHandle *);
using LogicalGenerationFn = uint64_t (*)(OliphauntHandle *);
using CloseIfGenerationFn = int32_t (*)(uint64_t);
using LastErrorFn = const char *(*)(OliphauntHandle *);
using VersionFn = const char *(*)();
using CapabilitiesFn = uint64_t (*)();
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
  InitExFn init_ex = nullptr;
  ExecProtocolFn exec_protocol = nullptr;
  ExecSimpleQueryFn exec_simple_query = nullptr;
  ExecProtocolStreamFn exec_protocol_stream = nullptr;
  BackupFn backup = nullptr;
  RestoreFn restore = nullptr;
  CancelFn cancel = nullptr;
  DetachFn detach = nullptr;
  LogicalGenerationFn logical_generation = nullptr;
  CloseIfGenerationFn close_if_generation = nullptr;
  LastErrorFn last_error = nullptr;
  VersionFn version = nullptr;
  CapabilitiesFn capabilities = nullptr;
  FreeResponseFn free_response = nullptr;
  // JavaScript close is intentionally a logical detach so a direct backend can
  // be reopened. Keep its process-resident handle until the owning Node
  // environment performs the one terminal close.
  std::mutex lifecycle_mutex;
  OliphauntHandle *resident_handle = nullptr;
  uint64_t resident_generation = 0;
  napi_env owner_env = nullptr;
  bool terminally_closed = false;
};

struct NativeHandleBox {
  std::shared_ptr<NativeLibrary> library;
  OliphauntHandle *handle = nullptr;
  uint64_t generation = 0;
  bool detached = false;
};

std::mutex g_libraries_mutex;
std::map<std::string, std::shared_ptr<NativeLibrary>> g_libraries;

struct AddonEnvironment {
  napi_env env = nullptr;
};

void Throw(napi_env env, const std::string &message) { napi_throw_error(env, nullptr, message.c_str()); }

#if defined(_WIN32)
bool Utf8ToWidePath(napi_env env, const std::string &path, std::wstring *wide_path) {
  if (path.size() > static_cast<size_t>(std::numeric_limits<int>::max())) {
    Throw(env, "liboliphaunt path is too long to load on Windows");
    return false;
  }

  const int source_length = static_cast<int>(path.size());
  const int required_length =
      MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path.data(), source_length, nullptr, 0);
  if (required_length <= 0) {
    Throw(env, "liboliphaunt path is not valid UTF-8");
    return false;
  }

  wide_path->resize(static_cast<size_t>(required_length));
  const int converted_length = MultiByteToWideChar(
      CP_UTF8, MB_ERR_INVALID_CHARS, path.data(), source_length, wide_path->data(), required_length);
  if (converted_length != required_length) {
    wide_path->clear();
    Throw(env, "liboliphaunt path could not be converted for the Windows loader");
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

bool ExceptionPending(napi_env env) {
  bool pending = false;
  return napi_is_exception_pending(env, &pending) == napi_ok && pending;
}

std::string LastError(NativeLibrary *library, OliphauntHandle *handle) {
  if (library == nullptr || library->last_error == nullptr) {
    return "unknown error";
  }
  const char *message = library->last_error(handle);
  return message == nullptr || message[0] == '\0' ? "unknown error" : message;
}

void *LoadSymbol(napi_env env, DynamicLibrary library, const char *name) {
#if defined(_WIN32)
  void *symbol = reinterpret_cast<void *>(GetProcAddress(library.handle, name));
#else
  void *symbol = dlsym(library.handle, name);
#endif
  if (symbol == nullptr) {
    Throw(env, std::string("liboliphaunt is missing required symbol ") + name);
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

std::shared_ptr<NativeLibrary> LoadNativeLibrary(napi_env env, const std::string &path) {
  if (path.empty()) {
    Throw(env, "liboliphaunt path must not be empty");
    return nullptr;
  }
  if (path.find('\0') != std::string::npos) {
    Throw(env, "liboliphaunt path must not contain a null byte");
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
  if (!Utf8ToWidePath(env, path, &wide_path)) {
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
    Throw(env, "load liboliphaunt failed");
#else
    const char *message = dlerror();
    Throw(env, std::string("load liboliphaunt failed: ") + (message == nullptr ? path : message));
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
  library->init = reinterpret_cast<InitFn>(LoadSymbol(env, dynamic, "oliphaunt_init"));
  library->init_ex = reinterpret_cast<InitExFn>(LoadSymbol(env, dynamic, "oliphaunt_init_ex"));
  library->exec_protocol =
      reinterpret_cast<ExecProtocolFn>(LoadSymbol(env, dynamic, "oliphaunt_exec_protocol"));
  library->exec_simple_query =
      reinterpret_cast<ExecSimpleQueryFn>(LoadSymbol(env, dynamic, "oliphaunt_exec_simple_query"));
  library->exec_protocol_stream = reinterpret_cast<ExecProtocolStreamFn>(
      LoadSymbol(env, dynamic, "oliphaunt_exec_protocol_stream"));
  library->backup = reinterpret_cast<BackupFn>(LoadSymbol(env, dynamic, "oliphaunt_backup"));
  library->restore = reinterpret_cast<RestoreFn>(LoadSymbol(env, dynamic, "oliphaunt_restore"));
  library->cancel = reinterpret_cast<CancelFn>(LoadSymbol(env, dynamic, "oliphaunt_cancel"));
  library->detach = reinterpret_cast<DetachFn>(LoadSymbol(env, dynamic, "oliphaunt_detach"));
  // Validate the mandatory terminal-close ABI even though Node cleanup uses
  // only the generation-guarded entry point and never invokes this pointer API.
  (void)LoadSymbol(env, dynamic, "oliphaunt_close");
  library->logical_generation = reinterpret_cast<LogicalGenerationFn>(
      LoadSymbol(env, dynamic, "oliphaunt_logical_generation"));
  library->close_if_generation = reinterpret_cast<CloseIfGenerationFn>(
      LoadSymbol(env, dynamic, "oliphaunt_close_if_generation"));
  library->last_error =
      reinterpret_cast<LastErrorFn>(LoadSymbol(env, dynamic, "oliphaunt_last_error"));
  library->version = reinterpret_cast<VersionFn>(LoadSymbol(env, dynamic, "oliphaunt_version"));
  library->capabilities =
      reinterpret_cast<CapabilitiesFn>(LoadSymbol(env, dynamic, "oliphaunt_capabilities"));
  library->free_response =
      reinterpret_cast<FreeResponseFn>(LoadSymbol(env, dynamic, "oliphaunt_free_response"));

  if (ExceptionPending(env)) {
    return nullptr;
  }
  g_libraries[path] = library;
  return library;
}

void CleanupEnvironment(void *data) {
  std::unique_ptr<AddonEnvironment> environment(static_cast<AddonEnvironment *>(data));
  if (environment == nullptr) {
    return;
  }

  std::vector<std::shared_ptr<NativeLibrary>> libraries;
  {
    std::lock_guard<std::mutex> guard(g_libraries_mutex);
    libraries.reserve(g_libraries.size());
    for (const auto &entry : g_libraries) {
      libraries.push_back(entry.second);
    }
  }

  for (const auto &library : libraries) {
    std::lock_guard<std::mutex> guard(library->lifecycle_mutex);
    if (library->owner_env != environment->env || library->resident_handle == nullptr ||
        library->terminally_closed) {
      continue;
    }

    uint64_t generation = library->resident_generation;
    // Node runs environment cleanup hooks before external finalizers. Publish
    // the local terminal state first so a later NativeHandleBox finalizer
    // cannot detach the generation being closed. A copied addon image has an
    // independent lifecycle map, so liboliphaunt must decide atomically whether
    // this image still owns the process-resident generation.
    library->terminally_closed = true;
    library->resident_handle = nullptr;
    library->resident_generation = 0;
    library->owner_env = nullptr;
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

uint32_t GetUint32(napi_env env, napi_value object, const char *name) {
  napi_value value = GetNamed(env, object, name);
  uint32_t out = 0;
  Check(env, napi_get_value_uint32(env, value, &out), "read uint32 property");
  return out;
}

bool GetBool(napi_env env, napi_value object, const char *name) {
  if (!HasNamedProperty(env, object, name)) {
    return false;
  }
  napi_value value = GetNamed(env, object, name);
  bool out = false;
  Check(env, napi_get_value_bool(env, value, &out), "read boolean property");
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
          box->library->resident_generation == box->generation &&
          box->library->detach != nullptr) {
        box->library->detach(box->handle);
      }
    }
    delete box;
  }
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

napi_value Version(napi_env env, napi_callback_info info) {
  auto args = Args(env, info, 1);
  if (args.empty()) return nullptr;
  std::string library_path = ValueToString(env, args[0], "read library path");
  auto library = LoadNativeLibrary(env, library_path);
  if (library == nullptr) return nullptr;
  const char *version = library->version();
  napi_value out = nullptr;
  Check(env, napi_create_string_utf8(env, version == nullptr ? "unknown" : version, NAPI_AUTO_LENGTH, &out),
        "create version string");
  return out;
}

napi_value Capabilities(napi_env env, napi_callback_info info) {
  auto args = Args(env, info, 1);
  if (args.empty()) return nullptr;
  std::string library_path = ValueToString(env, args[0], "read library path");
  auto library = LoadNativeLibrary(env, library_path);
  if (library == nullptr) return nullptr;
  napi_value out = nullptr;
  Check(env, napi_create_bigint_uint64(env, library->capabilities(), &out), "create capabilities bigint");
  return out;
}

napi_value Open(napi_env env, napi_callback_info info) {
  auto args = Args(env, info, 1);
  if (args.empty()) return nullptr;
  napi_value config = args[0];
  std::string library_path = GetString(env, config, "libraryPath");
  std::string pgdata = GetString(env, config, "pgdata");
  std::string runtime_dir = GetString(env, config, "runtimeDirectory", false);
  std::string module_dir = GetString(env, config, "moduleDirectory", false);
  std::string username = GetString(env, config, "username");
  std::string database = GetString(env, config, "database");
  std::vector<std::string> startup_args = GetStringArray(env, config, "startupArgs");
  if (ExceptionPending(env)) return nullptr;
  auto library = LoadNativeLibrary(env, library_path);
  if (library == nullptr) return nullptr;

  std::vector<const char *> startup_ptrs;
  startup_ptrs.reserve(startup_args.size());
  for (const auto &arg : startup_args) {
    startup_ptrs.push_back(arg.c_str());
  }

  OliphauntConfig native_config = {};
  native_config.abi_version = OLIPHAUNT_ABI_VERSION;
  native_config.pgdata = pgdata.c_str();
  native_config.runtime_dir = runtime_dir.empty() ? nullptr : runtime_dir.c_str();
  native_config.username = username.c_str();
  native_config.database = database.c_str();
  native_config.reserved_flags = 0;
  native_config.startup_args = startup_ptrs.empty() ? nullptr : startup_ptrs.data();
  native_config.startup_arg_count = startup_ptrs.size();

  OliphauntHandle *handle = nullptr;
  uint64_t generation = 0;
  {
    std::lock_guard<std::mutex> guard(library->lifecycle_mutex);
    if (library->terminally_closed) {
      Throw(env, "native liboliphaunt environment has already shut down");
      return nullptr;
    }
    int32_t rc;
    if (module_dir.empty()) {
      rc = library->init(&native_config, &handle);
    } else {
      OliphauntInitOptions init_options = {};
      init_options.abi_version = OLIPHAUNT_INIT_OPTIONS_ABI_VERSION;
      init_options.module_dir = module_dir.c_str();
      init_options.reserved_flags = 0;
      rc = library->init_ex(&native_config, &init_options, &handle);
    }
    if (rc != 0) {
      Throw(env, "native liboliphaunt init failed: " + LastError(library.get(), nullptr));
      return nullptr;
    }
    if (handle == nullptr) {
      Throw(env, "native liboliphaunt init returned a null handle");
      return nullptr;
    }
    generation = library->logical_generation(handle);
    if (generation == 0) {
      // Another cleanup owner can terminally close and free the resident
      // handle between init and generation acquisition. A zero generation
      // therefore makes handle opaque and potentially stale: fail closed
      // without passing it to detach, close, last_error, or any other ABI.
      library->terminally_closed = true;
      library->resident_handle = nullptr;
      library->resident_generation = 0;
      library->owner_env = nullptr;
      Throw(env, "native liboliphaunt init returned an invalid logical generation");
      return nullptr;
    }
    library->resident_handle = handle;
    library->resident_generation = generation;
    library->owner_env = env;
  }
  auto *box = new NativeHandleBox();
  box->library = library;
  box->handle = handle;
  box->generation = generation;
  napi_value external = nullptr;
  if (!Check(env, napi_create_external(env, box, FinalizeHandle, nullptr, &external),
             "create native handle")) {
    std::lock_guard<std::mutex> guard(library->lifecycle_mutex);
    if (!library->terminally_closed && library->resident_handle == handle &&
        library->resident_generation == generation &&
        library->detach != nullptr) {
      (void)library->detach(handle);
    }
    delete box;
    return nullptr;
  }
  return external;
}

napi_value ExecProtocolRaw(napi_env env, napi_callback_info info) {
  auto args = Args(env, info, 2);
  if (args.empty()) return nullptr;
  NativeHandleBox *box = GetHandleBox(env, args[0]);
  if (box == nullptr) return nullptr;
  std::vector<uint8_t> request = GetBytes(env, args[1]);
  OliphauntResponse response = {};
  int32_t rc = box->library->exec_protocol(box->handle, request.data(), request.size(), &response);
  if (rc != 0) {
    box->library->free_response(&response);
    Throw(env, "native liboliphaunt protocol execution failed: " + LastError(box->library.get(), box->handle));
    return nullptr;
  }
  return MakeResponse(env, box->library.get(), &response);
}

napi_value ExecSimpleQuery(napi_env env, napi_callback_info info) {
  auto args = Args(env, info, 2);
  if (args.empty()) return nullptr;
  NativeHandleBox *box = GetHandleBox(env, args[0]);
  if (box == nullptr) return nullptr;
  std::string sql = ValueToString(env, args[1], "read SQL");
  OliphauntResponse response = {};
  int32_t rc = box->library->exec_simple_query(box->handle, sql.data(), sql.size(), &response);
  if (rc != 0) {
    box->library->free_response(&response);
    Throw(env, "native liboliphaunt simple query failed: " + LastError(box->library.get(), box->handle));
    return nullptr;
  }
  return MakeResponse(env, box->library.get(), &response);
}

struct StreamContext {
  napi_env env;
  napi_ref callback;
  std::string error;
};

int32_t StreamChunk(void *data, const uint8_t *bytes, size_t length) {
  auto *context = static_cast<StreamContext *>(data);
  napi_handle_scope scope = nullptr;
  if (napi_open_handle_scope(context->env, &scope) != napi_ok) {
    context->error = "open stream callback scope failed";
    return 1;
  }
  napi_value callback = nullptr;
  napi_get_reference_value(context->env, context->callback, &callback);
  napi_value global = nullptr;
  napi_get_global(context->env, &global);
  napi_value chunk = MakeBytes(context->env, bytes, length);
  napi_value result = nullptr;
  napi_status status = napi_call_function(context->env, global, callback, 1, &chunk, &result);
  napi_close_handle_scope(context->env, scope);
  if (status != napi_ok) {
    context->error = "stream callback failed";
    return 1;
  }
  return 0;
}

napi_value ExecProtocolStream(napi_env env, napi_callback_info info) {
  auto args = Args(env, info, 3);
  if (args.empty()) return nullptr;
  NativeHandleBox *box = GetHandleBox(env, args[0]);
  if (box == nullptr) return nullptr;
  std::vector<uint8_t> request = GetBytes(env, args[1]);
  StreamContext context = {env, nullptr, {}};
  Check(env, napi_create_reference(env, args[2], 1, &context.callback), "create stream callback reference");
  int32_t rc = box->library->exec_protocol_stream(
      box->handle, request.data(), request.size(), StreamChunk, &context);
  napi_delete_reference(env, context.callback);
  if (!context.error.empty()) {
    Throw(env, context.error);
    return nullptr;
  }
  if (rc != 0) {
    Throw(env, "native liboliphaunt protocol streaming failed: " + LastError(box->library.get(), box->handle));
    return nullptr;
  }
  napi_value out = nullptr;
  Check(env, napi_get_undefined(env, &out), "create undefined");
  return out;
}

napi_value Backup(napi_env env, napi_callback_info info) {
  auto args = Args(env, info, 2);
  if (args.empty()) return nullptr;
  NativeHandleBox *box = GetHandleBox(env, args[0]);
  if (box == nullptr) return nullptr;
  uint32_t format = 0;
  Check(env, napi_get_value_uint32(env, args[1], &format), "read backup format");
  OliphauntResponse response = {};
  int32_t rc = box->library->backup(box->handle, format, &response);
  if (rc != 0) {
    box->library->free_response(&response);
    Throw(env, "native liboliphaunt backup failed: " + LastError(box->library.get(), box->handle));
    return nullptr;
  }
  return MakeResponse(env, box->library.get(), &response);
}

napi_value Restore(napi_env env, napi_callback_info info) {
  auto args = Args(env, info, 1);
  if (args.empty()) return nullptr;
  napi_value options = args[0];
  std::string library_path = GetString(env, options, "libraryPath");
  auto library = LoadNativeLibrary(env, library_path);
  if (library == nullptr) return nullptr;
  std::string root = GetString(env, options, "root");
  uint32_t format = GetUint32(env, options, "format");
  std::vector<uint8_t> bytes = GetBytes(env, GetNamed(env, options, "bytes"));
  bool replace = GetBool(env, options, "replaceExisting");
  OliphauntRestoreOptions native_options = {};
  native_options.abi_version = OLIPHAUNT_ABI_VERSION;
  native_options.root = root.c_str();
  native_options.format = format;
  native_options.data = bytes.empty() ? nullptr : bytes.data();
  native_options.len = bytes.size();
  native_options.flags = replace ? OLIPHAUNT_RESTORE_REPLACE_EXISTING : 0;
  int32_t rc = library->restore(&native_options);
  if (rc != 0) {
    Throw(env, "native liboliphaunt restore failed: " + LastError(library.get(), nullptr));
    return nullptr;
  }
  napi_value out = nullptr;
  Check(env, napi_get_undefined(env, &out), "create undefined");
  return out;
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

napi_value Detach(napi_env env, napi_callback_info info) {
  auto args = Args(env, info, 1);
  if (args.empty()) return nullptr;
  NativeHandleBox *box = GetHandleBox(env, args[0]);
  if (box == nullptr) return nullptr;
  std::lock_guard<std::mutex> guard(box->library->lifecycle_mutex);
  if (box->library->terminally_closed || box->library->resident_handle != box->handle ||
      box->library->resident_generation != box->generation) {
    box->detached = true;
    box->handle = nullptr;
    Throw(env, "native liboliphaunt environment has already shut down");
    return nullptr;
  }
  int32_t rc = box->library->detach(box->handle);
  if (rc != 0) {
    Throw(env, "native liboliphaunt detach failed: " + LastError(box->library.get(), box->handle));
    return nullptr;
  }
  box->detached = true;
  box->handle = nullptr;
  napi_value out = nullptr;
  Check(env, napi_get_undefined(env, &out), "create undefined");
  return out;
}

napi_value Init(napi_env env, napi_value exports) {
  auto *environment = new AddonEnvironment{env};
  if (!Check(env, napi_add_env_cleanup_hook(env, CleanupEnvironment, environment),
             "register native environment cleanup")) {
    delete environment;
    return nullptr;
  }
  const napi_property_descriptor descriptors[] = {
      {"version", nullptr, Version, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"capabilities", nullptr, Capabilities, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"open", nullptr, Open, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"execProtocolRaw", nullptr, ExecProtocolRaw, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"execSimpleQuery", nullptr, ExecSimpleQuery, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"execProtocolStream", nullptr, ExecProtocolStream, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"backup", nullptr, Backup, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"restore", nullptr, Restore, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"cancel", nullptr, Cancel, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"detach", nullptr, Detach, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  Check(env, napi_define_properties(env, exports, sizeof(descriptors) / sizeof(descriptors[0]), descriptors),
        "define exports");
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
