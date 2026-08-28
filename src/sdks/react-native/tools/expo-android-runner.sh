#!/usr/bin/env bash
set -euo pipefail

script_path="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"
. "$root/src/runtimes/liboliphaunt/native/bin/build-output.bash"
. "$root/src/sdks/react-native/tools/expo-runner-common.sh"
. "$root/src/sdks/react-native/tools/expo-android-gradle-limits.sh"
. "$root/src/sdks/react-native/tools/expo-runner-metro.sh"
. "$root/src/sdks/react-native/tools/expo-runner-reporting.sh"
. "$root/src/sdks/react-native/tools/expo-runner-workspace.sh"
. "$root/src/sdks/react-native/tools/mobile-extension-runtime.sh"
. "$root/src/sdks/react-native/tools/expo-runner-runtime-resources.sh"
. "$root/src/sdks/react-native/tools/expo-runner-android-device.sh"

source_example_dir="$root/examples/react-native-expo"
rn_dir="$root/src/sdks/react-native"
mobile_platform="android"
scratch_workspace_name="oliphaunt-react-native-expo-android-workspace"
runner="${OLIPHAUNT_EXPO_ANDROID_RUNNER:-smoke}"
case "$runner" in
  smoke|benchmark|crash)
    ;;
  *)
    echo "error: OLIPHAUNT_EXPO_ANDROID_RUNNER must be smoke, benchmark, or crash, got $runner" >&2
    exit 1
    ;;
esac
success_tag="OLIPHAUNT_EXPO_SMOKE_PASS"
failure_tag="OLIPHAUNT_EXPO_SMOKE_FAIL"
if [ "$runner" = "benchmark" ]; then
  success_tag="OLIPHAUNT_EXPO_BENCH_PASS"
  failure_tag="OLIPHAUNT_EXPO_BENCH_FAIL"
elif [ "$runner" = "crash" ]; then
  success_tag="OLIPHAUNT_EXPO_CRASH_RECOVERY_PASS"
  failure_tag="OLIPHAUNT_EXPO_CRASH_RECOVERY_FAIL"
fi
scratch_root="${OLIPHAUNT_EXPO_ANDROID_SCRATCH:-$root/target/oliphaunt-expo-android-$runner}"
example_dir="${OLIPHAUNT_EXPO_ANDROID_EXAMPLE_DIR:-$scratch_root/examples/react-native-expo}"
package_work="$scratch_root/src/sdks/react-native"
crash_storage_suffix="$(printf '%s' "$(basename "$scratch_root")" | LC_ALL=C tr -c 'A-Za-z0-9_.-' '-')"
[ -n "$crash_storage_suffix" ] || crash_storage_suffix="run"
pack_dir="$root/target/oliphaunt-rn-expo-pack/android"
tarball="$pack_dir/$(react_native_package_tarball_name "$rn_dir")"
local_maven_repo="$scratch_root/maven-local"
build_type="${OLIPHAUNT_EXPO_ANDROID_BUILD_TYPE:-debug}"
case "$build_type" in
  debug|release)
    ;;
  *)
    echo "error: OLIPHAUNT_EXPO_ANDROID_BUILD_TYPE must be debug or release, got $build_type" >&2
    exit 1
    ;;
esac
build_only="${OLIPHAUNT_EXPO_ANDROID_BUILD_ONLY:-0}"
e2e_only="${OLIPHAUNT_EXPO_ANDROID_E2E_ONLY:-0}"
e2e_assertion_runner="${OLIPHAUNT_EXPO_ANDROID_E2E_ASSERTION_RUNNER:-${OLIPHAUNT_MOBILE_E2E_ASSERTION_RUNNER:-log}}"
case "$e2e_assertion_runner" in
  auto|log|maestro)
    ;;
  *)
    echo "error: OLIPHAUNT_EXPO_ANDROID_E2E_ASSERTION_RUNNER must be auto, log, or maestro, got $e2e_assertion_runner" >&2
    exit 1
    ;;
esac
build_type_capitalized="$(printf '%s' "$build_type" | awk '{ print toupper(substr($0, 1, 1)) substr($0, 2) }')"
apk="${OLIPHAUNT_EXPO_ANDROID_APK:-$example_dir/android/app/build/outputs/apk/$build_type/app-$build_type.apk}"
build_artifact_dir="${OLIPHAUNT_EXPO_ANDROID_BUILD_ARTIFACT_DIR:-$root/target/mobile-build/react-native/android}"
maestro_flow="${OLIPHAUNT_EXPO_ANDROID_MAESTRO_FLOW:-$source_example_dir/maestro/installed-smoke.yaml}"
app_id="${OLIPHAUNT_EXPO_ANDROID_APP_ID:-dev.oliphaunt.reactnative.example}"
scheme="${OLIPHAUNT_EXPO_ANDROID_SCHEME:-reactnativeoliphauntexpo}"
dev_client_scheme="${OLIPHAUNT_EXPO_ANDROID_DEV_CLIENT_SCHEME:-exp+react-native-oliphaunt-expo}"
metro_host="${OLIPHAUNT_EXPO_ANDROID_METRO_HOST:-10.0.2.2}"
if [ -n "${OLIPHAUNT_EXPO_ANDROID_METRO_PORT:-}" ]; then
  metro_port="$OLIPHAUNT_EXPO_ANDROID_METRO_PORT"
  metro_port_explicit=1
