#include <ReactCommon/BindingsInstallerHolder.h>
#include <ReactCommon/CallInvoker.h>
#include <fbjni/fbjni.h>
#include <jsi/jsi.h>
#include <react/bridging/Function.h>

#include <atomic>
#include <cmath>
#include <cstdint>
#include <memory>
#include <mutex>
#include <limits>
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

namespace facebook::react {
namespace {

class OliphauntMutableBuffer final : public jsi::MutableBuffer {
 public:
  explicit OliphauntMutableBuffer(std::vector<uint8_t> bytes)
      : bytes_(std::move(bytes)) {}

  size_t size() const override
  {
    return bytes_.size();
  }

  uint8_t *data() override
  {
    return bytes_.data();
  }

 private:
  std::vector<uint8_t> bytes_;
};

struct PendingPromise final {
  std::shared_ptr<AsyncCallback<>> resolve;
  std::shared_ptr<AsyncCallback<>> reject;
};

struct PendingStream final {
  std::shared_ptr<AsyncCallback<>> onChunk;
  std::shared_ptr<AsyncCallback<>> resolve;
  std::shared_ptr<AsyncCallback<>> reject;
};

std::mutex gPendingMutex;
std::unordered_map<int64_t, PendingPromise> gPendingPromises;
std::unordered_map<int64_t, std::shared_ptr<PendingStream>> gPendingStreams;
std::atomic<int64_t> gNextToken{1};

jsi::ArrayBuffer arrayBufferFromBytes(jsi::Runtime &runtime, std::vector<uint8_t> bytes)
{
  return jsi::ArrayBuffer(
      runtime,
      std::make_shared<OliphauntMutableBuffer>(std::move(bytes)));
}

jsi::Value createError(jsi::Runtime &runtime, const std::string &message)
{
  return runtime.global()
      .getPropertyAsFunction(runtime, "Error")
      .callAsConstructor(runtime, jsi::String::createFromUtf8(runtime, message));
}

size_t copySizeArgument(jsi::Runtime &runtime, double value, const char *name)
{
  constexpr double kMaxSafeInteger = 9007199254740991.0;
  if (!std::isfinite(value) ||
      value < 0 ||
      std::trunc(value) != value ||
      value > kMaxSafeInteger ||
      value > static_cast<double>(std::numeric_limits<size_t>::max())) {
    throw jsi::JSError(
        runtime,
        std::string("liboliphaunt JSI ") + name + " must be a non-negative integer");
  }
  return static_cast<size_t>(value);
}

int64_t copyHandleArgument(jsi::Runtime &runtime, const jsi::Value &value)
{
  constexpr double kMaxSafeInteger = 9007199254740991.0;
  if (!value.isNumber()) {
    throw jsi::JSError(runtime, "liboliphaunt JSI handle must be a number");
  }
  double handle = value.asNumber();
  if (!std::isfinite(handle) ||
      handle <= 0 ||
      std::trunc(handle) != handle ||
      handle > kMaxSafeInteger ||
      handle > static_cast<double>(std::numeric_limits<int64_t>::max())) {
    throw jsi::JSError(runtime, "liboliphaunt JSI handle must be a positive safe integer");
  }
  return static_cast<int64_t>(handle);
}

std::vector<uint8_t> copyBinaryArgument(jsi::Runtime &runtime, const jsi::Value &value)
{
  if (!value.isObject()) {
    throw jsi::JSError(runtime, "liboliphaunt JSI request must be an ArrayBuffer or typed array");
  }

  auto object = value.asObject(runtime);
  size_t byteOffset = 0;
  size_t byteLength = 0;
  jsi::ArrayBuffer buffer = [&]() {
    if (object.isArrayBuffer(runtime)) {
      auto arrayBuffer = object.getArrayBuffer(runtime);
      byteLength = arrayBuffer.size(runtime);
      return arrayBuffer;
    }

    auto bufferValue = object.getProperty(runtime, "buffer");
    if (!bufferValue.isObject() || !bufferValue.asObject(runtime).isArrayBuffer(runtime)) {
      throw jsi::JSError(runtime, "liboliphaunt JSI request must be an ArrayBuffer or typed array");
    }
    auto offsetValue = object.getProperty(runtime, "byteOffset");
    auto lengthValue = object.getProperty(runtime, "byteLength");
    if (!offsetValue.isNumber() || !lengthValue.isNumber()) {
      throw jsi::JSError(runtime, "liboliphaunt JSI typed-array request is missing byteOffset/byteLength");
    }
    byteOffset = copySizeArgument(runtime, offsetValue.asNumber(), "typed-array byteOffset");
    byteLength = copySizeArgument(runtime, lengthValue.asNumber(), "typed-array byteLength");
    return bufferValue.asObject(runtime).getArrayBuffer(runtime);
  }();

  if (byteOffset > buffer.size(runtime) || byteLength > buffer.size(runtime) - byteOffset) {
    throw jsi::JSError(runtime, "liboliphaunt JSI typed-array request is out of bounds");
  }

  const uint8_t *begin = buffer.data(runtime) + byteOffset;
  return std::vector<uint8_t>(begin, begin + byteLength);
}

std::string copyStringArgument(jsi::Runtime &runtime, const jsi::Value &value, const char *name)
{
  if (!value.isString()) {
    throw jsi::JSError(runtime, std::string("liboliphaunt JSI ") + name + " must be a string");
  }
  return value.asString(runtime).utf8(runtime);
}

std::optional<std::string> copyOptionalStringArgument(
    jsi::Runtime &runtime,
    const jsi::Value &value,
    const char *name)
{
  if (value.isNull() || value.isUndefined()) {
    return std::nullopt;
  }
  return copyStringArgument(runtime, value, name);
}

void storePendingPromise(int64_t token, PendingPromise promise)
{
  std::lock_guard<std::mutex> lock(gPendingMutex);
  gPendingPromises.emplace(token, std::move(promise));
}

std::optional<PendingPromise> takePendingPromise(int64_t token)
{
  std::lock_guard<std::mutex> lock(gPendingMutex);
  auto iter = gPendingPromises.find(token);
  if (iter == gPendingPromises.end()) {
    return std::nullopt;
  }
  auto promise = std::move(iter->second);
  gPendingPromises.erase(iter);
  return promise;
}

void storePendingStream(int64_t token, std::shared_ptr<PendingStream> stream)
{
  std::lock_guard<std::mutex> lock(gPendingMutex);
  gPendingStreams.emplace(token, std::move(stream));
}

std::shared_ptr<PendingStream> findPendingStream(int64_t token)
{
  std::lock_guard<std::mutex> lock(gPendingMutex);
  auto iter = gPendingStreams.find(token);
  return iter == gPendingStreams.end() ? nullptr : iter->second;
}

std::shared_ptr<PendingStream> takePendingStream(int64_t token)
{
  std::lock_guard<std::mutex> lock(gPendingMutex);
  auto iter = gPendingStreams.find(token);
  if (iter == gPendingStreams.end()) {
    return nullptr;
  }
  auto stream = std::move(iter->second);
  gPendingStreams.erase(iter);
  return stream;
}

jni::local_ref<jbyteArray> makeByteArray(const std::vector<uint8_t> &bytes)
{
  if (bytes.size() > static_cast<size_t>(std::numeric_limits<jsize>::max())) {
    throw std::overflow_error("liboliphaunt JSI request is too large for JNI byte[]");
  }
  JNIEnv *env = jni::Environment::current();
  auto array = jni::adopt_local(env->NewByteArray(static_cast<jsize>(bytes.size())));
  if (array == nullptr) {
    throw std::runtime_error("failed to allocate liboliphaunt JNI request byte[]");
  }
  if (!bytes.empty()) {
    env->SetByteArrayRegion(
        array.get(),
        0,
        static_cast<jsize>(bytes.size()),
        reinterpret_cast<const jbyte *>(bytes.data()));
  }
  return array;
}

std::vector<uint8_t> copyByteArray(jni::alias_ref<jbyteArray> array)
{
  JNIEnv *env = jni::Environment::current();
  jbyteArray raw = array.get();
  if (raw == nullptr) {
    return {};
  }
  jsize length = env->GetArrayLength(raw);
  std::vector<uint8_t> bytes(static_cast<size_t>(length));
  if (length > 0) {
    env->GetByteArrayRegion(raw, 0, length, reinterpret_cast<jbyte *>(bytes.data()));
  }
  return bytes;
}

class OliphauntJsiPromiseCallback
    : public jni::JavaClass<OliphauntJsiPromiseCallback> {
 public:
  static constexpr const char *kJavaDescriptor =
      "Ldev/oliphaunt/reactnative/OliphauntJsiPromiseCallback;";

  static void registerNatives()
  {
    javaClassLocal()->registerNatives({
        makeNativeMethod("nativeResolveBytes", nativeResolveBytes),
        makeNativeMethod("nativeResolveString", nativeResolveString),
        makeNativeMethod("nativeReject", nativeReject),
    });
  }

 private:
  static void nativeResolveBytes(
      jni::alias_ref<OliphauntJsiPromiseCallback>,
      jlong token,
      jni::alias_ref<jbyteArray> response)
  {
    auto promise = takePendingPromise(static_cast<int64_t>(token));
    if (!promise) {
      return;
    }
    std::vector<uint8_t> bytes = copyByteArray(response);
    promise->resolve->call([bytes = std::move(bytes)](
                               jsi::Runtime &runtime,
                               jsi::Function &resolveFunction) mutable {
      resolveFunction.call(runtime, arrayBufferFromBytes(runtime, std::move(bytes)));
    });
  }

  static void nativeResolveString(
      jni::alias_ref<OliphauntJsiPromiseCallback>,
      jlong token,
      jni::alias_ref<jni::JString> value)
  {
    auto promise = takePendingPromise(static_cast<int64_t>(token));
    if (!promise) {
      return;
    }
    std::string restored = value != nullptr ? value->toStdString() : "";
    promise->resolve->call([restored](
                               jsi::Runtime &runtime,
                               jsi::Function &resolveFunction) {
      resolveFunction.call(runtime, jsi::String::createFromUtf8(runtime, restored));
    });
  }

  static void nativeReject(
      jni::alias_ref<OliphauntJsiPromiseCallback>,
      jlong token,
      jni::alias_ref<jni::JString> message)
  {
    auto promise = takePendingPromise(static_cast<int64_t>(token));
    if (!promise) {
      return;
    }
    std::string errorMessage = message != nullptr ? message->toStdString() : "liboliphaunt exec failed";
    promise->reject->call([errorMessage](
                              jsi::Runtime &runtime,
                              jsi::Function &rejectFunction) {
      rejectFunction.call(runtime, createError(runtime, errorMessage));
    });
  }
};

class OliphauntJsiStreamCallback
    : public jni::JavaClass<OliphauntJsiStreamCallback> {
 public:
  static constexpr const char *kJavaDescriptor =
      "Ldev/oliphaunt/reactnative/OliphauntJsiStreamCallback;";

  static void registerNatives()
  {
    javaClassLocal()->registerNatives({
        makeNativeMethod("nativeEmitChunk", nativeEmitChunk),
        makeNativeMethod("nativeResolveUnit", nativeResolveUnit),
        makeNativeMethod("nativeReject", nativeReject),
    });
  }

 private:
  static void nativeEmitChunk(
      jni::alias_ref<OliphauntJsiStreamCallback>,
      jlong token,
      jni::alias_ref<jbyteArray> chunk)
  {
    auto stream = findPendingStream(static_cast<int64_t>(token));
    if (stream == nullptr) {
      return;
    }
    std::vector<uint8_t> bytes = copyByteArray(chunk);
    stream->onChunk->call([bytes = std::move(bytes)](
                              jsi::Runtime &runtime,
                              jsi::Function &chunkFunction) mutable {
      chunkFunction.call(runtime, arrayBufferFromBytes(runtime, std::move(bytes)));
    });
  }

  static void nativeResolveUnit(
      jni::alias_ref<OliphauntJsiStreamCallback>,
      jlong token)
  {
    auto stream = takePendingStream(static_cast<int64_t>(token));
    if (stream == nullptr) {
      return;
    }
    stream->resolve->call([](jsi::Runtime &runtime, jsi::Function &resolveFunction) {
      resolveFunction.call(runtime, jsi::Value::undefined());
    });
  }

  static void nativeReject(
      jni::alias_ref<OliphauntJsiStreamCallback>,
      jlong token,
      jni::alias_ref<jni::JString> message)
  {
    auto stream = takePendingStream(static_cast<int64_t>(token));
    if (stream == nullptr) {
      return;
    }
    std::string errorMessage = message != nullptr ? message->toStdString() : "liboliphaunt stream failed";
    stream->reject->call([errorMessage](
                             jsi::Runtime &runtime,
                             jsi::Function &rejectFunction) {
      rejectFunction.call(runtime, createError(runtime, errorMessage));
    });
  }
};

class OliphauntModuleJSIBindings
    : public jni::JavaClass<OliphauntModuleJSIBindings> {
 public:
  static constexpr const char *kJavaDescriptor =
      "Ldev/oliphaunt/reactnative/OliphauntModule;";

  static void registerNatives()
  {
    javaClassLocal()->registerNatives({
        makeNativeMethod("getBindingsInstaller", getBindingsInstaller),
    });
  }

 private:
  static jni::local_ref<BindingsInstallerHolder::javaobject> getBindingsInstaller(
      jni::alias_ref<OliphauntModuleJSIBindings> module)
  {
    auto moduleGlobal = jni::make_global(module);
    return BindingsInstallerHolder::newObjectCxxArgs(
        [moduleGlobal](
            jsi::Runtime &runtime,
            const std::shared_ptr<CallInvoker> &callInvoker) {
          auto transport = jsi::Object(runtime);
          transport.setProperty(runtime, "version", 1);
          transport.setProperty(
              runtime,
              "execProtocolRaw",
              jsi::Function::createFromHostFunction(
                  runtime,
                  jsi::PropNameID::forAscii(runtime, "liboliphauntExecProtocolRaw"),
                  2,
                  [moduleGlobal, callInvoker](
                      jsi::Runtime &runtime,
                      const jsi::Value &,
                      const jsi::Value *args,
                      size_t count) -> jsi::Value {
                    if (count != 2) {
                      throw jsi::JSError(runtime, "liboliphaunt JSI execProtocolRaw expects handle and request");
                    }

                    int64_t handle = copyHandleArgument(runtime, args[0]);
                    std::vector<uint8_t> request = copyBinaryArgument(runtime, args[1]);
                    auto promiseConstructor = runtime.global().getPropertyAsFunction(runtime, "Promise");
                    auto executor = jsi::Function::createFromHostFunction(
                        runtime,
                        jsi::PropNameID::forAscii(runtime, "liboliphauntExecProtocolRawExecutor"),
                        2,
                        [moduleGlobal, callInvoker, handle, request = std::move(request)](
                            jsi::Runtime &runtime,
                            const jsi::Value &,
                            const jsi::Value *promiseArgs,
                            size_t promiseArgCount) mutable -> jsi::Value {
                          if (promiseArgCount < 2 ||
                              !promiseArgs[0].isObject() ||
                              !promiseArgs[0].asObject(runtime).isFunction(runtime) ||
                              !promiseArgs[1].isObject() ||
                              !promiseArgs[1].asObject(runtime).isFunction(runtime)) {
                            throw jsi::JSError(
                                runtime,
                                "liboliphaunt JSI Promise executor received invalid callbacks");
                          }

                          int64_t token = gNextToken.fetch_add(1);
                          PendingPromise pending{
                              std::make_shared<AsyncCallback<>>(
                                  runtime,
                                  promiseArgs[0].asObject(runtime).getFunction(runtime),
                                  callInvoker),
                              std::make_shared<AsyncCallback<>>(
                                  runtime,
                                  promiseArgs[1].asObject(runtime).getFunction(runtime),
                                  callInvoker),
                          };
                          auto reject = pending.reject;
                          storePendingPromise(token, std::move(pending));

                          try {
                            auto requestArray = makeByteArray(request);
                            static const auto callbackConstructor =
                                OliphauntJsiPromiseCallback::javaClassStatic()
                                    ->getConstructor<OliphauntJsiPromiseCallback::javaobject(jlong)>();
                            auto callback =
                                OliphauntJsiPromiseCallback::javaClassStatic()
                                    ->newObject(callbackConstructor, static_cast<jlong>(token));
                            static const auto execProtocolRawBytes =
                                OliphauntModuleJSIBindings::javaClassStatic()
                                    ->getMethod<void(jlong, jbyteArray, OliphauntJsiPromiseCallback::javaobject)>(
                                        "execProtocolRawBytes");
                            execProtocolRawBytes(
                                moduleGlobal,
                                static_cast<jlong>(handle),
                                requestArray.get(),
                                callback.get());
                          } catch (const std::exception &error) {
                            takePendingPromise(token);
                            std::string message = error.what();
                            reject->call([message](
                                             jsi::Runtime &runtime,
                                             jsi::Function &rejectFunction) {
                              rejectFunction.call(runtime, createError(runtime, message));
                            });
                          }
                          return jsi::Value::undefined();
                        });
                    return promiseConstructor.callAsConstructor(runtime, std::move(executor));
                  }));
          transport.setProperty(
              runtime,
              "execProtocolStream",
              jsi::Function::createFromHostFunction(
                  runtime,
                  jsi::PropNameID::forAscii(runtime, "liboliphauntExecProtocolStream"),
                  3,
                  [moduleGlobal, callInvoker](
                      jsi::Runtime &runtime,
                      const jsi::Value &,
                      const jsi::Value *args,
                      size_t count) -> jsi::Value {
                    if (count != 3 ||
                        !args[2].isObject() ||
                        !args[2].asObject(runtime).isFunction(runtime)) {
                      throw jsi::JSError(
                          runtime,
                          "liboliphaunt JSI execProtocolStream expects handle, request, and onChunk");
                    }

                    int64_t handle = copyHandleArgument(runtime, args[0]);
                    std::vector<uint8_t> request = copyBinaryArgument(runtime, args[1]);
                    auto onChunk = std::make_shared<AsyncCallback<>>(
                        runtime,
                        args[2].asObject(runtime).getFunction(runtime),
                        callInvoker);
                    auto promiseConstructor = runtime.global().getPropertyAsFunction(runtime, "Promise");
                    auto executor = jsi::Function::createFromHostFunction(
                        runtime,
                        jsi::PropNameID::forAscii(runtime, "liboliphauntExecProtocolStreamExecutor"),
                        2,
                        [moduleGlobal,
                         callInvoker,
                         handle,
                         request = std::move(request),
                         onChunk = std::move(onChunk)](
                            jsi::Runtime &runtime,
                            const jsi::Value &,
                            const jsi::Value *promiseArgs,
                            size_t promiseArgCount) mutable -> jsi::Value {
                          if (promiseArgCount < 2 ||
                              !promiseArgs[0].isObject() ||
                              !promiseArgs[0].asObject(runtime).isFunction(runtime) ||
                              !promiseArgs[1].isObject() ||
                              !promiseArgs[1].asObject(runtime).isFunction(runtime)) {
                            throw jsi::JSError(
                                runtime,
                                "liboliphaunt JSI Promise executor received invalid callbacks");
                          }

                          int64_t token = gNextToken.fetch_add(1);
                          auto stream = std::make_shared<PendingStream>(PendingStream{
                              onChunk,
                              std::make_shared<AsyncCallback<>>(
                                  runtime,
                                  promiseArgs[0].asObject(runtime).getFunction(runtime),
                                  callInvoker),
                              std::make_shared<AsyncCallback<>>(
                                  runtime,
                                  promiseArgs[1].asObject(runtime).getFunction(runtime),
                                  callInvoker),
                          });
                          auto reject = stream->reject;
                          storePendingStream(token, stream);

                          try {
                            auto requestArray = makeByteArray(request);
                            static const auto callbackConstructor =
                                OliphauntJsiStreamCallback::javaClassStatic()
                                    ->getConstructor<OliphauntJsiStreamCallback::javaobject(jlong)>();
                            auto callback =
                                OliphauntJsiStreamCallback::javaClassStatic()
                                    ->newObject(callbackConstructor, static_cast<jlong>(token));
                            static const auto execProtocolStreamBytes =
                                OliphauntModuleJSIBindings::javaClassStatic()
                                    ->getMethod<void(jlong, jbyteArray, OliphauntJsiStreamCallback::javaobject)>(
                                        "execProtocolStreamBytes");
                            execProtocolStreamBytes(
                                moduleGlobal,
                                static_cast<jlong>(handle),
                                requestArray.get(),
                                callback.get());
                          } catch (const std::exception &error) {
                            takePendingStream(token);
                            std::string message = error.what();
                            reject->call([message](
                                             jsi::Runtime &runtime,
                                             jsi::Function &rejectFunction) {
                              rejectFunction.call(runtime, createError(runtime, message));
                            });
                          }
                          return jsi::Value::undefined();
                        });
                    return promiseConstructor.callAsConstructor(runtime, std::move(executor));
                  }));
          transport.setProperty(
              runtime,
              "backup",
              jsi::Function::createFromHostFunction(
                  runtime,
                  jsi::PropNameID::forAscii(runtime, "liboliphauntBackup"),
                  2,
                  [moduleGlobal, callInvoker](
                      jsi::Runtime &runtime,
                      const jsi::Value &,
                      const jsi::Value *args,
                      size_t count) -> jsi::Value {
                    if (count != 2) {
                      throw jsi::JSError(runtime, "liboliphaunt JSI backup expects handle and format");
                    }

                    int64_t handle = copyHandleArgument(runtime, args[0]);
                    std::string format = copyStringArgument(runtime, args[1], "backup format");
                    auto promiseConstructor = runtime.global().getPropertyAsFunction(runtime, "Promise");
                    auto executor = jsi::Function::createFromHostFunction(
                        runtime,
                        jsi::PropNameID::forAscii(runtime, "liboliphauntBackupExecutor"),
                        2,
                        [moduleGlobal, callInvoker, handle, format = std::move(format)](
                            jsi::Runtime &runtime,
                            const jsi::Value &,
                            const jsi::Value *promiseArgs,
                            size_t promiseArgCount) -> jsi::Value {
                          if (promiseArgCount < 2 ||
                              !promiseArgs[0].isObject() ||
                              !promiseArgs[0].asObject(runtime).isFunction(runtime) ||
                              !promiseArgs[1].isObject() ||
                              !promiseArgs[1].asObject(runtime).isFunction(runtime)) {
                            throw jsi::JSError(
                                runtime,
                                "liboliphaunt JSI Promise executor received invalid callbacks");
                          }

                          int64_t token = gNextToken.fetch_add(1);
                          PendingPromise pending{
                              std::make_shared<AsyncCallback<>>(
                                  runtime,
                                  promiseArgs[0].asObject(runtime).getFunction(runtime),
                                  callInvoker),
                              std::make_shared<AsyncCallback<>>(
                                  runtime,
                                  promiseArgs[1].asObject(runtime).getFunction(runtime),
                                  callInvoker),
                          };
                          auto reject = pending.reject;
                          storePendingPromise(token, std::move(pending));

                          try {
                            static const auto callbackConstructor =
                                OliphauntJsiPromiseCallback::javaClassStatic()
                                    ->getConstructor<OliphauntJsiPromiseCallback::javaobject(jlong)>();
                            auto callback =
                                OliphauntJsiPromiseCallback::javaClassStatic()
                                    ->newObject(callbackConstructor, static_cast<jlong>(token));
                            static const auto backupBytes =
                                OliphauntModuleJSIBindings::javaClassStatic()
                                    ->getMethod<void(jlong, jni::JString::javaobject, OliphauntJsiPromiseCallback::javaobject)>(
                                        "backupBytes");
                            auto formatString = jni::make_jstring(format);
                            backupBytes(
                                moduleGlobal,
                                static_cast<jlong>(handle),
                                formatString.get(),
                                callback.get());
                          } catch (const std::exception &error) {
                            takePendingPromise(token);
                            std::string message = error.what();
                            reject->call([message](
                                             jsi::Runtime &runtime,
                                             jsi::Function &rejectFunction) {
                              rejectFunction.call(runtime, createError(runtime, message));
                            });
                          }
                          return jsi::Value::undefined();
                        });
                    return promiseConstructor.callAsConstructor(runtime, std::move(executor));
                  }));
          transport.setProperty(
              runtime,
              "restore",
              jsi::Function::createFromHostFunction(
                  runtime,
                  jsi::PropNameID::forAscii(runtime, "liboliphauntRestore"),
                  5,
                  [moduleGlobal, callInvoker](
                      jsi::Runtime &runtime,
                      const jsi::Value &,
                      const jsi::Value *args,
                      size_t count) -> jsi::Value {
                    if (count != 5 || !args[3].isBool()) {
                      throw jsi::JSError(
                          runtime,
                          "liboliphaunt JSI restore expects root, format, artifact, replaceExisting, and libraryPath");
                    }

                    std::string root = copyStringArgument(runtime, args[0], "restore root");
                    std::string format = copyStringArgument(runtime, args[1], "restore format");
                    std::vector<uint8_t> artifact = copyBinaryArgument(runtime, args[2]);
                    bool replaceExisting = args[3].getBool();
                    auto libraryPath = copyOptionalStringArgument(runtime, args[4], "restore libraryPath");
                    auto promiseConstructor = runtime.global().getPropertyAsFunction(runtime, "Promise");
                    auto executor = jsi::Function::createFromHostFunction(
                        runtime,
                        jsi::PropNameID::forAscii(runtime, "liboliphauntRestoreExecutor"),
                        2,
                        [moduleGlobal,
                         callInvoker,
                         root = std::move(root),
                         format = std::move(format),
                         artifact = std::move(artifact),
                         replaceExisting,
                         libraryPath = std::move(libraryPath)](
                            jsi::Runtime &runtime,
                            const jsi::Value &,
                            const jsi::Value *promiseArgs,
                            size_t promiseArgCount) mutable -> jsi::Value {
                          if (promiseArgCount < 2 ||
                              !promiseArgs[0].isObject() ||
                              !promiseArgs[0].asObject(runtime).isFunction(runtime) ||
                              !promiseArgs[1].isObject() ||
                              !promiseArgs[1].asObject(runtime).isFunction(runtime)) {
                            throw jsi::JSError(
                                runtime,
                                "liboliphaunt JSI Promise executor received invalid callbacks");
                          }

                          int64_t token = gNextToken.fetch_add(1);
                          PendingPromise pending{
                              std::make_shared<AsyncCallback<>>(
                                  runtime,
                                  promiseArgs[0].asObject(runtime).getFunction(runtime),
                                  callInvoker),
                              std::make_shared<AsyncCallback<>>(
                                  runtime,
                                  promiseArgs[1].asObject(runtime).getFunction(runtime),
                                  callInvoker),
                          };
                          auto reject = pending.reject;
                          storePendingPromise(token, std::move(pending));

                          try {
                            auto rootString = jni::make_jstring(root);
                            auto formatString = jni::make_jstring(format);
                            auto artifactArray = makeByteArray(artifact);
                            jni::local_ref<jni::JString> libraryPathString;
                            jni::JString::javaobject libraryPathObject = nullptr;
                            if (libraryPath) {
                              libraryPathString = jni::make_jstring(*libraryPath);
                              libraryPathObject = libraryPathString.get();
                            }
                            static const auto callbackConstructor =
                                OliphauntJsiPromiseCallback::javaClassStatic()
                                    ->getConstructor<OliphauntJsiPromiseCallback::javaobject(jlong)>();
                            auto callback =
                                OliphauntJsiPromiseCallback::javaClassStatic()
                                    ->newObject(callbackConstructor, static_cast<jlong>(token));
                            static const auto restoreBytes =
                                OliphauntModuleJSIBindings::javaClassStatic()
                                    ->getMethod<void(
                                        jni::JString::javaobject,
                                        jni::JString::javaobject,
                                        jbyteArray,
                                        jboolean,
                                        jni::JString::javaobject,
                                        OliphauntJsiPromiseCallback::javaobject)>("restoreBytes");
                            restoreBytes(
                                moduleGlobal,
                                rootString.get(),
                                formatString.get(),
                                artifactArray.get(),
                                static_cast<jboolean>(replaceExisting),
                                libraryPathObject,
                                callback.get());
                          } catch (const std::exception &error) {
                            takePendingPromise(token);
                            std::string message = error.what();
                            reject->call([message](
                                             jsi::Runtime &runtime,
                                             jsi::Function &rejectFunction) {
                              rejectFunction.call(runtime, createError(runtime, message));
                            });
                          }
                          return jsi::Value::undefined();
                        });
                    return promiseConstructor.callAsConstructor(runtime, std::move(executor));
                  }));
          runtime.global().setProperty(runtime, "__oliphauntReactNativeJsi", std::move(transport));
        });
  }
};

} // namespace

} // namespace facebook::react

JNIEXPORT jint JNI_OnLoad(JavaVM *vm, void *)
{
  return facebook::jni::initialize(vm, [] {
    facebook::react::OliphauntModuleJSIBindings::registerNatives();
    facebook::react::OliphauntJsiPromiseCallback::registerNatives();
    facebook::react::OliphauntJsiStreamCallback::registerNatives();
  });
}
