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
. "$root/src/sdks/react-native/tools/expo-runner-metro.sh"
. "$root/src/sdks/react-native/tools/expo-runner-reporting.sh"
. "$root/src/sdks/react-native/tools/expo-runner-workspace.sh"
. "$root/src/sdks/react-native/tools/mobile-extension-runtime.sh"
. "$root/src/sdks/react-native/tools/expo-runner-runtime-resources.sh"
. "$root/src/sdks/react-native/tools/expo-runner-ios-device.sh"
. "$root/src/sdks/react-native/tools/expo-runner-ios-installed-app.sh"

source_example_dir="$root/src/sdks/react-native/examples/expo"
rn_dir="$root/src/sdks/react-native"
scratch_workspace_name="oliphaunt-react-native-expo-ios-workspace"
runner="${OLIPHAUNT_EXPO_IOS_RUNNER:-smoke}"
case "$runner" in
  smoke|benchmark|crash)
    ;;
  *)
    echo "error: OLIPHAUNT_EXPO_IOS_RUNNER must be smoke, benchmark, or crash, got $runner" >&2
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
scratch_root="${OLIPHAUNT_EXPO_IOS_SCRATCH:-$root/target/oliphaunt-expo-ios-$runner}"
example_dir="${OLIPHAUNT_EXPO_IOS_EXAMPLE_DIR:-$scratch_root/src/sdks/react-native/examples/expo}"
crash_root_suffix="$(printf '%s' "$(basename "$scratch_root")" | LC_ALL=C tr -c 'A-Za-z0-9_.-' '-')"
[ -n "$crash_root_suffix" ] || crash_root_suffix="run"
package_work="$scratch_root/src/sdks/react-native"
pack_dir="${OLIPHAUNT_EXPO_IOS_PACK_DIR:-$root/target/oliphaunt-rn-expo-pack/ios}"
tarball="$pack_dir/$(react_native_package_tarball_name "$rn_dir")"
app_id="${OLIPHAUNT_EXPO_IOS_APP_ID:-dev.oliphaunt.reactnative.example}"
scheme="${OLIPHAUNT_EXPO_IOS_SCHEME:-reactnativeoliphauntexpo}"
if [ -n "${OLIPHAUNT_EXPO_IOS_METRO_PORT:-}" ]; then
  metro_port="$OLIPHAUNT_EXPO_IOS_METRO_PORT"
  metro_port_explicit=1
else
  metro_port=8081
  metro_port_explicit=0
fi
reuse_metro="${OLIPHAUNT_EXPO_IOS_REUSE_METRO:-0}"
keep_metro="${OLIPHAUNT_EXPO_IOS_KEEP_METRO:-0}"
reuse_metro_env_name="OLIPHAUNT_EXPO_IOS_REUSE_METRO"
metro_port_env_name="OLIPHAUNT_EXPO_IOS_METRO_PORT"
default_timeout_seconds=600
[ "$runner" = "benchmark" ] && default_timeout_seconds=720
timeout_seconds="${OLIPHAUNT_EXPO_IOS_TIMEOUT_SECONDS:-$default_timeout_seconds}"
default_lifecycle_smoke=0
[ "$runner" = "smoke" ] && default_lifecycle_smoke=1
lifecycle_smoke="${OLIPHAUNT_EXPO_IOS_LIFECYCLE_SMOKE:-$default_lifecycle_smoke}"
background_seconds="${OLIPHAUNT_EXPO_IOS_BACKGROUND_SECONDS:-3}"
reuse_installed_app="${OLIPHAUNT_EXPO_IOS_REUSE_INSTALLED_APP:-0}"
clean_simulator_install="${OLIPHAUNT_EXPO_IOS_CLEAN_INSTALL:-1}"
e2e_only="${OLIPHAUNT_EXPO_IOS_E2E_ONLY:-0}"
e2e_assertion_runner="${OLIPHAUNT_EXPO_IOS_E2E_ASSERTION_RUNNER:-${OLIPHAUNT_MOBILE_E2E_ASSERTION_RUNNER:-log}}"
case "$e2e_assertion_runner" in
  auto|log|maestro)
    ;;
  *)
    echo "error: OLIPHAUNT_EXPO_IOS_E2E_ASSERTION_RUNNER must be auto, log, or maestro, got $e2e_assertion_runner" >&2
    exit 1
    ;;
esac
configuration="${OLIPHAUNT_EXPO_IOS_CONFIGURATION:-Debug}"
sdk="${OLIPHAUNT_EXPO_IOS_SDK:-iphonesimulator}"
destination="${OLIPHAUNT_EXPO_IOS_DESTINATION:-}"
simulator_udid="${OLIPHAUNT_EXPO_IOS_SIMULATOR_UDID:-${OLIPHAUNT_EXPO_IOS_DEVICE_UDID:-}}"
physical_device_id="${OLIPHAUNT_EXPO_IOS_DEVICE_ID:-${OLIPHAUNT_EXPO_IOS_DEVICE_UDID:-}}"
simulator_name="${OLIPHAUNT_EXPO_IOS_DEVICE_NAME:-iPhone 15 Pro}"
derived_data="$scratch_root/DerivedData"
workspace="$example_dir/ios/reactnativeoliphauntexpo.xcworkspace"
xcode_scheme="reactnativeoliphauntexpo"
build_artifact_dir="${OLIPHAUNT_EXPO_IOS_BUILD_ARTIFACT_DIR:-$root/target/mobile-build/react-native/ios}"
maestro_flow="${OLIPHAUNT_EXPO_IOS_MAESTRO_FLOW:-$source_example_dir/maestro/installed-smoke.yaml}"
expo_use_precompiled_modules="${OLIPHAUNT_EXPO_IOS_USE_PRECOMPILED_MODULES:-true}"
use_ccache="${OLIPHAUNT_EXPO_IOS_USE_CCACHE:-1}"
liboliphaunt_pod_mode="vendored-framework"
code_signing_allowed="${OLIPHAUNT_EXPO_IOS_CODE_SIGNING_ALLOWED:-}"
development_team="${OLIPHAUNT_EXPO_IOS_DEVELOPMENT_TEAM:-}"
code_sign_style="${OLIPHAUNT_EXPO_IOS_CODE_SIGN_STYLE:-}"
code_sign_identity="${OLIPHAUNT_EXPO_IOS_CODE_SIGN_IDENTITY:-}"
provisioning_profile_specifier="${OLIPHAUNT_EXPO_IOS_PROVISIONING_PROFILE_SPECIFIER:-}"
allow_provisioning_updates="${OLIPHAUNT_EXPO_IOS_ALLOW_PROVISIONING_UPDATES:-}"
allow_device_registration="${OLIPHAUNT_EXPO_IOS_ALLOW_PROVISIONING_DEVICE_REGISTRATION:-}"
metro_dev_log="$example_dir/.expo/dev/logs/start.log"
if [ "${OLIPHAUNT_EXPO_IOS_EXTENSIONS+x}" = "x" ]; then
  mobile_extensions_raw="$OLIPHAUNT_EXPO_IOS_EXTENSIONS"