else
  metro_port=8081
  metro_port_explicit=0
fi
reuse_metro="${OLIPHAUNT_EXPO_ANDROID_REUSE_METRO:-0}"
keep_metro="${OLIPHAUNT_EXPO_ANDROID_KEEP_METRO:-0}"
reuse_metro_env_name="OLIPHAUNT_EXPO_ANDROID_REUSE_METRO"
metro_port_env_name="OLIPHAUNT_EXPO_ANDROID_METRO_PORT"
default_timeout_seconds=600
[ "$runner" = "benchmark" ] && default_timeout_seconds=720
timeout_seconds="${OLIPHAUNT_EXPO_ANDROID_TIMEOUT_SECONDS:-$default_timeout_seconds}"
android_abi="${OLIPHAUNT_EXPO_ANDROID_ABI:-arm64-v8a}"
default_lifecycle_smoke=0
[ "$runner" = "smoke" ] && default_lifecycle_smoke=1
lifecycle_smoke="${OLIPHAUNT_EXPO_ANDROID_LIFECYCLE_SMOKE:-$default_lifecycle_smoke}"
background_seconds="${OLIPHAUNT_EXPO_ANDROID_BACKGROUND_SECONDS:-3}"
if [ "${OLIPHAUNT_EXPO_ANDROID_EXTENSIONS+x}" = "x" ]; then
  mobile_extensions_raw="$OLIPHAUNT_EXPO_ANDROID_EXTENSIONS"
elif [ "${OLIPHAUNT_EXPO_MOBILE_EXTENSIONS+x}" = "x" ]; then
  mobile_extensions_raw="$OLIPHAUNT_EXPO_MOBILE_EXTENSIONS"
else
  mobile_extensions_raw="vector"
fi
startup_gucs="${OLIPHAUNT_EXPO_ANDROID_STARTUP_GUCS:-${OLIPHAUNT_EXPO_MOBILE_STARTUP_GUCS:-}}"
benchmark_preset="${OLIPHAUNT_EXPO_ANDROID_BENCHMARK_PRESET:-${OLIPHAUNT_EXPO_MOBILE_BENCHMARK_PRESET:-full}}"
crash_storage_override="${OLIPHAUNT_EXPO_ANDROID_CRASH_STORAGE:-}"
crash_storage="${crash_storage_override:-/data/data/$app_id/files/oliphaunt-crash-recovery-storage-$crash_storage_suffix}"
mobile_packaging_initdb="${OLIPHAUNT_EXPO_ANDROID_INITDB:-}"
case "${OLIPHAUNT_EXPO_ANDROID_ICU:-0}" in
  1|true|TRUE|yes|YES|on|ON) android_icu_enabled=1 ;;
  0|false|FALSE|no|NO|off|OFF) android_icu_enabled=0 ;;
  *) fail "OLIPHAUNT_EXPO_ANDROID_ICU must be a boolean value" ;;
esac
if [ "$android_icu_enabled" = "1" ]; then
  configure_mobile_catalog_profile_probe icu
else
  configure_mobile_catalog_profile_probe standard
fi
android_icu_data_dir="${OLIPHAUNT_EXPO_ANDROID_ICU_DATA_DIR:-}"
react_native_package_extra_excludes=(--exclude ios/vendor)
metro_pid=""
metro_bundle_runner=""
metro_bundle_storage=""

android_ndk_root() {
  local configured="${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-}}"
  if [ -n "$configured" ] && [ -d "$configured" ]; then
    printf '%s\n' "$configured"
    return
  fi
  find "$ANDROID_HOME/ndk" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | sort -V | tail -1
}

android_toolchain_bin() {
  local ndk_root toolchain_dir
  ndk_root="$(android_ndk_root)"
  [ -n "$ndk_root" ] || return 1
  while IFS= read -r toolchain_dir; do
    if [ -d "$toolchain_dir" ]; then
      printf '%s\n' "$toolchain_dir"
      return
    fi
  done < <(android_ndk_toolchain_bin_candidates "$ndk_root")
  return 1
}

android_ndk_toolchain_bin_candidates() {
  local ndk_root="$1"
  case "$(uname -s):$(uname -m)" in
    Darwin:arm64 | Darwin:aarch64)
      printf '%s\n' \
        "$ndk_root/toolchains/llvm/prebuilt/darwin-arm64/bin" \
        "$ndk_root/toolchains/llvm/prebuilt/darwin-x86_64/bin"
      ;;
    Darwin:x86_64)
      printf '%s\n' "$ndk_root/toolchains/llvm/prebuilt/darwin-x86_64/bin"
      ;;
    Linux:x86_64 | Linux:amd64)
      printf '%s\n' "$ndk_root/toolchains/llvm/prebuilt/linux-x86_64/bin"
      ;;
    Linux:aarch64 | Linux:arm64)
      printf '%s\n' \
        "$ndk_root/toolchains/llvm/prebuilt/linux-aarch64/bin" \
        "$ndk_root/toolchains/llvm/prebuilt/linux-x86_64/bin"
      ;;
  esac
}

