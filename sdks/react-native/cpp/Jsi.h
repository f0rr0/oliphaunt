#pragma once
#include "Lifecycle.h"
#include <ReactCommon/CallInvoker.h>
#include <react/bridging/Function.h>
#include <jsi/jsi.h>
#include <cmath>
#include <limits>
#include <cstdint>
#include <utility>

namespace oliphaunt::reactnative {
namespace jsi = facebook::jsi;

class RuntimeCallback final {
 public:
  RuntimeCallback(jsi::Runtime &runtime, jsi::Function function,
      const std::shared_ptr<facebook::react::CallInvoker> &invoker,
      std::shared_ptr<RuntimeLifetime> lifetime,
      std::shared_ptr<std::atomic<bool>> settled = nullptr)
      : callback_(runtime, std::move(function), invoker),
        lifetime_(std::move(lifetime)), settled_(std::move(settled)) {}

  template <typename F> void call(F action)
  {
    if (!lifetime_->active() || (settled_ && settled_->exchange(true))) return;
    callback_.call([lifetime = lifetime_, action = std::move(action)](
        jsi::Runtime &runtime, jsi::Function &function) mutable {
      if (lifetime->active()) action(runtime, function);
    });
  }

 private:
  facebook::react::AsyncCallback<> callback_;
  std::shared_ptr<RuntimeLifetime> lifetime_;
  std::shared_ptr<std::atomic<bool>> settled_;
};

struct PendingPromise {
  std::shared_ptr<RuntimeCallback> resolve;
  std::shared_ptr<RuntimeCallback> reject;
};

inline PendingPromise promiseCallbacks(jsi::Runtime &runtime,
    const jsi::Value *args, size_t count,
    const std::shared_ptr<facebook::react::CallInvoker> &invoker,
    const std::shared_ptr<RuntimeLifetime> &lifetime)
{
  if (!lifetime->active()) throw jsi::JSError(runtime, invalidatedMessage);
  if (count < 2 || !args[0].isObject() ||
      !args[0].asObject(runtime).isFunction(runtime) || !args[1].isObject() ||
      !args[1].asObject(runtime).isFunction(runtime))
    throw jsi::JSError(runtime, "liboliphaunt JSI Promise executor received invalid callbacks");
  auto settled = std::make_shared<std::atomic<bool>>(false);
  return {
    std::make_shared<RuntimeCallback>(runtime,
        args[0].asObject(runtime).getFunction(runtime), invoker, lifetime, settled),
    std::make_shared<RuntimeCallback>(runtime,
        args[1].asObject(runtime).getFunction(runtime), invoker, lifetime, settled),
  };
}
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

inline jsi::ArrayBuffer arrayBufferFromBytes(jsi::Runtime &runtime, std::vector<uint8_t> bytes)
{
  return jsi::ArrayBuffer(
      runtime,
      std::make_shared<OliphauntMutableBuffer>(std::move(bytes)));
}

inline jsi::Value createError(jsi::Runtime &runtime, const std::string &message)
{
  return runtime.global()
      .getPropertyAsFunction(runtime, "Error")
      .callAsConstructor(runtime, jsi::String::createFromUtf8(runtime, message));
}

inline jsi::Value createProtocolCallbackAbortedError(
    jsi::Runtime &runtime,
    const std::string &message)
{
  auto value = createError(runtime, message);
  auto object = value.asObject(runtime);
  object.setProperty(runtime, "__oliphauntProtocolCallbackAborted", true);
  return object;
}

inline size_t copySizeArgument(jsi::Runtime &runtime, double value, const char *name)
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

inline int64_t copyHandleArgument(jsi::Runtime &runtime, const jsi::Value &value)
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

inline std::vector<uint8_t> copyBinaryArgument(jsi::Runtime &runtime, const jsi::Value &value)
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

  if (byteLength == 0) return {};
  const uint8_t *begin = buffer.data(runtime) + byteOffset;
  return std::vector<uint8_t>(begin, begin + byteLength);
}

inline std::string copyStringArgument(jsi::Runtime &runtime, const jsi::Value &value, const char *name)
{
  if (!value.isString()) {
    throw jsi::JSError(runtime, std::string("liboliphaunt JSI ") + name + " must be a string");
  }
  return value.asString(runtime).utf8(runtime);
}

inline std::optional<std::string> copyOptionalStringArgument(
    jsi::Runtime &runtime,
    const jsi::Value &value,
    const char *name)
{
  if (value.isNull() || value.isUndefined()) {
    return std::nullopt;
  }
  return copyStringArgument(runtime, value, name);
}


inline void deliverChunk(jsi::Runtime &runtime, jsi::Function &chunkFunction,
    std::vector<uint8_t> bytes, const std::shared_ptr<ChunkAcknowledgement> &acknowledgement)
{
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
}

} // namespace oliphaunt::reactnative
