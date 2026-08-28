#include <ReactCommon/BindingsInstallerHolder.h>
#include <ReactCommon/CallInvoker.h>
#include <fbjni/fbjni.h>
#include <jsi/jsi.h>
#include <react/bridging/Function.h>

#include <atomic>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <exception>
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

class ChunkAcknowledgement final {
 public:
  void resolve()
  {
    finish(std::nullopt);
  }

  void reject(std::string message)
  {
    finish(std::move(message));
  }

  std::optional<std::string> wait()
  {
    std::unique_lock<std::mutex> lock(mutex_);
    condition_.wait(lock, [this]() { return complete_; });
    return error_;
  }

 private:
  void finish(std::optional<std::string> error)
  {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (complete_) {
        return;
      }
      error_ = std::move(error);
      complete_ = true;
    }
    condition_.notify_one();
  }

  std::mutex mutex_;
  std::condition_variable condition_;
  bool complete_ = false;
  std::optional<std::string> error_;
};

struct PendingStream final {
  PendingStream(
      std::shared_ptr<AsyncCallback<>> onChunk,
      std::shared_ptr<AsyncCallback<>> resolve,
      std::shared_ptr<AsyncCallback<>> reject)
      : onChunk(std::move(onChunk)),
        resolve(std::move(resolve)),
        reject(std::move(reject)) {}

  void acknowledgeWith(std::shared_ptr<ChunkAcknowledgement> next)
  {
    std::lock_guard<std::mutex> lock(mutex);
    acknowledgement = std::move(next);
  }

  void clearAcknowledgement(const std::shared_ptr<ChunkAcknowledgement> &current)
  {
    std::lock_guard<std::mutex> lock(mutex);
    if (acknowledgement == current) {
      acknowledgement.reset();
    }
  }

  void abort()
  {
    std::shared_ptr<ChunkAcknowledgement> current;
    {
      std::lock_guard<std::mutex> lock(mutex);
      invalidated = true;
      current = acknowledgement;
    }
    if (current != nullptr) {
      current->reject("React Native Oliphaunt module has been invalidated");
    }
  }

  bool settle()
  {
    std::lock_guard<std::mutex> lock(mutex);
    if (invalidated || settled) {
      return false;
    }
    settled = true;
    return true;
  }

  std::shared_ptr<AsyncCallback<>> onChunk;
  std::shared_ptr<AsyncCallback<>> resolve;
  std::shared_ptr<AsyncCallback<>> reject;

 private:
  std::mutex mutex;
  std::shared_ptr<ChunkAcknowledgement> acknowledgement;
  bool invalidated = false;
  bool settled = false;
};

std::mutex gPendingMutex;
std::unordered_map<int64_t, PendingPromise> gPendingPromises;
std::unordered_map<int64_t, std::shared_ptr<PendingStream>> gPendingStreams;
std::atomic<int64_t> gNextToken{1};
std::atomic<bool> gBindingsInvalidated{false};

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

