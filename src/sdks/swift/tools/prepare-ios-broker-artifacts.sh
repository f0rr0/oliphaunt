#!/usr/bin/env bash
set -euo pipefail

script_path="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
root="$(git -C "$(dirname "$script_path")" rev-parse --show-toplevel 2>/dev/null)" || {
  echo "error: prepare-ios-broker-artifacts.sh must run inside the Oliphaunt checkout" >&2
  exit 1
}
cd "$root"

# Reuse the mobile runtime package contract rather than maintaining a second
# copy for the Swift spike. These files define template normalization, exact
# extension assets, static-registry metadata, and resource-tree validation.
. "$root/src/sdks/react-native/tools/expo-runner-common.sh"
. "$root/src/sdks/react-native/tools/expo-runner-workspace.sh"
. "$root/src/sdks/react-native/tools/mobile-extension-runtime.sh"
. "$root/src/sdks/react-native/tools/expo-runner-runtime-resources.sh"

selected_extensions="$(oliphaunt_dev_normalize_mobile_extensions "vector,pg_trgm" "iOS")"
static_extensions="$(oliphaunt_dev_mobile_static_extensions_for_selection "$selected_extensions")"
broker_database_role="oliphaunt_broker"
broker_database_name="postgres"
[ "$selected_extensions" = "vector,pg_trgm" ] || \
  fail "broker artifact selection drifted: $selected_extensions"
[ "$static_extensions" = "vector,pg_trgm" ] || \
  fail "broker static-extension selection drifted: $static_extensions"

artifact_platform="${OLIPHAUNT_IOS_BROKER_ARTIFACT_PLATFORM:-simulator}"
case "$artifact_platform" in
  simulator)
    default_artifact_root="$root/target/ios-native-broker-artifacts"
    ;;
  device)
    default_artifact_root="$root/target/ios-native-broker-device-artifacts"
    ;;
  *)
    fail "OLIPHAUNT_IOS_BROKER_ARTIFACT_PLATFORM must be simulator or device"
    ;;
esac