elif [ "${OLIPHAUNT_EXPO_MOBILE_EXTENSIONS+x}" = "x" ]; then
  mobile_extensions_raw="$OLIPHAUNT_EXPO_MOBILE_EXTENSIONS"
else
  mobile_extensions_raw="vector"
fi
runtime_footprint="${OLIPHAUNT_EXPO_IOS_RUNTIME_FOOTPRINT:-${OLIPHAUNT_EXPO_MOBILE_RUNTIME_FOOTPRINT:-balancedMobile}}"
default_durability_profile=balanced
[ "$runner" = "crash" ] && default_durability_profile=safe
durability_profile="${OLIPHAUNT_EXPO_IOS_DURABILITY:-${OLIPHAUNT_EXPO_MOBILE_DURABILITY:-$default_durability_profile}}"
startup_gucs="${OLIPHAUNT_EXPO_IOS_STARTUP_GUCS:-${OLIPHAUNT_EXPO_MOBILE_STARTUP_GUCS:-}}"
wal_segsize_mb="${OLIPHAUNT_EXPO_IOS_WAL_SEGSIZE_MB:-${OLIPHAUNT_EXPO_MOBILE_WAL_SEGSIZE_MB:-16}}"
benchmark_preset="${OLIPHAUNT_EXPO_IOS_BENCHMARK_PRESET:-${OLIPHAUNT_EXPO_MOBILE_BENCHMARK_PRESET:-full}}"
crash_root_override="${OLIPHAUNT_EXPO_IOS_CRASH_ROOT:-}"
mobile_template_initdb="${OLIPHAUNT_EXPO_IOS_INITDB:-}"
metro_pid=""
metro_bundle_runner=""
metro_bundle_root=""

is_ios_build_only() {
  is_truthy "${OLIPHAUNT_EXPO_IOS_BUILD_ONLY:-0}"
}

is_physical_ios_launch() {
  [ "$sdk" = "iphoneos" ] && ! is_ios_build_only
}

is_ios_debug_configuration() {
  case "$configuration" in
    Debug|debug|DEBUG)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

uses_ios_metro() {
  is_ios_debug_configuration
}

is_reuse_installed_physical_ios_app() {
  is_physical_ios_launch && is_truthy "$reuse_installed_app"
}

normalize_mobile_extensions() {
  oliphaunt_dev_normalize_mobile_extensions "$mobile_extensions_raw" "iOS"
}

mobile_static_extensions_for_selection() {
  oliphaunt_dev_mobile_static_extensions_for_selection "$1"
}

mobile_static_registry_source_for_library() {
  local artifact="$1"
  local configured="${OLIPHAUNT_EXPO_IOS_STATIC_REGISTRY_SOURCE:-${OLIPHAUNT_EXPO_MOBILE_STATIC_REGISTRY_SOURCE:-}}"
  if [ -n "$configured" ]; then
    [ -f "$configured" ] || fail "configured iOS static registry source does not exist: $configured"
    printf '%s\n' "$configured"
    return
  fi
  case "$artifact" in
    *.xcframework)
      local candidate
      candidate="$(dirname "$artifact")/liboliphaunt_mobile_static_registry.c"
      [ -f "$candidate" ] && printf '%s\n' "$candidate"
      return 0 # exact-extension packages may provide the static registry source.
      ;;
    *.dylib)
      local candidate
      candidate="$(dirname "$artifact")/liboliphaunt_mobile_static_registry.c"
      [ -f "$candidate" ] && printf '%s\n' "$candidate"
      return 0 # exact-extension packages may provide the static registry source.
      ;;
  esac
  return 0 # exact-extension packages may provide the static registry source.
}

prepare_runtime_resources() {
  local static_registry_source="$1"

  local runtime_source="${OLIPHAUNT_EXPO_IOS_RUNTIME_DIR:-}"
  if [ -z "$runtime_source" ]; then
    if [ -f "$root/target/liboliphaunt-ios-runtime-smoke/share/postgresql/postgres.bki" ]; then
      runtime_source="$root/target/liboliphaunt-ios-runtime-smoke"
    elif [ -f "$root/target/liboliphaunt-ios-simulator/install/share/postgresql/postgres.bki" ]; then
      runtime_source="$root/target/liboliphaunt-ios-simulator/install"
    else
      runtime_source="$(ensure_host_runtime_assets)"
    fi
  fi
  [ -f "$runtime_source/share/postgresql/postgres.bki" ] ||
    fail "runtime assets are missing postgres.bki: $runtime_source"
  ensure_mobile_runtime_tool_permissions "$runtime_source"
  ensure_mobile_tool_executable "$mobile_template_initdb"

  local template_source
  template_source="$(
    find_latest_mobile_pgdata \
      iOS \
      "${OLIPHAUNT_EXPO_IOS_TEMPLATE_PGDATA_DIR:-}" \
      OLIPHAUNT_EXPO_IOS_TEMPLATE_PGDATA_DIR \
      OLIPHAUNT_EXPO_IOS_INITDB
  )"
  local selected_extensions
  selected_extensions="$(normalize_mobile_extensions)"
  local package_root="$scratch_root/runtime-resources"
  if oliphaunt_dev_prepare_prebuilt_mobile_runtime_resource_package \
    iOS \
    "$runtime_source" \
    "$mobile_template_initdb" \
    "$selected_extensions" \
    "$package_root"; then
    return 0
  fi
  prepare_mobile_runtime_resource_package \
    iOS \
    "$runtime_source" \
    "$template_source" \
    "$static_registry_source" \
    "$selected_extensions" \
    "${OLIPHAUNT_EXPO_IOS_REPACKAGE_ASSETS:-0}" \
    "$package_root"
}

