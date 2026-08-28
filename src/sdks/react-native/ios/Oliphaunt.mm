#import "OliphauntReactNative.h"
#import "OliphauntAdapter.h"

#import <React/RCTUtils.h>

#ifdef RCT_NEW_ARCH_ENABLED
#include <ReactCommon/CallInvoker.h>
#include <jsi/jsi.h>
#include <react/bridging/Function.h>
#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <exception>
#include <mutex>
#include <optional>
#endif

#include <cmath>
#include <limits>
#include <memory>
#include <string>
#include <vector>

NSString * const OliphauntProtocolStreamCallbackAbortedErrorDomain =
    @"dev.oliphaunt.reactnative.ios.protocolStreamCallbackAborted";

#ifdef RCT_NEW_ARCH_ENABLED
class OliphauntChunkAcknowledgement final {
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

static std::mutex gOliphauntChunkAcknowledgementsMutex;
static std::vector<std::weak_ptr<OliphauntChunkAcknowledgement>> gOliphauntChunkAcknowledgements;

static void OliphauntRegisterChunkAcknowledgement(
    const std::shared_ptr<OliphauntChunkAcknowledgement> &acknowledgement)
{
  std::lock_guard<std::mutex> lock(gOliphauntChunkAcknowledgementsMutex);
  gOliphauntChunkAcknowledgements.erase(
      std::remove_if(
          gOliphauntChunkAcknowledgements.begin(),
          gOliphauntChunkAcknowledgements.end(),
          [](const auto &entry) { return entry.expired(); }),
      gOliphauntChunkAcknowledgements.end());
  gOliphauntChunkAcknowledgements.emplace_back(acknowledgement);
}

static void OliphauntUnregisterChunkAcknowledgement(
    const std::shared_ptr<OliphauntChunkAcknowledgement> &acknowledgement)
{
  std::lock_guard<std::mutex> lock(gOliphauntChunkAcknowledgementsMutex);
  gOliphauntChunkAcknowledgements.erase(
      std::remove_if(
          gOliphauntChunkAcknowledgements.begin(),
          gOliphauntChunkAcknowledgements.end(),
          [&acknowledgement](const auto &entry) {
            auto current = entry.lock();
            return current == nullptr || current == acknowledgement;
          }),
      gOliphauntChunkAcknowledgements.end());
}

static void OliphauntAbortChunkAcknowledgements(void)
{
  std::vector<std::shared_ptr<OliphauntChunkAcknowledgement>> acknowledgements;
  {
    std::lock_guard<std::mutex> lock(gOliphauntChunkAcknowledgementsMutex);
    acknowledgements.reserve(gOliphauntChunkAcknowledgements.size());
    for (const auto &entry : gOliphauntChunkAcknowledgements) {
      if (auto acknowledgement = entry.lock()) {
        acknowledgements.push_back(std::move(acknowledgement));
      }
    }
    gOliphauntChunkAcknowledgements.clear();
  }
  for (const auto &acknowledgement : acknowledgements) {
    acknowledgement->reject("React Native Oliphaunt module has been invalidated");
  }
}

static NSError *OliphauntProtocolStreamCallbackError(const std::string &message)
{
  NSString *description = [NSString stringWithUTF8String:message.c_str()];
  return [NSError errorWithDomain:@"dev.oliphaunt.reactnative.ios"
                             code:1
                         userInfo:@{NSLocalizedDescriptionKey: description ?: @"protocol stream callback failed"}];
}
#endif

static void OliphauntReject(
    RCTPromiseRejectBlock reject,
    NSString *code,
    NSString *fallback,
    NSError *error)
{
  reject(code, error.localizedDescription ?: fallback, error);
}

static constexpr double kOliphauntMaxSafeIntegerHandle = 9007199254740991.0;

static BOOL OliphauntIsValidHandle(double handle)
{
  return std::isfinite(handle) &&
      handle > 0 &&
      std::trunc(handle) == handle &&
      handle <= kOliphauntMaxSafeIntegerHandle;
}

static NSNumber *_Nullable OliphauntHandleKey(double handle)
{
  if (!OliphauntIsValidHandle(handle)) {
    return nil;
  }
  return @(static_cast<uint64_t>(handle));
}

typedef NS_ENUM(NSInteger, OliphauntNativeDirectCleanupAdmission) {
  OliphauntNativeDirectCleanupStarted,
  OliphauntNativeDirectCleanupAlreadyInFlight,
  OliphauntNativeDirectCleanupRejected,
};

static NSObject *OliphauntNativeDirectOwnerLock(void)
{
  static NSObject *lock;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    lock = [NSObject new];
  });
  return lock;
}

