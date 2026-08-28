#ifndef OLIPHAUNT_KOTLIN_ANDROID_STREAM_COMPLETION_H
#define OLIPHAUNT_KOTLIN_ANDROID_STREAM_COMPLETION_H

#include "oliphaunt.h"

#include <cstdint>

namespace oliphaunt::android_bridge {

enum class StreamCompletion {
  Success,
  CallbackAborted,
  NativeFailure,
  ProtocolInconsistency,
};

constexpr StreamCompletion classifyStreamCompletion(
    int32_t result,
    bool callbackFailed) {
  if (result < 0) {
    return StreamCompletion::NativeFailure;
  }
  if (result == OLIPHAUNT_STREAM_CALLBACK_ABORTED) {
    return callbackFailed
        ? StreamCompletion::CallbackAborted
        : StreamCompletion::ProtocolInconsistency;
  }
  if (result == 0) {
    return callbackFailed
        ? StreamCompletion::ProtocolInconsistency
        : StreamCompletion::Success;
  }
  return StreamCompletion::ProtocolInconsistency;
}

}  // namespace oliphaunt::android_bridge

#endif
