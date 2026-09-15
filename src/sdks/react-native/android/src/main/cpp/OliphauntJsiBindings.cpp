#include "../../../../cpp/Jsi.h"
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
using namespace oliphaunt::reactnative;

struct PendingStream final : PendingPromise {
  PendingStream(std::shared_ptr<RuntimeCallback> chunk, PendingPromise promise,
      std::shared_ptr<RuntimeLifetime> owner)
      : PendingPromise(std::move(promise)), onChunk(std::move(chunk)), lifetime(std::move(owner)) {}
  std::shared_ptr<RuntimeCallback> onChunk;
  std::shared_ptr<RuntimeLifetime> lifetime;
};

struct RuntimeState final : RuntimeLifetime {
  int64_t id;
  std::mutex mutex;
  std::unordered_map<int64_t, PendingPromise> promises;
  std::unordered_map<int64_t, std::shared_ptr<PendingStream>> streams;
  explicit RuntimeState(int64_t id) : id(id) {}
void storePendingPromise(int64_t token, PendingPromise promise)
{
  std::lock_guard<std::mutex> lock(mutex);
  if (active()) promises.emplace(token, std::move(promise));
}

std::optional<PendingPromise> takePendingPromise(int64_t token)
{
  std::lock_guard<std::mutex> lock(mutex);
  auto iter = promises.find(token);
  if (iter == promises.end()) {
    return std::nullopt;
  }
  auto promise = std::move(iter->second);
  promises.erase(iter);
  return promise;
}

void storePendingStream(int64_t token, std::shared_ptr<PendingStream> stream)
{
  std::lock_guard<std::mutex> lock(mutex);
  if (active()) streams.emplace(token, std::move(stream));
}

std::shared_ptr<PendingStream> findPendingStream(int64_t token)
{
  std::lock_guard<std::mutex> lock(mutex);
  auto iter = streams.find(token);
  return iter == streams.end() ? nullptr : iter->second;
}

std::shared_ptr<PendingStream> takePendingStream(int64_t token)
{
  std::lock_guard<std::mutex> lock(mutex);
  auto iter = streams.find(token);
  if (iter == streams.end()) {
    return nullptr;
  }
  auto stream = std::move(iter->second);
  streams.erase(iter);
  return stream;
}