find_ios_library_artifact() {
  local artifact="${OLIPHAUNT_EXPO_IOS_OLIPHAUNT_XCFRAMEWORK:-}"
  [ -n "$artifact" ] || artifact="${OLIPHAUNT_EXPO_IOS_OLIPHAUNT_FRAMEWORK:-}"
  [ -n "$artifact" ] || artifact="${OLIPHAUNT_EXPO_IOS_OLIPHAUNT_DYLIB:-}"
  if [ -z "$artifact" ] && [ "$sdk" = "iphonesimulator" ]; then
    expo_allows_native_builds ||
      fail "missing iOS liboliphaunt artifact and native builds are disabled; set OLIPHAUNT_EXPO_IOS_OLIPHAUNT_XCFRAMEWORK, OLIPHAUNT_EXPO_IOS_OLIPHAUNT_FRAMEWORK, or OLIPHAUNT_EXPO_IOS_OLIPHAUNT_DYLIB"
    local extensions static_extensions
    extensions="$(normalize_mobile_extensions)"
    static_extensions="$(mobile_static_extensions_for_selection "$extensions")"
    artifact="$(oliphaunt_capture_build_artifact_path \
      "iOS simulator liboliphaunt build" \
      "$scratch_root/logs/build-ios-simulator.log" \
      env OLIPHAUNT_MOBILE_STATIC_EXTENSIONS="$static_extensions" src/runtimes/liboliphaunt/native/bin/build-postgres18-ios-simulator.sh)"
  fi
  [ -n "$artifact" ] ||
    fail "missing iOS liboliphaunt artifact; set OLIPHAUNT_EXPO_IOS_OLIPHAUNT_XCFRAMEWORK, OLIPHAUNT_EXPO_IOS_OLIPHAUNT_FRAMEWORK, or OLIPHAUNT_EXPO_IOS_OLIPHAUNT_DYLIB. macOS dylibs are not accepted."
  [ -e "$artifact" ] || fail "iOS liboliphaunt artifact does not exist: $artifact"
  printf '%s\n' "$artifact"
}

validate_ios_library_artifact() {
  local artifact="$1"
  case "$artifact" in
    *.xcframework)
      [ -d "$artifact" ] || fail "XCFramework path is not a directory: $artifact"
      if [ "$sdk" = "iphonesimulator" ] &&
        ! find "$artifact" -maxdepth 2 -type d -name '*simulator*' | grep -q .; then
        fail "XCFramework has no iOS simulator slice: $artifact"
      fi
      if [ "$sdk" = "iphoneos" ] &&
        ! find "$artifact" -maxdepth 2 -type d -name 'ios-*' ! -name '*simulator*' | grep -q .; then
        fail "XCFramework has no iOS device slice: $artifact"
      fi
      ;;
    *.framework)
      [ -d "$artifact" ] || fail "framework path is not a directory: $artifact"
      ;;
    *.dylib)
      [ -f "$artifact" ] || fail "dylib path is not a file: $artifact"
      local platform
      platform="$(xcrun vtool -show-build "$artifact" 2>/dev/null | awk '/platform /{print $2; exit}')"
      case "$sdk:$platform" in
        iphonesimulator:IOSSIMULATOR|iphoneos:IOS)
          ;;
        *:MACOS)
          fail "refusing macOS liboliphaunt.dylib for iOS smoke: $artifact"
          ;;
        *)
          fail "liboliphaunt.dylib platform $platform does not match sdk $sdk: $artifact"
          ;;
      esac
      ;;
    *)
      fail "unsupported iOS liboliphaunt artifact type: $artifact"
      ;;
  esac
}

validate_ios_static_extension_linkage() {
  local selected_extensions="$1"
  local xcode_log="$2"
  local resource_root="$3"
  local derived_data_root="$4"
  local stems
  stems="$(oliphaunt_dev_mobile_module_stems_for_selection "$selected_extensions")"
  [ -n "$stems" ] || return 0

  if find "$resource_root/static-registry" -type f -name 'oliphaunt_static_registry.c' -print -quit | grep -q .; then
    fail "iOS app bundled build-only static-registry source; it must be compiled by CocoaPods, not copied as a resource"
  fi
  if find "$resource_root" -type d -name '*.xcframework' -print -quit | grep -q .; then
    fail "iOS app bundled extension XCFramework inputs as resources; selected extensions must be linked by Xcode"
  fi

  local pods_support="$example_dir/ios/Pods/Target Support Files/OliphauntReactNativePayload"
  local input_file="$pods_support/OliphauntReactNativePayload-xcframeworks-input-files.xcfilelist"
  local output_file="$pods_support/OliphauntReactNativePayload-xcframeworks-output-files.xcfilelist"
  [ -f "$input_file" ] ||
    fail "iOS extension link evidence is missing CocoaPods XCFramework input file list: $input_file"
  [ -f "$output_file" ] ||
    fail "iOS extension link evidence is missing CocoaPods XCFramework output file list: $output_file"

  local expected_file pod_file built_file missing_pods missing_built extra_pods extra_built
  expected_file="$(mktemp "${TMPDIR:-/tmp}/oliphaunt-ios-linked-expected.XXXXXX")"
  pod_file="$(mktemp "${TMPDIR:-/tmp}/oliphaunt-ios-linked-pods.XXXXXX")"
  built_file="$(mktemp "${TMPDIR:-/tmp}/oliphaunt-ios-linked-built.XXXXXX")"
  printf '%s\n' "$stems" |
    tr ',' '\n' |
    sed '/^$/d' |
    sed 's#^#liboliphaunt_extension_#' |
    LC_ALL=C sort -u >"$expected_file"

  rg -o 'liboliphaunt_extension_[A-Za-z0-9_-]+' "$input_file" "$output_file" |
    sed 's#^.*:##' |
    LC_ALL=C sort -u >"$pod_file" || true
  find "$derived_data_root/Build/Products" \
    \( -name 'liboliphaunt_extension_*.a' -o -name 'liboliphaunt_extension_*.framework' \) \
    -print 2>/dev/null |
    while IFS= read -r linked_artifact; do
      basename "$linked_artifact" |
        sed 's#\.a$##;s#\.framework$##'
    done |
    LC_ALL=C sort -u >"$built_file"

  missing_pods="$(comm -23 "$expected_file" "$pod_file" | paste -sd ',' -)"
  missing_built="$(comm -23 "$expected_file" "$built_file" | paste -sd ',' -)"
  extra_pods="$(comm -13 "$expected_file" "$pod_file" | paste -sd ',' -)"
  extra_built="$(comm -13 "$expected_file" "$built_file" | paste -sd ',' -)"
  rm -f "$expected_file" "$pod_file" "$built_file"
  [ -z "$missing_pods" ] ||
    fail "iOS CocoaPods file lists do not include selected extension link input(s): $missing_pods"
  [ -z "$missing_built" ] ||
    fail "iOS build products do not include selected extension linked artifact(s): $missing_built"
  [ -z "$extra_pods" ] ||
    fail "iOS CocoaPods file lists include unselected extension link input(s): $extra_pods"
  [ -z "$extra_built" ] ||
    fail "iOS build products include unselected extension linked artifact(s): $extra_built"
  if ! rg -q "\\*\\* BUILD SUCCEEDED \\*\\*" "$xcode_log"; then
    fail "iOS extension link evidence requires a successful xcodebuild log: $xcode_log"
  fi
}

