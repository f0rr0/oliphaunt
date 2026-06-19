#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

fail() {
  echo "package-liboliphaunt-assets.sh: $*" >&2
  exit 1
}

require() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

source "$root/tools/release/liboliphaunt-extension-guard.sh"

require awk
require cargo
require ditto
require python3
require rsync
require shasum

version="$(python3 tools/release/product_metadata.py version liboliphaunt-native)"
out_dir="${OLIPHAUNT_LIBOLIPHAUNT_RELEASE_ASSETS:-$root/target/liboliphaunt/release-assets}"
stage_root="$root/target/liboliphaunt/release-stage"
headers_dir="$root/src/runtimes/liboliphaunt/native/include"
macos_work_root="${OLIPHAUNT_WORK_ROOT:-$root/target/liboliphaunt-pg18}"
ios_work_root="${OLIPHAUNT_IOS_XCFRAMEWORK_ROOT:-$root/target/liboliphaunt-ios-xcframework}"
android_arm64_work_root="${OLIPHAUNT_ANDROID_ARM64_ROOT:-$root/target/liboliphaunt-pg18-android-arm64}"
android_x86_64_work_root="${OLIPHAUNT_ANDROID_X86_64_ROOT:-$root/target/liboliphaunt-pg18-android-x86_64}"

if [ "$(uname -s)" != "Darwin" ]; then
  fail "liboliphaunt release assets require macOS so iOS XCFrameworks and Android NDK Darwin toolchains are validated together"
fi

rm -rf "$out_dir" "$stage_root"
mkdir -p "$out_dir" "$stage_root"

catalog_file="$stage_root/extension-catalog.tsv"

require_file() {
  local path="$1"
  local description="$2"
  [ -f "$path" ] || fail "missing $description at $path"
}

require_dir() {
  local path="$1"
  local description="$2"
  [ -d "$path" ] || fail "missing $description at $path"
}

merge_release_asset_input_dirs() {
  local input_dirs="${OLIPHAUNT_RELEASE_ASSET_INPUT_DIRS:-}"
  [ -n "$input_dirs" ] || return 0
  local input_dir asset
  IFS=':' read -r -a input_dir_array <<<"$input_dirs"
  for input_dir in "${input_dir_array[@]}"; do
    [ -n "$input_dir" ] || continue
    [ -d "$input_dir" ] || fail "release asset input directory does not exist: $input_dir"
    while IFS= read -r asset; do
      [ -n "$asset" ] || continue
      cp -p "$asset" "$out_dir/"
    done < <(find "$input_dir" -maxdepth 1 -type f \( -name 'liboliphaunt-*.tar.gz' -o -name 'liboliphaunt-*.zip' -o -name 'liboliphaunt-*.tsv' -o -name 'liboliphaunt-*.tar.zst' \) -print | sort)
  done
}

