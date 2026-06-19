#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

target="${1:-}"
case "$target" in
  android-arm64-v8a|android-x86_64|ios-xcframework)
    ;;
  *)
    echo "usage: src/runtimes/liboliphaunt/native/tools/build-ci-target.sh [android-arm64-v8a|android-x86_64|ios-xcframework]" >&2
    exit 2
    ;;
esac

stage_root="$root/target/liboliphaunt-native-ci/$target"
mobile_extensions="${OLIPHAUNT_CI_MOBILE_EXTENSIONS:-${OLIPHAUNT_MOBILE_STATIC_EXTENSIONS:-}}"
if [ -n "$mobile_extensions" ]; then
  echo "base liboliphaunt CI target builds do not accept selected extensions; publish exact extension artifacts through the extension artifact lane" >&2
  exit 2
fi

run() {
  printf '\n==> %s\n' "$*"
  "$@"
}

stage_path() {
  local source="$1"
  local relative="${source#$root/}"
  [ "$relative" != "$source" ] || {
    echo "refusing to stage path outside repository: $source" >&2
    exit 1
  }
  [ -e "$source" ] || {
    echo "missing CI target artifact input: $source" >&2
    exit 1
  }
  mkdir -p "$stage_root/$(dirname "$relative")"
  rsync -a --delete "$source/" "$stage_root/$relative/"
}

build_linux_runtime_assets() {
  run src/runtimes/liboliphaunt/native/bin/build-postgres18-linux.sh --runtime-only
}

build_macos_runtime_assets() {
  run env \
    OLIPHAUNT_BUILD_EXTENSIONS="${OLIPHAUNT_BUILD_EXTENSIONS:-0}" \
    src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh --runtime-only
}

rm -rf "$stage_root"
mkdir -p "$stage_root"

run bun tools/policy/fetch-sources.mjs native-runtime

case "$target" in
  android-arm64-v8a)
    run env \
      OLIPHAUNT_ANDROID_ABI=arm64-v8a \
      OLIPHAUNT_ANDROID_ARM64_ROOT="$root/target/liboliphaunt-pg18-android-arm64" \
      src/runtimes/liboliphaunt/native/bin/build-postgres18-android-arm64.sh
    build_linux_runtime_assets
    stage_path "$root/target/liboliphaunt-pg18-android-arm64/out"
    stage_path "$root/target/liboliphaunt-pg18-linux-x64-gnu/install"
    ;;
  android-x86_64)
    run env \
      OLIPHAUNT_ANDROID_ABI=x86_64 \
      OLIPHAUNT_ANDROID_X86_64_ROOT="$root/target/liboliphaunt-pg18-android-x86_64" \
      src/runtimes/liboliphaunt/native/bin/build-postgres18-android-x86_64.sh
    build_linux_runtime_assets
    stage_path "$root/target/liboliphaunt-pg18-android-x86_64/out"
    stage_path "$root/target/liboliphaunt-pg18-linux-x64-gnu/install"
    ;;
  ios-xcframework)
    run src/runtimes/liboliphaunt/native/bin/build-ios-xcframework.sh
    build_macos_runtime_assets
    stage_path "$root/target/liboliphaunt-ios-xcframework/out"
    stage_path "$root/target/liboliphaunt-ios-simulator/out"
    stage_path "$root/target/liboliphaunt-ios-device/out"
    stage_path "$root/target/liboliphaunt-pg18/install"
    ;;
esac

printf '\nStaged liboliphaunt CI target artifact: %s\n' "$stage_root"