android_liboliphaunt_has_current_abi() {
  local library="$1"
  local toolchain_bin symbols symbol
  [ -f "$library" ] || return 1
  toolchain_bin="$(android_toolchain_bin)" || return 1
  [ -x "$toolchain_bin/llvm-nm" ] || return 1
  symbols="$("$toolchain_bin/llvm-nm" -D --defined-only "$library" 2>/dev/null || true)"
  for symbol in \
    oliphaunt_init \
    oliphaunt_exec_protocol \
    oliphaunt_exec_simple_query \
    oliphaunt_exec_protocol_raw_stream \
    oliphaunt_backup \
    oliphaunt_restore \
    oliphaunt_init_with_error \
    oliphaunt_exec_protocol_with_error \
    oliphaunt_exec_simple_query_with_error \
    oliphaunt_exec_protocol_raw_stream_with_error \
    oliphaunt_backup_with_error \
    oliphaunt_restore_with_error \
    oliphaunt_detach_with_error \
    oliphaunt_cancel \
    oliphaunt_detach \
    oliphaunt_logical_generation \
    oliphaunt_close_if_generation \
    oliphaunt_close \
    oliphaunt_register_static_extensions \
    oliphaunt_copy_last_error \
    oliphaunt_version \
    oliphaunt_free_response
  do
    case "$symbols" in
      *" T $symbol"*|*" D $symbol"*|*" B $symbol"*) ;;
      *) return 1 ;;
    esac
  done
}

android_build_root_for_abi() {
  case "$android_abi" in
    arm64-v8a) printf '%s\n' "$root/target/liboliphaunt-pg18-android-arm64" ;;
    x86_64) printf '%s\n' "$root/target/liboliphaunt-pg18-android-x86_64" ;;
    *) fail "unsupported Android ABI: $android_abi" ;;
  esac
}

android_build_script_for_abi() {
  case "$android_abi" in
    arm64-v8a) printf '%s\n' "$root/src/runtimes/liboliphaunt/native/bin/build-postgres18-android-arm64.sh" ;;
    x86_64) printf '%s\n' "$root/src/runtimes/liboliphaunt/native/bin/build-postgres18-android-x86_64.sh" ;;
    *) fail "unsupported Android ABI: $android_abi" ;;
  esac
}

normalize_mobile_extensions() {
  oliphaunt_dev_normalize_mobile_extensions "$mobile_extensions_raw" "Android"
}

mobile_static_extensions_for_selection() {
  oliphaunt_dev_mobile_static_extensions_for_selection "$1"
}

mobile_static_registry_source_for_library() {
  local library="$1"
  local configured="${OLIPHAUNT_EXPO_ANDROID_STATIC_REGISTRY_SOURCE:-${OLIPHAUNT_EXPO_MOBILE_STATIC_REGISTRY_SOURCE:-}}"
  if [ -n "$configured" ]; then
    [ -f "$configured" ] || fail "configured Android static registry source does not exist: $configured"
    printf '%s\n' "$configured"
    return
  fi
  local candidate
  candidate="$(dirname "$library")/liboliphaunt_mobile_static_registry.c"
  [ -f "$candidate" ] && printf '%s\n' "$candidate"
  return 0 # exact-extension packages may provide the static registry source.
}

ensure_android_env() {
  if [ -z "${ANDROID_HOME:-}" ] && [ -d "$HOME/Library/Android/sdk" ]; then
    export ANDROID_HOME="$HOME/Library/Android/sdk"
  fi
  if [ -n "${ANDROID_HOME:-}" ] && [ -z "${ANDROID_SDK_ROOT:-}" ]; then
    export ANDROID_SDK_ROOT="$ANDROID_HOME"
  fi
  [ -n "${ANDROID_HOME:-}" ] || fail "ANDROID_HOME is not set"
  [ -x "$ANDROID_HOME/platform-tools/adb" ] || fail "adb not found under ANDROID_HOME=$ANDROID_HOME"

  if [ -z "${JAVA_HOME:-}" ] &&
    [ -d /opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home ]; then
    export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
  fi
}

pack_react_native_sdk_if_needed() {
  if expo_requires_sdk_artifacts; then
    tarball="$(expo_single_sdk_artifact_file oliphaunt-react-native '*.tgz')"
    install_react_native_sdk_tarball
    return
  fi

  need_cmd pnpm
  mkdir -p "$pack_dir"

  local package_stamp="$pack_dir/.android-package-inputs.sha256"
  local package_fingerprint
  package_fingerprint="$(react_native_source_package_fingerprint)"
  local needs_pack=0
  if [ ! -f "$tarball" ] ||
    [ ! -f "$package_stamp" ] ||
    [ "$(tr -d '\r\n' <"$package_stamp")" != "$package_fingerprint" ]; then
    needs_pack=1
  fi

  if [ "$needs_pack" -eq 1 ]; then
    prepare_react_native_package_worktree
    run pnpm --dir "$package_work" run build
    echo
    echo "==> (cd $package_work && pnpm pack --pack-destination $pack_dir)"
    (
      cd "$package_work"
      pnpm pack --pack-destination "$pack_dir"
    )
    printf '%s\n' "$package_fingerprint" >"$package_stamp"
  else
    echo "React Native SDK tarball matches source content: $tarball"
  fi

  patch_expo_example_react_native_dependency "file:$tarball"
  if [ ! -d "$example_dir/node_modules/@oliphaunt/react-native" ] ||
    [ "$tarball" -nt "$example_dir/node_modules/@oliphaunt/react-native/package.json" ]; then
    install_expo_example_dependencies
  else
    echo "Expo example dependencies are current"
  fi
}

