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
    echo "usage: src/sdks/react-native/tools/mobile-e2e.sh [android|ios]" >&2
    exit 2
    ;;
esac

case "$platform" in
  android)
    artifact_dir="${OLIPHAUNT_EXPO_ANDROID_BUILD_ARTIFACT_DIR:-$root/target/mobile-build/react-native/android}"
    apk="${OLIPHAUNT_EXPO_ANDROID_APK:-}"
    if [ -z "$apk" ]; then
      apk="$(find "$artifact_dir" -maxdepth 1 -name 'app-*.apk' -type f 2>/dev/null | head -1 || true)"
    fi
    [ -n "$apk" ] || {
      echo "Android mobile E2E requires a built APK. Run mobile-build:android first or set OLIPHAUNT_EXPO_ANDROID_APK." >&2
      exit 1
    }
    export OLIPHAUNT_EXPO_ANDROID_APK="$apk"
    export OLIPHAUNT_EXPO_ANDROID_RUNNER="${OLIPHAUNT_EXPO_ANDROID_RUNNER:-smoke}"
    export OLIPHAUNT_EXPO_ANDROID_BUILD_TYPE="${OLIPHAUNT_EXPO_ANDROID_BUILD_TYPE:-release}"
    export OLIPHAUNT_EXPO_ANDROID_E2E_ONLY=1
    export OLIPHAUNT_EXPO_ANDROID_LIFECYCLE_SMOKE="${OLIPHAUNT_EXPO_ANDROID_LIFECYCLE_SMOKE:-0}"
    export OLIPHAUNT_MOBILE_E2E_ASSERTION_RUNNER="${OLIPHAUNT_MOBILE_E2E_ASSERTION_RUNNER:-maestro}"
    export OLIPHAUNT_EXPO_ANDROID_SCRATCH="${OLIPHAUNT_EXPO_ANDROID_SCRATCH:-$root/target/mobile/react-native/android-e2e}"
    exec "$root/src/sdks/react-native/tools/expo-android-runner.sh"
    ;;
  ios)
    artifact_dir="${OLIPHAUNT_EXPO_IOS_BUILD_ARTIFACT_DIR:-$root/target/mobile-build/react-native/ios}"
    app="${OLIPHAUNT_EXPO_IOS_APP:-}"
    if [ -z "$app" ]; then
      app="$(find "$artifact_dir" -maxdepth 1 -name '*.app' -type d 2>/dev/null | head -1 || true)"
    fi
    [ -n "$app" ] || {
      echo "iOS mobile E2E requires a built .app. Run mobile-build:ios first or set OLIPHAUNT_EXPO_IOS_APP." >&2
      exit 1
    }
    export OLIPHAUNT_EXPO_IOS_APP="$app"
    export OLIPHAUNT_EXPO_IOS_RUNNER="${OLIPHAUNT_EXPO_IOS_RUNNER:-smoke}"
    export OLIPHAUNT_EXPO_IOS_CONFIGURATION="${OLIPHAUNT_EXPO_IOS_CONFIGURATION:-Release}"
    export OLIPHAUNT_EXPO_IOS_E2E_ONLY=1
    export OLIPHAUNT_EXPO_IOS_LIFECYCLE_SMOKE="${OLIPHAUNT_EXPO_IOS_LIFECYCLE_SMOKE:-0}"
    export OLIPHAUNT_MOBILE_E2E_ASSERTION_RUNNER="${OLIPHAUNT_MOBILE_E2E_ASSERTION_RUNNER:-maestro}"
    export OLIPHAUNT_EXPO_IOS_SCRATCH="${OLIPHAUNT_EXPO_IOS_SCRATCH:-$root/target/mobile/react-native/ios-e2e}"
    exec "$root/src/sdks/react-native/tools/expo-ios-runner.sh"
    ;;
esac
