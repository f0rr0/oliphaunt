#import "OliphauntReactNative.h"
#import "OliphauntAdapter.h"

#import <React/RCTUtils.h>

#ifdef RCT_NEW_ARCH_ENABLED
#include <ReactCommon/CallInvoker.h>
#include <jsi/jsi.h>
#include <react/bridging/Function.h>
#endif

#include <cmath>
#include <limits>
#include <memory>
#include <string>
#include <vector>

static void OliphauntReject(
    RCTPromiseRejectBlock reject,
    NSString *code,
    NSString *fallback,
    NSError *error)
{
  reject(code, error.localizedDescription ?: fallback, error);
}

#ifdef RCT_NEW_ARCH_ENABLED
static void OliphauntSetIfPresent(NSMutableDictionary *dictionary, NSString *key, id value)
{
  if (value != nil) {
    dictionary[key] = value;
  }
}

static NSDictionary *OliphauntNativeResourceConfigToDictionary(
    JS::NativeOliphaunt::NativeResourceConfig &config)
{
  NSMutableDictionary *dictionary = [NSMutableDictionary new];
  OliphauntSetIfPresent(dictionary, @"resourceRoot", config.resourceRoot());
  return dictionary;
}

static NSDictionary *OliphauntNativeOpenConfigToDictionary(
    JS::NativeOliphaunt::NativeOpenConfig &config)
{
  NSMutableDictionary *dictionary = [NSMutableDictionary new];
  OliphauntSetIfPresent(dictionary, @"engine", config.engine());
  OliphauntSetIfPresent(dictionary, @"root", config.root());
  if (auto temporary = config.temporary()) {
    dictionary[@"temporary"] = @(*temporary);
  }
  OliphauntSetIfPresent(dictionary, @"durability", config.durability());
  OliphauntSetIfPresent(dictionary, @"runtimeFootprint", config.runtimeFootprint());
  OliphauntSetIfPresent(dictionary, @"startupGUCs", RCTConvertOptionalVecToArray(config.startupGUCs()));
  OliphauntSetIfPresent(dictionary, @"username", config.username());
  OliphauntSetIfPresent(dictionary, @"database", config.database());
  OliphauntSetIfPresent(dictionary, @"extensions", RCTConvertOptionalVecToArray(config.extensions()));
  OliphauntSetIfPresent(dictionary, @"libraryPath", config.libraryPath());
  OliphauntSetIfPresent(dictionary, @"runtimeDirectory", config.runtimeDirectory());
  OliphauntSetIfPresent(dictionary, @"resourceRoot", config.resourceRoot());
  return dictionary;
}