artifact_root_raw="${OLIPHAUNT_IOS_BROKER_ARTIFACT_ROOT:-$default_artifact_root}"
case "$artifact_root_raw" in
  /*) ;;
  *) artifact_root_raw="$root/$artifact_root_raw" ;;
esac
artifact_parent="$(dirname "$artifact_root_raw")"
artifact_name="$(basename "$artifact_root_raw")"
case "$artifact_name" in
  ''|.|..) fail "unsafe broker artifact root: $artifact_root_raw" ;;
esac
mkdir -p "$artifact_parent"
artifact_parent="$(cd "$artifact_parent" && pwd -P)"
artifact_root="$artifact_parent/$artifact_name"
case "$artifact_root" in
  /|"$root"|"$root/target") fail "refusing broad broker artifact root: $artifact_root" ;;
esac
[ ! -L "$artifact_root" ] || fail "broker artifact root must not be a symlink: $artifact_root"

work_root="$artifact_root/work"
logs_dir="$artifact_root/logs"
scratch_root="$work_root/runtime-package"
xcframework_out="$artifact_root/liboliphaunt.xcframework"
resources_out="$artifact_root/runtime-resources"
environment_out="$artifact_root/broker-artifacts.env"
manifest_out="$artifact_root/manifest.properties"
mkdir -p "$artifact_root" "$work_root" "$logs_dir" "$scratch_root/logs"
[ ! -L "$xcframework_out" ] || fail "XCFramework output must not be a symlink: $xcframework_out"
[ ! -L "$resources_out" ] || fail "runtime-resource output must not be a symlink: $resources_out"

for command_name in awk basename cp dirname find grep mkdir mktemp mv nm node otool \
  plutil rsync sed shasum sort tr wc xcodebuild xcrun; do
  need_cmd "$command_name"
done
if [ "$artifact_platform" = "device" ]; then
  need_cmd install_name_tool
fi
[ "$(uname -s)" = "Darwin" ] || fail "iOS broker artifacts require macOS"

case "$artifact_platform" in
  simulator)
    native_root="${OLIPHAUNT_IOS_SIMULATOR_ROOT:-$root/target/liboliphaunt-ios-simulator}"
    native_build_script="$root/src/runtimes/liboliphaunt/native/bin/build-postgres18-ios-simulator.sh"
    native_platform_name="iOS simulator"
    expected_library_platform="IOSSIMULATOR"
    manifest_platform="ios-simulator"
    check_log="$logs_dir/check-ios-simulator.log"
    build_log="$logs_dir/build-ios-simulator.log"
    ;;
  device)
    native_root="${OLIPHAUNT_IOS_DEVICE_ROOT:-$root/target/liboliphaunt-ios-device}"
    native_build_script="$root/src/runtimes/liboliphaunt/native/bin/build-postgres18-ios-device.sh"
    native_platform_name="iOS device"
    expected_library_platform="IOS"
    manifest_platform="ios-device"
    check_log="$logs_dir/check-ios-device.log"
    build_log="$logs_dir/build-ios-device.log"
    ;;
esac
native_dylib="${OLIPHAUNT_IOS_BROKER_DYLIB:-$native_root/out/liboliphaunt.dylib}"
static_registry_source="${OLIPHAUNT_IOS_BROKER_STATIC_REGISTRY_SOURCE:-$native_root/out/liboliphaunt_mobile_static_registry.c}"
minimum_ios="${OLIPHAUNT_IOS_BROKER_MIN_VERSION:-26.0}"
printf '%s\n' "$minimum_ios" | grep -Eq '^[0-9]+([.][0-9]+){0,2}$' || \
  fail "OLIPHAUNT_IOS_BROKER_MIN_VERSION must be a numeric iOS version"
allow_native_builds="${OLIPHAUNT_IOS_BROKER_ALLOW_NATIVE_BUILD:-1}"
case "$allow_native_builds" in
  1|true|TRUE|yes|YES|on|ON) allow_native_builds=1 ;;
  0|false|FALSE|no|NO|off|OFF) allow_native_builds=0 ;;
  *) fail "OLIPHAUNT_IOS_BROKER_ALLOW_NATIVE_BUILD must be boolean" ;;
esac

run_native_builder() {
  case "$artifact_platform" in
    simulator)
      env \
        OLIPHAUNT_IOS_SIMULATOR_ROOT="$native_root" \
        OLIPHAUNT_IOS_SIMULATOR_MIN_VERSION="$minimum_ios" \
        OLIPHAUNT_MOBILE_STATIC_EXTENSIONS="$static_extensions" \
        "$native_build_script" "$@"
      ;;
    device)
      env \
        OLIPHAUNT_IOS_DEVICE_ROOT="$native_root" \
        OLIPHAUNT_IOS_MIN_VERSION="$minimum_ios" \
        OLIPHAUNT_MOBILE_STATIC_EXTENSIONS="$static_extensions" \
        "$native_build_script" "$@"
      ;;
  esac
}

if [ "$native_dylib" = "$native_root/out/liboliphaunt.dylib" ]; then
  if ! run_native_builder --check-current >"$check_log" 2>&1; then
    [ "$allow_native_builds" = "1" ] || {
      tail -80 "$check_log" >&2 || true
      fail "$native_platform_name liboliphaunt is missing or stale and native builds are disabled"
    }
    echo "Preparing current $native_platform_name liboliphaunt (extensions=$static_extensions)..." >&2
    run_native_builder >"$build_log" 2>&1 || {
        tail -120 "$build_log" >&2 || true
        fail "failed to build $native_platform_name liboliphaunt"
      }
  fi
fi

[ -f "$native_dylib" ] || fail "missing $native_platform_name dylib: $native_dylib"
[ -f "$static_registry_source" ] || fail "missing mobile static registry: $static_registry_source"
library_platform="$(xcrun vtool -show-build "$native_dylib" 2>/dev/null | awk '/platform / { print $2; exit }')"
[ "$library_platform" = "$expected_library_platform" ] || \
  fail "liboliphaunt platform is $library_platform, expected $expected_library_platform"
case "$(otool -D "$native_dylib" 2>/dev/null)" in
  *"@rpath/liboliphaunt.dylib"*) ;;
  *) fail "$native_platform_name dylib has an unexpected install name: $native_dylib" ;;
esac
if [ "$artifact_platform" = "device" ]; then
  native_install_name="$(otool -D "$native_dylib" 2>/dev/null | sed -n '2{s/^[[:space:]]*//;s/[[:space:]]*$//;p;}')"
  [ "$native_install_name" = "@rpath/liboliphaunt.dylib" ] || \
    fail "iOS device dylib has an unexpected install name: $native_install_name"
  native_architectures="$(xcrun lipo -archs "$native_dylib" 2>/dev/null)"
  [ "$native_architectures" = "arm64" ] || \
    fail "iOS device dylib architectures are $native_architectures, expected arm64"
  native_minimum_ios="$(xcrun vtool -show-build "$native_dylib" 2>/dev/null | awk '/minos / { print $2; exit }')"
  [ "$native_minimum_ios" = "$minimum_ios" ] || \
    fail "iOS device dylib minimum OS is $native_minimum_ios, expected $minimum_ios"
