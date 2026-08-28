#include "oliphaunt.h"
#include "stream_completion.h"

#include <dlfcn.h>
#include <jni.h>

#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <string>
#include <vector>

namespace {

using OliphauntInitFn = int32_t (*)(const OliphauntConfig *, OliphauntHandle **);
using OliphauntExecProtocolFn = int32_t (*)(
    OliphauntHandle *,
    const uint8_t *,
    size_t,
    OliphauntResponse *);
using OliphauntExecProtocolRawStreamFn = int32_t (*)(
    OliphauntHandle *,
    const uint8_t *,
    size_t,
    OliphauntStreamCallback,
    void *);
using OliphauntCancelFn = int32_t (*)(OliphauntHandle *);
using OliphauntDetachFn = int32_t (*)(OliphauntHandle *);
using OliphauntCloseFn = int32_t (*)(OliphauntHandle *);
using OliphauntRegisterStaticExtensionsFn = int32_t (*)(const OliphauntStaticExtension *, size_t);
using OliphauntSelectedStaticExtensionsFn = const OliphauntStaticExtension *(*)(size_t *);
using OliphauntCopyLastErrorFn = size_t (*)(OliphauntHandle *, char *, size_t);
using OliphauntFreeResponseFn = void (*)(OliphauntResponse *);
using OliphauntBackupFn = int32_t (*)(OliphauntHandle *, OliphauntResponse *);
using OliphauntRestoreFn = int32_t (*)(const OliphauntRestoreOptions *);

struct Symbols {
  void *library = nullptr;
  bool ownsLibrary = false;
  OliphauntInitFn init = nullptr;
  OliphauntExecProtocolFn execProtocol = nullptr;
  OliphauntExecProtocolRawStreamFn execProtocolRawStream = nullptr;
  OliphauntCancelFn cancel = nullptr;
  OliphauntDetachFn detach = nullptr;
  OliphauntCloseFn close = nullptr;
  OliphauntRegisterStaticExtensionsFn registerStaticExtensions = nullptr;
  OliphauntCopyLastErrorFn copyLastError = nullptr;
  OliphauntFreeResponseFn freeResponse = nullptr;
  OliphauntBackupFn backup = nullptr;
  OliphauntRestoreFn restore = nullptr;
};

struct Session {
  Symbols symbols;
  OliphauntHandle *handle = nullptr;
};

struct StreamContext {
  JNIEnv *env = nullptr;
  jobject sink = nullptr;
  jmethodID onChunk = nullptr;
  bool failed = false;
};

std::string jniString(JNIEnv *env, jstring value) {
  if (value == nullptr) {
    return {};
  }
  const char *chars = env->GetStringUTFChars(value, nullptr);
  if (chars == nullptr) {
    return {};
  }
  std::string out(chars);
  env->ReleaseStringUTFChars(value, chars);
  return out;
}

std::vector<std::string> jniStringArray(JNIEnv *env, jobjectArray values) {
  std::vector<std::string> out;
  if (values == nullptr) {
    return out;
  }
  const jsize count = env->GetArrayLength(values);
  out.reserve(static_cast<size_t>(count));
  for (jsize index = 0; index < count; index += 1) {
    auto item = static_cast<jstring>(env->GetObjectArrayElement(values, index));
    out.push_back(jniString(env, item));
    env->DeleteLocalRef(item);
  }
  return out;
}

void throwException(JNIEnv *env, const char *className, const std::string &message) {
  jclass cls = env->FindClass(className);
  if (cls == nullptr) {
    return;
  }
  env->ThrowNew(cls, message.c_str());
  env->DeleteLocalRef(cls);
}

void throwIllegalState(JNIEnv *env, const std::string &message) {
  throwException(env, "java/lang/IllegalStateException", message);
}

void throwRuntime(JNIEnv *env, const std::string &message) {
  throwException(env, "java/lang/RuntimeException", message);
}

const char *envPath(const char *name) {
  const char *value = std::getenv(name);
  return value != nullptr && value[0] != '\0' ? value : nullptr;
}

std::string defaultLibraryPath() {
  const char *path = envPath("OLIPHAUNT_KOTLIN_ANDROID_LIBRARY");
  if (path == nullptr) {
    path = envPath("LIBOLIPHAUNT_PATH");
  }
  if (path == nullptr) {
    path = envPath("OLIPHAUNT_LIBRARY");
  }
  return path != nullptr ? std::string(path) : std::string("liboliphaunt.so");
}

void unloadSymbols(Symbols *symbols) {
  // liboliphaunt embeds PostgreSQL, which installs process-global runtime state
  // while a backend session is active. Ordinary SDK close calls oliphaunt_detach;
  // oliphaunt_close is terminal for the process lifetime. Unloading the code image
  // can leave host-process callbacks or handlers pointing at unmapped addresses.
  // Keep the native engine resident once it has been loaded.
  *symbols = Symbols{};
}

bool loadSymbol(Symbols *symbols, const char *name, void **out, std::string *error) {
  dlerror();
  void *lookupHandle = symbols->library != nullptr ? symbols->library : RTLD_DEFAULT;
  *out = dlsym(lookupHandle, name);
  const char *dlError = dlerror();
  if (dlError != nullptr || *out == nullptr) {
    *error = "liboliphaunt symbol ";
    *error += name;
    *error += " is unavailable: ";
    *error += dlError != nullptr ? dlError : "symbol not found";
    return false;
  }
  return true;
}

bool loadSymbols(const std::string &configuredLibraryPath, Symbols *symbols, std::string *error) {
  *symbols = Symbols{};
  std::string libraryPath = configuredLibraryPath.empty()
      ? defaultLibraryPath()
      : configuredLibraryPath;

  if (!libraryPath.empty()) {
    symbols->library = dlopen(libraryPath.c_str(), RTLD_NOW | RTLD_GLOBAL);
    if (symbols->library == nullptr && configuredLibraryPath.empty()) {
      libraryPath.clear();
    } else if (symbols->library == nullptr) {
      *error = "failed to load liboliphaunt at ";
      *error += configuredLibraryPath;
      *error += ": ";
      *error += dlerror();
      return false;
    } else {
      symbols->ownsLibrary = true;
    }
  }

  if (!loadSymbol(symbols, "oliphaunt_init", reinterpret_cast<void **>(&symbols->init), error) ||
      !loadSymbol(symbols, "oliphaunt_exec_protocol", reinterpret_cast<void **>(&symbols->execProtocol), error) ||
      !loadSymbol(symbols, "oliphaunt_exec_protocol_raw_stream", reinterpret_cast<void **>(&symbols->execProtocolRawStream), error) ||
      !loadSymbol(symbols, "oliphaunt_cancel", reinterpret_cast<void **>(&symbols->cancel), error) ||
      !loadSymbol(symbols, "oliphaunt_detach", reinterpret_cast<void **>(&symbols->detach), error) ||
      !loadSymbol(symbols, "oliphaunt_close", reinterpret_cast<void **>(&symbols->close), error) ||
      !loadSymbol(symbols, "oliphaunt_register_static_extensions", reinterpret_cast<void **>(&symbols->registerStaticExtensions), error) ||
      !loadSymbol(symbols, "oliphaunt_copy_last_error", reinterpret_cast<void **>(&symbols->copyLastError), error) ||
      !loadSymbol(symbols, "oliphaunt_free_response", reinterpret_cast<void **>(&symbols->freeResponse), error) ||
      !loadSymbol(symbols, "oliphaunt_backup", reinterpret_cast<void **>(&symbols->backup), error) ||
      !loadSymbol(symbols, "oliphaunt_restore", reinterpret_cast<void **>(&symbols->restore), error)) {
    unloadSymbols(symbols);
    if (libraryPath.empty()) {
      *error += "; package liboliphaunt.so with the app or pass libraryPath";
    }
    return false;
  }
  return true;
}

bool registerSelectedStaticExtensions(Symbols *symbols, std::string *error) {
  dlerror();
  OliphauntSelectedStaticExtensionsFn selected = nullptr;
  static void *extensionLibrary = nullptr;
  if (symbols->library != nullptr) {
    selected = reinterpret_cast<OliphauntSelectedStaticExtensionsFn>(
        dlsym(symbols->library, "liboliphaunt_selected_static_extensions"));
    const char *libraryError = dlerror();
    if (libraryError != nullptr) {
      selected = nullptr;
    }
    dlerror();
  }
  if (selected == nullptr && extensionLibrary == nullptr) {
    extensionLibrary = dlopen("liboliphaunt_extensions.so", RTLD_NOW | RTLD_GLOBAL);
    dlerror();
  }
  if (selected == nullptr && extensionLibrary != nullptr) {
    selected = reinterpret_cast<OliphauntSelectedStaticExtensionsFn>(
        dlsym(extensionLibrary, "liboliphaunt_selected_static_extensions"));
    const char *extensionError = dlerror();
    if (extensionError != nullptr) {
      selected = nullptr;
    }
    dlerror();
  }
  if (selected == nullptr) {
    selected = reinterpret_cast<OliphauntSelectedStaticExtensionsFn>(
        dlsym(RTLD_DEFAULT, "liboliphaunt_selected_static_extensions"));
  }
  const char *dlError = dlerror();
  if (dlError != nullptr || selected == nullptr) {
    return true;
  }
  size_t count = 0;
  const OliphauntStaticExtension *extensions = selected(&count);
  if (count == 0) {
    return true;
  }
  if (extensions == nullptr) {
    *error = "selected liboliphaunt static extension registry returned null extensions";
    return false;
  }
  if (symbols->registerStaticExtensions(extensions, count) != 0) {
    const char *fallback = "liboliphaunt static extension registration failed";
    size_t required = symbols->copyLastError(nullptr, nullptr, 0);
    if (required == 0 || required == std::numeric_limits<size_t>::max()) {
      *error = fallback;
    } else {
      std::vector<char> message(required + 1, '\0');
      size_t currentRequired = symbols->copyLastError(nullptr, message.data(), message.size());
      if (currentRequired >= message.size() && currentRequired != std::numeric_limits<size_t>::max()) {
        message.assign(currentRequired + 1, '\0');
        symbols->copyLastError(nullptr, message.data(), message.size());
      }
      *error = message[0] != '\0' ? std::string(message.data()) : fallback;
    }
    return false;
  }
  return true;
}

Session *sessionFromHandle(jlong handle) {
  return reinterpret_cast<Session *>(static_cast<intptr_t>(handle));
}

int32_t streamCallback(void *context, const uint8_t *data, size_t len) {
  auto *stream = static_cast<StreamContext *>(context);
  if (stream == nullptr || stream->env == nullptr || stream->sink == nullptr || stream->onChunk == nullptr) {
    return -1;
  }
  jbyteArray chunk = stream->env->NewByteArray(static_cast<jsize>(len));
  if (chunk == nullptr) {
    stream->failed = true;
    return -1;
  }
  if (len > 0 && data != nullptr) {
    stream->env->SetByteArrayRegion(
        chunk,
        0,
        static_cast<jsize>(len),
        reinterpret_cast<const jbyte *>(data));
    if (stream->env->ExceptionCheck()) {
      stream->failed = true;
      stream->env->DeleteLocalRef(chunk);
      return -1;
    }
  }
  jint rc = stream->env->CallIntMethod(stream->sink, stream->onChunk, chunk);
  stream->env->DeleteLocalRef(chunk);
  if (stream->env->ExceptionCheck()) {
    stream->failed = true;
    return -1;
  }
  if (rc != 0) {
    stream->failed = true;
    return -1;
  }
  return 0;
}

std::string lastError(Session *session) {
  if (session == nullptr) {
    return "invalid liboliphaunt Android session";
  }
  const char *fallback = "unknown liboliphaunt Android runtime error";
  if (session->symbols.copyLastError == nullptr) {
    return fallback;
  }
  size_t required = session->symbols.copyLastError(session->handle, nullptr, 0);
  if (required == 0 || required == std::numeric_limits<size_t>::max()) {
    return fallback;
  }
  std::vector<char> message(required + 1, '\0');
  size_t currentRequired = session->symbols.copyLastError(
      session->handle,
      message.data(),
      message.size());
  if (currentRequired >= message.size() && currentRequired != std::numeric_limits<size_t>::max()) {
    message.assign(currentRequired + 1, '\0');
    session->symbols.copyLastError(session->handle, message.data(), message.size());
  }
  return message[0] != '\0' ? std::string(message.data()) : fallback;
}

}  // namespace

