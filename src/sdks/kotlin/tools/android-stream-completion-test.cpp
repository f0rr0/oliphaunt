#include "stream_completion.h"

#include <iostream>

using oliphaunt::android_bridge::StreamCompletion;
using oliphaunt::android_bridge::classifyStreamCompletion;

static_assert(classifyStreamCompletion(0, false) == StreamCompletion::Success);
static_assert(
    classifyStreamCompletion(OLIPHAUNT_STREAM_CALLBACK_ABORTED, true) ==
    StreamCompletion::CallbackAborted);
static_assert(
    classifyStreamCompletion(-1, true) == StreamCompletion::NativeFailure);
static_assert(
    classifyStreamCompletion(-1, false) == StreamCompletion::NativeFailure);
static_assert(
    classifyStreamCompletion(0, true) ==
    StreamCompletion::ProtocolInconsistency);
static_assert(
    classifyStreamCompletion(OLIPHAUNT_STREAM_CALLBACK_ABORTED, false) ==
    StreamCompletion::ProtocolInconsistency);
static_assert(
    classifyStreamCompletion(2, true) ==
    StreamCompletion::ProtocolInconsistency);

int main() {
  std::cout << "Kotlin Android stream completion precedence passed\n";
  return 0;
}