fi

library_symbols="$(nm -g "$native_dylib" 2>/dev/null)"
case "$library_symbols" in
  *"_liboliphaunt_selected_static_extensions"*) ;;
  *) fail "$native_platform_name dylib has no selected-static-extension registry" ;;
esac
for extension in vector pg_trgm; do
  module_stem="$(oliphaunt_mobile_static_extension_module_stem "$extension")"
  symbol_prefix="$(oliphaunt_static_symbol_prefix "$module_stem")"
  case "$library_symbols" in
    *"_${symbol_prefix}_Pg_magic_func"*) ;;
    *) fail "$native_platform_name dylib is missing static $extension symbols" ;;
  esac
done

native_headers="$root/src/runtimes/liboliphaunt/native/include"
[ -f "$native_headers/oliphaunt.h" ] || fail "missing public native header"
xcframework_stage="$(mktemp -d "$work_root/xcframework.XXXXXX")"
broker_template_source=""
broker_template_socket_dir=""
broker_template_pg_ctl=""
broker_template_server_started=0
cleanup_stage() {
  if [ "$broker_template_server_started" = "1" ] &&
    [ -n "$broker_template_pg_ctl" ] &&
    [ -n "$broker_template_source" ]; then
    "$broker_template_pg_ctl" -D "$broker_template_source" -m immediate stop >/dev/null 2>&1 || true
  fi
  rm -rf "$xcframework_stage"
  if [ -n "$broker_template_socket_dir" ]; then
    rm -rf "$broker_template_socket_dir"
  fi
}
trap cleanup_stage EXIT INT TERM