static uint64_t OliphauntNativeDirectGeneration = 0;
static uint64_t OliphauntNativeDirectClaim = 0;
static OliphauntAdapterDatabase *_Nullable OliphauntRetainedNativeDirectDatabase = nil;
static BOOL OliphauntNativeDirectCleanupInFlight = NO;

static NSError *OliphauntNativeDirectOwnerError(
    NSString *message,
    NSError *_Nullable underlying)
{
  NSMutableDictionary *userInfo = [@{NSLocalizedDescriptionKey: message} mutableCopy];
  if (underlying != nil) {
    userInfo[NSUnderlyingErrorKey] = underlying;
  }
  return [NSError errorWithDomain:@"dev.oliphaunt.reactnative.nativeDirect"
                             code:1
                         userInfo:userInfo];
}

static uint64_t OliphauntNextNativeDirectClaim(void)
{
  OliphauntNativeDirectGeneration += 1;
  if (OliphauntNativeDirectGeneration == 0) {
    OliphauntNativeDirectGeneration = 1;
  }
  return OliphauntNativeDirectGeneration;
}

static void OliphauntAcquireNativeDirect(
    void (^completion)(uint64_t claim, NSError *_Nullable error))
{
  __block uint64_t claim = 0;
  __block uint64_t retainedClaim = 0;
  __block OliphauntAdapterDatabase *retainedDatabase = nil;
  __block NSError *admissionError = nil;
  @synchronized (OliphauntNativeDirectOwnerLock()) {
    if (OliphauntNativeDirectCleanupInFlight) {
      admissionError = OliphauntNativeDirectOwnerError(
          @"React Native nativeDirect cleanup is already in progress",
          nil);
    } else if (OliphauntRetainedNativeDirectDatabase != nil) {
      retainedClaim = OliphauntNativeDirectClaim;
      retainedDatabase = OliphauntRetainedNativeDirectDatabase;
      OliphauntNativeDirectCleanupInFlight = YES;
    } else if (OliphauntNativeDirectClaim != 0) {
      admissionError = OliphauntNativeDirectOwnerError(
          @"React Native nativeDirect already has an active or pending open; close the active instance before opening another",
          nil);
    } else {
      claim = OliphauntNextNativeDirectClaim();
      OliphauntNativeDirectClaim = claim;
    }
  }

  if (admissionError != nil) {
    completion(0, admissionError);
    return;
  }
  if (retainedDatabase == nil) {
    completion(claim, nil);
    return;
  }

  [retainedDatabase closeWithCompletion:^(NSError *_Nullable closeError) {
    __block uint64_t recoveredClaim = 0;
    __block NSError *recoveryError = nil;
    @synchronized (OliphauntNativeDirectOwnerLock()) {
      OliphauntNativeDirectCleanupInFlight = NO;
      if (closeError != nil) {
        recoveryError = OliphauntNativeDirectOwnerError(
            @"React Native nativeDirect could not recover the previously retained instance",
            closeError);
      } else if (
          OliphauntNativeDirectClaim != retainedClaim ||
          OliphauntRetainedNativeDirectDatabase != retainedDatabase) {
        recoveryError = OliphauntNativeDirectOwnerError(
            @"React Native nativeDirect ownership changed during retained cleanup",
            nil);
      } else {
        OliphauntRetainedNativeDirectDatabase = nil;
        recoveredClaim = OliphauntNextNativeDirectClaim();
        OliphauntNativeDirectClaim = recoveredClaim;
      }
    }
    completion(recoveredClaim, recoveryError);
  }];
}

static void OliphauntReleaseNativeDirect(uint64_t claim)
{
  @synchronized (OliphauntNativeDirectOwnerLock()) {
    if (
        OliphauntNativeDirectClaim == claim &&
        OliphauntRetainedNativeDirectDatabase == nil) {
      OliphauntNativeDirectClaim = 0;
    }
  }
}

