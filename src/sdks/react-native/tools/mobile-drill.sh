#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

platform="${1:-}"
drill="${2:-crash}"
case "$platform" in
  android|ios)
    ;;
  *)
    echo "usage: src/sdks/react-native/tools/mobile-drill.sh [android|ios] [crash|benchmark]" >&2
    exit 2
    ;;
esac
case "$drill" in
  crash|benchmark)
    ;;
  *)
    echo "usage: src/sdks/react-native/tools/mobile-drill.sh [android|ios] [crash|benchmark]" >&2
    exit 2
    ;;
esac

case "$platform:$drill" in
  android:crash)
    export OLIPHAUNT_EXPO_ANDROID_RUNNER=crash
    export OLIPHAUNT_EXPO_ANDROID_SCRATCH="${OLIPHAUNT_EXPO_ANDROID_SCRATCH:-$root/target/mobile/react-native/android-crash}"
    exec "$root/src/sdks/react-native/tools/expo-android-runner.sh"
    ;;
  android:benchmark)
    export OLIPHAUNT_EXPO_ANDROID_RUNNER=benchmark
    export OLIPHAUNT_EXPO_ANDROID_SCRATCH="${OLIPHAUNT_EXPO_ANDROID_SCRATCH:-$root/target/mobile/react-native/android-benchmark}"
    exec "$root/src/sdks/react-native/tools/expo-android-runner.sh"
    ;;
  ios:crash)
    export OLIPHAUNT_EXPO_IOS_RUNNER=crash
    export OLIPHAUNT_EXPO_IOS_SCRATCH="${OLIPHAUNT_EXPO_IOS_SCRATCH:-$root/target/mobile/react-native/ios-crash}"
    exec "$root/src/sdks/react-native/tools/expo-ios-runner.sh"
    ;;
  ios:benchmark)
    export OLIPHAUNT_EXPO_IOS_RUNNER=benchmark
    export OLIPHAUNT_EXPO_IOS_SCRATCH="${OLIPHAUNT_EXPO_IOS_SCRATCH:-$root/target/mobile/react-native/ios-benchmark}"
    exec "$root/src/sdks/react-native/tools/expo-ios-runner.sh"
    ;;
esac