validate_device_framework() {
  local framework="$1"
  local binary="$framework/liboliphaunt"
  local framework_platform framework_architectures framework_install_name framework_minimum_ios
  [ -d "$framework" ] || fail "missing iOS device framework: $framework"
  [ -f "$framework/Info.plist" ] || fail "iOS device framework is missing Info.plist"
  [ -f "$framework/Headers/oliphaunt.h" ] || fail "iOS device framework is missing oliphaunt.h"
  [ -f "$framework/Modules/module.modulemap" ] || fail "iOS device framework is missing its module map"
  [ -f "$binary" ] || fail "iOS device framework is missing its executable"
  plutil -lint "$framework/Info.plist" >/dev/null || \
    fail "iOS device framework has an invalid Info.plist"
  [ "$(plutil -extract CFBundleExecutable raw -o - "$framework/Info.plist")" = "liboliphaunt" ] || \
    fail "iOS device framework has an unexpected CFBundleExecutable"
  [ "$(plutil -extract CFBundlePackageType raw -o - "$framework/Info.plist")" = "FMWK" ] || \
    fail "iOS device framework has an unexpected CFBundlePackageType"
  [ "$(plutil -extract CFBundleSupportedPlatforms.0 raw -o - "$framework/Info.plist")" = "iPhoneOS" ] || \
    fail "iOS device framework has an unexpected supported platform"
  [ "$(plutil -extract MinimumOSVersion raw -o - "$framework/Info.plist")" = "$minimum_ios" ] || \
    fail "iOS device framework has an unexpected minimum OS version"
  framework_platform="$(xcrun vtool -show-build "$binary" 2>/dev/null | awk '/platform / { print $2; exit }')"
  [ "$framework_platform" = "IOS" ] || \
    fail "iOS device framework binary platform is $framework_platform, expected IOS"
  framework_minimum_ios="$(xcrun vtool -show-build "$binary" 2>/dev/null | awk '/minos / { print $2; exit }')"
  [ "$framework_minimum_ios" = "$minimum_ios" ] || \
    fail "iOS device framework binary minimum OS is $framework_minimum_ios, expected $minimum_ios"
  framework_architectures="$(xcrun lipo -archs "$binary" 2>/dev/null)"
  [ "$framework_architectures" = "arm64" ] || \
    fail "iOS device framework binary architectures are $framework_architectures, expected arm64"
  framework_install_name="$(otool -D "$binary" 2>/dev/null | sed -n '2{s/^[[:space:]]*//;s/[[:space:]]*$//;p;}')"
  [ "$framework_install_name" = "@rpath/liboliphaunt.framework/liboliphaunt" ] || \
    fail "iOS device framework has an unexpected install name: $framework_install_name"
}

case "$artifact_platform" in
  simulator)
    echo "Creating simulator-only liboliphaunt XCFramework..." >&2
    xcodebuild -create-xcframework \
      -library "$native_dylib" \
      -headers "$native_headers" \
      -output "$xcframework_stage/liboliphaunt.xcframework" \
      >"$logs_dir/create-xcframework.log" 2>&1 || {
        tail -120 "$logs_dir/create-xcframework.log" >&2 || true
        fail "failed to create simulator liboliphaunt XCFramework"
      }
    ;;
  device)
    runtime_version_file="$root/src/runtimes/liboliphaunt/native/VERSION"
    [ -f "$runtime_version_file" ] || fail "missing liboliphaunt version file"
    runtime_version="$(tr -d '\r\n' <"$runtime_version_file")"
    printf '%s\n' "$runtime_version" | grep -Eq '^(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)$' || \
      fail "liboliphaunt VERSION must be stable x.y.z, got: $runtime_version"
    device_framework="$xcframework_stage/liboliphaunt.framework"
    mkdir -p "$device_framework/Headers" "$device_framework/Modules"
    cp "$native_dylib" "$device_framework/liboliphaunt"
    install_name_tool -id \
      "@rpath/liboliphaunt.framework/liboliphaunt" \
      "$device_framework/liboliphaunt"
    rsync -a --delete "$native_headers/" "$device_framework/Headers/"
    cat >"$device_framework/Modules/module.modulemap" <<'MODULEMAP'
framework module liboliphaunt {
  umbrella header "oliphaunt.h"
  export *
  module * { export * }
}
MODULEMAP
    cat >"$device_framework/Info.plist" <<FRAMEWORK_PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>liboliphaunt</string>
  <key>CFBundleIdentifier</key>
  <string>dev.oliphaunt.liboliphaunt</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>liboliphaunt</string>
  <key>CFBundlePackageType</key>
  <string>FMWK</string>
  <key>CFBundleShortVersionString</key>
  <string>$runtime_version</string>
  <key>CFBundleSupportedPlatforms</key>
  <array>
    <string>iPhoneOS</string>
  </array>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>MinimumOSVersion</key>
  <string>$minimum_ios</string>
  <key>UIDeviceFamily</key>
  <array>
    <integer>1</integer>
  </array>
