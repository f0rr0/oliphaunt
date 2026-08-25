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
require rsync

target_id="${1:-}"
case "$target_id" in
  android-arm64-v8a|android-x86_64|ios-xcframework)
    ;;
  *)
    fail "usage: tools/release/package-liboliphaunt-mobile-assets.sh [android-arm64-v8a|android-x86_64|ios-xcframework]"
    ;;
esac

version="$(tools/dev/bun.sh tools/release/product-version.mjs version liboliphaunt-native)"
out_dir="${OLIPHAUNT_LIBOLIPHAUNT_RELEASE_ASSETS:-$root/target/liboliphaunt/release-assets}"
stage_root="${OLIPHAUNT_LIBOLIPHAUNT_RELEASE_STAGE_ROOT:-$root/target/liboliphaunt/release-stage-$target_id}"
headers_dir="$root/src/runtimes/liboliphaunt/native/include"

rm -rf "$stage_root"
mkdir -p "$out_dir" "$stage_root"

archive_staged_dir() {
  local staged="$1"
  local profile="$2"
  local name
  name="$(basename "$staged")"
  tools/release/archive_dir.mjs "$staged" "$out_dir/${name}.tar.gz"
  tools/dev/bun.sh tools/release/release-notices.mjs check-archive \
    "$out_dir/${name}.tar.gz" \
    --profile "$profile"
}

archive_swiftpm_xcframework() {
  local xcframework="$1"
  local output="$2"
  [ -d "$xcframework" ] || fail "missing SwiftPM XCFramework input at $xcframework"
  rm -f "$output"
  tools/dev/bun.sh tools/release/archive_dir.mjs --keep-parent "$xcframework" "$output"
}

stage_runtime_resource_closure() {
  local runtime="$1"
  local icu_data="$2"
  local seed_target="$3"
  local stage="$4"

  env \
    OLIPHAUNT_INSTALL_DIR="$runtime" \
    cargo run -p oliphaunt-native-packaging --bin oliphaunt-resources --locked -- \
      --output "$stage" \
      --mode native-direct \
      --force >/tmp/liboliphaunt-release-mobile-runtime-resources.log
  local closure="$stage/oliphaunt"
  [ -d "$closure/runtime/files" ] || fail "runtime-resource package did not create $closure/runtime/files"
  tools/dev/bun.sh tools/release/stage-native-cluster-seed.mjs \
    --runtime "$runtime" \
    --destination "$closure/cluster-seed" \
    --target "$seed_target" \
    --profile standard
  tools/dev/bun.sh tools/release/stage-native-cluster-seed.mjs \
    --runtime "$runtime" \
    --destination "$closure/cluster-seed-icu" \
    --target "$seed_target" \
    --profile icu \
    --icu-data "$icu_data"
  tools/dev/bun.sh tools/release/finalize-native-runtime-carrier.mjs \
    --root "$closure" \
    --target "$seed_target" \
    --icu-data "$icu_data"
}