  void close() {
    invalidate();
    std::lock_guard<std::mutex> lock(mutex);
    promises.clear();
    streams.clear();
  }
};
// JNI callbacks carry the module owner ID; the routing table holds no callback
// from a different runtime and is erased by that module's invalidate hook.
std::mutex gOwnersMutex;
std::unordered_map<int64_t, std::shared_ptr<RuntimeState>> gOwners;
std::atomic<int64_t> gNextToken{1};
std::shared_ptr<RuntimeState> findOwner(int64_t id) {
  std::lock_guard<std::mutex> lock(gOwnersMutex);
  auto found = gOwners.find(id);
  return found == gOwners.end() ? nullptr : found->second;
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
      jlong ownerId,
      jlong token,
      jni::alias_ref<jbyteArray> response)
  {
    auto owner = findOwner(ownerId);
    auto promise = owner ? owner->takePendingPromise(static_cast<int64_t>(token)) : std::nullopt;
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
      jlong ownerId,
      jlong token,
      jni::alias_ref<jni::JString> value)
  {
    auto owner = findOwner(ownerId);
    auto promise = owner ? owner->takePendingPromise(static_cast<int64_t>(token)) : std::nullopt;
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
      jlong ownerId,
      jlong token)
  {
    auto owner = findOwner(ownerId);
    auto promise = owner ? owner->takePendingPromise(static_cast<int64_t>(token)) : std::nullopt;
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
      jlong ownerId,
      jlong token,
      jni::alias_ref<jni::JString> message)
  {
    auto owner = findOwner(ownerId);
    auto promise = owner ? owner->takePendingPromise(static_cast<int64_t>(token)) : std::nullopt;
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
      jlong ownerId,
      jlong token,
      jni::alias_ref<jbyteArray> chunk)
  {
    auto owner = findOwner(ownerId);
    auto stream = owner ? owner->findPendingStream(static_cast<int64_t>(token)) : nullptr;
    if (stream == nullptr) {
      return jni::make_jstring("liboliphaunt protocol stream is no longer active");
    }
    std::vector<uint8_t> bytes = copyByteArray(chunk);
    auto acknowledgement = stream->lifetime->acknowledge();
    try {
      stream->onChunk->call([bytes = std::move(bytes), acknowledgement, lifetime = stream->lifetime](
                                jsi::Runtime &runtime,
                                jsi::Function &chunkFunction) mutable {
        if (!lifetime->active()) {
          acknowledgement->reject("React Native Oliphaunt module has been invalidated");
          return;
        }
        deliverChunk(runtime, chunkFunction, std::move(bytes), acknowledgement);
      });
    } catch (const std::exception &error) {
      acknowledgement->reject(error.what());
    } catch (...) {
      acknowledgement->reject("failed to schedule protocol stream callback");
    }
    auto error = acknowledgement->wait();
    return error ? jni::make_jstring(*error) : jni::local_ref<jni::JString>();
  }

  static void nativeResolveUnit(
      jni::alias_ref<OliphauntJsiStreamCallback>,
      jlong ownerId,
      jlong token)
  {
    auto owner = findOwner(ownerId);
    auto stream = owner ? owner->takePendingStream(static_cast<int64_t>(token)) : nullptr;
    if (stream == nullptr) {
      return;
    }
    if (!stream->lifetime->active()) {
      return;
    }
    stream->resolve->call([](jsi::Runtime &runtime, jsi::Function &resolveFunction) {
      resolveFunction.call(runtime, jsi::Value::undefined());
    });
  }

  static void nativeRejectCallbackAborted(
      jni::alias_ref<OliphauntJsiStreamCallback>,
      jlong ownerId,
      jlong token,
      jni::alias_ref<jni::JString> message)
  {
    auto owner = findOwner(ownerId);
    auto stream = owner ? owner->takePendingStream(static_cast<int64_t>(token)) : nullptr;
    if (stream == nullptr) {
      return;
    }
    if (!stream->lifetime->active()) {
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
      jlong ownerId,
      jlong token,
      jni::alias_ref<jni::JString> message)
  {
    auto owner = findOwner(ownerId);
    auto stream = owner ? owner->takePendingStream(static_cast<int64_t>(token)) : nullptr;
    if (stream == nullptr) {
      return;
    }
    if (!stream->lifetime->active()) {
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
    static const auto ownerField = javaClassStatic()->getField<jlong>("jsiOwnerId");
    auto owner = std::make_shared<RuntimeState>(gNextToken.fetch_add(1));
    {
      std::lock_guard<std::mutex> lock(gOwnersMutex);
      const auto previous = module->getFieldValue(ownerField);
      if (previous == -1) owner->invalidate();
      if (auto found = gOwners.find(previous); found != gOwners.end()) {
        found->second->close();
        gOwners.erase(found);
      }
      gOwners.emplace(owner->id, owner);
      module->setFieldValue(ownerField, static_cast<jlong>(owner->id));
    }
    return BindingsInstallerHolder::newObjectCxxArgs(
        [owner, moduleGlobal](
            jsi::Runtime &runtime,
            const std::shared_ptr<CallInvoker> &callInvoker) {
          auto transport = jsi::Object(runtime);
          transport.setProperty(runtime, "version", 1);
          transport.setProperty(
              runtime,
              "closeIfGeneration",
              jsi::Function::createFromHostFunction(
                  runtime,
                  jsi::PropNameID::forAscii(runtime, "liboliphauntCloseIfGeneration"),
                  1,
                  [owner, moduleGlobal](
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
                    if (!owner->active()) {
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
                  [owner, moduleGlobal, callInvoker](
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
                        [owner, moduleGlobal, callInvoker, handle, request = std::move(request)](
                            jsi::Runtime &runtime,
                            const jsi::Value &,
                            const jsi::Value *promiseArgs,
                            size_t promiseArgCount) mutable -> jsi::Value {
                          int64_t token = gNextToken.fetch_add(1);
                          auto pending = promiseCallbacks(runtime, promiseArgs, promiseArgCount, callInvoker, owner);
                          auto reject = pending.reject;
                          owner->storePendingPromise(token, std::move(pending));

                          try {
                            auto requestArray = makeByteArray(request);
                            static const auto callbackConstructor =
                                OliphauntJsiPromiseCallback::javaClassStatic()
                                    ->getConstructor<OliphauntJsiPromiseCallback::javaobject(jlong, jlong)>();
                            auto callback =
                                OliphauntJsiPromiseCallback::javaClassStatic()
                                    ->newObject(callbackConstructor, static_cast<jlong>(owner->id), static_cast<jlong>(token));
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
                            owner->takePendingPromise(token);
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
                  [owner, moduleGlobal, callInvoker](
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
                    auto onChunk = std::make_shared<RuntimeCallback>(
                        runtime,
                        args[2].asObject(runtime).getFunction(runtime),
                        callInvoker, owner);
                    auto promiseConstructor = runtime.global().getPropertyAsFunction(runtime, "Promise");
                    auto executor = jsi::Function::createFromHostFunction(
                        runtime,
                        jsi::PropNameID::forAscii(runtime, "liboliphauntExecProtocolStreamExecutor"),
                        2,
                        [owner, moduleGlobal,
                         callInvoker,
                         handle,
                         request = std::move(request),
                         onChunk = std::move(onChunk)](
                            jsi::Runtime &runtime,
                            const jsi::Value &,
                            const jsi::Value *promiseArgs,
                            size_t promiseArgCount) mutable -> jsi::Value {
                          int64_t token = gNextToken.fetch_add(1);
                          auto stream = std::make_shared<PendingStream>(onChunk,
                              promiseCallbacks(runtime, promiseArgs, promiseArgCount, callInvoker, owner), owner);
                          auto reject = stream->reject;
                          owner->storePendingStream(token, stream);

                          try {
                            auto requestArray = makeByteArray(request);
                            static const auto callbackConstructor =
                                OliphauntJsiStreamCallback::javaClassStatic()
                                    ->getConstructor<OliphauntJsiStreamCallback::javaobject(jlong, jlong)>();
                            auto callback =
                                OliphauntJsiStreamCallback::javaClassStatic()
                                    ->newObject(callbackConstructor, static_cast<jlong>(owner->id), static_cast<jlong>(token));
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
                            owner->takePendingStream(token);
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
                  [owner, moduleGlobal, callInvoker](
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
                        [owner, moduleGlobal, callInvoker, handle](
                            jsi::Runtime &runtime,
                            const jsi::Value &,
                            const jsi::Value *promiseArgs,
                            size_t promiseArgCount) -> jsi::Value {
                          int64_t token = gNextToken.fetch_add(1);
                          auto pending = promiseCallbacks(runtime, promiseArgs, promiseArgCount, callInvoker, owner);
                          auto reject = pending.reject;
                          owner->storePendingPromise(token, std::move(pending));

                          try {
                            static const auto callbackConstructor =
                                OliphauntJsiPromiseCallback::javaClassStatic()
                                    ->getConstructor<OliphauntJsiPromiseCallback::javaobject(jlong, jlong)>();
                            auto callback =
                                OliphauntJsiPromiseCallback::javaClassStatic()
                                    ->newObject(callbackConstructor, static_cast<jlong>(owner->id), static_cast<jlong>(token));
                            static const auto backupBytes =
                                OliphauntModuleJSIBindings::javaClassStatic()
                                    ->getMethod<void(jlong, OliphauntJsiPromiseCallback::javaobject)>(
                                        "backupBytes");
                            backupBytes(
                                moduleGlobal,
                                static_cast<jlong>(handle),
                                callback.get());
                          } catch (const std::exception &error) {
                            owner->takePendingPromise(token);
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
                  [owner, moduleGlobal, callInvoker](
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
                        [owner, moduleGlobal,
                         callInvoker,
                         storageKind = std::move(storageKind),
                         storagePath = std::move(storagePath),
                         storageName = std::move(storageName),
                         artifact = std::move(artifact)](
                            jsi::Runtime &runtime,
                            const jsi::Value &,
                            const jsi::Value *promiseArgs,
                            size_t promiseArgCount) mutable -> jsi::Value {
                          int64_t token = gNextToken.fetch_add(1);
                          auto pending = promiseCallbacks(runtime, promiseArgs, promiseArgCount, callInvoker, owner);
                          auto reject = pending.reject;
                          owner->storePendingPromise(token, std::move(pending));

                          try {
                            auto storageKindString = jni::make_jstring(storageKind);
                            auto storagePathString = jni::make_jstring(storagePath.value_or(""));
                            auto storageNameString = jni::make_jstring(storageName.value_or(""));
                            auto artifactArray = makeByteArray(artifact);
                            static const auto callbackConstructor =
                                OliphauntJsiPromiseCallback::javaClassStatic()
                                    ->getConstructor<OliphauntJsiPromiseCallback::javaobject(jlong, jlong)>();
                            auto callback =
                                OliphauntJsiPromiseCallback::javaClassStatic()
                                    ->newObject(callbackConstructor, static_cast<jlong>(owner->id), static_cast<jlong>(token));
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
                            owner->takePendingPromise(token);
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

  static void invalidateJsiBindings(jni::alias_ref<OliphauntModuleJSIBindings> module)
  {
    static const auto ownerField = javaClassStatic()->getField<jlong>("jsiOwnerId");
    std::shared_ptr<RuntimeState> owner;
    {
      std::lock_guard<std::mutex> lock(gOwnersMutex);
      auto found = gOwners.find(module->getFieldValue(ownerField));
      module->setFieldValue(ownerField, static_cast<jlong>(-1));
      if (found == gOwners.end()) return;
      owner = std::move(found->second);
      gOwners.erase(found);
    }
    owner->close();
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
