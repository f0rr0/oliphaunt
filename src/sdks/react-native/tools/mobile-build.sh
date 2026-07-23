#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

platform="${1:-}"
case "$platform" in
  android|ios)
    ;;
  *)
    echo "usage: src/sdks/react-native/tools/mobile-build.sh [android|ios]" >&2
    exit 2
    ;;
esac

case "$platform" in
  android)
    export OLIPHAUNT_EXPO_ANDROID_RUNNER="${OLIPHAUNT_EXPO_ANDROID_RUNNER:-smoke}"
    export OLIPHAUNT_EXPO_ANDROID_BUILD_TYPE="${OLIPHAUNT_EXPO_ANDROID_BUILD_TYPE:-release}"
    export OLIPHAUNT_EXPO_ANDROID_BUILD_ONLY=1
    export OLIPHAUNT_EXPO_ANDROID_SCRATCH="${OLIPHAUNT_EXPO_ANDROID_SCRATCH:-$root/target/mobile/react-native/android-build}"
    exec "$root/src/sdks/react-native/tools/expo-android-runner.sh"
    ;;
  ios)
    export OLIPHAUNT_EXPO_IOS_RUNNER="${OLIPHAUNT_EXPO_IOS_RUNNER:-smoke}"
    export OLIPHAUNT_EXPO_IOS_CONFIGURATION="${OLIPHAUNT_EXPO_IOS_CONFIGURATION:-Release}"
    export OLIPHAUNT_EXPO_IOS_BUILD_ONLY=1
    export OLIPHAUNT_EXPO_IOS_SCRATCH="${OLIPHAUNT_EXPO_IOS_SCRATCH:-$root/target/mobile/react-native/ios-build}"
    exec "$root/src/sdks/react-native/tools/expo-ios-runner.sh"
    ;;
esac