class OliphauntMutableBuffer final : public facebook::jsi::MutableBuffer {
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

static facebook::jsi::ArrayBuffer OliphauntArrayBufferFromBytes(
    facebook::jsi::Runtime &runtime,
    std::vector<uint8_t> bytes)
{
  return facebook::jsi::ArrayBuffer(
      runtime,
      std::make_shared<OliphauntMutableBuffer>(std::move(bytes)));
}

static std::vector<uint8_t> OliphauntBytesFromNSData(NSData *_Nullable data)
{
  std::vector<uint8_t> bytes;
  if (data != nil && data.length > 0) {
    const uint8_t *begin = static_cast<const uint8_t *>(data.bytes);
    bytes.assign(begin, begin + data.length);
  }
  return bytes;
}

static size_t OliphauntCopySizeArgument(
    facebook::jsi::Runtime &runtime,
    double value,
    const char *name)
{
  constexpr double kMaxSafeInteger = 9007199254740991.0;
  if (!std::isfinite(value) ||
      value < 0 ||
      std::trunc(value) != value ||
      value > kMaxSafeInteger ||
      value > static_cast<double>(std::numeric_limits<size_t>::max())) {
    throw facebook::jsi::JSError(
        runtime,
        std::string("liboliphaunt JSI ") + name + " must be a non-negative integer");
  }
  return static_cast<size_t>(value);
}

static double OliphauntCopyHandleArgument(
    facebook::jsi::Runtime &runtime,
    const facebook::jsi::Value &value)
{
  constexpr double kMaxSafeInteger = 9007199254740991.0;
  if (!value.isNumber()) {
    throw facebook::jsi::JSError(runtime, "liboliphaunt JSI handle must be a number");
  }
  double handle = value.asNumber();
  if (!std::isfinite(handle) ||
      handle <= 0 ||
      std::trunc(handle) != handle ||
      handle > kMaxSafeInteger) {
    throw facebook::jsi::JSError(runtime, "liboliphaunt JSI handle must be a positive safe integer");
  }
  return handle;
}

static std::vector<uint8_t> OliphauntCopyBinaryArgument(
    facebook::jsi::Runtime &runtime,
    const facebook::jsi::Value &value)
{
  if (!value.isObject()) {
    throw facebook::jsi::JSError(runtime, "liboliphaunt JSI request must be an ArrayBuffer or typed array");
  }

  auto object = value.asObject(runtime);
  size_t byteOffset = 0;
  size_t byteLength = 0;
  facebook::jsi::ArrayBuffer buffer = [&]() {
    if (object.isArrayBuffer(runtime)) {
      auto arrayBuffer = object.getArrayBuffer(runtime);
      byteLength = arrayBuffer.size(runtime);
      return arrayBuffer;
    }

    auto bufferValue = object.getProperty(runtime, "buffer");
    if (!bufferValue.isObject() || !bufferValue.asObject(runtime).isArrayBuffer(runtime)) {
      throw facebook::jsi::JSError(runtime, "liboliphaunt JSI request must be an ArrayBuffer or typed array");
    }
    auto offsetValue = object.getProperty(runtime, "byteOffset");
    auto lengthValue = object.getProperty(runtime, "byteLength");
    if (!offsetValue.isNumber() || !lengthValue.isNumber()) {
      throw facebook::jsi::JSError(runtime, "liboliphaunt JSI typed-array request is missing byteOffset/byteLength");
    }
    byteOffset = OliphauntCopySizeArgument(
        runtime,
        offsetValue.asNumber(),
        "typed-array byteOffset");
    byteLength = OliphauntCopySizeArgument(
        runtime,
        lengthValue.asNumber(),
        "typed-array byteLength");
    return bufferValue.asObject(runtime).getArrayBuffer(runtime);
  }();

  if (byteOffset > buffer.size(runtime) || byteLength > buffer.size(runtime) - byteOffset) {
    throw facebook::jsi::JSError(runtime, "liboliphaunt JSI typed-array request is out of bounds");
  }

  const uint8_t *begin = buffer.data(runtime) + byteOffset;
  return std::vector<uint8_t>(begin, begin + byteLength);
}

static std::string OliphauntCopyStringArgument(
    facebook::jsi::Runtime &runtime,
    const facebook::jsi::Value &value,
    const char *name)
{
  if (!value.isString()) {
    throw facebook::jsi::JSError(runtime, std::string("liboliphaunt JSI ") + name + " must be a string");
  }
  return value.asString(runtime).utf8(runtime);
}

static NSString *OliphauntNSStringFromString(const std::string &value)
{
  return [NSString stringWithUTF8String:value.c_str()] ?: @"";
}

static NSString *_Nullable OliphauntCopyOptionalNSStringArgument(
    facebook::jsi::Runtime &runtime,
    const facebook::jsi::Value &value,
    const char *name)
{
  if (value.isNull() || value.isUndefined()) {
    return nil;
  }
  return OliphauntNSStringFromString(OliphauntCopyStringArgument(runtime, value, name));
}

static facebook::jsi::Value OliphauntCreateError(
    facebook::jsi::Runtime &runtime,
    const std::string &message)
{
  return runtime.global()
      .getPropertyAsFunction(runtime, "Error")
      .callAsConstructor(runtime, facebook::jsi::String::createFromUtf8(runtime, message));
}
#endif

static NSString *OliphauntStringConfigValue(id value, NSString *defaultValue)
{
  return [value isKindOfClass:[NSString class]] ? (NSString *)value : defaultValue;
}

@implementation Oliphaunt {
  NSMutableDictionary<NSNumber *, OliphauntAdapterDatabase *> *_sessions;
  NSMutableDictionary<NSNumber *, NSString *> *_sessionKeys;
  dispatch_queue_t _methodQueue;
  NSString *_pendingSessionKey;
  uint64_t _nextHandle;
}

RCT_EXPORT_MODULE(Oliphaunt)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (instancetype)init
{
  if (self = [super init]) {
    _sessions = [NSMutableDictionary new];
    _sessionKeys = [NSMutableDictionary new];
    _methodQueue = dispatch_queue_create("dev.oliphaunt.reactnative.ios.module", DISPATCH_QUEUE_SERIAL);
    _nextHandle = 1;
  }
  return self;
}

- (dispatch_queue_t)methodQueue
{
  return _methodQueue;
}

#ifdef RCT_NEW_ARCH_ENABLED
- (void)open:(JS::NativeOliphaunt::NativeOpenConfig &)config
     resolve:(RCTPromiseResolveBlock)resolve
      reject:(RCTPromiseRejectBlock)reject
{
  [self openWithConfigDictionary:OliphauntNativeOpenConfigToDictionary(config) resolve:resolve reject:reject];
}
#else
- (void)open:(NSDictionary *)config
     resolve:(RCTPromiseResolveBlock)resolve
      reject:(RCTPromiseRejectBlock)reject
{
  [self openWithConfigDictionary:config resolve:resolve reject:reject];
}
#endif

- (void)openWithConfigDictionary:(NSDictionary *)config
                         resolve:(RCTPromiseResolveBlock)resolve
                          reject:(RCTPromiseRejectBlock)reject
{
  NSDictionary *configCopy = [config copy] ?: @{};
  NSString *sessionKey = [self sessionKeyForConfigDictionary:configCopy];
  @synchronized (self) {
    NSNumber *existingHandle = [self existingHandleForSessionKey:sessionKey];
    if (existingHandle != nil) {
      resolve(existingHandle);
      return;
    }
    if (_pendingSessionKey != nil) {
      reject(
          @"liboliphaunt_open_in_progress",
          @"React Native nativeDirect already has an open in progress",
          nil);
      return;
    }
    if (_sessions.count > 0) {
      reject(
          @"liboliphaunt_open_failed",
          @"React Native nativeDirect already has an active database; close it before opening another root",
          nil);
      return;
    }
    _pendingSessionKey = sessionKey;
  }
  [OliphauntAdapterDatabase openWithConfig:configCopy completion:^(
      OliphauntAdapterDatabase *_Nullable database,
      NSError *_Nullable error) {
    if (database == nil) {
      @synchronized (self) {
        self->_pendingSessionKey = nil;
      }
      OliphauntReject(reject, @"liboliphaunt_open_failed", @"failed to open liboliphaunt", error);
      return;
    }

    NSNumber *handle = nil;
    @synchronized (self) {
      handle = @(self->_nextHandle++);
      self->_sessions[handle] = database;
      self->_sessionKeys[handle] = sessionKey;
      self->_pendingSessionKey = nil;
    }
    resolve(handle);
  }];
}

- (void)supportedModes:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject
{
  [OliphauntAdapterDatabase supportedModesWithCompletion:^(
      NSArray *_Nullable modes,
      NSError *_Nullable error) {
    if (error != nil) {
      OliphauntReject(reject, @"liboliphaunt_supported_modes_failed", @"liboliphaunt supportedModes failed", error);
      return;
    }
    resolve(modes ?: @[]);
  }];
}

- (void)packageSizeReportWithConfigDictionary:(NSDictionary *)config
                                      resolve:(RCTPromiseResolveBlock)resolve
                                       reject:(RCTPromiseRejectBlock)reject
{
  NSDictionary *configCopy = [config copy] ?: @{};
  [OliphauntAdapterDatabase packageSizeReportWithConfig:configCopy completion:^(
      NSDictionary *_Nullable report,
      NSError *_Nullable error) {
    if (error != nil) {
      OliphauntReject(reject, @"liboliphaunt_package_size_failed", @"liboliphaunt packageSizeReport failed", error);
      return;
    }
    resolve(report ?: [NSNull null]);
  }];
}

- (void)processMemory:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject
{
  [OliphauntAdapterDatabase processMemoryWithCompletion:^(
      NSDictionary *_Nullable report,
      NSError *_Nullable error) {
    if (error != nil) {
      OliphauntReject(reject, @"liboliphaunt_process_memory_failed", @"liboliphaunt processMemory failed", error);
      return;
    }
    resolve(report ?: @{});
  }];
}

#ifdef RCT_NEW_ARCH_ENABLED
- (void)packageSizeReport:(JS::NativeOliphaunt::NativeResourceConfig &)config
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject
{
  [self packageSizeReportWithConfigDictionary:OliphauntNativeResourceConfigToDictionary(config)
                                      resolve:resolve
                                       reject:reject];
}
#else
- (void)packageSizeReport:(NSDictionary *)config
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject
{
  [self packageSizeReportWithConfigDictionary:config resolve:resolve reject:reject];
}
#endif

- (void)execProtocolRawDataForJsi:(double)handle
                          request:(NSData *)request
                       completion:(OliphauntDataCompletion)completion
{
  OliphauntAdapterDatabase *database = [self sessionForHandle:handle];
  if (database == nil) {
    completion(nil, [NSError errorWithDomain:@"dev.oliphaunt.reactnative.ios"
                                        code:404
                                    userInfo:@{NSLocalizedDescriptionKey: @"unknown Oliphaunt handle"}]);
    return;
  }
  [database execProtocolData:request completion:completion];
}

- (void)execProtocolStreamDataForJsi:(double)handle
                              request:(NSData *)request
                              onChunk:(OliphauntStreamChunk)onChunk
                           completion:(OliphauntVoidCompletion)completion
{
  OliphauntAdapterDatabase *database = [self sessionForHandle:handle];
  if (database == nil) {
    completion([NSError errorWithDomain:@"dev.oliphaunt.reactnative.ios"
                                   code:404
                               userInfo:@{NSLocalizedDescriptionKey: @"unknown Oliphaunt handle"}]);
    return;
  }
  [database execProtocolStreamData:request onChunk:onChunk completion:completion];
}

- (void)backupDataForJsi:(double)handle
                  format:(NSString *)format
              completion:(OliphauntDataCompletion)completion
{
  OliphauntAdapterDatabase *database = [self sessionForHandle:handle];
  if (database == nil) {
    completion(nil, [NSError errorWithDomain:@"dev.oliphaunt.reactnative.ios"
                                        code:404
                                    userInfo:@{NSLocalizedDescriptionKey: @"unknown Oliphaunt handle"}]);
    return;
  }
  [database backupDataWithFormat:format completion:completion];
}

- (void)restoreDataForJsi:(NSString *)root
                   format:(NSString *)format
             artifactData:(NSData *)artifactData
          replaceExisting:(BOOL)replaceExisting
              libraryPath:(NSString *_Nullable)libraryPath
               completion:(OliphauntStringCompletion)completion
{
  [OliphauntAdapterDatabase restoreWithRoot:root
                                   format:format
                             artifactData:artifactData
                          replaceExisting:replaceExisting
                              libraryPath:libraryPath
                               completion:completion];
}

#ifdef RCT_NEW_ARCH_ENABLED
- (void)installJSIBindingsWithRuntime:(facebook::jsi::Runtime &)runtime
                          callInvoker:(const std::shared_ptr<facebook::react::CallInvoker> &)callInvoker
{
  __weak Oliphaunt *weakSelf = self;
  auto transport = facebook::jsi::Object(runtime);
  transport.setProperty(runtime, "version", 1);
  transport.setProperty(
      runtime,
      "execProtocolRaw",
      facebook::jsi::Function::createFromHostFunction(
          runtime,
          facebook::jsi::PropNameID::forAscii(runtime, "liboliphauntExecProtocolRaw"),
          2,
          [weakSelf, callInvoker](
              facebook::jsi::Runtime &runtime,
              const facebook::jsi::Value &,
              const facebook::jsi::Value *args,
              size_t count) -> facebook::jsi::Value {
            if (count != 2) {
              throw facebook::jsi::JSError(runtime, "liboliphaunt JSI execProtocolRaw expects handle and request");
            }

            double handle = OliphauntCopyHandleArgument(runtime, args[0]);
            std::vector<uint8_t> request = OliphauntCopyBinaryArgument(runtime, args[1]);
            auto requestData = [NSData dataWithBytes:request.data() length:request.size()];
            auto promiseConstructor = runtime.global().getPropertyAsFunction(runtime, "Promise");
            auto executor = facebook::jsi::Function::createFromHostFunction(
                runtime,
                facebook::jsi::PropNameID::forAscii(runtime, "liboliphauntExecProtocolRawExecutor"),
                2,
                [weakSelf, callInvoker, handle, requestData](
                    facebook::jsi::Runtime &runtime,
                    const facebook::jsi::Value &,
                    const facebook::jsi::Value *promiseArgs,
                    size_t promiseArgCount) -> facebook::jsi::Value {
                  if (promiseArgCount < 2 ||
                      !promiseArgs[0].isObject() ||
                      !promiseArgs[0].asObject(runtime).isFunction(runtime) ||
                      !promiseArgs[1].isObject() ||
                      !promiseArgs[1].asObject(runtime).isFunction(runtime)) {
                    throw facebook::jsi::JSError(runtime, "liboliphaunt JSI Promise executor received invalid callbacks");
                  }

                  auto resolve = std::make_shared<facebook::react::AsyncCallback<>>(
                      runtime,
                      promiseArgs[0].asObject(runtime).getFunction(runtime),
                      callInvoker);
                  auto reject = std::make_shared<facebook::react::AsyncCallback<>>(
                      runtime,
                      promiseArgs[1].asObject(runtime).getFunction(runtime),
                      callInvoker);
                  Oliphaunt *strongSelf = weakSelf;
                  if (strongSelf == nil) {
                    reject->call([](facebook::jsi::Runtime &runtime, facebook::jsi::Function &rejectFunction) {
                      rejectFunction.call(runtime, OliphauntCreateError(runtime, "liboliphaunt native module is unavailable"));
                    });
                    return facebook::jsi::Value::undefined();
                  }

                  [strongSelf execProtocolRawDataForJsi:handle
                                                request:requestData
                                             completion:^(NSData *_Nullable response, NSError *_Nullable error) {
                    if (error != nil) {
                      const char *errorMessage = error.localizedDescription.UTF8String;
                      std::string message = errorMessage != nullptr ? errorMessage : "liboliphaunt exec failed";
                      reject->call([message](facebook::jsi::Runtime &runtime, facebook::jsi::Function &rejectFunction) {
                        rejectFunction.call(runtime, OliphauntCreateError(runtime, message));
                      });
                      return;
                    }
                    std::vector<uint8_t> bytes = OliphauntBytesFromNSData(response);
                    resolve->call([bytes = std::move(bytes)](
                                      facebook::jsi::Runtime &runtime,
                                      facebook::jsi::Function &resolveFunction) mutable {
                      resolveFunction.call(runtime, OliphauntArrayBufferFromBytes(runtime, std::move(bytes)));
                    });
                  }];
                  return facebook::jsi::Value::undefined();
                });
            return promiseConstructor.callAsConstructor(runtime, std::move(executor));
          }));
  transport.setProperty(
      runtime,
      "execProtocolStream",
      facebook::jsi::Function::createFromHostFunction(
          runtime,
          facebook::jsi::PropNameID::forAscii(runtime, "liboliphauntExecProtocolStream"),
          3,
          [weakSelf, callInvoker](
              facebook::jsi::Runtime &runtime,
              const facebook::jsi::Value &,
              const facebook::jsi::Value *args,
              size_t count) -> facebook::jsi::Value {
            if (count != 3 || !args[2].isObject() || !args[2].asObject(runtime).isFunction(runtime)) {
              throw facebook::jsi::JSError(runtime, "liboliphaunt JSI execProtocolStream expects handle, request, and onChunk");
            }

            double handle = OliphauntCopyHandleArgument(runtime, args[0]);
            std::vector<uint8_t> request = OliphauntCopyBinaryArgument(runtime, args[1]);
            auto requestData = [NSData dataWithBytes:request.data() length:request.size()];
            auto chunkCallback = std::make_shared<facebook::react::AsyncCallback<>>(
                runtime,
                args[2].asObject(runtime).getFunction(runtime),
                callInvoker);
            auto promiseConstructor = runtime.global().getPropertyAsFunction(runtime, "Promise");
            auto executor = facebook::jsi::Function::createFromHostFunction(
                runtime,
                facebook::jsi::PropNameID::forAscii(runtime, "liboliphauntExecProtocolStreamExecutor"),
                2,
                [weakSelf, callInvoker, handle, requestData, chunkCallback](
                    facebook::jsi::Runtime &runtime,
                    const facebook::jsi::Value &,
                    const facebook::jsi::Value *promiseArgs,
                    size_t promiseArgCount) -> facebook::jsi::Value {
                  if (promiseArgCount < 2 ||
                      !promiseArgs[0].isObject() ||
                      !promiseArgs[0].asObject(runtime).isFunction(runtime) ||
                      !promiseArgs[1].isObject() ||
                      !promiseArgs[1].asObject(runtime).isFunction(runtime)) {
                    throw facebook::jsi::JSError(runtime, "liboliphaunt JSI Promise executor received invalid callbacks");
                  }

                  auto resolve = std::make_shared<facebook::react::AsyncCallback<>>(
                      runtime,
                      promiseArgs[0].asObject(runtime).getFunction(runtime),
                      callInvoker);
                  auto reject = std::make_shared<facebook::react::AsyncCallback<>>(
                      runtime,
                      promiseArgs[1].asObject(runtime).getFunction(runtime),
                      callInvoker);
                  Oliphaunt *strongSelf = weakSelf;
                  if (strongSelf == nil) {
                    reject->call([](facebook::jsi::Runtime &runtime, facebook::jsi::Function &rejectFunction) {
                      rejectFunction.call(runtime, OliphauntCreateError(runtime, "liboliphaunt native module is unavailable"));
                    });
                    return facebook::jsi::Value::undefined();
                  }

                  [strongSelf execProtocolStreamDataForJsi:handle
                                                   request:requestData
                                                   onChunk:^(NSData *chunk) {
                    std::vector<uint8_t> bytes = OliphauntBytesFromNSData(chunk);
                    chunkCallback->call([bytes = std::move(bytes)](
                                            facebook::jsi::Runtime &runtime,
                                            facebook::jsi::Function &chunkFunction) mutable {
                      chunkFunction.call(runtime, OliphauntArrayBufferFromBytes(runtime, std::move(bytes)));
                    });
                  }
                                                completion:^(NSError *_Nullable error) {
                    if (error != nil) {
                      const char *errorMessage = error.localizedDescription.UTF8String;
                      std::string message = errorMessage != nullptr ? errorMessage : "liboliphaunt stream failed";
                      reject->call([message](facebook::jsi::Runtime &runtime, facebook::jsi::Function &rejectFunction) {
                        rejectFunction.call(runtime, OliphauntCreateError(runtime, message));
                      });
                      return;
                    }
                    resolve->call([](facebook::jsi::Runtime &runtime, facebook::jsi::Function &resolveFunction) {
                      resolveFunction.call(runtime, facebook::jsi::Value::undefined());
                    });
                  }];
                  return facebook::jsi::Value::undefined();
                });
            return promiseConstructor.callAsConstructor(runtime, std::move(executor));
          }));
  transport.setProperty(
      runtime,
      "backup",
      facebook::jsi::Function::createFromHostFunction(
          runtime,
          facebook::jsi::PropNameID::forAscii(runtime, "liboliphauntBackup"),
          2,
          [weakSelf, callInvoker](
              facebook::jsi::Runtime &runtime,
              const facebook::jsi::Value &,
              const facebook::jsi::Value *args,
              size_t count) -> facebook::jsi::Value {
            if (count != 2) {
              throw facebook::jsi::JSError(runtime, "liboliphaunt JSI backup expects handle and format");
            }

            double handle = OliphauntCopyHandleArgument(runtime, args[0]);
            NSString *format = OliphauntNSStringFromString(
                OliphauntCopyStringArgument(runtime, args[1], "backup format"));
            auto promiseConstructor = runtime.global().getPropertyAsFunction(runtime, "Promise");
            auto executor = facebook::jsi::Function::createFromHostFunction(
                runtime,
                facebook::jsi::PropNameID::forAscii(runtime, "liboliphauntBackupExecutor"),
                2,
                [weakSelf, callInvoker, handle, format](
                    facebook::jsi::Runtime &runtime,
                    const facebook::jsi::Value &,
                    const facebook::jsi::Value *promiseArgs,
                    size_t promiseArgCount) -> facebook::jsi::Value {
                  if (promiseArgCount < 2 ||
                      !promiseArgs[0].isObject() ||
                      !promiseArgs[0].asObject(runtime).isFunction(runtime) ||
                      !promiseArgs[1].isObject() ||
                      !promiseArgs[1].asObject(runtime).isFunction(runtime)) {
                    throw facebook::jsi::JSError(runtime, "liboliphaunt JSI Promise executor received invalid callbacks");
                  }

                  auto resolve = std::make_shared<facebook::react::AsyncCallback<>>(
                      runtime,
                      promiseArgs[0].asObject(runtime).getFunction(runtime),
                      callInvoker);
                  auto reject = std::make_shared<facebook::react::AsyncCallback<>>(
                      runtime,
                      promiseArgs[1].asObject(runtime).getFunction(runtime),
                      callInvoker);
                  Oliphaunt *strongSelf = weakSelf;
                  if (strongSelf == nil) {
                    reject->call([](facebook::jsi::Runtime &runtime, facebook::jsi::Function &rejectFunction) {
                      rejectFunction.call(runtime, OliphauntCreateError(runtime, "liboliphaunt native module is unavailable"));
                    });
                    return facebook::jsi::Value::undefined();
                  }

                  [strongSelf backupDataForJsi:handle
                                        format:format
                                    completion:^(NSData *_Nullable response, NSError *_Nullable error) {
                    if (error != nil) {
                      const char *errorMessage = error.localizedDescription.UTF8String;
                      std::string message = errorMessage != nullptr ? errorMessage : "liboliphaunt backup failed";
                      reject->call([message](facebook::jsi::Runtime &runtime, facebook::jsi::Function &rejectFunction) {
                        rejectFunction.call(runtime, OliphauntCreateError(runtime, message));
                      });
                      return;
                    }
                    std::vector<uint8_t> bytes = OliphauntBytesFromNSData(response);
                    resolve->call([bytes = std::move(bytes)](
                                      facebook::jsi::Runtime &runtime,
                                      facebook::jsi::Function &resolveFunction) mutable {
                      resolveFunction.call(runtime, OliphauntArrayBufferFromBytes(runtime, std::move(bytes)));
                    });
                  }];
                  return facebook::jsi::Value::undefined();
                });
            return promiseConstructor.callAsConstructor(runtime, std::move(executor));
          }));
  transport.setProperty(
      runtime,
      "restore",
      facebook::jsi::Function::createFromHostFunction(
          runtime,
          facebook::jsi::PropNameID::forAscii(runtime, "liboliphauntRestore"),
          5,
          [weakSelf, callInvoker](
              facebook::jsi::Runtime &runtime,
              const facebook::jsi::Value &,
              const facebook::jsi::Value *args,
              size_t count) -> facebook::jsi::Value {
            if (count != 5 || !args[3].isBool()) {
              throw facebook::jsi::JSError(runtime, "liboliphaunt JSI restore expects root, format, artifact, replaceExisting, and libraryPath");
            }

            NSString *root = OliphauntNSStringFromString(
                OliphauntCopyStringArgument(runtime, args[0], "restore root"));
            NSString *format = OliphauntNSStringFromString(
                OliphauntCopyStringArgument(runtime, args[1], "restore format"));
            std::vector<uint8_t> artifact = OliphauntCopyBinaryArgument(runtime, args[2]);
            auto artifactData = [NSData dataWithBytes:artifact.data() length:artifact.size()];
            BOOL replaceExisting = args[3].getBool();
            NSString *libraryPath = OliphauntCopyOptionalNSStringArgument(runtime, args[4], "restore libraryPath");
            auto promiseConstructor = runtime.global().getPropertyAsFunction(runtime, "Promise");
            auto executor = facebook::jsi::Function::createFromHostFunction(
                runtime,
                facebook::jsi::PropNameID::forAscii(runtime, "liboliphauntRestoreExecutor"),
                2,
                [weakSelf, callInvoker, root, format, artifactData, replaceExisting, libraryPath](
                    facebook::jsi::Runtime &runtime,
                    const facebook::jsi::Value &,
                    const facebook::jsi::Value *promiseArgs,
                    size_t promiseArgCount) -> facebook::jsi::Value {
                  if (promiseArgCount < 2 ||
                      !promiseArgs[0].isObject() ||
                      !promiseArgs[0].asObject(runtime).isFunction(runtime) ||
                      !promiseArgs[1].isObject() ||
                      !promiseArgs[1].asObject(runtime).isFunction(runtime)) {
                    throw facebook::jsi::JSError(runtime, "liboliphaunt JSI Promise executor received invalid callbacks");
                  }

                  auto resolve = std::make_shared<facebook::react::AsyncCallback<>>(
                      runtime,
                      promiseArgs[0].asObject(runtime).getFunction(runtime),
                      callInvoker);
                  auto reject = std::make_shared<facebook::react::AsyncCallback<>>(
                      runtime,
                      promiseArgs[1].asObject(runtime).getFunction(runtime),
                      callInvoker);
                  Oliphaunt *strongSelf = weakSelf;
                  if (strongSelf == nil) {
                    reject->call([](facebook::jsi::Runtime &runtime, facebook::jsi::Function &rejectFunction) {
                      rejectFunction.call(runtime, OliphauntCreateError(runtime, "liboliphaunt native module is unavailable"));
                    });
                    return facebook::jsi::Value::undefined();
                  }

                  [strongSelf restoreDataForJsi:root
                                         format:format
                                   artifactData:artifactData
                                replaceExisting:replaceExisting
                                    libraryPath:libraryPath
                                     completion:^(NSString *_Nullable restoredRoot, NSError *_Nullable error) {
                    if (error != nil) {
                      const char *errorMessage = error.localizedDescription.UTF8String;
                      std::string message = errorMessage != nullptr ? errorMessage : "liboliphaunt restore failed";
                      reject->call([message](facebook::jsi::Runtime &runtime, facebook::jsi::Function &rejectFunction) {
                        rejectFunction.call(runtime, OliphauntCreateError(runtime, message));
                      });
                      return;
                    }
                    std::string restored = restoredRoot.UTF8String != nullptr ? restoredRoot.UTF8String : "";
                    resolve->call([restored](facebook::jsi::Runtime &runtime, facebook::jsi::Function &resolveFunction) {
                      resolveFunction.call(runtime, facebook::jsi::String::createFromUtf8(runtime, restored));
                    });
                  }];
                  return facebook::jsi::Value::undefined();
                });
            return promiseConstructor.callAsConstructor(runtime, std::move(executor));
          }));
  runtime.global().setProperty(runtime, "__oliphauntReactNativeJsi", std::move(transport));
}
#endif

- (void)close:(double)handle
      resolve:(RCTPromiseResolveBlock)resolve
       reject:(RCTPromiseRejectBlock)reject
{
  OliphauntAdapterDatabase *database = [self removeSessionForHandle:handle];
  if (database == nil) {
    resolve(nil);
    return;
  }
  [database closeWithCompletion:^(NSError *_Nullable error) {
    if (error != nil) {
      OliphauntReject(reject, @"liboliphaunt_close_failed", @"liboliphaunt close failed", error);
      return;
    }
    resolve(nil);
  }];
}

- (void)cancel:(double)handle
       resolve:(RCTPromiseResolveBlock)resolve
        reject:(RCTPromiseRejectBlock)reject
{
  OliphauntAdapterDatabase *database = [self sessionForHandle:handle];
  if (database == nil) {
    reject(@"liboliphaunt_unknown_handle", @"unknown Oliphaunt handle", nil);
    return;
  }
  [database cancelWithCompletion:^(NSError *_Nullable error) {
    if (error != nil) {
      OliphauntReject(reject, @"liboliphaunt_cancel_failed", @"liboliphaunt cancel failed", error);
      return;
    }
    resolve(nil);
  }];
}

- (void)capabilities:(double)handle
             resolve:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject
{
  OliphauntAdapterDatabase *database = [self sessionForHandle:handle];
  if (database == nil) {
    reject(@"liboliphaunt_unknown_handle", @"unknown Oliphaunt handle", nil);
    return;
  }
  [database capabilitiesWithCompletion:^(NSDictionary *_Nullable capabilities, NSError *_Nullable error) {
    if (error != nil) {
      OliphauntReject(reject, @"liboliphaunt_capabilities_failed", @"liboliphaunt capabilities failed", error);
      return;
    }
    resolve(capabilities ?: @{});
  }];
}

- (OliphauntAdapterDatabase *)sessionForHandle:(double)handle
{
  NSNumber *key = @((uint64_t)handle);
  @synchronized (self) {
    return _sessions[key];
  }
}

- (OliphauntAdapterDatabase *)removeSessionForHandle:(double)handle
{
  NSNumber *key = @((uint64_t)handle);
  @synchronized (self) {
    OliphauntAdapterDatabase *database = _sessions[key];
    [_sessions removeObjectForKey:key];
    [_sessionKeys removeObjectForKey:key];
    return database;
  }
}

- (NSNumber *)existingHandleForSessionKey:(NSString *)sessionKey
{
  for (NSNumber *handle in _sessionKeys) {
    if ([_sessionKeys[handle] isEqualToString:sessionKey] && _sessions[handle] != nil) {
      return handle;
    }
  }
  return nil;
}

- (NSString *)sessionKeyForConfigDictionary:(NSDictionary *)config
{
  NSMutableArray<NSString *> *extensions = [NSMutableArray new];
  NSMutableArray<NSString *> *startupGUCs = [NSMutableArray new];
  id rawExtensions = config[@"extensions"];
  if ([rawExtensions isKindOfClass:[NSArray class]]) {
    for (id extension in (NSArray *)rawExtensions) {
      if ([extension isKindOfClass:[NSString class]]) {
        [extensions addObject:(NSString *)extension];
      }
    }
  }
  id rawStartupGUCs = config[@"startupGUCs"];
  if ([rawStartupGUCs isKindOfClass:[NSArray class]]) {
    for (id guc in (NSArray *)rawStartupGUCs) {
      if ([guc isKindOfClass:[NSString class]]) {
        [startupGUCs addObject:(NSString *)guc];
      }
    }
  }
  NSString *separator = [NSString stringWithFormat:@"%C", (unichar)0x001F];
  return [@[
    OliphauntStringConfigValue(config[@"engine"], @"nativeDirect"),
    OliphauntStringConfigValue(config[@"root"], @""),
    OliphauntStringConfigValue(config[@"durability"], @"balanced"),
    OliphauntStringConfigValue(config[@"runtimeFootprint"], @"balancedMobile"),
    [startupGUCs componentsJoinedByString:@","],
    OliphauntStringConfigValue(config[@"username"], @"postgres"),
    OliphauntStringConfigValue(config[@"database"], @"postgres"),
    [extensions componentsJoinedByString:@","],
    OliphauntStringConfigValue(config[@"libraryPath"], @""),
    OliphauntStringConfigValue(config[@"runtimeDirectory"], @""),
    OliphauntStringConfigValue(config[@"resourceRoot"], @""),
  ] componentsJoinedByString:separator];
}

- (void)invalidate
{
  NSArray<OliphauntAdapterDatabase *> *sessionsToClose = nil;
  @synchronized (self) {
    sessionsToClose = _sessions.allValues;
    [_sessions removeAllObjects];
    [_sessionKeys removeAllObjects];
    _pendingSessionKey = nil;
  }
  if (sessionsToClose.count == 0) {
    return;
  }
  dispatch_group_t group = dispatch_group_create();
  for (OliphauntAdapterDatabase *database in sessionsToClose) {
    dispatch_group_enter(group);
    [database closeWithCompletion:^(__unused NSError *_Nullable error) {
      dispatch_group_leave(group);
    }];
  }
  dispatch_group_wait(group, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC));
}

#ifdef RCT_NEW_ARCH_ENABLED
- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeOliphauntSpecJSI>(params);
}
#endif

@end