</dict>
</plist>
FRAMEWORK_PLIST
    validate_device_framework "$device_framework"
    echo "Creating device-only liboliphaunt XCFramework..." >&2
    xcodebuild -create-xcframework \
      -framework "$device_framework" \
      -output "$xcframework_stage/liboliphaunt.xcframework" \
      >"$logs_dir/create-xcframework.log" 2>&1 || {
        tail -120 "$logs_dir/create-xcframework.log" >&2 || true
        fail "failed to create device liboliphaunt XCFramework"
      }
    ;;
esac
rm -rf "$xcframework_out"
mv "$xcframework_stage/liboliphaunt.xcframework" "$xcframework_out"

xcframework_info="$xcframework_out/Info.plist"
[ -f "$xcframework_info" ] || fail "XCFramework is missing Info.plist"
slice_identifier="$(plutil -extract AvailableLibraries.0.LibraryIdentifier raw -o - "$xcframework_info")"
slice_platform="$(plutil -extract AvailableLibraries.0.SupportedPlatform raw -o - "$xcframework_info")"
slice_variant="$(plutil -extract AvailableLibraries.0.SupportedPlatformVariant raw -o - "$xcframework_info" 2>/dev/null || true)"
slice_architecture="$(plutil -extract AvailableLibraries.0.SupportedArchitectures.0 raw -o - "$xcframework_info")"
slice_library_path="$(plutil -extract AvailableLibraries.0.LibraryPath raw -o - "$xcframework_info")"
case "$artifact_platform" in
  simulator)
    [ "$slice_platform:$slice_variant:$slice_architecture" = "ios:simulator:arm64" ] || \
      fail "unexpected XCFramework slice: $slice_platform/$slice_variant/$slice_architecture"
    ;;
  device)
    [ "$slice_platform:$slice_variant:$slice_architecture" = "ios::arm64" ] || \
      fail "unexpected XCFramework slice: $slice_platform/${slice_variant:-none}/$slice_architecture"
    if plutil -extract AvailableLibraries.0.SupportedArchitectures.1 raw -o - \
      "$xcframework_info" >/dev/null 2>&1; then
      fail "iOS device XCFramework unexpectedly contains multiple architectures"
    fi
    [ "$slice_library_path" = "liboliphaunt.framework" ] || \
      fail "iOS device XCFramework must contain liboliphaunt.framework, got: $slice_library_path"
    ;;
esac
if plutil -extract AvailableLibraries.1.LibraryIdentifier raw -o - "$xcframework_info" >/dev/null 2>&1; then
  fail "$artifact_platform broker XCFramework unexpectedly contains multiple slices"
fi
case "$artifact_platform" in
  simulator)
    packaged_native_library="$xcframework_out/$slice_identifier/$slice_library_path"
    [ -f "$packaged_native_library" ] || \
      fail "XCFramework dylib is missing: $packaged_native_library"
    [ "$(shasum -a 256 "$packaged_native_library" | awk '{ print $1 }')" = \
      "$(shasum -a 256 "$native_dylib" | awk '{ print $1 }')" ] || \
      fail "XCFramework dylib differs from the validated simulator artifact"
    ;;
  device)
    packaged_framework="$xcframework_out/$slice_identifier/$slice_library_path"
    validate_device_framework "$packaged_framework"
    packaged_native_library="$packaged_framework/liboliphaunt"
    [ "$(shasum -a 256 "$packaged_native_library" | awk '{ print $1 }')" = \
      "$(shasum -a 256 "$device_framework/liboliphaunt" | awk '{ print $1 }')" ] || \
      fail "XCFramework framework binary differs from the validated device artifact"
    ;;
esac

runtime_source="${OLIPHAUNT_IOS_BROKER_RUNTIME_DIR:-}"
if [ -z "$runtime_source" ]; then
  export OLIPHAUNT_EXPO_ALLOW_NATIVE_BUILDS="$allow_native_builds"
  runtime_source="$(ensure_host_runtime_assets)"