install_react_native_sdk_tarball() {
  patch_expo_example_react_native_dependency "file:$tarball"
  rm -rf "$example_dir/node_modules/@oliphaunt/react-native"
  install_expo_example_dependencies
}

ensure_android_project() {
  if [ -x "$example_dir/android/gradlew" ]; then
    return
  fi

  echo "Generating Expo Android project for smoke validation"
  (
    cd "$example_dir"
    CI=1 EXPO_NO_TELEMETRY=1 pnpm exec expo prebuild --platform android
  )
}

find_android_liboliphaunt_so() {
  local source_so="${OLIPHAUNT_EXPO_ANDROID_OLIPHAUNT_SO:-}"
  local android_build_root
  android_build_root="$(android_build_root_for_abi)"
  local explicit_source=0
  if [ -n "$source_so" ]; then
    explicit_source=1
  fi
  if [ -z "$source_so" ] && [ -f "$android_build_root/out/liboliphaunt.so" ]; then
    source_so="$android_build_root/out/liboliphaunt.so"
  fi
  if [ -n "$source_so" ] && ! android_liboliphaunt_has_current_abi "$source_so"; then
    if [ "$explicit_source" -eq 1 ]; then
      fail "Android liboliphaunt.so is stale or missing required ABI symbols: $source_so"
    fi
    expo_allows_native_builds ||
      fail "Android liboliphaunt.so is stale and native builds are disabled; provide a current prebuilt liboliphaunt.so"
    echo "Android liboliphaunt.so is stale; rebuilding PG18 $android_abi artifact" >&2
    local extensions static_extensions
    extensions="$(normalize_mobile_extensions)"
    static_extensions="$(mobile_static_extensions_for_selection "$extensions")"
    source_so="$(oliphaunt_capture_build_artifact_path \
      "Android $android_abi liboliphaunt build" \
      "$scratch_root/logs/build-android-$android_abi.log" \
      env ANDROID_HOME="$ANDROID_HOME" OLIPHAUNT_ANDROID_ABI="$android_abi" OLIPHAUNT_MOBILE_STATIC_EXTENSIONS="$static_extensions" "$(android_build_script_for_abi)")"
  fi
  if [ -z "$source_so" ] && [ -f "$root/target/liboliphaunt-android-jni-smoke/$android_abi/liboliphaunt.so" ]; then
    source_so="$root/target/liboliphaunt-android-jni-smoke/$android_abi/liboliphaunt.so"
  fi
  if [ -z "$source_so" ] && [ -x "$(android_build_script_for_abi)" ]; then
    expo_allows_native_builds ||
      fail "missing Android liboliphaunt.so and native builds are disabled; set OLIPHAUNT_EXPO_ANDROID_OLIPHAUNT_SO to a prebuilt artifact"
    local extensions static_extensions
    extensions="$(normalize_mobile_extensions)"
    static_extensions="$(mobile_static_extensions_for_selection "$extensions")"
    source_so="$(oliphaunt_capture_build_artifact_path \
      "Android $android_abi liboliphaunt build" \
      "$scratch_root/logs/build-android-$android_abi.log" \
      env ANDROID_HOME="$ANDROID_HOME" OLIPHAUNT_ANDROID_ABI="$android_abi" OLIPHAUNT_MOBILE_STATIC_EXTENSIONS="$static_extensions" "$(android_build_script_for_abi)")"
  fi
  [ -f "$source_so" ] || fail "missing Android liboliphaunt.so; set OLIPHAUNT_EXPO_ANDROID_OLIPHAUNT_SO or build $android_build_root/out/liboliphaunt.so"
  android_liboliphaunt_has_current_abi "$source_so" ||
    fail "Android liboliphaunt.so is stale or missing required ABI symbols: $source_so"
  printf '%s\n' "$source_so"
}

prepare_jni_libs() {
  local source_so="$1"
  local jni_root="$scratch_root/jniLibs"
  local target_dir="$jni_root/$android_abi"
  mkdir -p "$target_dir"
  if [ ! -f "$target_dir/liboliphaunt.so" ] || ! cmp -s "$source_so" "$target_dir/liboliphaunt.so"; then
    cp "$source_so" "$target_dir/liboliphaunt.so"
  fi
  printf '%s\n' "$jni_root"
}

runtime_manifest_has_icu() {
  local manifest="$1"
  awk -F= '$1 == "runtimeFeatures" { print substr($0, index($0, "=") + 1) }' "$manifest" |
    tr ',' '\n' |
    grep -Fxq icu
}