install_react_native_sdk_tarball() {
  patch_expo_example_react_native_dependency "file:$tarball"
  rm -rf "$example_dir/node_modules/@oliphaunt/react-native"
  install_expo_example_dependencies
}

install_react_native_sdk_from_source_for_reuse() {
  need_cmd pnpm
  patch_expo_example_react_native_dependency "file:$rn_dir"
  rm -rf "$example_dir/node_modules/@oliphaunt/react-native"
  install_expo_example_dependencies
}

verify_ios_package_payload() {
  local package_root="$1"
  local verifier="$package_root/tools/verify-ios-package.mjs"
  [ -f "$verifier" ] ||
    fail "React Native SDK package is missing its iOS payload verifier: $verifier"
  run node "$verifier" --package-dir "$package_root"
}

verify_installed_ios_package() {
  local installed_package="$1"
  [ -d "$installed_package" ] ||
    fail "installed React Native SDK package is missing after artifact install: $installed_package"
  # This intentionally performs no repair or copy into node_modules. The
  # installed package itself is the consumer contract under test.
  verify_ios_package_payload "$installed_package"
}

pack_react_native_sdk() {
  need_cmd pnpm
  mkdir -p "$pack_dir" "$scratch_root"

  if expo_requires_sdk_artifacts; then
    tarball="$(expo_single_sdk_artifact_file oliphaunt-react-native '*.tgz')"
    install_react_native_sdk_tarball
    local installed_package="$example_dir/node_modules/@oliphaunt/react-native"
    verify_installed_ios_package "$installed_package"
    return
  fi

  local package_stamp="$pack_dir/.ios-package.stamp"
  if [ "${OLIPHAUNT_EXPO_IOS_REPACK_RN:-0}" != "1" ] &&
    [ -f "$tarball" ] &&
    [ -f "$package_stamp" ] &&
    [ -z "$(
      find "$rn_dir" \
        -path "$rn_dir/node_modules" -prune -o \
        -path "$rn_dir/lib" -prune -o \
        -path "$rn_dir/.build" -prune -o \
        -path "$rn_dir/android/.gradle" -prune -o \
        -path "$rn_dir/android/.cxx" -prune -o \
        -path "$rn_dir/android/build" -prune -o \
        -type f -newer "$package_stamp" -print -quit
    )" ]; then
    echo "Reusing React Native SDK package: $tarball" >&2
    if [ ! -f "$example_dir/node_modules/@oliphaunt/react-native/package.json" ]; then
      install_react_native_sdk_tarball
    fi
    local installed_package="$example_dir/node_modules/@oliphaunt/react-native"
    verify_installed_ios_package "$installed_package"
    return
  fi

  prepare_react_native_package_worktree
  run pnpm --dir "$package_work" run build
  echo
  echo "==> (cd $package_work && pnpm pack --pack-destination $pack_dir)"
  (
    cd "$package_work"
    pnpm pack --pack-destination "$pack_dir"
  )
  install_react_native_sdk_tarball
  local installed_package="$example_dir/node_modules/@oliphaunt/react-native"
  verify_installed_ios_package "$installed_package"
  touch "$package_stamp"
}