fi
[ -f "$runtime_source/share/postgresql/postgres.bki" ] || \
  fail "runtime source is missing postgres.bki: $runtime_source"

mobile_postgres_build_dir="${OLIPHAUNT_IOS_BROKER_POSTGRES_SOURCE_DIR:-}"
if [ -z "$mobile_postgres_build_dir" ]; then
  for candidate in \
    "$native_root/postgresql-18.4" \
    "$(host_runtime_work_root)/postgresql-18.4"; do
    if [ -d "$candidate/contrib/pg_trgm" ]; then
      mobile_postgres_build_dir="$candidate"
      break
    fi
  done
fi
[ -d "$mobile_postgres_build_dir/contrib/pg_trgm" ] || \
  fail "missing pinned PostgreSQL 18.4 source tree for pg_trgm resources"
export OLIPHAUNT_MOBILE_POSTGRES_BUILD_DIR="$mobile_postgres_build_dir"

mobile_template_initdb="${OLIPHAUNT_IOS_BROKER_INITDB:-$runtime_source/bin/initdb}"
[ -x "$mobile_template_initdb" ] || fail "missing PostgreSQL 18 initdb: $mobile_template_initdb"
initdb_version="$($mobile_template_initdb --version 2>/dev/null || true)"
case "$initdb_version" in
  *" 18.4"*) ;;
  *) fail "broker template requires PostgreSQL 18.4 initdb, got: $initdb_version" ;;
esac

wal_segsize_mb="${OLIPHAUNT_IOS_BROKER_WAL_SEGSIZE_MB:-16}"
case "$wal_segsize_mb" in
  ''|*[!0-9]*) fail "OLIPHAUNT_IOS_BROKER_WAL_SEGSIZE_MB must be an integer" ;;
esac
template_source="$(
  find_latest_mobile_pgdata \
    iOS \
    "${OLIPHAUNT_IOS_BROKER_TEMPLATE_PGDATA_DIR:-}" \
    OLIPHAUNT_IOS_BROKER_TEMPLATE_PGDATA_DIR \
    OLIPHAUNT_IOS_BROKER_INITDB
)"
[ "$(tr -d '\r\n' <"$template_source/PG_VERSION")" = "18" ] || \
  fail "broker template PGDATA is not PostgreSQL 18: $template_source"

# Seed a non-bootstrap login for the extension worker. WorkerCore uses this
# role only while no host data channel exists: it installs the selected static
# extensions, grants its narrow checkpoint capability, and permanently drops
# SUPERUSER before Ready. PostgreSQL refuses to demote initdb's bootstrap role,
# so authenticating the host-visible session as postgres cannot satisfy the
# broker's PGDATA-confidentiality boundary.
for broker_template_tool in pg_ctl psql; do
  [ -x "$runtime_source/bin/$broker_template_tool" ] || \
    fail "broker template role provisioning requires $runtime_source/bin/$broker_template_tool"
done
broker_template_source="$work_root/broker-template-pgdata"
case "$broker_template_source" in
  "$template_source") fail "broker template staging path overlaps its source" ;;
esac
rm -rf "$broker_template_source"
mkdir -p "$broker_template_source"
rsync -a --delete \
  --exclude postmaster.pid \
  --exclude postmaster.opts \
  --exclude 'pg_stat_tmp/*' \
  "$template_source/" "$broker_template_source/"
rm -f "$broker_template_source/postmaster.pid" "$broker_template_source/postmaster.opts"
normalize_template_pgdata "$broker_template_source"

