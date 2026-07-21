#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"
. "$root/src/sdks/react-native/tools/expo-runner-reporting.sh"

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
    mobile_runner="${OLIPHAUNT_EXPO_ANDROID_RUNNER:-smoke}"
    mobile_scratch="${OLIPHAUNT_EXPO_ANDROID_SCRATCH:-$root/target/mobile/react-native/android-e2e}"
    export OLIPHAUNT_EXPO_ANDROID_RUNNER="$mobile_runner"
    export OLIPHAUNT_EXPO_ANDROID_BUILD_TYPE="${OLIPHAUNT_EXPO_ANDROID_BUILD_TYPE:-release}"
    export OLIPHAUNT_EXPO_ANDROID_E2E_ONLY=1
    export OLIPHAUNT_EXPO_ANDROID_LIFECYCLE_SMOKE="${OLIPHAUNT_EXPO_ANDROID_LIFECYCLE_SMOKE:-0}"
    export OLIPHAUNT_MOBILE_E2E_ASSERTION_RUNNER="${OLIPHAUNT_MOBILE_E2E_ASSERTION_RUNNER:-maestro}"
    export OLIPHAUNT_EXPO_ANDROID_SCRATCH="$mobile_scratch"
    if [ "$mobile_runner" = "smoke" ]; then
      rm -f \
        "$mobile_scratch/reports/smoke-report.json" \
        "$mobile_scratch/reports/smoke-extension-receipt.json"
    fi
    "$root/src/sdks/react-native/tools/expo-android-runner.sh"
    if [ "$mobile_runner" = "smoke" ]; then
      verify_mobile_e2e_smoke_receipt android "$mobile_scratch"
    fi
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
    mobile_runner="${OLIPHAUNT_EXPO_IOS_RUNNER:-smoke}"
    mobile_scratch="${OLIPHAUNT_EXPO_IOS_SCRATCH:-$root/target/mobile/react-native/ios-e2e}"
    export OLIPHAUNT_EXPO_IOS_RUNNER="$mobile_runner"
    export OLIPHAUNT_EXPO_IOS_CONFIGURATION="${OLIPHAUNT_EXPO_IOS_CONFIGURATION:-Release}"
    export OLIPHAUNT_EXPO_IOS_E2E_ONLY=1
    export OLIPHAUNT_EXPO_IOS_LIFECYCLE_SMOKE="${OLIPHAUNT_EXPO_IOS_LIFECYCLE_SMOKE:-0}"
    export OLIPHAUNT_MOBILE_E2E_ASSERTION_RUNNER="${OLIPHAUNT_MOBILE_E2E_ASSERTION_RUNNER:-maestro}"
    export OLIPHAUNT_EXPO_IOS_SCRATCH="$mobile_scratch"
    if [ "$mobile_runner" = "smoke" ]; then
      rm -f \
        "$mobile_scratch/reports/smoke-report.json" \
        "$mobile_scratch/reports/smoke-extension-receipt.json"
    fi
    "$root/src/sdks/react-native/tools/expo-ios-runner.sh"
    if [ "$mobile_runner" = "smoke" ]; then
      verify_mobile_e2e_smoke_receipt ios "$mobile_scratch"
    fi
    ;;
esac