assert_android_icu_payload() {
  local manifest="$1"
  local candidate="$2"
  local expected_source="$3"
  local label="$4"
  [ -f "$manifest" ] || fail "$label is missing its runtime manifest: $manifest"
  [ "$(grep -c '^runtimeFeatures=' "$manifest" || true)" = "1" ] ||
    fail "$label runtime manifest must contain exactly one runtimeFeatures property"

  if [ "$android_icu_enabled" = "1" ]; then
    [ -d "$expected_source" ] || fail "selected Android ICU source is missing: $expected_source"
    [ -d "$candidate" ] || fail "$label is missing selected ICU data: $candidate"
    runtime_manifest_has_icu "$manifest" ||
      fail "$label runtime manifest does not record selected ICU data"
    [ -z "$(find "$candidate" -type l -print -quit)" ] ||
      fail "$label ICU payload contains a symbolic link"
    [ -n "$(find "$candidate" -type f -print -quit)" ] ||
      fail "$label ICU payload is empty: $candidate"
    if ! diff -qr "$expected_source" "$candidate" >&2; then
      fail "$label ICU payload does not exactly match its selected source"
    fi
  else
    if runtime_manifest_has_icu "$manifest"; then
      fail "$label unexpectedly records ICU when it was not selected"
    fi
    [ ! -e "$candidate" ] || fail "$label unexpectedly contains unselected ICU data: $candidate"
  fi
}

prepare_runtime_resources() {
  local static_registry_source="$1"

  local runtime_source="${OLIPHAUNT_EXPO_ANDROID_RUNTIME_DIR:-}"
  if [ -z "$runtime_source" ]; then
    local android_runtime_source
    android_runtime_source="$(android_build_root_for_abi)/install"
    if [ -f "$root/target/liboliphaunt-android-runtime-smoke/share/postgresql/postgres.bki" ]; then
      runtime_source="$root/target/liboliphaunt-android-runtime-smoke"
    elif [ -f "$android_runtime_source/share/postgresql/postgres.bki" ]; then
      runtime_source="$android_runtime_source"
    else
      runtime_source="$(ensure_host_runtime_assets)"
    fi
  fi
  [ -f "$runtime_source/share/postgresql/postgres.bki" ] ||
    fail "runtime assets are missing postgres.bki: $runtime_source"
  ensure_mobile_runtime_tool_permissions "$runtime_source"
  ensure_mobile_tool_executable "$mobile_packaging_initdb"

  local seed_closure
  seed_closure="$(
    require_mobile_runtime_seed_closure \
      Android \
      "${OLIPHAUNT_EXPO_ANDROID_SEED_CLOSURE_DIR:-}" \
      OLIPHAUNT_EXPO_ANDROID_SEED_CLOSURE_DIR
  )"
  local selected_extensions
  selected_extensions="$(normalize_mobile_extensions)"
  local package_root="$scratch_root/runtime-resources"
  if [ "$android_icu_enabled" = "1" ]; then
    [ -n "$android_icu_data_dir" ] ||
      fail "OLIPHAUNT_EXPO_ANDROID_ICU_DATA_DIR is required when Android ICU is selected"
    [ -d "$android_icu_data_dir" ] ||
      fail "selected Android ICU data directory is missing: $android_icu_data_dir"
  fi
  local prepared_package
  if prepared_package="$(oliphaunt_dev_prepare_prebuilt_mobile_runtime_resource_package \
    Android \
    "$runtime_source" \
    "$mobile_packaging_initdb" \
    "$selected_extensions" \
    "$package_root" \
    "$android_icu_enabled" \
    "$android_icu_data_dir")"; then
    install_mobile_runtime_seed_closure "$prepared_package" "$seed_closure"
    bind_mobile_runtime_manifest_to_seed_closure "$prepared_package" "$seed_closure"
    assert_android_icu_payload \
      "$prepared_package/oliphaunt/runtime/manifest.properties" \
      "$prepared_package/oliphaunt/runtime/files/share/icu" \
      "$android_icu_data_dir" \
      "staged Android runtime resources"
    printf '%s\n' "$prepared_package"
    return 0
  fi
  [ "$android_icu_enabled" = "0" ] ||
    fail "selected Android ICU data could not be staged by the exact runtime resource packager"
  prepared_package="$(prepare_mobile_runtime_resource_package \
    Android \
    "$runtime_source" \
    "$seed_closure" \
    "$static_registry_source" \
    "$selected_extensions" \
    "${OLIPHAUNT_EXPO_ANDROID_REPACKAGE_ASSETS:-0}" \
    "$package_root")"
  assert_android_icu_payload \
    "$prepared_package/oliphaunt/runtime/manifest.properties" \
    "$prepared_package/oliphaunt/runtime/files/share/icu" \
    "" \
    "staged Android runtime resources"
  printf '%s\n' "$prepared_package"
}

install_kotlin_sdk_maven_artifacts_if_required() {
  if ! expo_requires_sdk_artifacts; then
    return 1
  fi

  local product_root source_repo marker
  product_root="$(expo_sdk_artifact_product_root oliphaunt-kotlin)"
  source_repo="$product_root/maven"
  marker="$source_repo/dev/oliphaunt/oliphaunt-android"
  [ -d "$marker" ] ||
    fail "required Kotlin SDK Maven artifact is missing: $marker"

  rm -rf "$local_maven_repo"
  mkdir -p "$local_maven_repo"
  cp -R "$source_repo/." "$local_maven_repo/"
  return 0
}