prepare_swift_sdk_artifact_git_repo_if_required() {
  if ! expo_requires_sdk_artifacts; then
    return 0
  fi

  local archive artifact_repo extract_root package_archive_root source_root
  need_cmd unzip
  need_cmd git
  archive="$(expo_single_sdk_artifact_file oliphaunt-swift 'Oliphaunt-source.zip')"
  artifact_repo="$scratch_root/swift-sdk-artifact-repo"
  extract_root="$scratch_root/swift-sdk-artifact-extract"
  source_root="$artifact_repo/src/sdks/swift"
  rm -rf "$artifact_repo" "$extract_root"
  mkdir -p "$source_root"
  unzip -q "$archive" -d "$extract_root"
  package_archive_root="$extract_root"
  if [ ! -f "$package_archive_root/Sources/Oliphaunt/Oliphaunt.swift" ]; then
    local -a archive_dirs=()
    local archive_dir
    while IFS= read -r archive_dir; do
      archive_dirs+=("$archive_dir")
    done < <(find "$extract_root" -mindepth 1 -maxdepth 1 -type d -print | sort)
    if [ "${#archive_dirs[@]}" -eq 1 ]; then
      package_archive_root="${archive_dirs[0]}"
    else
      package_archive_root=""
    fi
  fi
  [ -n "$package_archive_root" ] &&
    [ -f "$package_archive_root/Sources/Oliphaunt/Oliphaunt.swift" ] ||
    fail "Swift SDK source artifact did not contain Sources/Oliphaunt/Oliphaunt.swift at the archive root or one top-level package directory: $archive"
  cp -R "$package_archive_root/." "$source_root/"
  [ -f "$source_root/Sources/Oliphaunt/Oliphaunt.swift" ] ||
    fail "Swift SDK source artifact did not unpack to Sources/Oliphaunt/Oliphaunt.swift: $archive"
  if [ -f "$(expo_sdk_artifact_product_root oliphaunt-swift)/Package.swift.release" ]; then
    cp "$(expo_sdk_artifact_product_root oliphaunt-swift)/Package.swift.release" "$artifact_repo/Package.swift"
  fi
  (
    cd "$artifact_repo"
    git init -q
    git config user.name "Oliphaunt CI"
    git config user.email "ci@oliphaunt.dev"
    git checkout -q -b artifact
    git add .
    git commit -q -m "artifact: stage swift sdk source"
  )
  export OLIPHAUNT_SWIFT_SDK_GIT_URL="file://$artifact_repo"
  export OLIPHAUNT_SWIFT_SDK_BRANCH="artifact"
  unset OLIPHAUNT_SWIFT_SDK_COMMIT
  unset OLIPHAUNT_SWIFT_SDK_TAG
}

configure_ios_carrier_inputs() {
  local carrier_manifest="${OLIPHAUNT_REACT_NATIVE_IOS_BASE_CARRIER:-}"
  if [ -z "$carrier_manifest" ]; then
    local candidate="$root/target/release/ios-carriers/oliphaunt-react-native-ios-carriers.json"
    if [ -f "$candidate" ]; then
      carrier_manifest="$candidate"
    elif expo_requires_sdk_artifacts; then
      local artifact_root
      artifact_root="$(expo_sdk_artifact_product_root oliphaunt-react-native)"
      carrier_manifest="$(
        find "$artifact_root" -type f \
          -name 'oliphaunt-react-native-ios-carriers.json' -print -quit 2>/dev/null || true
      )"
    fi
  fi
  [ -n "$carrier_manifest" ] && [ -f "$carrier_manifest" ] ||
    fail "iOS carrier manifest is missing; stage target/release/ios-carriers/oliphaunt-react-native-ios-carriers.json or set OLIPHAUNT_REACT_NATIVE_IOS_BASE_CARRIER"
  carrier_manifest="$(cd "$(dirname "$carrier_manifest")" && pwd)/$(basename "$carrier_manifest")"
  export OLIPHAUNT_REACT_NATIVE_IOS_BASE_CARRIER="$carrier_manifest"
  if rg -q '"url"[[:space:]]*:[[:space:]]*"file:' "$carrier_manifest"; then
    export OLIPHAUNT_REACT_NATIVE_IOS_ALLOW_FILE_URLS=1
  fi

  local selected_extensions icu_enabled
  selected_extensions="$(normalize_mobile_extensions)"
  icu_enabled="${OLIPHAUNT_EXPO_IOS_ICU:-0}"
  node - "$example_dir/app.json" "$selected_extensions" "$icu_enabled" <<'NODE'
const fs = require("node:fs");
const file = process.argv[2];
const extensions = process.argv[3].split(",").map((value) => value.trim()).filter(Boolean);
const icu = ["1", "true", "yes"].includes(process.argv[4].toLowerCase());
const value = JSON.parse(fs.readFileSync(file, "utf8"));
const plugins = Array.isArray(value.expo?.plugins) ? value.expo.plugins : [];
value.expo.plugins = plugins.filter((entry) => {
  const name = Array.isArray(entry) ? entry[0] : entry;
  return name !== "@oliphaunt/react-native";
});
value.expo.plugins.push(["@oliphaunt/react-native", { extensions, icu }]);
fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
NODE
}

ensure_ios_project() {
  echo "Generating Expo iOS project and app-owned carrier payload for smoke validation"
  (
    cd "$example_dir"
    CI=1 EXPO_NO_TELEMETRY=1 npx expo prebuild --platform ios --no-install
  )
}

