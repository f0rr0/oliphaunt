#include <android/api-level.h>
#include <string>

static_assert(__ANDROID_API__ == 24, "runtime must compile against the public API 24 contract");

extern "C" int oliphaunt_android_abi_smoke(const char *text) {
  // Exercise libc++ rather than proving static-runtime settings from flags.
  return static_cast<int>(std::string(text).size()) + android_get_device_api_level();
}
