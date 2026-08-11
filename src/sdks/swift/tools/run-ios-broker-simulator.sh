#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
default_repo_root="$(cd "$script_dir/../../../.." && pwd)"
repo_root="${OLIPHAUNT_REPO_ROOT:-$default_repo_root}"

absolute_path() {
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    *) printf '%s/%s\n' "$repo_root" "$1" ;;
  esac
}

fixture_root="$(absolute_path "${OLIPHAUNT_IOS_BROKER_FIXTURE_ROOT:-spikes/ios-native-broker}")"
generator="$(absolute_path "${OLIPHAUNT_IOS_BROKER_PROJECT_GENERATOR:-$fixture_root/generate_project.rb}")"
build_root="$(absolute_path "${OLIPHAUNT_IOS_BROKER_BUILD_ROOT:-target/ios-native-broker-spike}")"
derived_data="$(absolute_path "${OLIPHAUNT_IOS_BROKER_DERIVED_DATA:-$build_root/DerivedData}")"
logs_dir="$(absolute_path "${OLIPHAUNT_IOS_BROKER_LOGS_DIR:-$build_root/logs}")"
reports_dir="$(absolute_path "${OLIPHAUNT_IOS_BROKER_REPORTS_DIR:-$build_root/reports}")"
artifact_root="$(absolute_path "${OLIPHAUNT_IOS_BROKER_ARTIFACT_ROOT:-target/ios-native-broker-artifacts}")"
artifact_preparer="$(absolute_path "${OLIPHAUNT_IOS_BROKER_ARTIFACT_PREPARER:-$script_dir/prepare-ios-broker-artifacts.sh}")"
artifact_environment="$(absolute_path "${OLIPHAUNT_IOS_BROKER_ARTIFACT_ENV:-$artifact_root/broker-artifacts.env}")"
storage_quarantine_helper="$(absolute_path "${OLIPHAUNT_IOS_BROKER_STORAGE_QUARANTINE_HELPER:-$script_dir/quarantine-ios-broker-simulator-storage.sh}")"

scheme="${OLIPHAUNT_IOS_BROKER_SCHEME:-OliphauntBrokerSpike}"
configuration="${OLIPHAUNT_IOS_BROKER_CONFIGURATION:-Debug}"
app_product_name="${OLIPHAUNT_IOS_BROKER_APP_PRODUCT_NAME:-OliphauntBrokerSpike}"
extension_product_name="${OLIPHAUNT_IOS_BROKER_EXTENSION_PRODUCT_NAME:-BrokerAppExtension}"
app_bundle_id="${OLIPHAUNT_IOS_BROKER_BUNDLE_ID:-dev.oliphaunt.brokerspike}"
extension_bundle_id="${OLIPHAUNT_IOS_BROKER_EXTENSION_BUNDLE_ID:-dev.oliphaunt.brokerspike.extension}"
requested_udid="${OLIPHAUNT_IOS_BROKER_SIMULATOR_UDID:-}"
requested_device_name="${OLIPHAUNT_IOS_BROKER_SIMULATOR_NAME:-iPhone 17 Pro}"
requested_runtime="${OLIPHAUNT_IOS_BROKER_SIMULATOR_RUNTIME:-}"
minimum_ios_major="${OLIPHAUNT_IOS_BROKER_MIN_IOS_MAJOR:-26}"
timeout_seconds="${OLIPHAUNT_IOS_BROKER_TIMEOUT_SECONDS:-120}"
code_signing_allowed="${OLIPHAUNT_IOS_BROKER_CODE_SIGNING_ALLOWED:-YES}"
terminate_after_run="${OLIPHAUNT_IOS_BROKER_TERMINATE_AFTER_RUN:-YES}"
uninstall_after_run="${OLIPHAUNT_IOS_BROKER_UNINSTALL_AFTER_RUN:-NO}"
log_capture_startup_seconds="${OLIPHAUNT_IOS_BROKER_LOG_CAPTURE_STARTUP_SECONDS:-1}"
prepare_artifacts="${OLIPHAUNT_IOS_BROKER_PREPARE_ARTIFACTS:-YES}"
reset_simulator_storage="${OLIPHAUNT_IOS_BROKER_RESET_SIMULATOR_STORAGE:-NO}"
fixture_mode="${OLIPHAUNT_BROKER_FIXTURE_MODE:-semantic}"

success_marker="OLIPHAUNT_BROKER_SPIKE PASS"
failure_marker="OLIPHAUNT_BROKER_SPIKE FAIL"
app_report_name="broker-spike-report.json"
app_report_path="$(absolute_path "${OLIPHAUNT_IOS_BROKER_APP_REPORT_PATH:-$reports_dir/$app_report_name}")"
runner_report_path="$(absolute_path "${OLIPHAUNT_IOS_BROKER_RUNNER_REPORT_PATH:-$reports_dir/runner-report.json}")"

generator_log="$logs_dir/generate-project.log"
build_log="$logs_dir/xcodebuild.log"
boot_log="$logs_dir/simulator-boot.log"
install_log="$logs_dir/simctl-install.log"
launch_log="$logs_dir/simctl-launch.log"
app_stdout_log="$logs_dir/app-stdout.log"
app_stderr_log="$logs_dir/app-stderr.log"
unified_stream_log="$logs_dir/simulator-unified-stream.log"
unified_snapshot_log="$logs_dir/simulator-unified-snapshot.log"
report_validation_log="$logs_dir/report-validation.log"
artifact_preparation_log="$logs_dir/prepare-broker-artifacts.log"
artifact_validation_file="$reports_dir/broker-artifacts.txt"
embedded_extensions_file="$reports_dir/embedded-extensions.txt"
installed_extensions_file="$reports_dir/installed-extensions.txt"
host_linkage_file="$reports_dir/host-otool.txt"
extension_linkage_file="$reports_dir/extension-otool.txt"
extension_symbols_file="$reports_dir/extension-symbols.txt"
embedded_native_file="$reports_dir/embedded-native-library.txt"
extension_resources_file="$reports_dir/extension-resource-checks.txt"
pass_marker_file="$reports_dir/pass-marker.txt"
simulator_inventory="$reports_dir/simulators.json"
storage_reset_file="$reports_dir/simulator-storage-reset.txt"

selected_udid=""
selected_name=""
selected_runtime=""
selected_state=""
host_executable=""
extension_executable=""
embedded_native_library=""
log_predicate=""
log_start_time=""
log_stream_pid=""
failure_reason=""

fail() {
  failure_reason="$*"
  printf 'error: %s\n' "$failure_reason" >&2
  exit 1
}

need_command() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