kotlin_sdk_aar_from_maven_repo() {
  local package_root="$local_maven_repo/dev/oliphaunt/oliphaunt-android"
  [ -d "$package_root" ] ||
    fail "Kotlin SDK Maven repository is missing oliphaunt-android coordinates: $package_root"
  local versions
  versions="$(find "$package_root" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | LC_ALL=C sort)"
  [ -n "$versions" ] ||
    fail "Kotlin SDK Maven repository has no oliphaunt-android versions: $package_root"
  local count
  count="$(printf '%s\n' "$versions" | wc -l | tr -d '[:space:]')"
  [ "$count" = "1" ] ||
    fail "Kotlin SDK Maven repository contains $count oliphaunt-android versions; expected exactly one"
  local version
  version="$(printf '%s\n' "$versions")"
  local aar="$package_root/$version/oliphaunt-android-$version.aar"
  [ -f "$aar" ] ||
    fail "Kotlin SDK Maven repository is missing candidate AAR: $aar"
  printf '%s\n' "$aar"
}

publish_local_kotlin_sdk() {
  local runtime_resources="$1"
  local jni_libs="$2"
  local kotlin_build_root="$scratch_root/kotlin-gradle-build"
  local kotlin_cxx_root="$scratch_root/kotlin-cxx-build"
  local kotlin_cache_root="$scratch_root/kotlin-gradle-cache"
  local extension_archives_root
  extension_archives_root="$runtime_resources/oliphaunt/static-registry/archives"
  if [ ! -d "$extension_archives_root" ]; then
    extension_archives_root="$(android_build_root_for_abi)/out"
  fi

  if install_kotlin_sdk_maven_artifacts_if_required; then
    return
  fi

  rm -rf "$local_maven_repo/dev/oliphaunt/oliphaunt-android"
  mkdir -p "$local_maven_repo"
  run "$root/src/sdks/kotlin/gradlew" -p "$root/src/sdks/kotlin" \
    :oliphaunt:publishAndroidReleasePublicationToMavenLocal \
    "-Dmaven.repo.local=$local_maven_repo" \
    "-PoliphauntAndroidAbiFilters=$android_abi" \
    "-PoliphauntBuildRoot=$kotlin_build_root" \
    "-PoliphauntCxxBuildRoot=$kotlin_cxx_root" \
    --project-cache-dir "$kotlin_cache_root" \
    --no-configuration-cache
}