package_android() {
  local abi="$1"
  local work_root="$2"
  local lib="$work_root/out/liboliphaunt.so"
  local static_registry="$work_root/out/liboliphaunt_mobile_static_registry.c"
  local stage="$stage_root/liboliphaunt-${version}-android-${abi}"
  local host_work_root="${OLIPHAUNT_LINUX_X64_ROOT:-$root/target/liboliphaunt-pg18-linux-x64-gnu}"
  local host_runtime="$host_work_root/install"
  local icu_source="$host_work_root/icu/share/icu"
  local runtime_stage="$stage_root/liboliphaunt-${version}-runtime-resources-android-datum64"

  [ -f "$lib" ] || fail "missing Android $abi liboliphaunt shared library at $lib"
  [ ! -f "$static_registry" ] ||
    fail "base Android $abi release asset must not include mobile static extension registry $static_registry"
  [ -d "$host_runtime" ] || fail "missing native host runtime at $host_runtime"
  [ -d "$icu_source" ] || fail "missing portable ICU data at $icu_source"

  tools/dev/bun.sh tools/release/native-mobile-abi-contract.mjs write \
    --build-root "$work_root/postgresql-18.4" \
    --target "$target_id" \
    --output "$work_root/out/native-mobile-abi.properties"

  mkdir -p "$stage/include" "$stage/jni/$abi"
  rsync -a --delete "$headers_dir/" "$stage/include/"
  cp "$lib" "$stage/jni/$abi/"
  echo "==> Stripping staged liboliphaunt Android $abi release binaries"
  tools/dev/bun.sh tools/release/strip_native_release_binaries.mjs --target "$target_id" "$stage"
  echo "==> Verifying staged liboliphaunt Android $abi binary compatibility"
  tools/dev/bun.sh tools/release/platform-binary-contract.mjs --target "$target_id" --root "$stage"
  tools/dev/bun.sh tools/release/release-notices.mjs stage \
    "$stage" \
    --profile native-runtime
  archive_staged_dir "$stage" native-runtime
  if [ "$target_id" = "android-x86_64" ]; then
    stage_runtime_resource_closure \
      "$host_runtime" \
      "$icu_source" \
      android-datum64 \
      "$runtime_stage"
    tools/dev/bun.sh tools/release/release-notices.mjs stage \
      "$runtime_stage" \
      --profile native-runtime-resources
    archive_staged_dir "$runtime_stage" native-runtime-resources
  fi
}

