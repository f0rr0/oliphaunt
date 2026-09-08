#!/usr/bin/env bash
set -euo pipefail
root="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$root"
target="${1:-}"
case "$target" in android-arm64-v8a|android-x86_64|ios-xcframework) ;; *) echo 'usage: build-ci-target.sh android-arm64-v8a|android-x86_64|ios-xcframework' >&2; exit 2 ;; esac
[ -z "${OLIPHAUNT_CI_MOBILE_EXTENSIONS-${OLIPHAUNT_MOBILE_STATIC_EXTENSIONS-}}" ] || { echo 'build exact extension artifacts through the extension artifact lane' >&2; exit 2; }
stage_root="$root/target/liboliphaunt-native-ci/$target"
host_root="target/liboliphaunt-mobile-host/$target"
pg_version="$(awk -F '"' '/^version = / { print $2; exit }' src/postgres/versions/18/source.toml)"
[ -n "$pg_version" ] || { echo 'PostgreSQL version is missing' >&2; exit 1; }
rm -rf "$stage_root"
mkdir -p "$stage_root"
stage() {
  [ -d "$root/$1" ] || { echo "missing CI artifact: $1" >&2; exit 1; }
  mkdir -p "$stage_root/$1"
  rsync -a --delete "$root/$1/" "$stage_root/$1/"
}
receipt() {
  bun src/shared/artifact-packaging/native-mobile-abi-contract.mts write --build-root "$root/$1/postgresql-$pg_version" --target "$2" --output "$root/$3"
}
case "$target" in
  android-*)
    if [ "$target" = android-arm64-v8a ]; then
      mobile_root=target/liboliphaunt-pg18-android-arm64
      OLIPHAUNT_ANDROID_ABI=arm64-v8a OLIPHAUNT_ANDROID_ARM64_ROOT="$root/$mobile_root" bash src/runtimes/liboliphaunt/native/bin/build-postgres18-android-arm64.sh
      host_args=(--runtime-only)
    else
      mobile_root=target/liboliphaunt-pg18-android-x86_64
      OLIPHAUNT_ANDROID_ABI=x86_64 OLIPHAUNT_ANDROID_X86_64_ROOT="$root/$mobile_root" bash src/runtimes/liboliphaunt/native/bin/build-postgres18-android-x86_64.sh
      host_args=()
    fi
    OLIPHAUNT_LINUX_WORK_ROOT="$root/$host_root" bash src/runtimes/liboliphaunt/native/bin/build-postgres18-linux.sh "${host_args[@]}"
    receipt "$host_root" linux-x64-gnu "$mobile_root/out/native-mobile-abi-producer.properties"
    receipt "$mobile_root" "$target" "$mobile_root/out/native-mobile-abi.properties"
    stage "$mobile_root/out"
    stage "$host_root/install"
    stage "$host_root/icu/share/icu"
    [ "$target" != android-x86_64 ] || stage "$host_root/out/modules"
    ;;
  ios-xcframework)
    OLIPHAUNT_WORK_ROOT="$root/$host_root" bash src/runtimes/liboliphaunt/native/bin/build-ios-xcframework.sh
    OLIPHAUNT_BUILD_EXTENSIONS="${OLIPHAUNT_BUILD_EXTENSIONS-0}" OLIPHAUNT_WORK_ROOT="$root/$host_root" bash src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh --runtime-only
    device=target/liboliphaunt-ios-device
    simulator=target/liboliphaunt-ios-simulator
    framework=target/liboliphaunt-ios-xcframework
    receipt "$host_root" macos-arm64 "$framework/out/native-mobile-abi-producer.properties"
    receipt "$device" ios-arm64 "$device/out/native-mobile-abi.properties"
    receipt "$simulator" ios-arm64-simulator "$simulator/out/native-mobile-abi.properties"
    bun src/shared/artifact-packaging/native-mobile-abi-contract.mts compare --domain ios-datum64 --receipt "$root/$device/out/native-mobile-abi.properties" --receipt "$root/$simulator/out/native-mobile-abi.properties" --receipt "$root/$framework/out/native-mobile-abi-producer.properties"
    stage "$framework/out"
    stage "$simulator/out"
    stage "$device/out"
    stage "$host_root/install"
    ;;
esac
printf 'Staged native CI artifact: %s\n' "$stage_root"