build_apk() {
  local runtime_resources="$1"
  local jni_libs="$2"
  local gradle_cache_arg="--no-configuration-cache"

  if [ "${OLIPHAUNT_EXPO_ANDROID_GRADLE_CONFIGURATION_CACHE:-0}" = "1" ]; then
    gradle_cache_arg="--configuration-cache"
  fi

  if [ "${OLIPHAUNT_EXPO_ANDROID_SKIP_BUILD:-0}" = "1" ] && [ -f "$apk" ]; then
    echo "Skipping APK build: $apk"
  else
    local gradle_jvmargs gradle_max_workers node_binary
    gradle_jvmargs="$(oliphaunt_android_gradle_jvmargs)"
    gradle_max_workers="$(oliphaunt_android_gradle_max_workers)"
    node_binary="$(node -p 'process.execPath')"
    local selected_extensions extension_archives_root kotlin_sdk_aar android_link_evidence module_stems
    selected_extensions="$(normalize_mobile_extensions)"
    module_stems="$(oliphaunt_dev_mobile_module_stems_for_selection "$selected_extensions")"
    kotlin_sdk_aar="$(kotlin_sdk_aar_from_maven_repo)"
    extension_archives_root="$runtime_resources/oliphaunt/static-registry/archives"
    if [ ! -d "$extension_archives_root" ]; then
      extension_archives_root="$(android_build_root_for_abi)/out"
    fi
    android_link_evidence="$scratch_root/android-static-extension-link-$android_abi.tsv"
    # CMake writes this receipt while configuring native inputs. Preserve it when
    # Gradle is up to date; a native reconfiguration overwrites it when needed.
    local gradle_build_tasks=(":app:assemble$build_type_capitalized")
    if [ "$build_type" = "release" ]; then
      gradle_build_tasks+=("-x" ":app:lintVitalRelease")
    fi
    run env \
      NODE_ENV=development \
      NODE_BINARY="$node_binary" \
      OLIPHAUNT_REACT_NATIVE_ANDROID_PACKAGE_RUNTIME=1 \
      OLIPHAUNT_REACT_NATIVE_ANDROID_RUNTIME_RESOURCES_DIR="$runtime_resources" \
      OLIPHAUNT_REACT_NATIVE_ANDROID_JNI_LIBS_DIR="$jni_libs" \
      OLIPHAUNT_REACT_NATIVE_ANDROID_EXTENSION_ARCHIVES_DIR="$extension_archives_root" \
      OLIPHAUNT_REACT_NATIVE_ANDROID_EXTENSIONS="$selected_extensions" \
      OLIPHAUNT_REACT_NATIVE_ANDROID_LINK_EVIDENCE_FILE="$android_link_evidence" \
      OLIPHAUNT_REACT_NATIVE_KOTLIN_SDK_AAR="$kotlin_sdk_aar" \
      "$example_dir/android/gradlew" \
      --project-dir "$example_dir/android" \
      "-Dorg.gradle.jvmargs=$gradle_jvmargs" \
      "--max-workers=$gradle_max_workers" \
      "${gradle_build_tasks[@]}" \
      "-PoliphauntAndroidAbiFilters=$android_abi" \
      "-PreactNativeArchitectures=$android_abi" \
      "-PliboliphauntKotlinSdkAar=$kotlin_sdk_aar" \
      "-PoliphauntReactNativePackageRuntime=true" \
      "-PoliphauntRuntimeResourcesDir=$runtime_resources" \
      "-PoliphauntAndroidJniLibsDir=$jni_libs" \
      "-PoliphauntAndroidExtensionArchivesDir=$extension_archives_root" \
      "-PoliphauntAndroidLinkEvidenceFile=$android_link_evidence" \
      "-PoliphauntExtensions=$selected_extensions" \
      "-PoliphauntBuildRoot=$scratch_root/gradle-build" \
      "-PoliphauntCxxBuildRoot=$scratch_root/cxx-build" \
      "-PnodeExecutable=$node_binary" \
      "$gradle_cache_arg"
    if [ -n "$module_stems" ] && [ ! -s "$android_link_evidence" ]; then
      fail "Android build did not emit static extension link evidence: $android_link_evidence"
    fi
    if [ -n "$module_stems" ]; then
      run node "$root/src/sdks/react-native/tools/validate-android-link-evidence.mjs" \
        --evidence "$android_link_evidence" \
        --abi "$android_abi" \
        --module-stems "$module_stems" \
        --static-registry "$runtime_resources/oliphaunt/static-registry/manifest.properties" \
        --target "android-$android_abi"
    fi
  fi

  run "$root/src/sdks/react-native/tools/verify-android-apk.sh" "$apk"

  local apk_files="$scratch_root/apk-files.txt"
  zipinfo -1 "$apk" >"$apk_files"
  grep -Fxq "lib/$android_abi/liboliphaunt.so" "$apk_files" ||
    fail "APK is missing lib/$android_abi/liboliphaunt.so"
  grep -Fxq "assets/oliphaunt/runtime/manifest.properties" "$apk_files" ||
    fail "APK is missing Oliphaunt runtime manifest"
  grep -Fxq "assets/oliphaunt/cluster-seed/manifest.properties" "$apk_files" ||
    fail "APK is missing liboliphaunt template manifest"
  grep -Fxq "assets/oliphaunt/package-size.tsv" "$apk_files" ||
    fail "APK is missing Oliphaunt package-size report"
  local selected_extensions
  selected_extensions="$(normalize_mobile_extensions)"
  oliphaunt_dev_assert_runtime_file_list "$selected_extensions" "Android" <"$apk_files"

  local apk_payload_root="$scratch_root/apk-runtime-verification"
  rm -rf "$apk_payload_root"
  mkdir -p "$apk_payload_root"
  unzip -q "$apk" "assets/oliphaunt/runtime/manifest.properties" -d "$apk_payload_root"
  if [ "$android_icu_enabled" = "1" ]; then
    unzip -q "$apk" "assets/oliphaunt/runtime/files/share/icu/*" -d "$apk_payload_root"
  fi
  assert_android_icu_payload \
    "$apk_payload_root/assets/oliphaunt/runtime/manifest.properties" \
    "$apk_payload_root/assets/oliphaunt/runtime/files/share/icu" \
    "$runtime_resources/oliphaunt/runtime/files/share/icu" \
    "built Android APK"
}

start_metro_if_needed() {
  local bundle_runner="${1:-$runner}"
  local bundle_storage="${2:-}"
  if [ "$build_type" = "release" ]; then
    return
  fi

  mkdir -p "$scratch_root"
  if [ -n "${metro_pid:-}" ] && kill -0 "$metro_pid" >/dev/null 2>&1; then
    if [ "$metro_bundle_runner" = "$bundle_runner" ] && [ "$metro_bundle_storage" = "$bundle_storage" ]; then
      return 0
    fi
    stop_owned_metro
  fi
  reserve_metro_port
  if port_is_listening; then
    if [ "$reuse_metro" = "1" ]; then
      echo "Reusing Metro on port $metro_port"
      return
    fi
    fail "Expo Metro port $metro_port is already in use; stop it, set OLIPHAUNT_EXPO_ANDROID_REUSE_METRO=1, or choose OLIPHAUNT_EXPO_ANDROID_METRO_PORT"
  fi

  echo "Starting Expo Metro on port $metro_port for runner $bundle_runner"
  (
    cd "$example_dir"
    CI=1 EXPO_NO_TELEMETRY=1 EXPO_UNSTABLE_MCP_SERVER=1 \
      EXPO_PUBLIC_OLIPHAUNT_RUNNER="$bundle_runner" \
      EXPO_PUBLIC_OLIPHAUNT_LIFECYCLE_SMOKE="$lifecycle_smoke" \
      EXPO_PUBLIC_OLIPHAUNT_BENCHMARK_PRESET="$benchmark_preset" \
      EXPO_PUBLIC_OLIPHAUNT_STARTUP_GUCS="$startup_gucs" \
      EXPO_PUBLIC_OLIPHAUNT_STORAGE_DIRECTORY="$bundle_storage" \
      pnpm exec expo start --dev-client --port "$metro_port" --clear \
      >"$scratch_root/metro.log" 2>&1
  ) &
  metro_pid="$!"
  metro_bundle_runner="$bundle_runner"
  metro_bundle_storage="$bundle_storage"

  for _ in $(seq 1 60); do
    if port_is_listening; then
      return
    fi
    sleep 1
  done

  tail -80 "$scratch_root/metro.log" >&2 || true
  fail "Expo Metro did not start on port $metro_port"
}