package_ios() {
  local ios_work_root="${OLIPHAUNT_IOS_XCFRAMEWORK_ROOT:-$root/target/liboliphaunt-ios-xcframework}"
  local macos_work_root="${OLIPHAUNT_WORK_ROOT:-$root/target/liboliphaunt-pg18}"
  local ios_xcframework="$ios_work_root/out/liboliphaunt.xcframework"
  local macos_runtime="$macos_work_root/install"
  local catalog_file="$stage_root/extension-catalog.tsv"
  local macos_runtime_stage="$stage_root/liboliphaunt-${version}-runtime-resources-macos-arm64"
  local ios_runtime_stage="$stage_root/liboliphaunt-${version}-runtime-resources-ios-datum64"
  local stage_ios="$stage_root/liboliphaunt-${version}-ios-xcframework"
  local static_registry="$ios_work_root/out/liboliphaunt_mobile_static_registry.c"
  local icu_source="$macos_work_root/icu/share/icu"
  local ios_device_receipt="${OLIPHAUNT_IOS_DEVICE_ROOT:-$root/target/liboliphaunt-ios-device}/out/native-mobile-abi.properties"
  local ios_simulator_receipt="${OLIPHAUNT_IOS_SIMULATOR_ROOT:-$root/target/liboliphaunt-ios-simulator}/out/native-mobile-abi.properties"
  local macos_producer_receipt="$ios_work_root/out/native-mobile-abi-producer.properties"

  [ -d "$ios_xcframework" ] || fail "missing iOS XCFramework at $ios_xcframework"
  [ -d "$macos_runtime" ] || fail "missing macOS PostgreSQL runtime at $macos_runtime"
  [ -d "$icu_source" ] || fail "missing portable ICU data sidecar at $icu_source"
  [ ! -f "$static_registry" ] ||
    fail "base iOS release asset must not include mobile static extension registry $static_registry"

  cargo run -p oliphaunt-native-packaging --bin oliphaunt-resources --locked -- --list-extensions >"$catalog_file"
  oliphaunt_assert_base_runtime_has_no_optional_extensions "$catalog_file" "$macos_runtime" ||
    fail "base iOS release runtime must not ship optional extension assets; selected extensions belong in exact extension artifacts"

  tools/dev/bun.sh tools/release/native-mobile-abi-contract.mjs write \
    --build-root "${OLIPHAUNT_IOS_DEVICE_ROOT:-$root/target/liboliphaunt-ios-device}/postgresql-18.4" \
    --target ios-arm64 \
    --output "$ios_device_receipt"
  tools/dev/bun.sh tools/release/native-mobile-abi-contract.mjs write \
    --build-root "${OLIPHAUNT_IOS_SIMULATOR_ROOT:-$root/target/liboliphaunt-ios-simulator}/postgresql-18.4" \
    --target ios-arm64-simulator \
    --output "$ios_simulator_receipt"
  tools/dev/bun.sh tools/release/native-mobile-abi-contract.mjs write \
    --build-root "$macos_work_root/postgresql-18.4" \
    --target macos-arm64 \
    --output "$macos_producer_receipt"
  tools/dev/bun.sh tools/release/native-mobile-abi-contract.mjs compare \
    --domain ios-datum64 \
    --receipt "$ios_device_receipt" \
    --receipt "$ios_simulator_receipt" \
    --receipt "$macos_producer_receipt"

  stage_runtime_resource_closure "$macos_runtime" "$icu_source" macos-arm64 "$macos_runtime_stage"
  stage_runtime_resource_closure "$macos_runtime" "$icu_source" ios-datum64 "$ios_runtime_stage"
  local ios_proof="$ios_runtime_stage/oliphaunt/provenance/native-mobile-abi"
  mkdir -p "$ios_proof"
  cp "$ios_device_receipt" "$ios_proof/ios-arm64.properties"
  cp "$ios_simulator_receipt" "$ios_proof/ios-arm64-simulator.properties"
  cp "$macos_producer_receipt" "$ios_proof/macos-arm64.properties"
  OLIPHAUNT_MACOS_RUNTIME_RESOURCES_ROOT="$macos_runtime_stage/oliphaunt" \
    OLIPHAUNT_IOS_RUNTIME_RESOURCES_ROOT="$ios_runtime_stage/oliphaunt" \
    src/runtimes/liboliphaunt/native/bin/build-ios-xcframework.sh >/tmp/liboliphaunt-release-ios-xcframework-resources.log
  local ci_xcframework_out="$root/target/liboliphaunt-native-ci/ios-xcframework/target/liboliphaunt-ios-xcframework/out"
  if [ -d "$ci_xcframework_out" ]; then
    rsync -a --delete "$ios_work_root/out/" "$ci_xcframework_out/"
  fi

  mkdir -p "$stage_ios"
  rsync -a --delete "$ios_xcframework" "$stage_ios/"
  echo "==> Stripping staged liboliphaunt iOS release binaries"
  tools/dev/bun.sh tools/release/strip_native_release_binaries.mjs --target "$target_id" "$stage_ios"
  echo "==> Verifying staged liboliphaunt iOS binary compatibility"
  tools/dev/bun.sh tools/release/platform-binary-contract.mjs --target "$target_id" --root "$stage_ios"

  tools/dev/bun.sh tools/release/release-notices.mjs stage \
    "$stage_ios" \
    --profile native-runtime
  tools/dev/bun.sh tools/release/release-notices.mjs stage \
    "$stage_ios/liboliphaunt.xcframework" \
    --profile native-runtime

  archive_staged_dir "$stage_ios" native-runtime
  archive_swiftpm_xcframework \
    "$stage_ios/liboliphaunt.xcframework" \
    "$out_dir/liboliphaunt-${version}-apple-spm-xcframework.zip"
  tools/dev/bun.sh tools/release/release-notices.mjs check-archive \
    "$out_dir/liboliphaunt-${version}-apple-spm-xcframework.zip" \
    --prefix liboliphaunt.xcframework \
    --profile native-runtime
  tools/dev/bun.sh tools/release/release-notices.mjs stage \
    "$ios_runtime_stage" \
    --profile native-runtime-resources
  archive_staged_dir "$ios_runtime_stage" native-runtime-resources
  tools/release/package-liboliphaunt-icu-data.sh "$icu_source" "$out_dir"
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