static OliphauntNativeDirectCleanupAdmission OliphauntBeginNativeDirectCleanup(
    uint64_t claim,
    OliphauntAdapterDatabase *database,
    NSError *_Nullable *_Nullable error)
{
  @synchronized (OliphauntNativeDirectOwnerLock()) {
    if (OliphauntNativeDirectClaim != claim || claim == 0) {
      if (error != nullptr) {
        *error = OliphauntNativeDirectOwnerError(
            @"React Native nativeDirect ownership changed before cleanup",
            nil);
      }
      return OliphauntNativeDirectCleanupRejected;
    }
    if (
        OliphauntRetainedNativeDirectDatabase != nil &&
        OliphauntRetainedNativeDirectDatabase != database) {
      if (error != nullptr) {
        *error = OliphauntNativeDirectOwnerError(
            @"React Native nativeDirect already retains a different database",
            nil);
      }
      return OliphauntNativeDirectCleanupRejected;
    }
    OliphauntRetainedNativeDirectDatabase = database;
    if (OliphauntNativeDirectCleanupInFlight) {
      return OliphauntNativeDirectCleanupAlreadyInFlight;
    }
    OliphauntNativeDirectCleanupInFlight = YES;
    return OliphauntNativeDirectCleanupStarted;
  }
}

static void OliphauntFinishNativeDirectCleanup(
    uint64_t claim,
    OliphauntAdapterDatabase *database,
    NSError *_Nullable error,
    BOOL retainOnFailure)
{
  @synchronized (OliphauntNativeDirectOwnerLock()) {
    if (
        OliphauntNativeDirectClaim != claim ||
        OliphauntRetainedNativeDirectDatabase != database) {
      return;
    }
    OliphauntNativeDirectCleanupInFlight = NO;
    if (error == nil) {
      OliphauntRetainedNativeDirectDatabase = nil;
      OliphauntNativeDirectClaim = 0;
    } else if (!retainOnFailure) {
      // The live module still owns this failed close and can retry it. Process-
      // wide retention is reserved for teardown, where that module owner goes
      // away and the next module must recover the exact database first.
      OliphauntRetainedNativeDirectDatabase = nil;
    }
  }
}

#ifdef RCT_NEW_ARCH_ENABLED
static void OliphauntSetIfPresent(NSMutableDictionary *dictionary, NSString *key, id value)
{
  if (value != nil) {
    dictionary[key] = value;
  }
}

