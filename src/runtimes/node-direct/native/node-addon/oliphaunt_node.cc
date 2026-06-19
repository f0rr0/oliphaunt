#include <node_api.h>

#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#if defined(_WIN32)
#include <windows.h>
#else
#include <dlfcn.h>
#endif

namespace {

constexpr uint32_t kAbiVersion = 6;
constexpr uint64_t kRestoreReplaceExisting = 1;

struct OliphauntHandle;

struct OliphauntConfig {
  uint32_t abi_version;
  const char *pgdata;
  const char *runtime_dir;
  const char *username;
  const char *database;
  uint64_t reserved_flags;
  const char *const *startup_args;
  size_t startup_arg_count;
};

struct OliphauntResponse {
  uint8_t *data;
  size_t len;
};

struct OliphauntRestoreOptions {
  uint32_t abi_version;
  const char *root;
  uint32_t format;
  const uint8_t *data;
  size_t len;
  uint64_t flags;
};

using StreamCallback = int32_t (*)(void *, const uint8_t *, size_t);

using InitFn = int32_t (*)(const OliphauntConfig *, OliphauntHandle **);
using ExecProtocolFn = int32_t (*)(OliphauntHandle *, const uint8_t *, size_t, OliphauntResponse *);
using ExecSimpleQueryFn = int32_t (*)(OliphauntHandle *, const char *, size_t, OliphauntResponse *);
using ExecProtocolStreamFn = int32_t (*)(
    OliphauntHandle *, const uint8_t *, size_t, StreamCallback, void *);
using BackupFn = int32_t (*)(OliphauntHandle *, uint32_t, OliphauntResponse *);
using RestoreFn = int32_t (*)(const OliphauntRestoreOptions *);
using CancelFn = int32_t (*)(OliphauntHandle *);
using DetachFn = int32_t (*)(OliphauntHandle *);
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
  ExecProtocolFn exec_protocol = nullptr;
  ExecSimpleQueryFn exec_simple_query = nullptr;
  ExecProtocolStreamFn exec_protocol_stream = nullptr;
  BackupFn backup = nullptr;
  RestoreFn restore = nullptr;
  CancelFn cancel = nullptr;
  DetachFn detach = nullptr;
  LastErrorFn last_error = nullptr;
  VersionFn version = nullptr;
  CapabilitiesFn capabilities = nullptr;
  FreeResponseFn free_response = nullptr;
};

struct NativeHandleBox {
  std::shared_ptr<NativeLibrary> library;
  OliphauntHandle *handle = nullptr;
  bool detached = false;
};

std::mutex g_libraries_mutex;
std::map<std::string, std::shared_ptr<NativeLibrary>> g_libraries;

void Throw(napi_env env, const std::string &message) { napi_throw_error(env, nullptr, message.c_str()); }

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

std::shared_ptr<NativeLibrary> LoadNativeLibrary(napi_env env, const std::string &path) {
  std::lock_guard<std::mutex> guard(g_libraries_mutex);
  auto existing = g_libraries.find(path);
  if (existing != g_libraries.end()) {
    return existing->second;
  }

  DynamicLibrary dynamic;
#if defined(_WIN32)
  dynamic.handle = LoadLibraryA(path.c_str());
#else
  dynamic.handle = dlopen(path.c_str(), RTLD_NOW | RTLD_LOCAL);
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

  auto library = std::make_shared<NativeLibrary>();
  library->library = dynamic;
  library->init = reinterpret_cast<InitFn>(LoadSymbol(env, dynamic, "oliphaunt_init"));
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
    if (!box->detached && box->handle != nullptr && box->library != nullptr && box->library->detach != nullptr) {
      box->library->detach(box->handle);
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
  native_config.abi_version = kAbiVersion;
  native_config.pgdata = pgdata.c_str();
  native_config.runtime_dir = runtime_dir.empty() ? nullptr : runtime_dir.c_str();
  native_config.username = username.c_str();
  native_config.database = database.c_str();
  native_config.reserved_flags = 0;
  native_config.startup_args = startup_ptrs.empty() ? nullptr : startup_ptrs.data();
  native_config.startup_arg_count = startup_ptrs.size();

  OliphauntHandle *handle = nullptr;
  int32_t rc = library->init(&native_config, &handle);
  if (rc != 0) {
    Throw(env, "native liboliphaunt init failed: " + LastError(library.get(), nullptr));
    return nullptr;
  }
  if (handle == nullptr) {
    Throw(env, "native liboliphaunt init returned a null handle");
    return nullptr;
  }
  auto *box = new NativeHandleBox();
  box->library = library;
  box->handle = handle;
  napi_value external = nullptr;
  Check(env, napi_create_external(env, box, FinalizeHandle, nullptr, &external), "create native handle");
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
  native_options.abi_version = kAbiVersion;
  native_options.root = root.c_str();
  native_options.format = format;
  native_options.data = bytes.empty() ? nullptr : bytes.data();
  native_options.len = bytes.size();
  native_options.flags = replace ? kRestoreReplaceExisting : 0;
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