trap cleanup EXIT

write_android_package_metrics() {
  local apk_bytes="$1"
  local rn_package_bytes="$2"
  write_mobile_package_size_report apkBytes "$apk_bytes" "$rn_package_bytes"
}

write_android_build_artifact_report() {
  local selected_extensions="$1"
  local apk_bytes rn_package_bytes apk_copy report android_link_evidence android_link_evidence_sha256
  mkdir -p "$build_artifact_dir" "$scratch_root/reports"
  apk_copy="$build_artifact_dir/app-$build_type-$android_abi.apk"
  android_link_evidence="$scratch_root/android-static-extension-link-$android_abi.tsv"
  android_link_evidence_sha256=""
  if [ -f "$android_link_evidence" ]; then
    android_link_evidence_sha256="$(shasum -a 256 "$android_link_evidence" | awk '{print $1}')"
  fi
  cp "$apk" "$apk_copy"
  apk_bytes="$(wc -c <"$apk" | tr -d '[:space:]')"
  rn_package_bytes="$(wc -c <"$tarball" | tr -d '[:space:]')"
  report="$build_artifact_dir/build-report.json"
  write_mobile_build_artifact_report_json \
    "$report" \
    android \
    "$apk_copy" \
    "$apk_bytes" \
    "$tarball" \
    "$rn_package_bytes" \
    "$selected_extensions" \
    "$scratch_root" \
    buildType "$build_type" \
    abi "$android_abi" \
    icu "$android_icu_enabled" \
    androidLinkEvidence "$android_link_evidence" \
    androidLinkEvidenceSha256 "$android_link_evidence_sha256"
  cp "$report" "$scratch_root/reports/build-report.json"
  echo "Android mobile build artifact: $apk_copy"
  echo "Android mobile build report: $report"
}

main() {
  if ! { is_truthy "$e2e_only" && [ "$build_type" = "release" ] && [ "$e2e_assertion_runner" = "maestro" ]; }; then
    need_cmd rg
  fi
  if [ "$build_type" = "debug" ]; then
    need_cmd pgrep
    need_cmd lsof
  fi
  ensure_android_env
  if is_truthy "$e2e_only"; then
    need_cmd node
    need_cmd unzip
    [ -f "$apk" ] ||
      fail "Android E2E-only mode requires an existing APK at $apk; run mobile-build:android first or set OLIPHAUNT_EXPO_ANDROID_SCRATCH to its scratch root"
    export_mobile_e2e_icu_expectation_from_android_apk "$apk" "Android APK"
    install_and_launch
    local apk_bytes rn_package_bytes
    apk_bytes="$(wc -c <"$apk" | tr -d '[:space:]')"
    rn_package_bytes="$(file_bytes "$tarball")"
    write_android_package_metrics "$apk_bytes" "$rn_package_bytes"
    exit 0
  fi
  need_cmd zipinfo
  need_cmd unzip
  if [ "$android_icu_enabled" = "1" ]; then
    need_cmd diff
  fi
  prepare_expo_example_workspace
  pack_react_native_sdk_if_needed
  ensure_android_project
  local runtime_resources jni_libs source_so static_registry_source
  source_so="$(find_android_liboliphaunt_so)"
  static_registry_source="$(mobile_static_registry_source_for_library "$source_so")"
  runtime_resources="$(prepare_runtime_resources "$static_registry_source")"
  jni_libs="$(prepare_jni_libs "$source_so")"
  publish_local_kotlin_sdk "$runtime_resources" "$jni_libs"
  build_apk "$runtime_resources" "$jni_libs"
  export_mobile_e2e_icu_expectation_from_android_apk "$apk" "Android APK"
  local selected_extensions
  selected_extensions="$(normalize_mobile_extensions)"
  write_android_build_artifact_report "$selected_extensions"
  if is_truthy "$build_only"; then
    printf '\nAndroid build-only mobile artifact complete: %s\n' "$apk"
    exit 0
  fi
  install_and_launch

  local apk_bytes rn_package_bytes
  apk_bytes="$(wc -c <"$apk" | tr -d '[:space:]')"
  rn_package_bytes="$(wc -c <"$tarball" | tr -d '[:space:]')"
  write_android_package_metrics "$apk_bytes" "$rn_package_bytes"

  printf '\nAPK bytes: '
  printf '%s' "$apk_bytes"
  printf '\nRN package bytes: '
  printf '%s' "$rn_package_bytes"
  printf '\n'
}

main "$@"