extern "C" JNIEXPORT jlong JNICALL
Java_dev_oliphaunt_OliphauntAndroidNativeBridge_openNative(
    JNIEnv *env,
    jobject,
    jstring libraryPath,
    jstring pgdata,
    jstring runtimeDirectory,
    jstring username,
    jstring database,
    jobjectArray startupArgs) {
  auto session = new Session();
  std::string error;
  if (!loadSymbols(jniString(env, libraryPath), &session->symbols, &error)) {
    delete session;
    throwRuntime(env, error);
    return 0;
  }
  if (!registerSelectedStaticExtensions(&session->symbols, &error)) {
    unloadSymbols(&session->symbols);
    delete session;
    throwRuntime(env, error);
    return 0;
  }

  std::vector<std::string> args = jniStringArray(env, startupArgs);
  std::vector<const char *> argPointers;
  argPointers.reserve(args.size());
  for (const auto &arg : args) {
    argPointers.push_back(arg.c_str());
  }

  std::string pgdataPath = jniString(env, pgdata);
  std::string runtimePath = jniString(env, runtimeDirectory);
  std::string usernameString = jniString(env, username);
  std::string databaseString = jniString(env, database);
  OliphauntConfig config = {
      .abi_version = OLIPHAUNT_ABI_VERSION,
      .pgdata = pgdataPath.c_str(),
      .runtime_dir = runtimePath.c_str(),
      .module_dir = nullptr,
      .username = usernameString.c_str(),
      .database = databaseString.c_str(),
      .flags = 0,
      .startup_args = argPointers.data(),
      .startup_arg_count = argPointers.size(),
  };

  int32_t rc = session->symbols.init(&config, &session->handle);
  if (rc != 0 || session->handle == nullptr) {
    error = lastError(session);
    unloadSymbols(&session->symbols);
    delete session;
    throwRuntime(env, error);
    return 0;
  }

  return static_cast<jlong>(reinterpret_cast<intptr_t>(session));
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_dev_oliphaunt_OliphauntAndroidNativeBridge_execProtocolRawNative(
    JNIEnv *env,
    jobject,
    jlong handle,
    jbyteArray request) {
  Session *session = sessionFromHandle(handle);
  if (session == nullptr || session->handle == nullptr) {
    throwIllegalState(env, "Oliphaunt database is closed");
    return nullptr;
  }
  if (request == nullptr) {
    throwRuntime(env, "request must not be null");
    return nullptr;
  }

  const jsize requestLength = env->GetArrayLength(request);
  std::vector<uint8_t> requestBytes(static_cast<size_t>(requestLength));
  if (requestLength > 0) {
    env->GetByteArrayRegion(
        request,
        0,
        requestLength,
        reinterpret_cast<jbyte *>(requestBytes.data()));
    if (env->ExceptionCheck()) {
      return nullptr;
    }
  }

  OliphauntResponse response = {nullptr, 0};
  int32_t rc = session->symbols.execProtocol(
      session->handle,
      requestBytes.empty() ? nullptr : requestBytes.data(),
      requestBytes.size(),
      &response);
  if (rc != 0) {
    std::string error = lastError(session);
    if (session->symbols.freeResponse != nullptr) {
      session->symbols.freeResponse(&response);
    }
    throwRuntime(env, error);
    return nullptr;
  }

  jbyteArray out = env->NewByteArray(static_cast<jsize>(response.len));
  if (out != nullptr && response.len > 0) {
    env->SetByteArrayRegion(
        out,
        0,
        static_cast<jsize>(response.len),
        reinterpret_cast<const jbyte *>(response.data));
  }
  session->symbols.freeResponse(&response);
  return out;
}

extern "C" JNIEXPORT jboolean JNICALL
Java_dev_oliphaunt_OliphauntAndroidNativeBridge_execProtocolRawStreamNative(
    JNIEnv *env,
    jobject,
    jlong handle,
    jbyteArray request,
    jobject sink) {
  Session *session = sessionFromHandle(handle);
  if (session == nullptr || session->handle == nullptr) {
    throwIllegalState(env, "Oliphaunt database is closed");
    return JNI_FALSE;
  }
  if (request == nullptr) {
    throwRuntime(env, "request must not be null");
    return JNI_FALSE;
  }
  if (sink == nullptr) {
    throwRuntime(env, "stream sink must not be null");
    return JNI_FALSE;
  }

  const jsize requestLength = env->GetArrayLength(request);
  std::vector<uint8_t> requestBytes(static_cast<size_t>(requestLength));
  if (requestLength > 0) {
    env->GetByteArrayRegion(
        request,
        0,
        requestLength,
        reinterpret_cast<jbyte *>(requestBytes.data()));
    if (env->ExceptionCheck()) {
      return JNI_FALSE;
    }
  }

  jclass sinkClass = env->GetObjectClass(sink);
  if (sinkClass == nullptr) {
    return JNI_FALSE;
  }
  jmethodID onChunk = env->GetMethodID(sinkClass, "onChunk", "([B)I");
  env->DeleteLocalRef(sinkClass);
  if (onChunk == nullptr) {
    throwRuntime(env, "stream sink is missing onChunk(byte[])");
    return JNI_FALSE;
  }

  StreamContext stream;
  stream.env = env;
  stream.sink = sink;
  stream.onChunk = onChunk;
  int32_t rc = session->symbols.execProtocolRawStream(
      session->handle,
      requestBytes.empty() ? nullptr : requestBytes.data(),
      requestBytes.size(),
      streamCallback,
      &stream);
  using oliphaunt::android_bridge::StreamCompletion;
  switch (oliphaunt::android_bridge::classifyStreamCompletion(rc, stream.failed)) {
    case StreamCompletion::Success:
      return JNI_FALSE;
    case StreamCompletion::CallbackAborted:
      // Expected Kotlin callback failures are captured by the sink. Any
      // unexpected pending JNI exception remains pending when JNI returns.
      return JNI_TRUE;
    case StreamCompletion::NativeFailure: {
      // Capture the same-thread native diagnostic before touching JNI state.
      // Transport or recovery failure is authoritative over a callback error.
      std::string nativeError = lastError(session);
      if (env->ExceptionCheck()) {
        env->ExceptionClear();
      }
      throwRuntime(env, nativeError);
      return JNI_FALSE;
    }
    case StreamCompletion::ProtocolInconsistency:
      if (env->ExceptionCheck()) {
        env->ExceptionClear();
      }
      if (rc == 0) {
        throwRuntime(
            env,
            "liboliphaunt returned protocol stream success after the callback failed");
      } else if (rc == OLIPHAUNT_STREAM_CALLBACK_ABORTED) {
        throwRuntime(
            env,
            "liboliphaunt reported a recovered callback abort without a callback failure");
      } else {
        throwRuntime(
            env,
            "liboliphaunt returned an unknown positive protocol stream result");
      }
      return JNI_FALSE;
  }
  throwRuntime(env, "unreachable protocol stream completion state");
  return JNI_FALSE;
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_dev_oliphaunt_OliphauntAndroidNativeBridge_backupNative(
    JNIEnv *env,
    jobject,
    jlong handle) {
  Session *session = sessionFromHandle(handle);
  if (session == nullptr || session->handle == nullptr) {
    throwIllegalState(env, "Oliphaunt database is closed");
    return nullptr;
  }
  OliphauntResponse response = {nullptr, 0};
  int32_t rc = session->symbols.backup(session->handle, &response);
  if (rc != 0) {
    std::string error = lastError(session);
    if (session->symbols.freeResponse != nullptr) {
      session->symbols.freeResponse(&response);
    }
    throwRuntime(env, error);
    return nullptr;
  }

  jbyteArray out = env->NewByteArray(static_cast<jsize>(response.len));
  if (out != nullptr && response.len > 0) {
    env->SetByteArrayRegion(
        out,
        0,
        static_cast<jsize>(response.len),
        reinterpret_cast<const jbyte *>(response.data));
  }
  session->symbols.freeResponse(&response);
  return out;
}

extern "C" JNIEXPORT void JNICALL
Java_dev_oliphaunt_OliphauntAndroidNativeBridge_restoreNative(
    JNIEnv *env,
    jobject,
    jstring destination,
    jbyteArray bytes,
    jstring libraryPath) {
  if (bytes == nullptr) {
    throwRuntime(env, "backup bytes must not be null");
    return;
  }

  Symbols symbols;
  std::string error;
  if (!loadSymbols(jniString(env, libraryPath), &symbols, &error)) {
    throwRuntime(env, error);
    return;
  }

  std::string destinationPath = jniString(env, destination);
  const jsize byteLength = env->GetArrayLength(bytes);
  std::vector<uint8_t> backupBytes(static_cast<size_t>(byteLength));
  if (byteLength > 0) {
    env->GetByteArrayRegion(
        bytes,
        0,
        byteLength,
        reinterpret_cast<jbyte *>(backupBytes.data()));
    if (env->ExceptionCheck()) {
      unloadSymbols(&symbols);
      return;
    }
  }

  OliphauntRestoreOptions options = {
      .abi_version = OLIPHAUNT_ABI_VERSION,
      .destination = destinationPath.c_str(),
      .data = backupBytes.empty() ? nullptr : backupBytes.data(),
      .len = backupBytes.size(),
  };
  int32_t rc = symbols.restore(&options);
  if (rc != 0) {
    const char *fallback = "liboliphaunt restore failed";
    size_t required = symbols.copyLastError(nullptr, nullptr, 0);
    if (required == 0 || required == std::numeric_limits<size_t>::max()) {
      error = fallback;
    } else {
      std::vector<char> message(required + 1, '\0');
      size_t currentRequired = symbols.copyLastError(nullptr, message.data(), message.size());
      if (currentRequired >= message.size() && currentRequired != std::numeric_limits<size_t>::max()) {
        message.assign(currentRequired + 1, '\0');
        symbols.copyLastError(nullptr, message.data(), message.size());
      }
      error = message[0] != '\0' ? std::string(message.data()) : fallback;
    }
    unloadSymbols(&symbols);
    throwRuntime(env, error);
    return;
  }
  unloadSymbols(&symbols);
}

extern "C" JNIEXPORT void JNICALL
Java_dev_oliphaunt_OliphauntAndroidNativeBridge_cancelNative(
    JNIEnv *env,
    jobject,
    jlong handle) {
  Session *session = sessionFromHandle(handle);
  if (session == nullptr || session->handle == nullptr) {
    throwIllegalState(env, "Oliphaunt database is closed");
    return;
  }
  int32_t rc = session->symbols.cancel(session->handle);
  if (rc != 0) {
    throwRuntime(env, lastError(session));
  }
}

extern "C" JNIEXPORT void JNICALL
Java_dev_oliphaunt_OliphauntAndroidNativeBridge_closeNative(
    JNIEnv *env,
    jobject,
    jlong handle) {
  Session *session = sessionFromHandle(handle);
  if (session == nullptr) {
    return;
  }
  int32_t rc = 0;
  std::string error;
  if (session->handle != nullptr) {
    rc = session->symbols.detach(session->handle);
    if (rc != 0) {
      error = lastError(session);
      throwRuntime(env, error.empty() ? "liboliphaunt close failed" : error);
      return;
    }
    session->handle = nullptr;
  }
  unloadSymbols(&session->symbols);
  delete session;
}