broker_template_socket_dir="$(mktemp -d /tmp/oliphaunt-broker-template.XXXXXX)"
chmod 700 "$broker_template_socket_dir"
broker_template_pg_ctl="$runtime_source/bin/pg_ctl"
broker_template_log="$logs_dir/prepare-broker-template.log"
broker_template_control_log="$logs_dir/prepare-broker-template-control.log"
"$broker_template_pg_ctl" \
  -D "$broker_template_source" \
  -l "$broker_template_log" \
  -o "-k $broker_template_socket_dir -h ''" \
  -w start >"$broker_template_control_log" 2>&1 || {
    tail -120 "$broker_template_control_log" >&2 || true
    tail -120 "$broker_template_log" >&2 || true
    fail "failed to start broker template PostgreSQL for role provisioning"
  }
broker_template_server_started=1
broker_template_psql=(
  "$runtime_source/bin/psql"
  -X
  -A
  -t
  -F '|'
  -v ON_ERROR_STOP=1
  -h "$broker_template_socket_dir"
  -U postgres
  -d "$broker_database_name"
)
broker_role_state="$(
  "${broker_template_psql[@]}" -c \
    "SELECT rolsuper, rolcanlogin FROM pg_roles WHERE rolname = '$broker_database_role'"
)"
if [ -z "$broker_role_state" ]; then
  "${broker_template_psql[@]}" -c \
    "CREATE ROLE $broker_database_role LOGIN SUPERUSER" >/dev/null
  broker_role_state="$(
    "${broker_template_psql[@]}" -c \
      "SELECT rolsuper, rolcanlogin FROM pg_roles WHERE rolname = '$broker_database_role'"
  )"
fi
[ "$broker_role_state" = "t|t" ] || \
  fail "broker template role must be a login superuser before first WorkerCore open"
"${broker_template_psql[@]}" -c \
  "ALTER ROLE $broker_database_role SET search_path TO \"\$user\", public" >/dev/null
[ "$(
  "${broker_template_psql[@]}" -c \
    "SELECT rolconfig @> ARRAY['search_path=\"\$user\", public'] FROM pg_roles WHERE rolname = '$broker_database_role'"
)" = "t" ] || fail "broker template role lost its durable restricted search_path"
[ "$(
  "${broker_template_psql[@]}" -c \
    "SELECT rolsuper FROM pg_roles WHERE rolname = 'postgres'"
)" = "t" ] || fail "broker template lost its inaccessible bootstrap superuser"
"$broker_template_pg_ctl" -D "$broker_template_source" -m fast -w stop \
  >>"$broker_template_control_log" 2>&1 || {
    tail -120 "$broker_template_control_log" >&2 || true
    tail -120 "$broker_template_log" >&2 || true
    fail "failed to stop broker template PostgreSQL after role provisioning"
  }
broker_template_server_started=0
rm -rf "$broker_template_socket_dir"
broker_template_socket_dir=""
normalize_template_pgdata "$broker_template_source"
template_source="$broker_template_source"

echo "Preparing validated mobile runtime resources (extensions=$selected_extensions)..." >&2
prepare_mobile_runtime_resource_package \
  iOS \
  "$runtime_source" \
  "$template_source" \
  "$static_registry_source" \
  "$selected_extensions" \
  "${OLIPHAUNT_IOS_BROKER_REPACKAGE_RESOURCES:-0}" \
  "$resources_out" \
  >"$logs_dir/prepare-runtime-resources.log"

runtime_manifest="$resources_out/oliphaunt/runtime/manifest.properties"
template_manifest="$resources_out/oliphaunt/template-pgdata/manifest.properties"
static_manifest="$resources_out/oliphaunt/static-registry/manifest.properties"
runtime_files="$resources_out/oliphaunt/runtime/files"
template_files="$resources_out/oliphaunt/template-pgdata/files"
for required_file in \
  "$runtime_manifest" \
  "$template_manifest" \
  "$static_manifest" \
  "$runtime_files/share/postgresql/postgres.bki" \
  "$runtime_files/share/postgresql/extension/vector.control" \
  "$runtime_files/share/postgresql/extension/pg_trgm.control" \
  "$resources_out/oliphaunt/static-registry/oliphaunt_static_registry.c" \
  "$template_files/PG_VERSION"; do
  [ -f "$required_file" ] || fail "prepared broker resource is missing: $required_file"