patch_podfile_for_installed_swift_podspecs() {
  local podfile="$example_dir/ios/Podfile"
  local podspecs_path="$example_dir/node_modules/@oliphaunt/react-native/ios/podspecs"
  [ -f "$podfile" ] || fail "missing generated iOS Podfile: $podfile"
  [ -f "$podspecs_path/COliphaunt.podspec" ] ||
    fail "missing installed React Native COliphaunt podspec shim: $podspecs_path/COliphaunt.podspec"
  [ -f "$podspecs_path/Oliphaunt.podspec" ] ||
    fail "missing installed React Native Oliphaunt podspec shim: $podspecs_path/Oliphaunt.podspec"
  ruby - "$podfile" <<'RUBY'
path = ARGV.fetch(0)
text = File.read(path)
block = <<~PODS
  # @oliphaunt/react-native begin
  oliphaunt_podspecs_path = File.expand_path('../node_modules/@oliphaunt/react-native/ios/podspecs', __dir__)
  pod 'COliphaunt', :podspec => File.join(oliphaunt_podspecs_path, 'COliphaunt.podspec'), :modular_headers => true
  pod 'Oliphaunt', :podspec => File.join(oliphaunt_podspecs_path, 'Oliphaunt.podspec')
  # @oliphaunt/react-native end
PODS
text = text.gsub(/^\s*# OLIPHAUNT_LOCAL_PODS_BEGIN\n.*?^\s*# OLIPHAUNT_LOCAL_PODS_END\n/m, "")
text = text.gsub(/^\s*# @oliphaunt\/react-native begin\n.*?^\s*# @oliphaunt\/react-native end\n/m, "")
unless text.sub!(/(target ['"]reactnativeoliphauntexpo['"] do\n)/, "\\1#{block}")
  abort "could not find reactnativeoliphauntexpo target in Podfile"
end
text.gsub!(
  /platform :ios, podfile_properties\['ios\.deploymentTarget'\] \|\| '[^']+'/,
  "platform :ios, podfile_properties['ios.deploymentTarget'] || '17.0'"
)
File.write(path, text)
RUBY
}

install_pods() {
  need_cmd pod
  if [ -z "${OLIPHAUNT_SWIFT_SDK_GIT_URL:-}" ]; then
    export OLIPHAUNT_SWIFT_SDK_GIT_URL="$root"
  fi
  if [ -z "${OLIPHAUNT_SWIFT_SDK_TAG:-}" ] &&
    [ -z "${OLIPHAUNT_SWIFT_SDK_BRANCH:-}" ] &&
    [ -z "${OLIPHAUNT_SWIFT_SDK_COMMIT:-}" ]; then
    export OLIPHAUNT_SWIFT_SDK_COMMIT="$(git rev-parse HEAD)"
  fi
  if [ "$expo_use_precompiled_modules" = "false" ]; then
    (
      cd "$example_dir/ios"
      OLIPHAUNT_LIBOLIPHAUNT_POD_MODE="$liboliphaunt_pod_mode" \
        USE_CCACHE="$use_ccache" \
        EXPO_USE_PRECOMPILED_MODULES="$expo_use_precompiled_modules" \
        pod install --repo-update
    )
  else
    (
      cd "$example_dir/ios"
      OLIPHAUNT_LIBOLIPHAUNT_POD_MODE="$liboliphaunt_pod_mode" \
        USE_CCACHE="$use_ccache" \
        EXPO_USE_PRECOMPILED_MODULES="$expo_use_precompiled_modules" \
        pod install
    )
  fi
}

patch_expo_modules_jsi_for_host_toolchain() {
  [ "${OLIPHAUNT_EXPO_IOS_PATCH_EXPO_JSI:-1}" = "1" ] || return 0

  local swift_version package_dir
  swift_version="$(xcrun swiftc -version 2>/dev/null || true)"
  case "$swift_version" in
    *"Swift version 6.2"*)
      ;;
    *)
      return 0
      ;;
  esac

  package_dir="$example_dir/node_modules/expo-modules-jsi/apple/Sources/ExpoModulesJSI"
  [ -d "$package_dir" ] || return 0
  find "$package_dir" -name '*.swift' -print0 |
    xargs -0 perl -pi -e 's/\b(nonisolated\(unsafe\)\s+)?weak\s+(let|var)\b/nonisolated(unsafe) weak var/g'
  echo "Patched ExpoModulesJSI weak references for local Swift 6.2 source builds" >&2
}

stamp_expo_modules_jsi_prebuilt() {
  [ "$expo_use_precompiled_modules" != "false" ] || return 0
  [ "${OLIPHAUNT_EXPO_IOS_REUSE_EXPO_JSI_PREBUILT:-1}" = "1" ] || return 0

  local package_dir="$example_dir/node_modules/expo-modules-jsi/apple"
  local pods_root="$example_dir/ios/Pods"
  local xcframework="$package_dir/Products/ExpoModulesJSI.xcframework"
  local simulator_binary="$xcframework/ios-arm64_x86_64-simulator/ExpoModulesJSI.framework/ExpoModulesJSI"
  [ -f "$simulator_binary" ] || return 0
  [ -x "$package_dir/scripts/generate-modulemap.sh" ] || return 0
  [ -f "$pods_root/Headers/Public/React-jsi/jsi/jsi.h" ] || return 0

  local pods_root_abs rn_root generated_module_map react_core_podspec
  pods_root_abs="$(cd "$pods_root" && pwd)"
  rn_root="$(cd "$example_dir/node_modules/react-native" && pwd)"
  PODS_ROOT="$pods_root_abs" RN_ROOT="$rn_root" "$package_dir/scripts/generate-modulemap.sh"
  generated_module_map="$package_dir/.generated/module.modulemap"
  react_core_podspec="$pods_root_abs/Local Podspecs/React-Core.podspec.json"

  local all_files current_hash
  all_files="$(
    find "$package_dir/Sources/ExpoModulesJSI" -type f
    find "$package_dir/Sources/ExpoModulesJSI-Cxx" -type f
    find "$package_dir/APINotes" -type f
    for file in \
      "$package_dir/Package.swift" \
      "$package_dir/scripts/build-xcframework.sh" \
      "$package_dir/scripts/create-stub-xcframework.sh" \
      "$package_dir/scripts/xcframework-helpers.sh" \
      "$pods_root_abs/Headers/Public/React-jsi/jsi/jsi.h" \
      "$pods_root_abs/Headers/Public/React-jsi/jsi/jsi-inl.h" \
      "$react_core_podspec" \
      "$generated_module_map"; do
      [ -f "$file" ] && printf '%s\n' "$file"
    done
  )"
  current_hash="$(
    {
      printf 'PODS_ROOT=%s\n' "$pods_root_abs"
      printf 'RN_ROOT=%s\n' "$rn_root"
      printf '%s\n' "$all_files" | LC_ALL=C sort | while IFS= read -r file; do
        printf '%s\n' "$file"
        cat "$file"
      done
    } | shasum -a 256 | awk '{print $1}'
  )"

  local slice
  for slice in "$xcframework"/*; do
    [ -d "$slice" ] || continue
    printf '%s\n' "$current_hash" >"$slice/.build-hash"
  done
  echo "Reusing ExpoModulesJSI prebuilt xcframework for local smoke validation: $current_hash" >&2
}

build_ios_app() {
  [ -d "$workspace" ] || fail "missing Xcode workspace: $workspace"
  if [ "${OLIPHAUNT_EXPO_IOS_CLEAN_BUILD:-0}" = "1" ]; then
    rm -rf "$derived_data"
  fi
  if [ -d "$derived_data/Build/Products" ]; then
    find "$derived_data/Build/Products" -name 'OliphauntReactNativeResources.bundle' -type d -prune -exec rm -rf {} +
  fi
  local xcode_log="$scratch_root/xcodebuild.log"
  local xcode_package_cache="$scratch_root/xcodebuild-package-cache"
  local xcode_source_packages="$scratch_root/xcodebuild-source-packages"
  local resolved_destination
  resolved_destination="$(resolve_xcode_destination)" ||
    fail "failed to resolve an available iOS simulator for xcodebuild"
  local build_settings=(
    USE_CCACHE="$use_ccache"
    EXPO_USE_PRECOMPILED_MODULES="$expo_use_precompiled_modules"
  )
  if [ -n "$code_signing_allowed" ]; then
    build_settings+=(CODE_SIGNING_ALLOWED="$code_signing_allowed")
  elif [ "$sdk" != "iphoneos" ]; then
    build_settings+=(CODE_SIGNING_ALLOWED=NO)
  fi
  if [ -n "$development_team" ]; then
    build_settings+=(DEVELOPMENT_TEAM="$development_team")
  fi
  if [ -n "$code_sign_style" ]; then
    build_settings+=(CODE_SIGN_STYLE="$code_sign_style")
  fi
  if [ -n "$code_sign_identity" ]; then
    build_settings+=(CODE_SIGN_IDENTITY="$code_sign_identity")
  fi
  if [ -n "$provisioning_profile_specifier" ]; then
    build_settings+=(PROVISIONING_PROFILE_SPECIFIER="$provisioning_profile_specifier")
  fi
  if [ "$sdk" = "iphonesimulator" ] && [ -z "$destination" ] && [ "$(uname -m)" = "arm64" ]; then
    build_settings+=(ONLY_ACTIVE_ARCH=YES ARCHS=arm64)
  fi
  local -a xcodebuild_flags
  xcodebuild_flags=()
  if is_truthy "$allow_provisioning_updates"; then
    xcodebuild_flags+=(-allowProvisioningUpdates)
  fi
  if is_truthy "$allow_device_registration"; then
    xcodebuild_flags+=(-allowProvisioningDeviceRegistration)
  fi
  local -a xcodebuild_command
  xcodebuild_command=(
    xcodebuild
    -workspace "$workspace"
    -scheme "$xcode_scheme"
    -configuration "$configuration"
    -sdk "$sdk"
    -destination "$resolved_destination"
    -derivedDataPath "$derived_data"
    -clonedSourcePackagesDirPath "$xcode_source_packages"
    -packageCachePath "$xcode_package_cache"
    -skipPackageUpdates
  )
  xcodebuild_command+=("${build_settings[@]}")
  if [ "${#xcodebuild_flags[@]}" -gt 0 ]; then
    xcodebuild_command+=("${xcodebuild_flags[@]}")
  fi
  xcodebuild_command+=(build)
  mkdir -p "$scratch_root" "$xcode_package_cache" "$xcode_source_packages"
  echo >&2
  printf '==>' >&2
  printf ' %q' "${xcodebuild_command[@]}" >&2
  printf '\n' >&2
  if ! "${xcodebuild_command[@]}" >"$xcode_log" 2>&1; then
    rg -n -C 40 "Could not resolve package dependencies" "$xcode_log" >&2 ||
      rg -n "error:|BUILD FAILED|The following build commands failed" "$xcode_log" | tail -160 >&2 ||
      tail -200 "$xcode_log" >&2
    fail "xcodebuild failed; full log: $xcode_log"
  fi
  rg -n "\\*\\* BUILD SUCCEEDED \\*\\*" "$xcode_log" >&2 || tail -40 "$xcode_log" >&2

  local app
  app="$(find "$derived_data/Build/Products" -path "*$configuration-*" -name '*.app' -type d | head -1)"
  [ -n "$app" ] || fail "xcodebuild succeeded but no .app was found under $derived_data"
  local resource_root="$app/OliphauntReactNativeResources.bundle/oliphaunt"
  [ -d "$resource_root" ] ||
    fail "iOS app is missing OliphauntReactNativeResources.bundle/oliphaunt resource root"
  echo "bundled: $resource_root ($(directory_files "$resource_root") files, $(directory_bytes "$resource_root") bytes)" >&2
  for required in \
    "$resource_root/template-pgdata/files/PG_VERSION" \
    "$resource_root/runtime/files/share/postgresql/postgres.bki"; do
    [ -e "$required" ] || fail "iOS app is missing packaged Oliphaunt resource: $required"
    echo "bundled: $required" >&2
  done
  if [ -e "$resource_root/lib/liboliphaunt.dylib" ]; then
    echo "bundled: $resource_root/lib/liboliphaunt.dylib" >&2
  fi
  local selected_extensions app_resource_files
  selected_extensions="$(normalize_mobile_extensions)"
  app_resource_files="$scratch_root/ios-resource-files.txt"
  find "$resource_root" -type f -print >"$app_resource_files"
  oliphaunt_dev_assert_runtime_file_list "$selected_extensions" "iOS" <"$app_resource_files"
  validate_ios_static_extension_linkage "$selected_extensions" "$xcode_log" "$resource_root" "$derived_data"
  printf '%s\n' "$app"
}

start_metro_if_needed() {
  local bundle_runner="${1:-$runner}"
  local bundle_root="${2:-}"
  mkdir -p "$scratch_root"
  mkdir -p "$(dirname "$metro_dev_log")"
  if [ -n "${metro_pid:-}" ] && kill -0 "$metro_pid" >/dev/null 2>&1; then
    if [ "$metro_bundle_runner" = "$bundle_runner" ] && [ "$metro_bundle_root" = "$bundle_root" ]; then
      return 0
    fi
    stop_owned_metro
  fi
  reserve_metro_port
  if port_is_listening; then
    if [ "$reuse_metro" = "1" ]; then
      echo "Reusing Metro on port $metro_port"
      return 0
    fi
    fail "Expo Metro port $metro_port is already in use; stop it, set OLIPHAUNT_EXPO_IOS_REUSE_METRO=1, or choose OLIPHAUNT_EXPO_IOS_METRO_PORT"
  else
    echo "Starting Expo Metro on port $metro_port for runner $bundle_runner"
    (
      cd "$example_dir"
      CI=1 EXPO_NO_TELEMETRY=1 EXPO_UNSTABLE_MCP_SERVER=1 \
      EXPO_PUBLIC_OLIPHAUNT_RUNNER="$bundle_runner" \
      EXPO_PUBLIC_OLIPHAUNT_LIFECYCLE_SMOKE="$lifecycle_smoke" \
      EXPO_PUBLIC_OLIPHAUNT_DURABILITY="$durability_profile" \
      EXPO_PUBLIC_OLIPHAUNT_RUNTIME_FOOTPRINT="$runtime_footprint" \
      EXPO_PUBLIC_OLIPHAUNT_BENCHMARK_PRESET="$benchmark_preset" \
      EXPO_PUBLIC_OLIPHAUNT_STARTUP_GUCS="$startup_gucs" \
      EXPO_PUBLIC_OLIPHAUNT_WAL_SEGSIZE_MB="$wal_segsize_mb" \
      EXPO_PUBLIC_OLIPHAUNT_ROOT="$bundle_root" \
      npx expo start --dev-client --port "$metro_port" --host lan --clear \
        >"$scratch_root/metro.log" 2>&1
    ) &
    metro_pid="$!"
    metro_bundle_runner="$bundle_runner"
    metro_bundle_root="$bundle_root"

    for _ in $(seq 1 60); do
      if port_is_listening; then
        break
      fi
      sleep 1
    done
  fi

  port_is_listening || {
    tail -80 "$scratch_root/metro.log" >&2 || true
    fail "Expo Metro did not start on port $metro_port"
  }

  if command -v curl >/dev/null 2>&1; then
    for _ in $(seq 1 60); do
      if curl -4 -fsS "http://127.0.0.1:$metro_port/status" 2>/dev/null | rg -q "packager-status:running"; then
        return
      fi
      sleep 1
    done
    tail -80 "$scratch_root/metro.log" >&2 || true
    fail "Expo Metro did not become ready on port $metro_port"
  fi

  return

  tail -80 "$scratch_root/metro.log" >&2 || true
  fail "Expo Metro did not start on port $metro_port"
}

write_ios_package_metrics() {
  local app_bytes="$1"
  local rn_package_bytes="$2"
  write_mobile_package_size_report iosAppBytes "$app_bytes" "$rn_package_bytes"
}

write_ios_build_artifact_report() {
  local app="$1"
  local selected_extensions="$2"
  local app_bytes rn_package_bytes app_copy report
  mkdir -p "$build_artifact_dir" "$scratch_root/reports"
  app_copy="$build_artifact_dir/$(basename "$app")"
  rm -rf "$app_copy"
  rsync -a --delete "$app/" "$app_copy/"
  app_bytes="$(directory_bytes "$app")"
  rn_package_bytes="$(wc -c <"$tarball" | tr -d '[:space:]')"
  report="$build_artifact_dir/build-report.json"
  write_mobile_build_artifact_report_json \
    "$report" \
    ios \
    "$app_copy" \
    "$app_bytes" \
    "$tarball" \
    "$rn_package_bytes" \
    "$selected_extensions" \
    "$scratch_root" \
    configuration "$configuration" \
    sdk "$sdk"
  cp "$report" "$scratch_root/reports/build-report.json"
  echo "iOS mobile build artifact: $app_copy"
  echo "iOS mobile build report: $report"
}

trap cleanup EXIT

main() {
  need_cmd node
  need_cmd xcrun
  if is_truthy "$e2e_only"; then
    local app
    app="$(resolve_prebuilt_ios_app)"
    install_and_launch "$app"
    local ios_app_bytes rn_package_bytes
    ios_app_bytes="$(directory_bytes "$app")"
    rn_package_bytes="$(file_bytes "$tarball")"
    write_ios_package_metrics "$ios_app_bytes" "$rn_package_bytes"
    exit 0
  fi
  need_cmd rg
  need_cmd ruby
  need_cmd rsync
  need_cmd pgrep
  need_cmd lsof
  need_cmd xcodebuild
  prepare_expo_example_workspace
  preflight_physical_ios_device
  if is_reuse_installed_physical_ios_app; then
    local device_id crash_root scratch_metro_offset dev_metro_offset
    device_id="$(select_ios_physical_device_id)" ||
      fail "failed to resolve a paired physical iOS device; set OLIPHAUNT_EXPO_IOS_DEVICE_ID"
    echo "Reusing installed iOS app $app_id on physical device: $device_id" >&2
    install_react_native_sdk_from_source_for_reuse
    if [ "$runner" = "crash" ]; then
      crash_root="$crash_root_override"
      [ -n "$crash_root" ] || crash_root="app-support://oliphaunt-crash-recovery-root-$crash_root_suffix"
      exercise_ios_device_crash_recovery "$device_id" "$crash_root"
      return
    fi
    if uses_ios_metro; then
      start_metro_if_needed "$runner"
    fi
    scratch_metro_offset="$(file_bytes "$scratch_root/metro.log")"
    dev_metro_offset="$(file_bytes "$metro_dev_log")"
    launch_ios_device_runner "$device_id" "$runner" >/dev/null ||
      fail "failed to launch Expo iOS $runner on physical device"
    wait_for_ios_device_runner "$device_id" "$scratch_metro_offset" "$dev_metro_offset" ||
      fail "timed out waiting for $success_tag from physical iOS device"
    return
  fi
  configure_iphoneos_signing
  local app
  pack_react_native_sdk
  configure_ios_carrier_inputs
  ensure_ios_project
  prepare_swift_sdk_artifact_git_repo_if_required
  patch_expo_modules_jsi_for_host_toolchain
  install_pods
  stamp_expo_modules_jsi_prebuilt
  app="$(build_ios_app)"
  local selected_extensions
  selected_extensions="$(normalize_mobile_extensions)"
  write_ios_build_artifact_report "$app" "$selected_extensions"
  if is_ios_build_only; then
    printf '\niOS build-only mobile artifact complete: %s\n' "$app"
    exit 0
  fi
  install_and_launch "$app"

  local ios_app_bytes rn_package_bytes
  ios_app_bytes="$(directory_bytes "$app")"
  rn_package_bytes="$(wc -c <"$tarball" | tr -d '[:space:]')"
  write_ios_package_metrics "$ios_app_bytes" "$rn_package_bytes"

  printf '\niOS app bytes: '
  printf '%s\n' "$ios_app_bytes"
  printf 'RN package bytes: '
  printf '%s' "$rn_package_bytes"
  printf '\n'
}

main "$@"
