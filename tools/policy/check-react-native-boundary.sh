#!/usr/bin/env sh
set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
. "$script_dir/sdk-check-lib.sh"

reject_text src/sdks/react-native/android/src/main/java/dev/oliphaunt/reactnative/OliphauntModule.kt "AndroidNativeDirectEngine" \
  "React Native Android must use the Kotlin SDK facade instead of constructing the native-direct engine itself"

unexpected_rn_android_cpp="$(
  find src/sdks/react-native/android/src/main/cpp -type f 2>/dev/null |
    sed 's#^src/sdks/react-native/android/##' |
    grep -Ev '^(src/main/cpp/CMakeLists\.txt|src/main/cpp/OliphauntJsiBindings\.cpp|src/main/cpp/include/oliphaunt\.h)$' || true
)"
if [ -n "$unexpected_rn_android_cpp" ]; then
  echo "React Native Android must only carry the JSI installer and must delegate the native C/C++ database runtime to the Kotlin SDK" >&2
  echo "$unexpected_rn_android_cpp" >&2
  exit 1
fi
require_no_files_under src/sdks/react-native/android/src/main/java/dev/oliphaunt/reactnative/runtime \
  "React Native Android must not grow a private runtime resources; delegate to the Kotlin SDK"
printf '\nReact Native boundary checks passed.\n'