jsi::Value createProtocolCallbackAbortedError(
    jsi::Runtime &runtime,
    const std::string &message)
{
  auto value = createError(runtime, message);
  auto object = value.asObject(runtime);
  object.setProperty(runtime, "__oliphauntProtocolCallbackAborted", true);
  return object;
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

void invalidatePendingCallbacks()
{
  std::vector<std::shared_ptr<PendingStream>> streams;
  {
    std::lock_guard<std::mutex> lock(gPendingMutex);
    streams.reserve(gPendingStreams.size());
    for (auto &[_, stream] : gPendingStreams) {
      streams.push_back(stream);
    }
    gPendingStreams.clear();
    gPendingPromises.clear();
  }
  for (const auto &stream : streams) {
    stream->abort();
  }
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
        makeNativeMethod("nativeResolveUnit", nativeResolveUnit),
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

  static void nativeResolveUnit(
      jni::alias_ref<OliphauntJsiPromiseCallback>,
      jlong token)
  {
    auto promise = takePendingPromise(static_cast<int64_t>(token));
    if (!promise) {
      return;
    }
    promise->resolve->call([](
                               jsi::Runtime &runtime,
                               jsi::Function &resolveFunction) {
      resolveFunction.call(runtime, jsi::Value::undefined());
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
        makeNativeMethod("nativeRejectCallbackAborted", nativeRejectCallbackAborted),
        makeNativeMethod("nativeReject", nativeReject),
    });
  }

 private:
  static jni::local_ref<jni::JString> nativeEmitChunk(
      jni::alias_ref<OliphauntJsiStreamCallback>,
      jlong token,
      jni::alias_ref<jbyteArray> chunk)
  {
    auto stream = findPendingStream(static_cast<int64_t>(token));
    if (stream == nullptr) {
      return jni::make_jstring("liboliphaunt protocol stream is no longer active");
    }
    std::vector<uint8_t> bytes = copyByteArray(chunk);
    auto acknowledgement = std::make_shared<ChunkAcknowledgement>();
    stream->acknowledgeWith(acknowledgement);
    try {
      stream->onChunk->call([bytes = std::move(bytes), acknowledgement](
                                jsi::Runtime &runtime,
                                jsi::Function &chunkFunction) mutable {
        if (gBindingsInvalidated.load()) {
          acknowledgement->reject("React Native Oliphaunt module has been invalidated");
          return;
        }
        try {
          auto result = chunkFunction.call(
              runtime,
              arrayBufferFromBytes(runtime, std::move(bytes)));
          if (result.isObject()) {
            auto resultObject = result.asObject(runtime);
            auto failureMarker = resultObject.getProperty(
                runtime,
                "__oliphauntProtocolChunkFailure");
            if (failureMarker.isBool() && failureMarker.getBool()) {
              acknowledgement->reject("protocol stream callback failed");
              return;
            }
          }
          acknowledgement->resolve();
        } catch (const jsi::JSError &error) {
          acknowledgement->reject(error.what());
        } catch (const std::exception &error) {
          acknowledgement->reject(error.what());
        } catch (...) {
          acknowledgement->reject("protocol stream callback failed");
        }
      });
    } catch (const std::exception &error) {
      acknowledgement->reject(error.what());
    } catch (...) {
      acknowledgement->reject("failed to schedule protocol stream callback");
    }
    auto error = acknowledgement->wait();
    stream->clearAcknowledgement(acknowledgement);
    return error ? jni::make_jstring(*error) : jni::local_ref<jni::JString>();
  }

  static void nativeResolveUnit(
      jni::alias_ref<OliphauntJsiStreamCallback>,
      jlong token)
  {
    auto stream = takePendingStream(static_cast<int64_t>(token));
    if (stream == nullptr) {
      return;
    }
    if (gBindingsInvalidated.load() || !stream->settle()) {
      return;
    }
    stream->resolve->call([](jsi::Runtime &runtime, jsi::Function &resolveFunction) {
      resolveFunction.call(runtime, jsi::Value::undefined());
    });
  }

  static void nativeRejectCallbackAborted(
      jni::alias_ref<OliphauntJsiStreamCallback>,
      jlong token,
      jni::alias_ref<jni::JString> message)
  {
    auto stream = takePendingStream(static_cast<int64_t>(token));
    if (stream == nullptr) {
      return;
    }
    if (gBindingsInvalidated.load() || !stream->settle()) {
      return;
    }
    std::string errorMessage =
        message != nullptr
        ? message->toStdString()
        : "protocol stream callback aborted after recovery to ReadyForQuery";
    stream->reject->call([errorMessage](
                             jsi::Runtime &runtime,
                             jsi::Function &rejectFunction) {
      rejectFunction.call(
          runtime,
          createProtocolCallbackAbortedError(runtime, errorMessage));
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
    if (gBindingsInvalidated.load() || !stream->settle()) {
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
        makeNativeMethod("invalidateJsiBindings", invalidateJsiBindings),
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
          gBindingsInvalidated.store(false);
          auto transport = jsi::Object(runtime);
          transport.setProperty(runtime, "version", 1);
          transport.setProperty(
              runtime,
              "closeIfGeneration",
              jsi::Function::createFromHostFunction(
                  runtime,
                  jsi::PropNameID::forAscii(runtime, "liboliphauntCloseIfGeneration"),
                  1,
                  [moduleGlobal](
                      jsi::Runtime &runtime,
                      const jsi::Value &,
                      const jsi::Value *args,
                      size_t count) -> jsi::Value {
                    if (count != 1) {
                      throw jsi::JSError(
                          runtime,
                          "liboliphaunt JSI closeIfGeneration expects a generation");
                    }
                    int64_t generation = copyHandleArgument(runtime, args[0]);
                    if (gBindingsInvalidated.load()) {
                      return jsi::Value::undefined();
                    }
                    static const auto closeIfGeneration =
                        OliphauntModuleJSIBindings::javaClassStatic()
                            ->getMethod<void(jlong)>("closeIfGeneration");
                    closeIfGeneration(moduleGlobal, static_cast<jlong>(generation));
                    return jsi::Value::undefined();
                  }));
          transport.setProperty(
              runtime,
              "execProtocolRaw",
              jsi::Function::createFromHostFunction(
                  runtime,
                  jsi::PropNameID::forAscii(runtime, "liboliphauntExecProtocolRaw"),
                  1,
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
                          auto stream = std::make_shared<PendingStream>(
                              onChunk,
                              std::make_shared<AsyncCallback<>>(
                                  runtime,
                                  promiseArgs[0].asObject(runtime).getFunction(runtime),
                                  callInvoker),
                              std::make_shared<AsyncCallback<>>(
                                  runtime,
                                  promiseArgs[1].asObject(runtime).getFunction(runtime),
                                  callInvoker));
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
                    if (count != 1) {
                      throw jsi::JSError(runtime, "liboliphaunt JSI backup expects a handle");
                    }

                    int64_t handle = copyHandleArgument(runtime, args[0]);
                    auto promiseConstructor = runtime.global().getPropertyAsFunction(runtime, "Promise");
                    auto executor = jsi::Function::createFromHostFunction(
                        runtime,
                        jsi::PropNameID::forAscii(runtime, "liboliphauntBackupExecutor"),
                        2,
                        [moduleGlobal, callInvoker, handle](
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
                                    ->getMethod<void(jlong, OliphauntJsiPromiseCallback::javaobject)>(
                                        "backupBytes");
                            backupBytes(
                                moduleGlobal,
                                static_cast<jlong>(handle),
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
                  2,
                  [moduleGlobal, callInvoker](
                      jsi::Runtime &runtime,
                      const jsi::Value &,
                      const jsi::Value *args,
                      size_t count) -> jsi::Value {
                    if (count != 2) {
                      throw jsi::JSError(
                          runtime,
                          "liboliphaunt JSI restore expects destination and backup bytes");
                    }

                    if (!args[0].isObject()) {
                      throw jsi::JSError(runtime, "liboliphaunt JSI restore destination must be an object");
                    }
                    auto destination = args[0].asObject(runtime);
                    std::string storageKind = copyStringArgument(
                        runtime,
                        destination.getProperty(runtime, "storageKind"),
                        "restore storageKind");
                    auto storagePath = copyOptionalStringArgument(
                        runtime,
                        destination.getProperty(runtime, "storagePath"),
                        "restore storagePath");
                    auto storageName = copyOptionalStringArgument(
                        runtime,
                        destination.getProperty(runtime, "storageName"),
                        "restore storageName");
                    std::vector<uint8_t> artifact = copyBinaryArgument(runtime, args[1]);
                    auto promiseConstructor = runtime.global().getPropertyAsFunction(runtime, "Promise");
                    auto executor = jsi::Function::createFromHostFunction(
                        runtime,
                        jsi::PropNameID::forAscii(runtime, "liboliphauntRestoreExecutor"),
                        2,
                        [moduleGlobal,
                         callInvoker,
                         storageKind = std::move(storageKind),
                         storagePath = std::move(storagePath),
                         storageName = std::move(storageName),
                         artifact = std::move(artifact)](
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
                            auto storageKindString = jni::make_jstring(storageKind);
                            auto storagePathString = jni::make_jstring(storagePath.value_or(""));
                            auto storageNameString = jni::make_jstring(storageName.value_or(""));
                            auto artifactArray = makeByteArray(artifact);
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
                                        jni::JString::javaobject,
                                        jbyteArray,
                                        OliphauntJsiPromiseCallback::javaobject)>("restoreBytes");
                            restoreBytes(
                                moduleGlobal,
                                storageKindString.get(),
                                storagePathString.get(),
                                storageNameString.get(),
                                artifactArray.get(),
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

  static void invalidateJsiBindings(jni::alias_ref<OliphauntModuleJSIBindings>)
  {
    gBindingsInvalidated.store(true);
    invalidatePendingCallbacks();
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