done
case "$(grep '^brokerDatabaseRole=' "$template_manifest" 2>/dev/null || true)" in
  '') printf 'brokerDatabaseRole=%s\n' "$broker_database_role" >>"$template_manifest" ;;
  "brokerDatabaseRole=$broker_database_role") ;;
  *) fail "prepared broker template manifest has an unexpected database role" ;;
esac
grep -Fqx "brokerDatabaseRole=$broker_database_role" "$template_manifest" || \
  fail "prepared broker template manifest omitted its restricted database role"
for extension in vector pg_trgm; do
  find "$runtime_files/share/postgresql/extension" -maxdepth 1 -type f \
    -name "$extension--*.sql" -print -quit | grep -q . || \
    fail "prepared broker resources are missing $extension SQL"
done
[ -f "$runtime_files/share/postgresql/extension/pg_trgm--1.3.sql" ] || \
  fail "prepared broker resources are missing an installable pg_trgm base version"
if grep -Eiq \
  '^[[:space:]]*(CREATE[[:space:]]+EXTENSION[[:space:]]+pg_trgm|\\copy([[:space:]]|$))' \
  "$runtime_files"/share/postgresql/extension/pg_trgm--*.sql; then
  fail "prepared broker resources contain the pg_trgm regression script instead of extension install SQL"
fi
grep -Fqx "selectedExtensions=pg_trgm,vector" "$runtime_manifest" || \
  fail "runtime manifest did not preserve exact extension selection"
grep -Fqx "registeredExtensions=$selected_extensions" "$static_manifest" || \
  fail "static registry did not preserve exact extension selection"
grep -Fqx "nativeModuleStems=vector,pg_trgm" "$static_manifest" || \
  fail "static registry did not preserve exact native-module stems"
if find "$resources_out/oliphaunt" -type f \( -name '*.dylib' -o -name '*.so' \) -print -quit | grep -q .; then
  fail "broker runtime resources unexpectedly contain dynamic extension modules"
fi

xcframework_sha256="$(directory_fingerprint "$xcframework_out")"
resources_sha256="$(directory_fingerprint "$resources_out/oliphaunt")"
dylib_sha256="$(shasum -a 256 "$native_dylib" | awk '{ print $1 }')"
initdb_sha256="$(shasum -a 256 "$mobile_template_initdb" | awk '{ print $1 }')"
cat >"$manifest_out" <<MANIFEST
schema=oliphaunt-ios-broker-artifacts-v1
platform=$manifest_platform
architecture=arm64
minimumOS=$minimum_ios
postgresVersion=18.4
selectedExtensions=$selected_extensions
nativeModuleStems=vector,pg_trgm
brokerDatabaseRole=$broker_database_role
dylibSHA256=$dylib_sha256
xcframeworkSHA256=$xcframework_sha256
resourcesSHA256=$resources_sha256
initdbSHA256=$initdb_sha256
runtimeSource=$runtime_source
templateSource=$template_source
xcframework=$xcframework_out
resources=$resources_out
MANIFEST
printf 'export OLIPHAUNT_IOS_BROKER_XCFRAMEWORK=%q\n' "$xcframework_out" >"$environment_out"
printf 'export OLIPHAUNT_IOS_BROKER_RESOURCES=%q\n' "$resources_out" >>"$environment_out"
if [ "$artifact_platform" = "device" ]; then
  printf 'export OLIPHAUNT_IOS_BROKER_ARTIFACT_PLATFORM=device\n' >>"$environment_out"
fi

trap - EXIT INT TERM
cleanup_stage
printf 'OLIPHAUNT_IOS_BROKER_ARTIFACTS_PASS xcframework=%s resources=%s env=%s manifest=%s\n' \
  "$xcframework_out" "$resources_out" "$environment_out" "$manifest_out"