normalize_yes_no() {
  case "$1" in
    1|YES|yes|TRUE|true|ON|on) printf 'YES\n' ;;
    0|NO|no|FALSE|false|OFF|off) printf 'NO\n' ;;
    *) fail "$2 must be YES or NO, got: $1" ;;
  esac
}

safe_bundle_identifier() {
  case "$1" in
    ''|*[!A-Za-z0-9.-]*) return 1 ;;
    *) return 0 ;;
  esac
}

safe_process_name() {
  case "$1" in
    ''|*[!A-Za-z0-9._-]*) return 1 ;;
    *) return 0 ;;
  esac
}

safe_build_name() {
  case "$1" in
    ''|.|..|*/*|*$'\n'*|*$'\r'*) return 1 ;;
    *) return 0 ;;
  esac
}

validate_broker_artifacts() {
  local xcframework="${OLIPHAUNT_IOS_BROKER_XCFRAMEWORK:-}"
  local resources="${OLIPHAUNT_IOS_BROKER_RESOURCES:-}"
  [ -n "$xcframework" ] || fail "OLIPHAUNT_IOS_BROKER_XCFRAMEWORK is not set"
  [ -n "$resources" ] || fail "OLIPHAUNT_IOS_BROKER_RESOURCES is not set"
  xcframework="$(absolute_path "$xcframework")"
  resources="$(absolute_path "$resources")"
  [ -d "$xcframework" ] || fail "broker XCFramework is missing: $xcframework"
  [ -f "$xcframework/Info.plist" ] || fail "broker XCFramework has no Info.plist: $xcframework"
  [ -d "$resources/oliphaunt" ] || fail "broker resources do not contain oliphaunt/: $resources"

  local simulator_library_metadata slice_identifier slice_library_path slice_product native_library
  simulator_library_metadata="$(
    plutil -convert json -o - "$xcframework/Info.plist" |
      ruby -rjson -e '
        libraries = JSON.parse(STDIN.read).fetch("AvailableLibraries")
        slice = libraries.find do |library|
          library["SupportedPlatform"] == "ios" &&
            library["SupportedPlatformVariant"] == "simulator" &&
            Array(library["SupportedArchitectures"]).include?("arm64")
        end
        abort("missing arm64 iOS simulator slice") unless slice
        puts [slice.fetch("LibraryIdentifier"), slice.fetch("LibraryPath")].join("\t")
      '
  )" || fail "broker XCFramework has no arm64 iOS simulator slice"
  IFS=$'\t' read -r slice_identifier slice_library_path <<EOF
$simulator_library_metadata
EOF
  slice_product="$xcframework/$slice_identifier/$slice_library_path"
  case "$slice_library_path" in
    *.framework)
      [ -f "$slice_product/Info.plist" ] || fail "broker framework slice has no Info.plist: $slice_product"
      local framework_executable
      framework_executable="$(plutil -extract CFBundleExecutable raw -o - "$slice_product/Info.plist" 2>/dev/null || true)"
      [ -n "$framework_executable" ] || fail "broker framework slice has no executable name: $slice_product"
      native_library="$slice_product/$framework_executable"
      ;;
    *) native_library="$slice_product" ;;
  esac
  [ -f "$native_library" ] || fail "broker simulator native library is missing: $native_library"
  [ "$(xcrun vtool -show-build "$native_library" 2>/dev/null | awk '/platform / { print $2; exit }')" = "IOSSIMULATOR" ] || \
    fail "broker XCFramework selected a non-simulator native library: $native_library"
  local native_symbols required_symbol
  native_symbols="$(nm -g "$native_library" 2>/dev/null)"
  case "$native_symbols" in
    *"_liboliphaunt_selected_static_extensions"*) ;;
    *) fail "broker simulator library does not contain its static-extension registry" ;;
  esac
  for required_symbol in _oliphaunt_static_vector_Pg_magic_func _oliphaunt_static_pg_trgm_Pg_magic_func; do
    case "$native_symbols" in
      *"$required_symbol"*) ;;
      *) fail "broker simulator library is missing $required_symbol" ;;
    esac
  done

  local resource_root="$resources/oliphaunt"
  local runtime_manifest="$resource_root/runtime/manifest.properties"
  local template_manifest="$resource_root/template-pgdata/manifest.properties"
  local static_manifest="$resource_root/static-registry/manifest.properties"
  local runtime_files="$resource_root/runtime/files"
  local template_files="$resource_root/template-pgdata/files"
  local required_file
  for required_file in \
    "$runtime_manifest" \
    "$template_manifest" \
    "$static_manifest" \
    "$runtime_files/share/postgresql/postgres.bki" \
    "$runtime_files/share/postgresql/extension/vector.control" \
    "$runtime_files/share/postgresql/extension/pg_trgm.control" \
    "$template_files/PG_VERSION"; do
    [ -f "$required_file" ] || fail "broker resources are incomplete: $required_file"
  done
  grep -Fqx 'selectedExtensions=pg_trgm,vector' "$runtime_manifest" || \
    fail "broker runtime resources do not select exactly vector,pg_trgm"
  grep -Fqx 'brokerDatabaseRole=oliphaunt_broker' "$template_manifest" || \
    fail "broker template does not seed the restricted database role"
  grep -Fqx 'registeredExtensions=vector,pg_trgm' "$static_manifest" || \
    fail "broker static registry does not register exactly vector,pg_trgm"
  for extension in vector pg_trgm; do
    find "$runtime_files/share/postgresql/extension" -maxdepth 1 -type f \
      -name "$extension--*.sql" -print -quit | grep -q . || \
      fail "broker runtime resources are missing $extension SQL"
  done

  export OLIPHAUNT_IOS_BROKER_XCFRAMEWORK="$xcframework"
  export OLIPHAUNT_IOS_BROKER_RESOURCES="$resources"
  {
    printf 'xcframework=%s\n' "$xcframework"
    printf 'simulatorLibrary=%s\n' "$native_library"
    printf 'simulatorLibrarySHA256=%s\n' "$(shasum -a 256 "$native_library" | awk '{ print $1 }')"
    printf 'resources=%s\n' "$resources"
    printf 'runtimeManifest=%s\n' "$runtime_manifest"
    printf 'templateManifest=%s\n' "$template_manifest"
    printf 'staticRegistryManifest=%s\n' "$static_manifest"
    printf 'selectedExtensions=pg_trgm,vector\n'
  } >"$artifact_validation_file"
}

validate_built_artifact_isolation() {
  local binary
  : >"$host_linkage_file"
  for binary in \
    "$app_path/$host_executable" \
    "$app_path/$host_executable.debug.dylib"; do
    [ -f "$binary" ] || continue
    otool -L "$binary" >>"$host_linkage_file"
  done
  : >"$extension_linkage_file"
  for binary in \
    "$extension_path/$extension_executable" \
    "$extension_path/$extension_executable.debug.dylib"; do
    [ -f "$binary" ] || continue
    otool -L "$binary" >>"$extension_linkage_file"
  done
  local native_link_pattern='[/@]liboliphaunt([.]framework/liboliphaunt|[.]dylib)'
  if grep -Eq "$native_link_pattern" "$host_linkage_file"; then
    fail "broker host unexpectedly links liboliphaunt; see $host_linkage_file"
  fi
  grep -Eq "$native_link_pattern" "$extension_linkage_file" || \
    fail "broker extension does not link liboliphaunt; see $extension_linkage_file"

  : >"$extension_symbols_file"
  for binary in \
    "$extension_path/$extension_executable" \
    "$extension_path/$extension_executable.debug.dylib"; do
    [ -f "$binary" ] || continue
    {
      nm "$binary" 2>/dev/null || true
    } | xcrun swift-demangle >>"$extension_symbols_file"
  done
  local host_adapter_symbol_pattern='OliphauntIOSBroker[.]IOSBroker(Manager|Engine|Session)([ .:$]|$)'
  if grep -Eq "$host_adapter_symbol_pattern" "$extension_symbols_file"; then
    fail "broker extension contains host-adapter symbols; see $extension_symbols_file"
  fi

  local frameworks_dir="$extension_path/Frameworks"
  [ -d "$frameworks_dir" ] || fail "broker extension has no embedded Frameworks directory"
  find "$frameworks_dir" -type f \( -name liboliphaunt -o -name liboliphaunt.dylib \) \
    -print | LC_ALL=C sort >"$embedded_native_file"
  local embedded_native_count
  embedded_native_count="$(wc -l <"$embedded_native_file" | tr -d '[:space:]')"
  [ "$embedded_native_count" = "1" ] || \
    fail "broker extension must embed exactly one liboliphaunt library, found $embedded_native_count"
  embedded_native_library="$(cat "$embedded_native_file")"

  local resource_root="$extension_path/oliphaunt"
  local runtime_manifest="$resource_root/runtime/manifest.properties"
  local static_manifest="$resource_root/static-registry/manifest.properties"
  local runtime_files="$resource_root/runtime/files"
  local template_files="$resource_root/template-pgdata/files"
  local -a required_resources=(
    "runtime/manifest.properties"
    "template-pgdata/manifest.properties"
    "static-registry/manifest.properties"
    "runtime/files/share/postgresql/postgres.bki"
    "runtime/files/share/postgresql/extension/vector.control"
    "runtime/files/share/postgresql/extension/pg_trgm.control"
    "template-pgdata/files/PG_VERSION"
  )
  local relative resource_file extension
  : >"$extension_resources_file"
  for relative in "${required_resources[@]}"; do
    resource_file="$resource_root/$relative"
    [ -f "$resource_file" ] || fail "embedded broker extension resource is missing: $relative"
    printf '%s\t%s\t%s\n' \
      "$relative" \
      "$(wc -c <"$resource_file" | tr -d '[:space:]')" \
      "$(shasum -a 256 "$resource_file" | awk '{ print $1 }')" \
      >>"$extension_resources_file"
  done
  grep -Fqx 'selectedExtensions=pg_trgm,vector' "$runtime_manifest" || \
    fail "embedded broker runtime manifest lost the exact extension selection"
  grep -Fqx 'brokerDatabaseRole=oliphaunt_broker' \
    "$resource_root/template-pgdata/manifest.properties" || \
    fail "embedded broker template lost its restricted database role"
  grep -Fqx 'registeredExtensions=vector,pg_trgm' "$static_manifest" || \
    fail "embedded broker static registry lost the exact extension selection"
  [ "$(tr -d '\r\n' <"$template_files/PG_VERSION")" = "18" ] || \
    fail "embedded broker template PGDATA is not PostgreSQL 18"
  for extension in vector pg_trgm; do
    find "$runtime_files/share/postgresql/extension" -maxdepth 1 -type f \
      -name "$extension--*.sql" -print | LC_ALL=C sort >>"$extension_resources_file"
    grep -Fq "/$extension--" "$extension_resources_file" || \
      fail "embedded broker runtime is missing $extension SQL"
  done
  if find "$resource_root" -type f \( -name '*.dylib' -o -name '*.so' \) -print -quit | grep -q .; then
    fail "embedded broker resource tree contains a dynamic extension module"
  fi
}

stop_log_capture() {
  [ -n "$log_stream_pid" ] || return 0
  if kill -0 "$log_stream_pid" 2>/dev/null; then
    kill -TERM "$log_stream_pid" 2>/dev/null || true
    local attempts=20
    while [ "$attempts" -gt 0 ] && kill -0 "$log_stream_pid" 2>/dev/null; do
      sleep 0.1
      attempts=$((attempts - 1))
    done
    kill -KILL "$log_stream_pid" 2>/dev/null || true
  fi
  wait "$log_stream_pid" 2>/dev/null || true
  log_stream_pid=""
}

capture_unified_snapshot() {
  [ -n "$selected_udid" ] || return 0
  [ -n "$log_predicate" ] || return 0
  [ -n "$log_start_time" ] || return 0
  xcrun simctl spawn "$selected_udid" log show \
    --style compact \
    --start "$log_start_time" \
    --predicate "$log_predicate" \
    >"$unified_snapshot_log" 2>&1 || true
}

capture_screenshot() {
  [ -n "$selected_udid" ] || return 0
  xcrun simctl io "$selected_udid" screenshot "$reports_dir/failure.png" \
    >"$logs_dir/screenshot.log" 2>&1 || true
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  set +e
  stop_log_capture
  if [ "$status" -ne 0 ]; then
    capture_unified_snapshot
    capture_screenshot
    if [ -z "$failure_reason" ]; then
      failure_reason="runner command failed with status $status"
    fi
    printf '%s\n' "$failure_reason" >"$reports_dir/failure.txt"
    printf '\nLast simulator/app output:\n' >&2
    tail -120 "$app_stdout_log" "$app_stderr_log" "$unified_stream_log" \
      "$unified_snapshot_log" 2>/dev/null >&2
  fi
  if [ -n "$selected_udid" ] && [ "$terminate_after_run" = "YES" ]; then
    xcrun simctl terminate "$selected_udid" "$app_bundle_id" >/dev/null 2>&1 || true
  fi
  if [ -n "$selected_udid" ] && [ "$uninstall_after_run" = "YES" ]; then
    xcrun simctl uninstall "$selected_udid" "$app_bundle_id" >/dev/null 2>&1 || true
  fi
  exit "$status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p \
  "$build_root" \
  "$derived_data" \
  "$logs_dir" \
  "$reports_dir" \
  "$(dirname "$app_report_path")" \
  "$(dirname "$runner_report_path")"
[ "$app_report_path" != "$runner_report_path" ] || \
  fail "app and runner report paths must be different"
: >"$generator_log"
: >"$build_log"
: >"$boot_log"
: >"$install_log"
: >"$launch_log"
: >"$app_stdout_log"
: >"$app_stderr_log"
: >"$unified_stream_log"
: >"$unified_snapshot_log"
: >"$report_validation_log"
: >"$artifact_preparation_log"
: >"$artifact_validation_file"
: >"$embedded_extensions_file"
: >"$installed_extensions_file"
: >"$host_linkage_file"
: >"$extension_linkage_file"
: >"$extension_symbols_file"
: >"$embedded_native_file"
: >"$extension_resources_file"
: >"$pass_marker_file"
: >"$storage_reset_file"
: >"$app_report_path"
: >"$runner_report_path"
: >"$reports_dir/failure.txt"

case "$minimum_ios_major" in
  ''|*[!0-9]*) fail "OLIPHAUNT_IOS_BROKER_MIN_IOS_MAJOR must be an integer" ;;
esac
[ "$minimum_ios_major" -ge 26 ] || fail "the broker fixture requires iOS 26 or newer"
case "$timeout_seconds" in
  ''|*[!0-9]*) fail "OLIPHAUNT_IOS_BROKER_TIMEOUT_SECONDS must be a positive integer" ;;
esac
[ "$timeout_seconds" -gt 0 ] || fail "OLIPHAUNT_IOS_BROKER_TIMEOUT_SECONDS must be positive"
case "$log_capture_startup_seconds" in
  ''|*[!0-9]*) fail "OLIPHAUNT_IOS_BROKER_LOG_CAPTURE_STARTUP_SECONDS must be a nonnegative integer" ;;
esac

code_signing_allowed="$(normalize_yes_no "$code_signing_allowed" OLIPHAUNT_IOS_BROKER_CODE_SIGNING_ALLOWED)"
terminate_after_run="$(normalize_yes_no "$terminate_after_run" OLIPHAUNT_IOS_BROKER_TERMINATE_AFTER_RUN)"
uninstall_after_run="$(normalize_yes_no "$uninstall_after_run" OLIPHAUNT_IOS_BROKER_UNINSTALL_AFTER_RUN)"
prepare_artifacts="$(normalize_yes_no "$prepare_artifacts" OLIPHAUNT_IOS_BROKER_PREPARE_ARTIFACTS)"
reset_simulator_storage="$(normalize_yes_no "$reset_simulator_storage" OLIPHAUNT_IOS_BROKER_RESET_SIMULATOR_STORAGE)"
case "$fixture_mode" in
  semantic|extendedFaults|hang|handshakeNegatives) ;;
  *) fail "unsupported OLIPHAUNT_BROKER_FIXTURE_MODE: $fixture_mode" ;;
esac
safe_bundle_identifier "$app_bundle_id" || fail "unsafe host bundle identifier: $app_bundle_id"
safe_bundle_identifier "$extension_bundle_id" || fail "unsafe extension bundle identifier: $extension_bundle_id"
safe_build_name "$scheme" || fail "unsafe Xcode scheme name: $scheme"
safe_build_name "$configuration" || fail "unsafe Xcode configuration name: $configuration"
safe_build_name "$app_product_name" || fail "unsafe host product name: $app_product_name"
safe_build_name "$extension_product_name" || fail "unsafe extension product name: $extension_product_name"

[ "$(uname -s)" = "Darwin" ] || fail "the iOS simulator runner requires macOS"
for command_name in awk bash cp date dirname find grep kill mv nm otool plutil ruby shasum sleep sort tail tee wc xcodebuild xcrun; do
  need_command "$command_name"
done
[ -f "$generator" ] || fail "missing project generator: $generator"
[ -f "$storage_quarantine_helper" ] || \
  fail "missing simulator storage quarantine helper: $storage_quarantine_helper"
[ -d "$fixture_root/Host" ] || fail "missing broker host fixture: $fixture_root/Host"
[ -d "$fixture_root/BrokerAppExtension" ] || fail "missing broker extension fixture: $fixture_root/BrokerAppExtension"

if ! ruby -e 'require "xcodeproj"' >"$logs_dir/xcodeproj-preflight.log" 2>&1; then
  fail "Ruby xcodeproj is required; install the repository's xcodeproj dependency before running the fixture"
fi
xcode_major="$(xcodebuild -version | awk 'NR == 1 { split($2, version, "."); print version[1] }')"
case "$xcode_major" in
  ''|*[!0-9]*) fail "could not determine the Xcode major version" ;;
esac
[ "$xcode_major" -ge 26 ] || fail "the ExtensionFoundation fixture requires Xcode 26 or newer"

if [ "$prepare_artifacts" = "YES" ]; then
  [ -x "$artifact_preparer" ] || fail "missing executable broker artifact preparer: $artifact_preparer"
  printf 'Preparing native broker XCFramework and runtime resources...\n'
  if ! env OLIPHAUNT_IOS_BROKER_ARTIFACT_ROOT="$artifact_root" \
    bash "$artifact_preparer" >"$artifact_preparation_log" 2>&1; then
    tail -120 "$artifact_preparation_log" >&2 || true
    fail "failed to prepare native broker artifacts"
  fi
  [ -f "$artifact_environment" ] || \
    fail "broker artifact preparer did not write its environment file: $artifact_environment"
  # shellcheck disable=SC1090
  . "$artifact_environment"
elif { [ -z "${OLIPHAUNT_IOS_BROKER_XCFRAMEWORK:-}" ] || \
  [ -z "${OLIPHAUNT_IOS_BROKER_RESOURCES:-}" ]; } && [ -f "$artifact_environment" ]; then
  printf 'Using previously prepared native broker artifacts from %s...\n' "$artifact_environment"
  # shellcheck disable=SC1090
  . "$artifact_environment"
else
  printf 'Using explicitly configured native broker artifacts...\n'
fi
validate_broker_artifacts
# Project generation only includes the native SDK targets when this is exactly
# one. Force it here so the simulator run cannot silently degrade to the
# ExtensionFoundation platform-only probe.
export OLIPHAUNT_BROKER_INCLUDE_SDK=1

printf 'Selecting %s on iOS %s+...\n' "$requested_device_name" "$minimum_ios_major"
if ! xcrun simctl list devices available -j >"$simulator_inventory"; then
  fail "failed to inventory available iOS simulators"
fi

simulator_selection=""
if ! simulator_selection="$(
  ruby -rjson - "$simulator_inventory" "$requested_udid" "$requested_device_name" \
    "$requested_runtime" "$minimum_ios_major" <<'RUBY'
inventory_path, requested_udid, requested_name, requested_runtime, minimum_major = ARGV
inventory = JSON.parse(File.read(inventory_path))
minimum_major = Integer(minimum_major, 10)
preferred_numbers = requested_runtime.scan(/\d+/).map(&:to_i)

candidates = []
inventory.fetch("devices", {}).each do |runtime_identifier, devices|
  match = runtime_identifier.match(/iOS-(\d+)-(\d+)/)
  next unless match
  major = Integer(match[1], 10)
  minor = Integer(match[2], 10)
  next if major < minimum_major
  unless preferred_numbers.empty?
    runtime_matches = preferred_numbers.length == 1 ? major == preferred_numbers[0] : [major, minor] == preferred_numbers.first(2)
    next unless runtime_matches
  end

  devices.each do |device|
    next unless device["isAvailable"] != false
    next if !requested_udid.empty? && device["udid"] != requested_udid
    next if requested_udid.empty? && device["name"] != requested_name
    candidates << [major, minor, device]
  end
end

if candidates.empty?
  selector = requested_udid.empty? ? "name=#{requested_name.inspect}" : "udid=#{requested_udid}"
  runtime = requested_runtime.empty? ? "iOS #{minimum_major}+" : "iOS #{requested_runtime}"
  warn "no available simulator matched #{selector}, runtime=#{runtime}"
  exit 1
end

candidates.sort_by! { |major, minor, device| [-major, -minor, device.fetch("udid")] }
major, minor, device = candidates.first
puts [device.fetch("udid"), device.fetch("name"), "iOS #{major}.#{minor}", device.fetch("state", "unknown")].join("\t")
RUBY
)"; then
  fail "failed to select an iPhone 17 Pro simulator running iOS 26 or newer"
fi

IFS=$'\t' read -r selected_udid selected_name selected_runtime selected_state <<EOF
$simulator_selection
EOF
[ -n "$selected_udid" ] || fail "simulator selection returned an empty UDID"
printf 'Selected simulator: %s (%s, %s, %s)\n' \
  "$selected_name" "$selected_udid" "$selected_runtime" "$selected_state"

printf 'Generating Xcode project...\n'
if ! ruby "$generator" >"$generator_log" 2>&1; then
  tail -120 "$generator_log" >&2 || true
  fail "failed to generate the broker spike Xcode project"
fi
generated_project="$(tail -1 "$generator_log")"
project_path="${OLIPHAUNT_IOS_BROKER_PROJECT_PATH:-$generated_project}"
project_path="$(absolute_path "$project_path")"
[ -d "$project_path" ] || fail "generated Xcode project is missing: $project_path"

build_result_bundle="$reports_dir/build-$(date -u +%Y%m%dT%H%M%SZ)-$$.xcresult"
printf 'Building %s for %s...\n' "$scheme" "$selected_udid"
if ! xcodebuild \
  -project "$project_path" \
  -scheme "$scheme" \
  -configuration "$configuration" \
  -sdk iphonesimulator \
  -destination "id=$selected_udid" \
  -derivedDataPath "$derived_data" \
  -resultBundlePath "$build_result_bundle" \
  CODE_SIGNING_ALLOWED="$code_signing_allowed" \
  COMPILER_INDEX_STORE_ENABLE=NO \
  clean build 2>&1 | tee "$build_log"; then
  fail "xcodebuild failed; see $build_log"
fi

app_path="${OLIPHAUNT_IOS_BROKER_APP_PATH:-$derived_data/Build/Products/$configuration-iphonesimulator/$app_product_name.app}"
app_path="$(absolute_path "$app_path")"
[ -d "$app_path" ] || fail "built host app is missing: $app_path"
[ -f "$app_path/Info.plist" ] || fail "built host app has no Info.plist: $app_path"
observed_app_bundle_id="$(plutil -extract CFBundleIdentifier raw -o - "$app_path/Info.plist" 2>/dev/null || true)"
[ "$observed_app_bundle_id" = "$app_bundle_id" ] || \
  fail "built host bundle identifier is $observed_app_bundle_id, expected $app_bundle_id"
host_executable="$(plutil -extract CFBundleExecutable raw -o - "$app_path/Info.plist" 2>/dev/null || true)"
safe_process_name "$host_executable" || fail "unsafe or missing host executable name: $host_executable"
[ -x "$app_path/$host_executable" ] || fail "host executable is missing: $app_path/$host_executable"

extensions_dir="$app_path/Extensions"
extension_path="$extensions_dir/$extension_product_name.appex"
legacy_extension_path="$app_path/PlugIns/$extension_product_name.appex"
[ ! -e "$legacy_extension_path" ] || \
  fail "host app contains stale legacy extension packaging: $legacy_extension_path"
[ -d "$extensions_dir" ] || fail "host app is missing its ExtensionKit Extensions directory: $extensions_dir"
find "$extensions_dir" -mindepth 1 -maxdepth 1 -type d -name '*.appex' -print | \
  LC_ALL=C sort >"$embedded_extensions_file"
[ -d "$extension_path" ] || fail "host app is missing the embedded ExtensionKit extension: $extension_path"
observed_extension_bundle_id="$(plutil -extract CFBundleIdentifier raw -o - "$extension_path/Info.plist" 2>/dev/null || true)"
[ "$observed_extension_bundle_id" = "$extension_bundle_id" ] || \
  fail "embedded extension bundle identifier is $observed_extension_bundle_id, expected $extension_bundle_id"
extension_executable="$(plutil -extract CFBundleExecutable raw -o - "$extension_path/Info.plist" 2>/dev/null || true)"
safe_process_name "$extension_executable" || \
  fail "unsafe or missing extension executable name: $extension_executable"
[ -x "$extension_path/$extension_executable" ] || \
  fail "embedded extension executable is missing: $extension_path/$extension_executable"
validate_built_artifact_isolation

printf 'Booting simulator...\n'
if [ "$selected_state" != "Booted" ]; then
  if ! xcrun simctl boot "$selected_udid" >"$boot_log" 2>&1; then
    if ! xcrun simctl list devices | grep -F "$selected_udid" | grep -Fq '(Booted)'; then
      tail -80 "$boot_log" >&2 || true
      fail "failed to boot simulator $selected_udid"
    fi
  fi
fi
if ! xcrun simctl bootstatus "$selected_udid" -b 2>&1 | tee -a "$boot_log"; then
  fail "simulator did not finish booting: $selected_udid"
fi

if [ "$reset_simulator_storage" = "YES" ]; then
  if ! bash "$storage_quarantine_helper" \
    "$selected_udid" \
    "$app_bundle_id" \
    "$extension_bundle_id" \
    "$app_product_name" \
    "$host_executable" \
    "$extension_product_name" \
    "$extension_executable" \
    "$storage_reset_file"; then
    fail "simulator storage quarantine was refused; see $storage_reset_file"
  fi
else
  xcrun simctl terminate "$selected_udid" "$app_bundle_id" >/dev/null 2>&1 || true
  xcrun simctl uninstall "$selected_udid" "$app_bundle_id" >/dev/null 2>&1 || true
  printf 'disabled\n' >"$storage_reset_file"
fi
printf 'Installing host app...\n'
if ! xcrun simctl install "$selected_udid" "$app_path" >"$install_log" 2>&1; then
  tail -80 "$install_log" >&2 || true
  fail "failed to install $app_bundle_id"
fi

installed_app_path="$(xcrun simctl get_app_container "$selected_udid" "$app_bundle_id" app 2>>"$install_log" || true)"
[ -d "$installed_app_path" ] || fail "installed host app container could not be resolved"
installed_extensions_dir="$installed_app_path/Extensions"
installed_extension_path="$installed_extensions_dir/$extension_product_name.appex"
installed_legacy_extension_path="$installed_app_path/PlugIns/$extension_product_name.appex"
[ ! -e "$installed_legacy_extension_path" ] || \
  fail "installed host app contains stale legacy extension packaging: $installed_legacy_extension_path"
[ -d "$installed_extensions_dir" ] || \
  fail "installed host app is missing its ExtensionKit Extensions directory"
find "$installed_extensions_dir" -mindepth 1 -maxdepth 1 -type d -name '*.appex' -print | \
  LC_ALL=C sort >"$installed_extensions_file"
[ -d "$installed_extension_path" ] || \
  fail "installed host app is missing the embedded ExtensionKit extension: $installed_extension_path"
installed_extension_bundle_id="$(plutil -extract CFBundleIdentifier raw -o - "$installed_extension_path/Info.plist" 2>/dev/null || true)"
[ "$installed_extension_bundle_id" = "$extension_bundle_id" ] || \
  fail "installed extension bundle identifier is $installed_extension_bundle_id, expected $extension_bundle_id"
[ -f "$installed_extension_path/oliphaunt/runtime/files/share/postgresql/postgres.bki" ] || \
  fail "installed broker extension lost its PostgreSQL runtime resources"
[ -f "$installed_extension_path/oliphaunt/template-pgdata/files/PG_VERSION" ] || \
  fail "installed broker extension lost its template PGDATA"
[ -f "$installed_extension_path/oliphaunt/static-registry/manifest.properties" ] || \
  fail "installed broker extension lost its static-extension registry"

data_container="$(xcrun simctl get_app_container "$selected_udid" "$app_bundle_id" data 2>>"$install_log" || true)"
[ -d "$data_container" ] || fail "installed host data container could not be resolved"
source_app_report="$data_container/Documents/$app_report_name"

log_predicate="process == '$host_executable' OR process == '$extension_executable' OR eventMessage CONTAINS '$success_marker' OR eventMessage CONTAINS '$failure_marker'"
log_start_time="$(date '+%Y-%m-%d %H:%M:%S')"
xcrun simctl spawn "$selected_udid" log stream \
  --style compact \
  --level debug \
  --predicate "$log_predicate" \
  >"$unified_stream_log" 2>&1 &
log_stream_pid=$!
sleep "$log_capture_startup_seconds"
kill -0 "$log_stream_pid" 2>/dev/null || fail "simulator unified-log capture exited before launch"

printf 'Launching host app...\n'
if ! SIMCTL_CHILD_NSUnbufferedIO=YES \
  SIMCTL_CHILD_OLIPHAUNT_BROKER_FIXTURE_MODE="$fixture_mode" \
  xcrun simctl launch \
  --terminate-running-process \
  --stdout="$app_stdout_log" \
  --stderr="$app_stderr_log" \
  "$selected_udid" "$app_bundle_id" >"$launch_log" 2>&1; then
  tail -80 "$launch_log" >&2 || true
  fail "failed to launch $app_bundle_id"
fi

latest_log_line() {
  local marker="$1"
  # `log stream` echoes its predicate on startup. Require the separator that
  # the app emits after a marker so that diagnostic cannot impersonate PASS
  # or FAIL merely by containing the quoted predicate string.
  grep -hF "$marker " \
    "$app_stdout_log" "$app_stderr_log" "$unified_stream_log" "$unified_snapshot_log" \
    2>/dev/null | tail -1 || true
}

validate_app_report() {
  ruby -rjson - "$source_app_report" "$report_validation_log" "$fixture_mode" <<'RUBY'
report_path, validation_path, fixture_mode = ARGV
report = JSON.parse(File.read(report_path))
raise "app report must be a JSON object" unless report.is_a?(Hash)
error = report["error"]
raise "app reported failure: #{error}" unless error.nil? || error.empty?
result = report["result"]
raise "app report is missing result" unless result.is_a?(Hash)

host_pid = result["hostPID"]
worker_pid = result["workerPID"]
raise "app report has invalid host PID" unless host_pid.is_a?(Integer) && host_pid.positive?
raise "app report has invalid worker PID" unless worker_pid.is_a?(Integer) && worker_pid.positive?
raise "host and extension PIDs are identical" if host_pid == worker_pid
epoch = result["epoch"]
uuid_pattern = /\A[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\z/
raise "app report has invalid epoch" unless epoch.is_a?(String) && epoch.match?(uuid_pattern)
checks = result["checks"]
required_checks = if fixture_mode == "extendedFaults"
  %w[
    archiveBoundaryRejected
    differentRootRejected
    closeCancelCompletionRace
    beforeDispatchCrash
    beforeDispatchNotReplayed
    afterResponseChunksCrash
    partialStreamOutcomeUnknown
    checkpointCrashRecovery
    idleAbortRecovery
    idleSIGSEGVRecovery
  ]
elsif fixture_mode == "hang"
  %w[
    hangCapabilityConservative
    hangTimeout
    mainActorResponsiveDuringHang
    oldHangEpochInvalidated
    replacementLaunchAttempted
  ]
elsif fixture_mode == "handshakeNegatives"
  %w[
    incompatibleProtocolRejected
    incompatibleABIRejected
    runtimeMismatchRejected
    rootMismatchRejected
    startupConfigurationRejected
    validHandshakeAfterRejections
    secondActiveDataChannelRejected
  ]
else
  %w[
    extensionDiscovery
    separatePID
    xpcSession
    fdTransfer
    fragmentedFrame
    boundedRequestAssembly
    realSelect
    ddl
    write
    parameterizedQuery
    postgresErrorRecovery
    vectorExtension
    pgTrgmExtension
    multiFrameRequest
    streamingResponse
    simultaneousHandles
    fifoSerialization
    referenceCounting
    transactionHandlePinning
    cancellation
    postCancelLiveness
    checkpointControl
    backgroundLifecycle
    sameRootReopen
    outcomeUnknown
    postCommitAmbiguity
    crashRecovery
    preCommitRollbackRecovery
    noAutomaticReplay
    capabilities
    pgdataPathConfidentiality
    workerDiagnostics
    openedIdleMemory
  ]
end
raise "app report checks must be an array" unless checks.is_a?(Array)
missing = required_checks - checks
raise "app report is missing checks: #{missing.join(",")}" unless missing.empty?
unexpected = checks - required_checks
raise "app report has unexpected checks: #{unexpected.join(",")}" unless unexpected.empty?
if fixture_mode == "semantic"
  observations = result["observations"]
  raise "semantic matrix omitted observations" unless observations.is_a?(Hash)
  raise "semantic matrix used the wrong database role" unless observations["restrictedDatabaseRole"] == "oliphaunt_broker"
  raise "semantic matrix assigned the database to the broker role" unless observations["databaseOwner"] == "postgres"
  raise "semantic matrix assigned selected extensions to the broker role" unless observations["selectedExtensionOwners"] == "pg_trgm:postgres,vector:postgres"
  raise "semantic matrix omitted the broker-owned working schema" unless observations["brokerSchemaOwner"] == "oliphaunt_broker"
  %w[
    dataDirectorySQLState parameterizedDataDirectorySQLState serverFileSQLState
    bootstrapEscalationSQLState sessionAuthorizationEscalationSQLState
    databaseOwnerEscalationSQLState relationPathSQLState tablespacePathSQLState
    listDirectorySQLState statFileSQLState largeObjectImportSQLState
    externalCopySQLState externalCopyFromSQLState alterSystemSQLState
    createRoleSQLState selfSuperuserEscalationSQLState grantFileRoleSQLState
    dropSelectedExtensionSQLState
    createTablespaceSQLState createNativeFunctionSQLState loadLibrarySQLState
    afterResetDataDirectorySQLState afterDiscardDataDirectorySQLState
  ].each do |key|
    raise "semantic matrix did not deny #{key}" unless observations[key] == "42501"
  end
  raise "semantic matrix did not preserve the sanitized backend SQLSTATE" unless observations["sanitizedBackendErrorSQLState"] == "F0000"
  raise "semantic matrix did not restore the broker search path after DISCARD ALL" unless observations["afterDiscardSearchPath"] == "{oliphaunt_broker,public}"
  raise "semantic matrix exposed data_directory through pg_settings" unless observations["pgSettingsDataDirectoryRows"] == "0"
  %w[
    restrictedFunctionExecuteCount restrictedViewSelectCount
    pgSettingsSourcePathRows visiblePrivatePathSettingRows
  ].each do |key|
    raise "semantic matrix exposed private catalog/path evidence through #{key}" unless observations[key] == "0"
  end
  raise "semantic matrix found a non-default tablespace" unless observations["nonDefaultTablespaceCount"] == "0"
end
if fixture_mode == "extendedFaults"
  recovered = result["recoveredEpochs"]
  raise "extended fault matrix did not publish five recoveries" unless recovered.is_a?(Array) && recovered.length == 5 && recovered.uniq.length == 5
  observations = result["observations"]
  raise "extended fault matrix has no partial response evidence" unless observations.is_a?(Hash) && observations.fetch("partialResponseBytesBeforeCrash", "0").to_i.positive?
  raise "extended fault matrix did not prove PostgreSQL cancellation and transport completion after native dispatch" unless observations["closeCancelCompletionTerminal"] == "postgresCanceledCompleted"
  raise "extended fault matrix hid an unexpected cancel-control failure" unless %w[acknowledged databaseClosed].include?(observations["closeCancelControlOutcome"])
  raise "extended fault matrix changed its root digest" unless observations["initialManifestDigest"] == observations["finalManifestDigest"]
elsif fixture_mode == "hang"
  observations = result["observations"]
  raise "hang matrix did not preserve conservative capability" unless observations.is_a?(Hash) && observations["hangRestartableCapability"] == "false"
  timeout = observations.fetch("timeout", "")
  raise "hang matrix omitted its bounded terminal error" if timeout.empty?
  raise "hang matrix terminal was not a deadline/interruption/outcome-unknown result" unless timeout.match?(/deadline|interrupt|outcome.*unknown/i)
  raise "hang fault was not acknowledged before the trigger" unless observations["faultAcknowledged"] == "true"
  raise "worker was not responsive after the fault acknowledgement" unless observations["postAckWorkerResponsive"] == "true"
  raise "post-ack worker PID changed" unless Integer(observations.fetch("postAckWorkerPID"), 10) == worker_pid
  raise "post-ack epoch changed" unless observations.fetch("postAckEpoch") == epoch
  fresh_process = observations["freshProcessObtained"]
  raise "hang matrix did not record fresh-process outcome" unless %w[true false].include?(fresh_process)
  initial_attempt_count = Integer(observations.fetch("initialLaunchAttemptCount"), 10)
  interrupted_attempt_count = Integer(observations.fetch("interruptedLaunchAttemptCount"), 10)
  post_attempt_count = Integer(observations.fetch("postRecoveryLaunchAttemptCount"), 10)
  attempt_delta = Integer(observations.fetch("replacementLaunchAttemptDelta"), 10)
  initial_launch_count = Integer(observations.fetch("initialLaunchCount"), 10)
  interrupted_launch_count = Integer(observations.fetch("interruptedLaunchCount"), 10)
  post_launch_count = Integer(observations.fetch("postRecoveryLaunchCount"), 10)
  successful_launch_delta = Integer(observations.fetch("successfulLaunchCountDelta"), 10)
  raise "hang matrix initial attempt count is invalid" unless initial_attempt_count.positive?
  raise "hang matrix initial launch count is invalid" unless initial_launch_count.positive?
  raise "hang matrix has fewer attempts than successful launches" unless initial_attempt_count >= initial_launch_count
  raise "hang interruption regressed process attempts" unless interrupted_attempt_count >= initial_attempt_count
  raise "hang interruption regressed launch count" unless interrupted_launch_count >= initial_launch_count
  raise "hang matrix did not prove a replacement process attempt" unless post_attempt_count > interrupted_attempt_count
  raise "hang replacement attempt delta is inconsistent" unless attempt_delta == post_attempt_count - interrupted_attempt_count
  raise "hang successful launch count regressed" unless post_launch_count >= interrupted_launch_count
  raise "hang successful launch delta is inconsistent" unless successful_launch_delta == post_launch_count - interrupted_launch_count
  recovered_epochs = result["recoveredEpochs"]
  raise "hang matrix recovered epochs must be an array" unless recovered_epochs.is_a?(Array)
  if fresh_process == "true"
    raise "hang fresh process had no successful replacement launch" unless post_launch_count > interrupted_launch_count
    recovered_pid = Integer(observations.fetch("recoveredWorkerPID"), 10)
    recovered_epoch = observations.fetch("recoveredEpoch")
    raise "hang matrix fresh process reused the stale PID" if recovered_pid == worker_pid
    raise "hang matrix fresh process reused the stale epoch" if recovered_epoch == epoch
    raise "hang matrix fresh process has an invalid epoch" unless recovered_epoch.is_a?(String) && recovered_epoch.match?(uuid_pattern)
    raise "hang matrix fresh recovery list is inconsistent" unless recovered_epochs == [recovered_epoch]
  else
    raise "hang matrix false recovery omitted its failure" if observations.fetch("recoveryFailure", "").empty?
    raise "hang matrix false recovery published recovered epochs" unless recovered_epochs.empty?
    if observations.key?("recoveredWorkerPID") || observations.key?("recoveredEpoch")
      recovered_pid = Integer(observations.fetch("recoveredWorkerPID"), 10)
      recovered_epoch = observations.fetch("recoveredEpoch")
      both_fresh = recovered_pid != worker_pid && recovered_epoch != epoch
      raise "hang matrix mislabeled a fully fresh process as unavailable" if both_fresh
    end
  end
end

File.write(validation_path, JSON.pretty_generate({
  status: "PASS",
  hostPID: host_pid,
  workerPID: worker_pid,
  epoch: epoch,
  fixtureMode: fixture_mode,
  checks: checks,
}) + "\n")
RUBY
}

deadline=$((SECONDS + timeout_seconds))
report_valid=0
pass_line=""
while [ "$SECONDS" -lt "$deadline" ]; do
  failure_line="$(latest_log_line "$failure_marker")"
  [ -z "$failure_line" ] || fail "broker spike emitted failure marker: $failure_line"

  if [ "$report_valid" -eq 0 ] && [ -s "$source_app_report" ]; then
    if ! validate_app_report; then
      cp "$source_app_report" "$app_report_path" 2>/dev/null || true
      fail "broker spike wrote an invalid or failed app report"
    fi
    cp "$source_app_report" "$app_report_path"
    report_valid=1
  fi

  pass_line="$(latest_log_line "$success_marker")"
  if [ "$report_valid" -eq 1 ] && [ -n "$pass_line" ]; then
    break
  fi
  kill -0 "$log_stream_pid" 2>/dev/null || fail "simulator unified-log capture ended before PASS"
  sleep 1
done

stop_log_capture
capture_unified_snapshot
if [ -z "$pass_line" ]; then
  pass_line="$(latest_log_line "$success_marker")"
fi
if [ "$report_valid" -eq 0 ] && [ -s "$source_app_report" ]; then
  if validate_app_report; then
    cp "$source_app_report" "$app_report_path"
    report_valid=1
  fi
fi
[ "$report_valid" -eq 1 ] || fail "timed out waiting for the broker spike app report"
[ -n "$pass_line" ] || fail "timed out waiting for the authoritative $success_marker marker"
printf '%s\n' "$pass_line" >"$pass_marker_file"

completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
ruby -rjson - "$runner_report_path" "$app_report_path" \
  "$selected_udid" "$selected_name" "$selected_runtime" "$scheme" "$configuration" \
  "$app_bundle_id" "$extension_bundle_id" "$app_path" "$extension_path" \
  "$OLIPHAUNT_IOS_BROKER_XCFRAMEWORK" "$OLIPHAUNT_IOS_BROKER_RESOURCES" \
  "$embedded_native_library" "$artifact_validation_file" "$host_linkage_file" \
  "$extension_linkage_file" "$extension_symbols_file" "$extension_resources_file" \
  "$artifact_preparation_log" \
  "$build_log" "$app_stdout_log" "$app_stderr_log" "$unified_stream_log" \
  "$unified_snapshot_log" "$build_result_bundle" "$pass_line" "$completed_at" \
  "$fixture_mode" "$storage_reset_file" <<'RUBY'
output, app_report_path, udid, device_name, runtime, scheme, configuration,
  app_bundle_id, extension_bundle_id, app_path, extension_path, xcframework,
  runtime_resources, embedded_native_library, artifact_validation, host_linkage,
  extension_linkage, extension_symbols, extension_resources,
  artifact_preparation_log, build_log,
  stdout_log, stderr_log, stream_log, snapshot_log, result_bundle,
  pass_marker, completed_at, fixture_mode, storage_reset_file = ARGV

payload = {
  schema: "oliphaunt-ios-broker-simulator-run-v1",
  status: "PASS",
  fixtureMode: fixture_mode,
  completedAt: completed_at,
  simulator: { udid: udid, name: device_name, runtime: runtime },
  build: {
    scheme: scheme,
    configuration: configuration,
    appPath: app_path,
    embeddedExtensionPath: extension_path,
    resultBundle: result_bundle,
  },
  bundleIdentifiers: { host: app_bundle_id, extension: extension_bundle_id },
  artifacts: {
    xcframework: xcframework,
    runtimeResources: runtime_resources,
    embeddedNativeLibrary: embedded_native_library,
  },
  validations: {
    artifacts: artifact_validation,
    hostLinkage: host_linkage,
    extensionLinkage: extension_linkage,
    extensionSymbols: extension_symbols,
    extensionResources: extension_resources,
    simulatorStorageReset: storage_reset_file,
  },
  logs: {
    artifactPreparation: artifact_preparation_log,
    xcodebuild: build_log,
    appStdout: stdout_log,
    appStderr: stderr_log,
    unifiedStream: stream_log,
    unifiedSnapshot: snapshot_log,
  },
  passMarker: pass_marker,
  appReport: JSON.parse(File.read(app_report_path)),
}
File.write(output, JSON.pretty_generate(payload) + "\n")
RUBY

printf 'OLIPHAUNT_IOS_BROKER_SIMULATOR_PASS report=%s appReport=%s logs=%s\n' \
  "$runner_report_path" "$app_report_path" "$logs_dir"
