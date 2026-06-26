#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

fail() {
  echo "package-liboliphaunt-mobile-assets.sh: $*" >&2
  exit 1
}

require() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

source "$root/tools/release/liboliphaunt-extension-guard.sh"

require cargo
require bun
require python3
require rsync

target_id="${1:-}"
case "$target_id" in
  android-arm64-v8a|android-x86_64|ios-xcframework)
    ;;
  *)
    fail "usage: tools/release/package-liboliphaunt-mobile-assets.sh [android-arm64-v8a|android-x86_64|ios-xcframework]"
    ;;
esac

if [ "$target_id" = "ios-xcframework" ]; then
  require ditto
fi

version="$(tools/dev/bun.sh tools/release/product-version.mjs version liboliphaunt-native)"
out_dir="${OLIPHAUNT_LIBOLIPHAUNT_RELEASE_ASSETS:-$root/target/liboliphaunt/release-assets}"
stage_root="${OLIPHAUNT_LIBOLIPHAUNT_RELEASE_STAGE_ROOT:-$root/target/liboliphaunt/release-stage-$target_id}"
headers_dir="$root/src/runtimes/liboliphaunt/native/include"

rm -rf "$stage_root"
mkdir -p "$out_dir" "$stage_root"

archive_staged_dir() {
  local staged="$1"
  local name
  name="$(basename "$staged")"
  tools/release/archive_dir.mjs "$staged" "$out_dir/${name}.tar.gz"
}

archive_swiftpm_xcframework() {
  local xcframework="$1"
  local output="$2"
  [ -d "$xcframework" ] || fail "missing SwiftPM XCFramework input at $xcframework"
  rm -f "$output"
  (
    cd "$(dirname "$xcframework")"
    ditto -c -k --keepParent "$(basename "$xcframework")" "$output"
  )
}

package_android() {
  local abi="$1"
  local work_root="$2"
  local lib="$work_root/out/liboliphaunt.so"
  local static_registry="$work_root/out/liboliphaunt_mobile_static_registry.c"
  local stage="$stage_root/liboliphaunt-${version}-android-${abi}"

  [ -f "$lib" ] || fail "missing Android $abi liboliphaunt shared library at $lib"
  [ ! -f "$static_registry" ] ||
    fail "base Android $abi release asset must not include mobile static extension registry $static_registry"

  mkdir -p "$stage/include" "$stage/jni/$abi"
  rsync -a --delete "$headers_dir/" "$stage/include/"
  cp "$lib" "$stage/jni/$abi/"
  echo "==> Stripping staged liboliphaunt Android $abi release binaries"
  tools/dev/bun.sh tools/release/strip_native_release_binaries.mjs "$stage"
  archive_staged_dir "$stage"
}

package_ios() {
  local ios_work_root="${OLIPHAUNT_IOS_XCFRAMEWORK_ROOT:-$root/target/liboliphaunt-ios-xcframework}"
  local macos_work_root="${OLIPHAUNT_WORK_ROOT:-$root/target/liboliphaunt-pg18}"
  local ios_xcframework="$ios_work_root/out/liboliphaunt.xcframework"
  local macos_runtime="$macos_work_root/install"
  local catalog_file="$stage_root/extension-catalog.tsv"
  local runtime_stage="$stage_root/liboliphaunt-${version}-runtime-resources"
  local icu_stage="$stage_root/liboliphaunt-${version}-icu-data"
  local stage_ios="$stage_root/liboliphaunt-${version}-ios-xcframework"
  local static_registry="$ios_work_root/out/liboliphaunt_mobile_static_registry.c"
  local icu_source="$macos_work_root/icu/share/icu"

  [ -d "$ios_xcframework" ] || fail "missing iOS XCFramework at $ios_xcframework"
  [ -d "$macos_runtime" ] || fail "missing macOS PostgreSQL runtime at $macos_runtime"
  [ -d "$icu_source" ] || fail "missing portable ICU data sidecar at $icu_source"
  [ ! -f "$static_registry" ] ||
    fail "base iOS release asset must not include mobile static extension registry $static_registry"

  cargo run -p oliphaunt --bin oliphaunt-resources --locked -- --list-extensions >"$catalog_file"
  oliphaunt_assert_base_runtime_has_no_optional_extensions "$catalog_file" "$macos_runtime" ||
    fail "base iOS release runtime must not ship optional extension assets; selected extensions belong in exact extension artifacts"

  env OLIPHAUNT_INSTALL_DIR="$macos_runtime" \
    cargo run -p oliphaunt --bin oliphaunt-resources --locked -- \
      --output "$runtime_stage" \
      --force >/tmp/liboliphaunt-release-mobile-runtime-resources.log
  local base_runtime_resources="$runtime_stage/oliphaunt"
  [ -d "$base_runtime_resources" ] || fail "runtime-resource package did not create $base_runtime_resources"
  [ -f "$base_runtime_resources/package-size.tsv" ] || fail "missing base runtime package-size report"
  cp "$base_runtime_resources/package-size.tsv" "$out_dir/liboliphaunt-${version}-package-size.tsv"

  mkdir -p "$stage_ios"
  rsync -a --delete "$ios_xcframework" "$stage_ios/"
  echo "==> Stripping staged liboliphaunt iOS release binaries"
  tools/dev/bun.sh tools/release/strip_native_release_binaries.mjs "$stage_ios"

  archive_staged_dir "$stage_ios"
  archive_swiftpm_xcframework \
    "$stage_ios/liboliphaunt.xcframework" \
    "$out_dir/liboliphaunt-${version}-apple-spm-xcframework.zip"
  archive_staged_dir "$runtime_stage"

  mkdir -p "$icu_stage/share/icu"
  rsync -a --delete "$icu_source/" "$icu_stage/share/icu/"
  archive_staged_dir "$icu_stage"
}

case "$target_id" in
  android-arm64-v8a)
    package_android arm64-v8a "${OLIPHAUNT_ANDROID_ARM64_ROOT:-$root/target/liboliphaunt-pg18-android-arm64}"
    ;;
  android-x86_64)
    package_android x86_64 "${OLIPHAUNT_ANDROID_X86_64_ROOT:-$root/target/liboliphaunt-pg18-android-x86_64}"
    ;;
  ios-xcframework)
    package_ios
    ;;
esac

echo "liboliphauntMobileReleaseAssetDir=$out_dir"
