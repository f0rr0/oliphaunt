#!/usr/bin/env bash
set -euo pipefail
root="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$root"
family="${1:?native or wasix is required}"
profile="${2:?standard or icu is required}"
shift 2
runtime="${OLIPHAUNT_SEED_RUNTIME_DIR:-}"
icu="${OLIPHAUNT_ICU_DATA_DIR:-}"
target="${OLIPHAUNT_CI_TARGET:-}"
case "$family" in
  native)
    source runtimes/liboliphaunt-native/tools/runtime-preflight.sh
    target="${target:-$(oliphaunt_runtime_native_host_target_id)}"
    case "$target" in
      linux-*) work_root="${OLIPHAUNT_LINUX_WORK_ROOT:-$root/target/liboliphaunt-pg18-$target}" ;;
      macos-arm64) work_root="${OLIPHAUNT_WORK_ROOT:-$root/target/liboliphaunt-pg18}" ;;
      windows-x64-msvc) work_root="${OLIPHAUNT_WINDOWS_WORK_ROOT:-${OLIPHAUNT_WORK_ROOT:-$root/target/liboliphaunt-pg18-$target}}" ;;
      android-datum64)
        work_root="$root/target/liboliphaunt-mobile-host/android-x86_64"
        bun runtimes/liboliphaunt-native/tools/native-mobile-abi-contract.mts compare --domain android-datum64 \
          --receipt "${OLIPHAUNT_ANDROID_ARM64_ROOT:-$root/target/liboliphaunt-pg18-android-arm64}/out/native-mobile-abi.properties" \
          --receipt "${OLIPHAUNT_ANDROID_X86_64_ROOT:-$root/target/liboliphaunt-pg18-android-x86_64}/out/native-mobile-abi.properties" \
          --receipt "${OLIPHAUNT_ANDROID_X86_64_ROOT:-$root/target/liboliphaunt-pg18-android-x86_64}/out/native-mobile-abi-producer.properties"
        ;;
      ios-datum64)
        work_root="$root/target/liboliphaunt-mobile-host/ios-xcframework"
        bun runtimes/liboliphaunt-native/tools/native-mobile-abi-contract.mts compare --domain ios-datum64 \
          --receipt "${OLIPHAUNT_IOS_DEVICE_ROOT:-$root/target/liboliphaunt-ios-device}/out/native-mobile-abi.properties" \
          --receipt "${OLIPHAUNT_IOS_SIMULATOR_ROOT:-$root/target/liboliphaunt-ios-simulator}/out/native-mobile-abi.properties" \
          --receipt "${OLIPHAUNT_IOS_XCFRAMEWORK_ROOT:-$root/target/liboliphaunt-ios-xcframework}/out/native-mobile-abi-producer.properties"
        ;;
      *) echo "unsupported native seed target: $target" >&2; exit 2 ;;
    esac
    if [[ "$target" == *-datum64 && -n "$runtime" && "$runtime" != "$work_root/install" ]]; then
      echo 'mobile seed runtime override is not covered by the checked producer ABI receipts' >&2
      exit 2
    fi
    runtime="${runtime:-$work_root/install}"
    ;;
  wasix)
    target=portable
    runtime="${runtime:-$root/target/oliphaunt-wasix/wasix-build/build/install}"
    ;;
  *) echo 'family must be native or wasix' >&2; exit 2 ;;
esac
case "$profile" in
  standard) icu="" ;;
  icu) icu="${icu:-$root/target/database-resources/icu/data/share/icu}" ;;
  *) echo 'profile must be standard or icu' >&2; exit 2 ;;
esac
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
if [ "$family" = native ]; then
  bash database-resources/seeds/native/tools/stage-native-cluster-seed.sh \
    --runtime "$runtime" --destination "$work/seed" --target "$target" --profile "$profile" ${icu:+--icu-data} ${icu:+"$icu"}
  pgdata="$work/seed/files"
else
  cargo run -p oliphaunt-wasix-seed-producer --features cluster-seed-runner --locked -- \
    "$runtime" "$work/seed" "$profile" ${icu:+"$icu"}
  pgdata="$work/seed/pgdata"
fi
bash tools/ci/with-projects.sh database-resources/seeds/package.mts --family "$family" --profile "$profile" --target "$target" \
  --pgdata "$pgdata" --runtime "$runtime" ${icu:+--icu-data} ${icu:+"$icu"} "$@"