archive_staged_dir() {
  local staged="$1"
  local name
  name="$(basename "$staged")"
  tools/release/archive_dir.py "$staged" "$out_dir/${name}.tar.gz"
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

fetch_release_source_assets() {
  if [ "${OLIPHAUNT_RELEASE_FETCH_ASSETS:-1}" = "0" ]; then
    return 0
  fi
  echo "==> Fetching pinned native runtime source assets"
  bun tools/policy/fetch-sources.mjs native-runtime >/tmp/liboliphaunt-release-assets-fetch.log
}

fetch_release_source_assets

echo "==> Building liboliphaunt macOS"
src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh >/tmp/liboliphaunt-release-macos.log
macos_lib="$macos_work_root/out/liboliphaunt.dylib"
macos_runtime="$macos_work_root/install"
[ -f "$macos_lib" ] || fail "missing macOS liboliphaunt dylib at $macos_lib"
[ -d "$macos_runtime" ] || fail "missing macOS PostgreSQL runtime at $macos_runtime"

echo "==> Reading exact extension catalog"
cargo run -p oliphaunt --bin oliphaunt-resources --locked -- --list-extensions >"$catalog_file"
oliphaunt_assert_base_runtime_has_no_optional_extensions "$catalog_file" "$macos_runtime" ||
  fail "base release runtime must not ship optional extension assets; selected extensions belong in exact extension artifacts"

stage_runtime_resources="$stage_root/liboliphaunt-${version}-runtime-resources"
env OLIPHAUNT_INSTALL_DIR="$macos_runtime" \
  cargo run -p oliphaunt --bin oliphaunt-resources --locked -- \
    --output "$stage_runtime_resources" \
    --force >/tmp/liboliphaunt-release-runtime-resources.log
base_ios_runtime_resources="$stage_runtime_resources/oliphaunt"
[ -d "$base_ios_runtime_resources" ] || fail "runtime-resource package did not create $base_ios_runtime_resources"
require_file "$base_ios_runtime_resources/package-size.tsv" "base runtime package-size report"
cp "$base_ios_runtime_resources/package-size.tsv" "$out_dir/liboliphaunt-${version}-package-size.tsv"

echo "==> Building liboliphaunt iOS XCFramework"
env OLIPHAUNT_IOS_RUNTIME_RESOURCES_ROOT="$base_ios_runtime_resources" \
  src/runtimes/liboliphaunt/native/bin/build-ios-xcframework.sh >/tmp/liboliphaunt-release-ios.log
ios_xcframework="$ios_work_root/out/liboliphaunt.xcframework"
[ -d "$ios_xcframework" ] || fail "missing iOS XCFramework at $ios_xcframework"

echo "==> Building liboliphaunt Android arm64-v8a"
env OLIPHAUNT_ANDROID_ABI=arm64-v8a \
  OLIPHAUNT_ANDROID_ARM64_ROOT="$android_arm64_work_root" \
  src/runtimes/liboliphaunt/native/bin/build-postgres18-android-arm64.sh >/tmp/liboliphaunt-release-android-arm64.log
android_arm64_lib="$android_arm64_work_root/out/liboliphaunt.so"
[ -f "$android_arm64_lib" ] || fail "missing Android arm64-v8a liboliphaunt shared library at $android_arm64_lib"

echo "==> Building liboliphaunt Android x86_64"
env OLIPHAUNT_ANDROID_ABI=x86_64 \
  OLIPHAUNT_ANDROID_X86_64_ROOT="$android_x86_64_work_root" \
  src/runtimes/liboliphaunt/native/bin/build-postgres18-android-x86_64.sh >/tmp/liboliphaunt-release-android-x86_64.log
android_x86_64_lib="$android_x86_64_work_root/out/liboliphaunt.so"
[ -f "$android_x86_64_lib" ] || fail "missing Android x86_64 liboliphaunt shared library at $android_x86_64_lib"

stage_macos="$stage_root/liboliphaunt-${version}-macos-arm64"
mkdir -p "$stage_macos/include" "$stage_macos/lib" "$stage_macos/runtime"
rsync -a --delete "$headers_dir/" "$stage_macos/include/"
cp "$macos_lib" "$stage_macos/lib/"
rsync -a --delete "$macos_runtime/" "$stage_macos/runtime/"

stage_ios="$stage_root/liboliphaunt-${version}-ios-xcframework"
mkdir -p "$stage_ios"
rsync -a --delete "$ios_xcframework" "$stage_ios/"
if [ -f "$ios_work_root/out/liboliphaunt_mobile_static_registry.c" ]; then
  cp "$ios_work_root/out/liboliphaunt_mobile_static_registry.c" "$stage_ios/"
fi

stage_android_arm64="$stage_root/liboliphaunt-${version}-android-arm64-v8a"
mkdir -p "$stage_android_arm64/include" "$stage_android_arm64/jni/arm64-v8a"
rsync -a --delete "$headers_dir/" "$stage_android_arm64/include/"
cp "$android_arm64_lib" "$stage_android_arm64/jni/arm64-v8a/"
if [ -f "$android_arm64_work_root/out/liboliphaunt_mobile_static_registry.c" ]; then
  cp "$android_arm64_work_root/out/liboliphaunt_mobile_static_registry.c" "$stage_android_arm64/"
fi

stage_android_x86_64="$stage_root/liboliphaunt-${version}-android-x86_64"
mkdir -p "$stage_android_x86_64/include" "$stage_android_x86_64/jni/x86_64"
rsync -a --delete "$headers_dir/" "$stage_android_x86_64/include/"
cp "$android_x86_64_lib" "$stage_android_x86_64/jni/x86_64/"
if [ -f "$android_x86_64_work_root/out/liboliphaunt_mobile_static_registry.c" ]; then
  cp "$android_x86_64_work_root/out/liboliphaunt_mobile_static_registry.c" "$stage_android_x86_64/"
fi

archive_staged_dir "$stage_macos"
archive_staged_dir "$stage_ios"
archive_swiftpm_xcframework \
  "$stage_ios/liboliphaunt.xcframework" \
  "$out_dir/liboliphaunt-${version}-apple-spm-xcframework.zip"
archive_staged_dir "$stage_android_arm64"
archive_staged_dir "$stage_android_x86_64"
archive_staged_dir "$stage_runtime_resources"

merge_release_asset_input_dirs

(
  cd "$out_dir"
  find . -maxdepth 1 -type f \
    \( -name '*.tar.gz' -o -name '*.tar.zst' -o -name '*.tsv' -o -name '*.zip' \) \
    -print0 |
    sort -z |
    xargs -0 shasum -a 256 > "liboliphaunt-${version}-release-assets.sha256"
)

tools/release/check_liboliphaunt_release_assets.py --asset-dir "$out_dir"

echo "liboliphauntReleaseAssetDir=$out_dir"