static NSDictionary *OliphauntNativeOpenConfigToDictionary(
    JS::NativeOliphaunt::NativeOpenConfig &config)
{
  NSMutableDictionary *dictionary = [NSMutableDictionary new];
  dictionary[@"storageKind"] = config.storageKind();
  OliphauntSetIfPresent(dictionary, @"storagePath", config.storagePath());
  OliphauntSetIfPresent(dictionary, @"storageName", config.storageName());
  OliphauntSetIfPresent(dictionary, @"startupGUCs", RCTConvertOptionalVecToArray(config.startupGUCs()));
  OliphauntSetIfPresent(dictionary, @"username", config.username());
  OliphauntSetIfPresent(dictionary, @"database", config.database());
  OliphauntSetIfPresent(dictionary, @"extensions", RCTConvertOptionalVecToArray(config.extensions()));
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
  if (!value.isNumber()) {
    throw facebook::jsi::JSError(runtime, "liboliphaunt JSI handle must be a number");
  }
  double handle = value.asNumber();
  if (!OliphauntIsValidHandle(handle)) {
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

static facebook::jsi::Value OliphauntCreateProtocolCallbackAbortedError(
    facebook::jsi::Runtime &runtime,
    const std::string &message)
{
  auto value = OliphauntCreateError(runtime, message);
  auto object = value.asObject(runtime);
  object.setProperty(runtime, "__oliphauntProtocolCallbackAborted", true);
  return object;
}
#endif

@interface Oliphaunt ()
- (void)closeIfGeneration:(double)generation;
@end

@implementation Oliphaunt {
  NSMutableDictionary<NSNumber *, OliphauntAdapterDatabase *> *_sessions;
  dispatch_queue_t _methodQueue;
  uint64_t _nativeDirectClaim;
  BOOL _invalidated;
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
    _methodQueue = dispatch_queue_create("dev.oliphaunt.reactnative.ios.module", DISPATCH_QUEUE_SERIAL);
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
  @synchronized (self) {
    if (_invalidated) {
      reject(
          @"liboliphaunt_invalidated",
          @"React Native Oliphaunt module has been invalidated",
          nil);
      return;
    }
  }
  OliphauntAcquireNativeDirect(^(uint64_t claim, NSError *_Nullable admissionError) {
    if (admissionError != nil) {
      OliphauntReject(
          reject,
          @"liboliphaunt_open_failed",
          @"failed to acquire React Native nativeDirect ownership",
          admissionError);
      return;
    }
    if (claim > static_cast<uint64_t>(kOliphauntMaxSafeIntegerHandle)) {
      OliphauntReleaseNativeDirect(claim);
      reject(
          @"liboliphaunt_open_failed",
          @"React Native Oliphaunt generation space is exhausted",
          nil);
      return;
    }
    // The opaque JS handle is the process-wide ownership generation, so stale
    // finalizers can only name the exact session they originally owned.
    NSNumber *handle = @(claim);

    __block BOOL invalidatedBeforeOpen = NO;
    @synchronized (self) {
      invalidatedBeforeOpen = self->_invalidated;
      if (!invalidatedBeforeOpen) {
        self->_nativeDirectClaim = claim;
      }
    }
    if (invalidatedBeforeOpen) {
      OliphauntReleaseNativeDirect(claim);
      reject(
          @"liboliphaunt_invalidated",
          @"React Native Oliphaunt module was invalidated before opening nativeDirect",
          nil);
      return;
    }

    [OliphauntAdapterDatabase openWithConfig:configCopy completion:^(
        OliphauntAdapterDatabase *_Nullable database,
        NSError *_Nullable error) {
      if (database == nil) {
        @synchronized (self) {
          if (self->_nativeDirectClaim == claim) {
            self->_nativeDirectClaim = 0;
          }
        }
        OliphauntReleaseNativeDirect(claim);
        OliphauntReject(reject, @"liboliphaunt_open_failed", @"failed to open liboliphaunt", error);
        return;
      }

      BOOL invalidated = NO;
      @synchronized (self) {
        invalidated = self->_invalidated;
        if (invalidated) {
          if (self->_nativeDirectClaim == claim) {
            self->_nativeDirectClaim = 0;
          }
        } else {
          self->_sessions[handle] = database;
        }
      }
      if (invalidated) {
        NSError *cleanupAdmissionError = nil;
        OliphauntNativeDirectCleanupAdmission cleanupAdmission =
            OliphauntBeginNativeDirectCleanup(claim, database, &cleanupAdmissionError);
        if (cleanupAdmission != OliphauntNativeDirectCleanupStarted) {
          OliphauntReject(
              reject,
              @"liboliphaunt_close_failed",
              @"failed to retain nativeDirect after module invalidation",
              cleanupAdmissionError);
          return;
        }
        [database closeWithCompletion:^(NSError *_Nullable closeError) {
          OliphauntFinishNativeDirectCleanup(claim, database, closeError, YES);
          if (closeError != nil) {
            OliphauntReject(
                reject,
                @"liboliphaunt_close_failed",
                @"React Native Oliphaunt module was invalidated while opening nativeDirect; cleanup is retained for the next open",
                closeError);
            return;
          }
          reject(
              @"liboliphaunt_invalidated",
              @"React Native Oliphaunt module was invalidated while opening nativeDirect",
              nil);
        }];
        return;
      }
      resolve(handle);
    }];
  });
}

- (void)execProtocolRawDataForJsi:(double)handle
                          request:(NSData *)request
                       completion:(OliphauntDataCompletion)completion
{
  if (!OliphauntIsValidHandle(handle)) {
    completion(nil, [NSError errorWithDomain:@"dev.oliphaunt.reactnative.ios"
                                        code:400
                                    userInfo:@{NSLocalizedDescriptionKey: @"Oliphaunt handle must be a finite positive safe integer"}]);
    return;
  }
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
  if (!OliphauntIsValidHandle(handle)) {
    completion([NSError errorWithDomain:@"dev.oliphaunt.reactnative.ios"
                                   code:400
                               userInfo:@{NSLocalizedDescriptionKey: @"Oliphaunt handle must be a finite positive safe integer"}]);
    return;
  }
  OliphauntAdapterDatabase *database = [self sessionForHandle:handle];
  if (database == nil) {
    completion([NSError errorWithDomain:@"dev.oliphaunt.reactnative.ios"
                                   code:404
                               userInfo:@{NSLocalizedDescriptionKey: @"unknown Oliphaunt handle"}]);
    return;
  }
  [database execProtocolStreamData:request onChunk:onChunk completion:completion];
}

- (void)backupDataForJsi:(double)handle completion:(OliphauntDataCompletion)completion
{
  if (!OliphauntIsValidHandle(handle)) {
    completion(nil, [NSError errorWithDomain:@"dev.oliphaunt.reactnative.ios"
                                        code:400
                                    userInfo:@{NSLocalizedDescriptionKey: @"Oliphaunt handle must be a finite positive safe integer"}]);
    return;
  }
  OliphauntAdapterDatabase *database = [self sessionForHandle:handle];
  if (database == nil) {
    completion(nil, [NSError errorWithDomain:@"dev.oliphaunt.reactnative.ios"
                                        code:404
                                    userInfo:@{NSLocalizedDescriptionKey: @"unknown Oliphaunt handle"}]);
    return;
  }
  [database backupDataWithCompletion:completion];
}

- (void)restoreDataForJsi:(NSString *)storageKind
                storagePath:(NSString *_Nullable)storagePath
                storageName:(NSString *_Nullable)storageName
               backupData:(NSData *)backupData
               completion:(OliphauntVoidCompletion)completion
{
  [OliphauntAdapterDatabase restoreWithStorageKind:storageKind
                                        storagePath:storagePath
                                        storageName:storageName
                                        backupData:backupData
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
      "closeIfGeneration",
      facebook::jsi::Function::createFromHostFunction(
          runtime,
          facebook::jsi::PropNameID::forAscii(runtime, "liboliphauntCloseIfGeneration"),
          1,
          [weakSelf](
              facebook::jsi::Runtime &runtime,
              const facebook::jsi::Value &,
              const facebook::jsi::Value *args,
              size_t count) -> facebook::jsi::Value {
            if (count != 1) {
              throw facebook::jsi::JSError(
                  runtime,
                  "liboliphaunt JSI closeIfGeneration expects a generation");
            }
            double generation = OliphauntCopyHandleArgument(runtime, args[0]);
            Oliphaunt *strongSelf = weakSelf;
            if (strongSelf != nil) {
              [strongSelf closeIfGeneration:generation];
            }
            return facebook::jsi::Value::undefined();
          }));
  transport.setProperty(
      runtime,
      "execProtocolRaw",
      facebook::jsi::Function::createFromHostFunction(
          runtime,
          facebook::jsi::PropNameID::forAscii(runtime, "liboliphauntExecProtocolRaw"),
          1,
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
                  auto settled = std::make_shared<std::atomic<bool>>(false);
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
                    @synchronized (strongSelf) {
                      if (strongSelf->_invalidated) {
                        return [NSError errorWithDomain:@"dev.oliphaunt.reactnative.ios"
                                                   code:1
                                               userInfo:@{NSLocalizedDescriptionKey: @"React Native Oliphaunt module has been invalidated"}];
                      }
                    }
                    std::vector<uint8_t> bytes = OliphauntBytesFromNSData(chunk);
                    auto acknowledgement = std::make_shared<OliphauntChunkAcknowledgement>();
                    OliphauntRegisterChunkAcknowledgement(acknowledgement);
                    try {
                      chunkCallback->call([strongSelf, bytes = std::move(bytes), acknowledgement](
                                              facebook::jsi::Runtime &runtime,
                                              facebook::jsi::Function &chunkFunction) mutable {
                        @synchronized (strongSelf) {
                          if (strongSelf->_invalidated) {
                            acknowledgement->reject("React Native Oliphaunt module has been invalidated");
                            return;
                          }
                        }
                        try {
                          auto result = chunkFunction.call(
                              runtime,
                              OliphauntArrayBufferFromBytes(runtime, std::move(bytes)));
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
                        } catch (const facebook::jsi::JSError &error) {
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
                    OliphauntUnregisterChunkAcknowledgement(acknowledgement);
                    return error ? OliphauntProtocolStreamCallbackError(*error) : nil;
                  }
                                                completion:^(NSError *_Nullable error) {
                    @synchronized (strongSelf) {
                      if (strongSelf->_invalidated) {
                        return;
                      }
                    }
                    if (settled->exchange(true)) {
                      return;
                    }
                    if (error != nil) {
                      const char *errorMessage = error.localizedDescription.UTF8String;
                      std::string message = errorMessage != nullptr ? errorMessage : "liboliphaunt stream failed";
                      BOOL callbackAborted =
                          [error.domain isEqualToString:OliphauntProtocolStreamCallbackAbortedErrorDomain];
                      reject->call([message, callbackAborted](facebook::jsi::Runtime &runtime, facebook::jsi::Function &rejectFunction) {
                        rejectFunction.call(
                            runtime,
                            callbackAborted
                                ? OliphauntCreateProtocolCallbackAbortedError(runtime, message)
                                : OliphauntCreateError(runtime, message));
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
            if (count != 1) {
              throw facebook::jsi::JSError(runtime, "liboliphaunt JSI backup expects a handle");
            }

            double handle = OliphauntCopyHandleArgument(runtime, args[0]);
            auto promiseConstructor = runtime.global().getPropertyAsFunction(runtime, "Promise");
            auto executor = facebook::jsi::Function::createFromHostFunction(
                runtime,
                facebook::jsi::PropNameID::forAscii(runtime, "liboliphauntBackupExecutor"),
                2,
                [weakSelf, callInvoker, handle](
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
          2,
          [weakSelf, callInvoker](
              facebook::jsi::Runtime &runtime,
              const facebook::jsi::Value &,
              const facebook::jsi::Value *args,
              size_t count) -> facebook::jsi::Value {
            if (count != 2) {
              throw facebook::jsi::JSError(runtime, "liboliphaunt JSI restore expects destination and backup bytes");
            }

            if (!args[0].isObject()) {
              throw facebook::jsi::JSError(runtime, "liboliphaunt JSI restore destination must be an object");
            }
            auto destination = args[0].asObject(runtime);
            NSString *storageKind = OliphauntNSStringFromString(
                OliphauntCopyStringArgument(
                    runtime,
                    destination.getProperty(runtime, "storageKind"),
                    "restore storageKind"));
            NSString *storagePath = OliphauntCopyOptionalNSStringArgument(
                runtime,
                destination.getProperty(runtime, "storagePath"),
                "restore storagePath");
            NSString *storageName = OliphauntCopyOptionalNSStringArgument(
                runtime,
                destination.getProperty(runtime, "storageName"),
                "restore storageName");
            std::vector<uint8_t> artifact = OliphauntCopyBinaryArgument(runtime, args[1]);
            auto artifactData = [NSData dataWithBytes:artifact.data() length:artifact.size()];
            auto promiseConstructor = runtime.global().getPropertyAsFunction(runtime, "Promise");
            auto executor = facebook::jsi::Function::createFromHostFunction(
                runtime,
                facebook::jsi::PropNameID::forAscii(runtime, "liboliphauntRestoreExecutor"),
                2,
                [weakSelf, callInvoker, storageKind, storagePath, storageName, artifactData](
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

                  [strongSelf restoreDataForJsi:storageKind
                                      storagePath:storagePath
                                      storageName:storageName
                                      backupData:artifactData
                                      completion:^(NSError *_Nullable error) {
                    if (error != nil) {
                      const char *errorMessage = error.localizedDescription.UTF8String;
                      std::string message = errorMessage != nullptr ? errorMessage : "liboliphaunt restore failed";
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
  runtime.global().setProperty(runtime, "__oliphauntReactNativeJsi", std::move(transport));
}
#endif

- (void)closeIfGeneration:(double)generation
{
  NSNumber *key = OliphauntHandleKey(generation);
  if (key == nil) {
    return;
  }
  OliphauntAdapterDatabase *database = [self sessionForHandle:generation];
  if (database == nil) {
    return;
  }
  __block uint64_t claim = 0;
  @synchronized (self) {
    claim = _nativeDirectClaim;
  }
  if (claim == 0 || claim != key.unsignedLongLongValue) {
    return;
  }

  OliphauntNativeDirectCleanupAdmission cleanupAdmission =
      OliphauntBeginNativeDirectCleanup(claim, database, nullptr);
  if (cleanupAdmission != OliphauntNativeDirectCleanupStarted) {
    return;
  }
  @synchronized (self) {
    if (_sessions[key] != database || _nativeDirectClaim != claim) {
      OliphauntFinishNativeDirectCleanup(
          claim,
          database,
          OliphauntNativeDirectOwnerError(
              @"React Native nativeDirect generation changed before forgotten cleanup",
              nil),
          YES);
      return;
    }
    [_sessions removeObjectForKey:key];
    _nativeDirectClaim = 0;
  }
  [database closeWithCompletion:^(NSError *_Nullable error) {
    // No JavaScript owner remains to retry a failed close. Retain the exact
    // generation process-wide so the next open recovers it before admission.
    OliphauntFinishNativeDirectCleanup(claim, database, error, YES);
  }];
}

- (void)close:(double)handle
      resolve:(RCTPromiseResolveBlock)resolve
       reject:(RCTPromiseRejectBlock)reject
{
  NSNumber *key = OliphauntHandleKey(handle);
  if (key == nil) {
    reject(
        @"liboliphaunt_invalid_handle",
        @"Oliphaunt handle must be a finite positive safe integer",
        nil);
    return;
  }
  OliphauntAdapterDatabase *database = [self sessionForHandle:handle];
  if (database == nil) {
    resolve(nil);
    return;
  }
  __block uint64_t claim = 0;
  @synchronized (self) {
    claim = _nativeDirectClaim;
  }
  NSError *cleanupAdmissionError = nil;
  OliphauntNativeDirectCleanupAdmission cleanupAdmission =
      OliphauntBeginNativeDirectCleanup(claim, database, &cleanupAdmissionError);
  if (cleanupAdmission != OliphauntNativeDirectCleanupStarted) {
    OliphauntReject(
        reject,
        @"liboliphaunt_close_failed",
        cleanupAdmission == OliphauntNativeDirectCleanupAlreadyInFlight
            ? @"liboliphaunt close is already in progress"
            : @"liboliphaunt could not retain nativeDirect ownership for close",
        cleanupAdmissionError);
    return;
  }
  [database closeWithCompletion:^(NSError *_Nullable error) {
    __block BOOL retainOnFailure = NO;
    @synchronized (self) {
      retainOnFailure = self->_invalidated;
    }
    OliphauntFinishNativeDirectCleanup(claim, database, error, retainOnFailure);
    if (error != nil) {
      OliphauntReject(reject, @"liboliphaunt_close_failed", @"liboliphaunt close failed", error);
      return;
    }
    @synchronized (self) {
      if (self->_sessions[key] == database) {
        [self->_sessions removeObjectForKey:key];
        if (self->_nativeDirectClaim == claim) {
          self->_nativeDirectClaim = 0;
        }
      }
    }
    resolve(nil);
  }];
}

- (void)cancel:(double)handle
       resolve:(RCTPromiseResolveBlock)resolve
        reject:(RCTPromiseRejectBlock)reject
{
  if (!OliphauntIsValidHandle(handle)) {
    reject(
        @"liboliphaunt_invalid_handle",
        @"Oliphaunt handle must be a finite positive safe integer",
        nil);
    return;
  }
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

- (OliphauntAdapterDatabase *)sessionForHandle:(double)handle
{
  NSNumber *key = OliphauntHandleKey(handle);
  if (key == nil) {
    return nil;
  }
  @synchronized (self) {
    return _sessions[key];
  }
}

- (void)invalidate
{
  NSDictionary<NSNumber *, OliphauntAdapterDatabase *> *sessionsToClose = nil;
  __block uint64_t claim = 0;
  @synchronized (self) {
    _invalidated = YES;
    sessionsToClose = [_sessions copy];
    claim = _nativeDirectClaim;
    _nativeDirectClaim = 0;
  }
#ifdef RCT_NEW_ARCH_ENABLED
  OliphauntAbortChunkAcknowledgements();
#endif
  [sessionsToClose enumerateKeysAndObjectsUsingBlock:^(
      NSNumber *key,
      OliphauntAdapterDatabase *database,
      __unused BOOL *stop) {
    OliphauntNativeDirectCleanupAdmission cleanupAdmission =
        OliphauntBeginNativeDirectCleanup(claim, database, nullptr);
    if (cleanupAdmission == OliphauntNativeDirectCleanupRejected) {
      // This indicates an internal ownership invariant violation. Keep the module's
      // reference rather than pretending the native engine was detached.
      @synchronized (self) {
        self->_nativeDirectClaim = claim;
      }
      return;
    }
    @synchronized (self) {
      if (self->_sessions[key] == database) {
        [self->_sessions removeObjectForKey:key];
      }
    }
    if (cleanupAdmission == OliphauntNativeDirectCleanupAlreadyInFlight) {
      return;
    }
    [database closeWithCompletion:^(NSError *_Nullable error) {
      OliphauntFinishNativeDirectCleanup(claim, database, error, YES);
    }];
  }];
}

#ifdef RCT_NEW_ARCH_ENABLED
- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeOliphauntSpecJSI>(params);
}
#endif

@end
