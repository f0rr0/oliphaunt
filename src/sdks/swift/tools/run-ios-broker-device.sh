#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
default_repo_root="$(cd "$script_dir/../../../.." && pwd)"
repo_root="${OLIPHAUNT_REPO_ROOT:-$default_repo_root}"

. "$repo_root/src/sdks/react-native/tools/expo-runner-common.sh"

absolute_path() {
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    *) printf '%s/%s\n' "$repo_root" "$1" ;;
  esac
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

select_xcode_development_team() {
  {
    defaults read com.apple.dt.Xcode IDEProvisioningTeams 2>/dev/null || true
    defaults read com.apple.dt.Xcode IDEProvisioningTeamByIdentifier 2>/dev/null || true
  } |
    awk -F'= ' '/teamID =/ { value = $2; gsub(/[;[:space:]]/, "", value); print value }' |
    sort -u |
    awk 'NR == 1 { first = $0 } NR > 1 { multiple = 1 } END { if (!multiple && first != "") print first; else exit 1 }'
}

valid_code_signing_identity_count() {
  security find-identity -v -p codesigning 2>/dev/null |
    awk '/valid identities found/ { print $1; found = 1 } END { if (!found) print 0 }'
}

fixture_root="$(absolute_path "${OLIPHAUNT_IOS_BROKER_FIXTURE_ROOT:-spikes/ios-native-broker}")"
generator="$(absolute_path "${OLIPHAUNT_IOS_BROKER_PROJECT_GENERATOR:-$fixture_root/generate_project.rb}")"
build_root="$(absolute_path "${OLIPHAUNT_IOS_BROKER_DEVICE_BUILD_ROOT:-target/ios-native-broker-device-spike}")"
derived_data="$(absolute_path "${OLIPHAUNT_IOS_BROKER_DEVICE_DERIVED_DATA:-$build_root/DerivedData}")"
logs_dir="$(absolute_path "${OLIPHAUNT_IOS_BROKER_DEVICE_LOGS_DIR:-$build_root/logs}")"
reports_dir="$(absolute_path "${OLIPHAUNT_IOS_BROKER_DEVICE_REPORTS_DIR:-$build_root/reports}")"
artifact_root="$(absolute_path "${OLIPHAUNT_IOS_BROKER_DEVICE_ARTIFACT_ROOT:-target/ios-native-broker-device-artifacts}")"
artifact_preparer="$(absolute_path "${OLIPHAUNT_IOS_BROKER_ARTIFACT_PREPARER:-$script_dir/prepare-ios-broker-artifacts.sh}")"
artifact_environment="$(absolute_path "${OLIPHAUNT_IOS_BROKER_DEVICE_ARTIFACT_ENV:-$artifact_root/broker-artifacts.env}")"

scheme="${OLIPHAUNT_IOS_BROKER_SCHEME:-OliphauntBrokerSpike}"
configuration="${OLIPHAUNT_IOS_BROKER_CONFIGURATION:-Debug}"
lifecycle_configuration="${OLIPHAUNT_IOS_BROKER_LIFECYCLE_CONFIGURATION:-Release}"
app_product_name="${OLIPHAUNT_IOS_BROKER_APP_PRODUCT_NAME:-OliphauntBrokerSpike}"
extension_product_name="${OLIPHAUNT_IOS_BROKER_EXTENSION_PRODUCT_NAME:-BrokerAppExtension}"
app_bundle_id="${OLIPHAUNT_IOS_BROKER_BUNDLE_ID:-dev.oliphaunt.brokerspike}"
extension_bundle_id="${OLIPHAUNT_IOS_BROKER_EXTENSION_BUNDLE_ID:-dev.oliphaunt.brokerspike.extension}"
requested_device_id="${OLIPHAUNT_IOS_BROKER_DEVICE_ID:-}"
requested_device_name="${OLIPHAUNT_IOS_BROKER_DEVICE_NAME:-}"
minimum_ios_major="${OLIPHAUNT_IOS_BROKER_MIN_IOS_MAJOR:-26}"
timeout_seconds="${OLIPHAUNT_IOS_BROKER_TIMEOUT_SECONDS:-180}"
prepare_artifacts="${OLIPHAUNT_IOS_BROKER_PREPARE_ARTIFACTS:-YES}"
preflight_only="${OLIPHAUNT_IOS_BROKER_DEVICE_PREFLIGHT_ONLY:-NO}"
resume_lifecycle_only="${OLIPHAUNT_IOS_BROKER_RESUME_LIFECYCLE_ONLY:-NO}"
resume_after_debug_install="${OLIPHAUNT_IOS_BROKER_RESUME_AFTER_DEBUG_INSTALL:-NO}"
resume_debug_result_bundle_input="${OLIPHAUNT_IOS_BROKER_RESUME_DEBUG_RESULT_BUNDLE:-}"
clean_install="${OLIPHAUNT_IOS_BROKER_DEVICE_CLEAN_INSTALL:-YES}"
uninstall_after_run="${OLIPHAUNT_IOS_BROKER_UNINSTALL_AFTER_RUN:-NO}"
code_signing_allowed="${OLIPHAUNT_IOS_BROKER_CODE_SIGNING_ALLOWED:-YES}"
development_team="${OLIPHAUNT_IOS_BROKER_DEVELOPMENT_TEAM:-}"
code_sign_style="${OLIPHAUNT_IOS_BROKER_CODE_SIGN_STYLE:-}"
code_sign_identity="${OLIPHAUNT_IOS_BROKER_CODE_SIGN_IDENTITY:-}"
provisioning_profile_specifier="${OLIPHAUNT_IOS_BROKER_PROVISIONING_PROFILE_SPECIFIER:-}"
allow_provisioning_updates="${OLIPHAUNT_IOS_BROKER_ALLOW_PROVISIONING_UPDATES:-0}"
allow_device_registration="${OLIPHAUNT_IOS_BROKER_ALLOW_PROVISIONING_DEVICE_REGISTRATION:-0}"

if [ "$#" -gt 0 ]; then
  case "$1" in
    --preflight-only) preflight_only=YES ;;
    --resume-lifecycle) resume_lifecycle_only=YES ;;
    --resume-after-debug-install) resume_after_debug_install=YES ;;
    *) fail "usage: run-ios-broker-device.sh [--preflight-only|--resume-after-debug-install|--resume-lifecycle]" ;;
  esac
fi
[ "$#" -le 1 ] || \
  fail "usage: run-ios-broker-device.sh [--preflight-only|--resume-after-debug-install|--resume-lifecycle]"

success_marker="OLIPHAUNT_BROKER_SPIKE PASS"
failure_marker="OLIPHAUNT_BROKER_SPIKE FAIL"
json_marker="OLIPHAUNT_BROKER_SPIKE_JSON "
runner_report_path="$reports_dir/device-runner-report.json"
persistence_report="$reports_dir/extension-private-persistence.json"
device_inventory="$reports_dir/devicectl-devices.json"
device_details="$reports_dir/devicectl-device-details.json"
device_lock_state="$reports_dir/devicectl-lock-state.json"
installed_apps="$reports_dir/devicectl-installed-apps.json"
install_result="$reports_dir/devicectl-install.json"
preflight_report="$reports_dir/device-preflight.json"
artifact_validation_file="$reports_dir/broker-artifacts.txt"
embedded_extensions_file="$reports_dir/embedded-extensions.txt"
host_linkage_file="$reports_dir/host-otool.txt"
extension_linkage_file="$reports_dir/extension-otool.txt"
embedded_native_file="$reports_dir/embedded-native-library.txt"
extension_resources_file="$reports_dir/extension-resource-checks.txt"
signing_validation_file="$reports_dir/code-signing-checks.txt"
extension_host_sdk_symbol_file="$reports_dir/extension-host-sdk-symbol-checks.txt"
release_fault_symbol_file="$reports_dir/release-fault-symbol-checks.txt"
launch_one_app_report="$reports_dir/launch-1-app-report.json"
launch_two_app_report="$reports_dir/launch-2-app-report.json"
launch_one_console_report="$reports_dir/launch-1-console-report.json"
launch_two_console_report="$reports_dir/launch-2-console-report.json"
launch_one_validation="$reports_dir/launch-1-report-validation.json"
launch_two_validation="$reports_dir/launch-2-report-validation.json"
launch_one_result="$reports_dir/devicectl-launch-1.json"
launch_two_result="$reports_dir/devicectl-launch-2.json"
launch_one_copy_result="$reports_dir/devicectl-copy-report-1.json"
launch_two_copy_result="$reports_dir/devicectl-copy-report-2.json"
launch_one_pass_marker="$reports_dir/launch-1-pass-marker.txt"
launch_two_pass_marker="$reports_dir/launch-2-pass-marker.txt"
lifecycle_runner_report="$reports_dir/device-lifecycle-runner-report.json"
lifecycle_size_report="$reports_dir/release-product-sizes.json"
lifecycle_archive_validation="$reports_dir/release-archive-validation.json"
retained_semantic_product_validation="$reports_dir/retained-semantic-debug-product.json"
lifecycle_launch_one_report="$reports_dir/lifecycle-launch-1-app-report.json"
lifecycle_launch_two_report="$reports_dir/lifecycle-launch-2-app-report.json"
lifecycle_launch_one_validation="$reports_dir/lifecycle-launch-1-validation.json"
lifecycle_launch_two_validation="$reports_dir/lifecycle-launch-2-validation.json"
lifecycle_launch_one_result="$reports_dir/devicectl-lifecycle-launch-1.json"
lifecycle_launch_two_result="$reports_dir/devicectl-lifecycle-launch-2.json"
lifecycle_install_result="$reports_dir/devicectl-install-release-lifecycle.json"
lifecycle_run_token_from_environment="${OLIPHAUNT_IOS_BROKER_LIFECYCLE_RUN_TOKEN:-}"
lifecycle_run_token="${lifecycle_run_token_from_environment:-device-lifecycle-$(date -u +%Y%m%dT%H%M%SZ)-$$}"

generator_log="$logs_dir/generate-project.log"
artifact_preparation_log="$logs_dir/prepare-broker-artifacts.log"
build_log="$logs_dir/xcodebuild-device.log"
install_log="$logs_dir/devicectl-install.log"
launch_one_log="$logs_dir/devicectl-console-launch-1.log"
launch_two_log="$logs_dir/devicectl-console-launch-2.log"
launch_one_copy_log="$logs_dir/devicectl-copy-report-1.log"
launch_two_copy_log="$logs_dir/devicectl-copy-report-2.log"
lifecycle_build_log="$logs_dir/xcodebuild-device-release-lifecycle.log"
lifecycle_archive_log="$logs_dir/xcodebuild-device-release-archive.log"
lifecycle_install_log="$logs_dir/devicectl-install-release-lifecycle.log"
lifecycle_launch_one_log="$logs_dir/devicectl-lifecycle-launch-1.log"
lifecycle_launch_two_log="$logs_dir/devicectl-lifecycle-launch-2.log"
lifecycle_build_result_bundle=""
lifecycle_archive_result_bundle=""
lifecycle_archive_path=""
lifecycle_release_build_app_path=""
validating_release_artifact=0
semantic_app_path=""
semantic_extension_path=""

selected_device_id=""
selected_device_udid=""
selected_device_name=""
selected_device_os=""
selected_device_product=""
selected_device_transport=""
selected_device_developer_mode=""
selected_device_ddi=""
host_executable=""
extension_executable=""
embedded_native_library=""
embedded_native_framework=""
app_path=""
extension_path=""
build_result_bundle=""
console_pid=""
installed=0
failure_reason=""

fail() {
  failure_reason="$*"
  printf 'error: %s\n' "$failure_reason" >&2
  exit 1
}

stop_device_console() {
  [ -n "$console_pid" ] || return 0
  if kill -0 "$console_pid" 2>/dev/null; then
    kill -TERM "$console_pid" 2>/dev/null || true
    local attempts=50
    while [ "$attempts" -gt 0 ] && kill -0 "$console_pid" 2>/dev/null; do
      sleep 0.1
      attempts=$((attempts - 1))
    done
    kill -KILL "$console_pid" 2>/dev/null || true
  fi
  wait "$console_pid" 2>/dev/null || true
  console_pid=""
}

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM
  set +e
  stop_device_console
  if [ "$exit_code" -ne 0 ]; then
    [ -n "$failure_reason" ] || failure_reason="device runner command failed with status $exit_code"
    printf '%s\n' "$failure_reason" >"$reports_dir/failure.txt"
    tail -120 "$launch_one_log" "$launch_two_log" "$launch_one_copy_log" \
      "$launch_two_copy_log" "$install_log" "$build_log" 2>/dev/null >&2
  fi
  if [ "$installed" = "1" ] && [ "$uninstall_after_run" = "YES" ]; then
    xcrun devicectl device uninstall app \
      --device "$selected_device_id" \
      --timeout 30 \
      "$app_bundle_id" >/dev/null 2>&1 || true
  fi
  exit "$exit_code"
}

select_physical_device() {
  xcrun devicectl list devices \
    --timeout 10 \
    --json-output "$device_inventory" \
    >"$logs_dir/devicectl-list.log" 2>&1 || \
    fail "failed to inventory physical iOS devices with devicectl"

  local selection
  selection="$(ruby -rjson - "$device_inventory" "$requested_device_id" \
    "$requested_device_name" "$minimum_ios_major" <<'RUBY'
inventory_path, requested_id, requested_name, minimum_major = ARGV
minimum_major = Integer(minimum_major, 10)
devices = JSON.parse(File.read(inventory_path)).dig("result", "devices") || []
candidates = devices.select do |device|
  hardware = device["hardwareProperties"] || {}
  connection = device["connectionProperties"] || {}
  properties = device["deviceProperties"] || {}
  identifier = device["identifier"] || hardware["udid"]
  version = properties["osVersionNumber"].to_s
  major = version[/\A\d+/].to_i
  next false unless hardware["platform"] == "iOS"
  next false unless hardware["reality"] == "physical"
  next false unless connection["pairingState"] == "paired"
  next false unless major >= minimum_major
  next false if !requested_id.empty? && identifier != requested_id && hardware["udid"] != requested_id
  next false if !requested_name.empty? && properties["name"] != requested_name
  true
end

if candidates.empty?
  warn "no paired physical iOS #{minimum_major}+ device matched the requested selector"
  exit 1
end
if candidates.length > 1
  warn "multiple physical iOS devices matched; set OLIPHAUNT_IOS_BROKER_DEVICE_ID"
  exit 1
end

device = candidates.fetch(0)
hardware = device["hardwareProperties"] || {}
connection = device["connectionProperties"] || {}
properties = device["deviceProperties"] || {}
fields = [
  device["identifier"] || hardware["udid"],
  hardware["udid"],
  properties["name"],
  properties["osVersionNumber"],
  hardware["productType"],
  connection["transportType"],
  properties["developerModeStatus"],
  properties.fetch("ddiServicesAvailable", "unknown"),
]
abort("selected device metadata contains a tab or newline") if fields.any? { |field| field.to_s.match?(/[\t\r\n]/) }
puts fields.map(&:to_s).join("\t")
RUBY
  )" || fail "failed to select a unique paired physical iOS device"

  IFS=$'\t' read -r selected_device_id selected_device_udid selected_device_name selected_device_os \
    selected_device_product selected_device_transport selected_device_developer_mode \
    selected_device_ddi <<EOF
$selection
EOF
  [ -n "$selected_device_id" ] || fail "physical-device selection returned an empty identifier"
  [ -n "$selected_device_udid" ] || fail "physical-device selection returned an empty hardware UDID"
}

preflight_device() {
  xcrun devicectl device info details \
    --device "$selected_device_id" \
    --timeout 10 \
    --json-output "$device_details" \
    >"$logs_dir/devicectl-details.log" 2>&1 || \
    fail "failed to inspect the selected iOS device; unlock and trust it, then retry"
  xcrun devicectl device info lockState \
    --device "$selected_device_id" \
    --timeout 10 \
    --json-output "$device_lock_state" \
    >"$logs_dir/devicectl-lock-state.log" 2>&1 || true

  local device_preflight
  device_preflight="$(ruby -rjson - "$device_details" "$minimum_ios_major" \
    "$selected_device_id" "$selected_device_udid" <<'RUBY'
details_path, minimum_major, expected_identifier, expected_udid = ARGV
minimum_major = Integer(minimum_major, 10)
result = JSON.parse(File.read(details_path))["result"] || {}
properties = result["deviceProperties"] || {}
hardware = result["hardwareProperties"] || {}
name = properties["name"] || "physical iOS device"
version = properties["osVersionNumber"].to_s
major = version[/\A\d+/].to_i
raise "device details CoreDevice identifier changed after selection" unless result["identifier"] == expected_identifier
raise "device details hardware UDID changed after selection" unless hardware["udid"] == expected_udid
raise "selected device is not a physical iOS device" unless hardware["platform"] == "iOS" && hardware["reality"] == "physical"
raise "#{name} runs iOS #{version}, but iOS #{minimum_major}+ is required" if major < minimum_major
mode = properties["developerModeStatus"] || "unknown"
raise "Developer Mode is not enabled on #{name}: #{mode}" unless mode == "enabled"
ddi = properties.fetch("ddiServicesAvailable", "unknown")
raise "Developer Disk Image services are unavailable on #{name}; reconnect/unlock it and let Xcode prepare it" unless ddi == true
puts [name, version, mode, ddi].join("\t")
RUBY
  )" || fail "physical-device preflight failed"

  IFS=$'\t' read -r selected_device_name selected_device_os \
    selected_device_developer_mode selected_device_ddi <<EOF
$device_preflight
EOF
}

configure_broker_device_signing() {
  if [ -z "$development_team" ]; then
    development_team="$(select_xcode_development_team || true)"
  fi
  [ -n "$development_team" ] || \
    fail "set OLIPHAUNT_IOS_BROKER_DEVELOPMENT_TEAM explicitly because Xcode has zero or multiple configured teams"
  [ -n "$code_sign_style" ] || code_sign_style=Automatic

  local identity_count
  identity_count="$(valid_code_signing_identity_count)"
  if [ "${identity_count:-0}" -eq 0 ]; then
    is_truthy "$allow_provisioning_updates" || \
      fail "iPhoneOS builds require a local signing identity or OLIPHAUNT_IOS_BROKER_ALLOW_PROVISIONING_UPDATES=1"
    if [ -z "$allow_device_registration" ]; then
      allow_device_registration=1
    fi
  fi
}

write_preflight_report() {
  local identity_count="$1"
  ruby -rjson - "$preflight_report" "$selected_device_id" "$selected_device_udid" "$selected_device_name" \
    "$selected_device_os" "$selected_device_product" "$selected_device_transport" \
    "$selected_device_developer_mode" "$selected_device_ddi" "$minimum_ios_major" \
    "$identity_count" "$device_inventory" "$device_details" "$device_lock_state" <<'RUBY'
output, identifier, udid, name, os, product, transport, developer_mode, ddi,
  minimum_major, identity_count, inventory, details, lock_state = ARGV
payload = {
  schema: "oliphaunt-ios-broker-device-preflight-v1",
  status: "PASS",
  evidenceType: "physical-device-preflight",
  device: {
    coreDeviceIdentifier: identifier,
    udid: udid,
    name: name,
    os: os,
    productType: product,
    transport: transport,
    developerMode: developer_mode,
    ddiServicesAvailable: ddi == "true",
  },
  requirements: {
    minimumIOSMajor: Integer(minimum_major, 10),
    validCodeSigningIdentities: Integer(identity_count, 10),
    developmentTeamConfigured: true,
  },
  evidence: { inventory: inventory, details: details, lockState: lock_state },
}
File.write(output, JSON.pretty_generate(payload) + "\n")
RUBY
}

validate_broker_artifacts() {
  local xcframework="${OLIPHAUNT_IOS_BROKER_XCFRAMEWORK:-}"
  local resources="${OLIPHAUNT_IOS_BROKER_RESOURCES:-}"
  [ -n "$xcframework" ] || fail "OLIPHAUNT_IOS_BROKER_XCFRAMEWORK is not set"
  [ -n "$resources" ] || fail "OLIPHAUNT_IOS_BROKER_RESOURCES is not set"
  xcframework="$(absolute_path "$xcframework")"
  resources="$(absolute_path "$resources")"
  [ -f "$xcframework/Info.plist" ] || fail "broker XCFramework has no Info.plist: $xcframework"
  [ -d "$resources/oliphaunt" ] || fail "broker resources do not contain oliphaunt/: $resources"

  local metadata slice_identifier slice_library_path slice_product native_library
  metadata="$(plutil -convert json -o - "$xcframework/Info.plist" | ruby -rjson -e '
    libraries = JSON.parse(STDIN.read).fetch("AvailableLibraries")
    slice = libraries.find do |library|
      library["SupportedPlatform"] == "ios" &&
        !library.key?("SupportedPlatformVariant") &&
        Array(library["SupportedArchitectures"]).include?("arm64")
    end
    abort("missing arm64 iOS device slice") unless slice
    puts [slice.fetch("LibraryIdentifier"), slice.fetch("LibraryPath")].join("\t")
  ')" || fail "broker XCFramework has no arm64 iOS device slice"
  IFS=$'\t' read -r slice_identifier slice_library_path <<EOF
$metadata
EOF
  slice_product="$xcframework/$slice_identifier/$slice_library_path"
  case "$slice_library_path" in
    *.framework) ;;
    *) fail "iOS device broker XCFramework must contain a framework, not a loose library" ;;
  esac
  local framework_executable
  framework_executable="$(plutil -extract CFBundleExecutable raw -o - "$slice_product/Info.plist" 2>/dev/null || true)"
  [ -n "$framework_executable" ] || fail "broker framework slice has no executable"
  native_library="$slice_product/$framework_executable"
  [ -f "$native_library" ] || fail "broker device native library is missing: $native_library"
  [ "$(xcrun vtool -show-build "$native_library" 2>/dev/null | awk '/platform / { print $2; exit }')" = "IOS" ] || \
    fail "broker XCFramework selected a non-device native library: $native_library"
  local native_symbols required_symbol
  native_symbols="$(nm -g "$native_library" 2>/dev/null)"
  for required_symbol in \
    _liboliphaunt_selected_static_extensions \
    _oliphaunt_static_vector_Pg_magic_func \
    _oliphaunt_static_pg_trgm_Pg_magic_func; do
    case "$native_symbols" in
      *"$required_symbol"*) ;;
      *) fail "broker device library is missing $required_symbol" ;;
    esac
  done

  local resource_root="$resources/oliphaunt"
  local runtime_manifest="$resource_root/runtime/manifest.properties"
  local template_manifest="$resource_root/template-pgdata/manifest.properties"
  local static_manifest="$resource_root/static-registry/manifest.properties"
  local required_resource
  for required_resource in \
    "$runtime_manifest" \
    "$template_manifest" \
    "$static_manifest" \
    "$resource_root/runtime/files/share/postgresql/postgres.bki" \
    "$resource_root/runtime/files/share/postgresql/extension/vector.control" \
    "$resource_root/runtime/files/share/postgresql/extension/pg_trgm.control" \
    "$resource_root/template-pgdata/files/PG_VERSION"; do
    [ -f "$required_resource" ] || fail "broker resources are incomplete: $required_resource"
  done
  grep -Fqx 'selectedExtensions=pg_trgm,vector' "$runtime_manifest" || \
    fail "broker runtime resources do not select exactly vector,pg_trgm"
  grep -Fqx 'brokerDatabaseRole=oliphaunt_broker' "$template_manifest" || \
    fail "broker template does not seed the restricted database role"
  grep -Fqx 'registeredExtensions=vector,pg_trgm' "$static_manifest" || \
    fail "broker static registry does not register exactly vector,pg_trgm"

  export OLIPHAUNT_IOS_BROKER_XCFRAMEWORK="$xcframework"
  export OLIPHAUNT_IOS_BROKER_RESOURCES="$resources"
  {
    printf 'platform=ios-device\n'
    printf 'architecture=arm64\n'
    printf 'xcframework=%s\n' "$xcframework"
    printf 'deviceLibrary=%s\n' "$native_library"
    printf 'deviceLibrarySHA256=%s\n' "$(shasum -a 256 "$native_library" | awk '{ print $1 }')"
    printf 'resources=%s\n' "$resources"
    printf 'selectedExtensions=pg_trgm,vector\n'
  } >"$artifact_validation_file"
}

validate_built_app() {
  [ -f "$app_path/Info.plist" ] || fail "built host app has no Info.plist: $app_path"
  local observed_bundle_id
  observed_bundle_id="$(plutil -extract CFBundleIdentifier raw -o - "$app_path/Info.plist" 2>/dev/null || true)"
  [ "$observed_bundle_id" = "$app_bundle_id" ] || \
    fail "built host bundle identifier is $observed_bundle_id, expected $app_bundle_id"
  host_executable="$(plutil -extract CFBundleExecutable raw -o - "$app_path/Info.plist" 2>/dev/null || true)"
  safe_process_name "$host_executable" || fail "unsafe or missing host executable: $host_executable"
  [ -x "$app_path/$host_executable" ] || fail "host executable is missing"

  extension_path="$app_path/Extensions/$extension_product_name.appex"
  [ ! -e "$app_path/PlugIns/$extension_product_name.appex" ] || \
    fail "host app contains stale legacy extension packaging"
  [ -d "$extension_path" ] || fail "host app is missing its embedded ExtensionKit extension"
  find "$app_path/Extensions" -mindepth 1 -maxdepth 1 -type d -name '*.appex' -print | \
    LC_ALL=C sort >"$embedded_extensions_file"
  observed_bundle_id="$(plutil -extract CFBundleIdentifier raw -o - "$extension_path/Info.plist" 2>/dev/null || true)"
  [ "$observed_bundle_id" = "$extension_bundle_id" ] || \
    fail "embedded extension bundle identifier is $observed_bundle_id, expected $extension_bundle_id"
  extension_executable="$(plutil -extract CFBundleExecutable raw -o - "$extension_path/Info.plist" 2>/dev/null || true)"
  safe_process_name "$extension_executable" || fail "unsafe or missing extension executable"
  [ -x "$extension_path/$extension_executable" ] || fail "embedded extension executable is missing"

  local host_binary extension_binary
  : >"$host_linkage_file"
  for host_binary in "$app_path/$host_executable" "$app_path/$host_executable.debug.dylib"; do
    [ -f "$host_binary" ] || continue
    otool -L "$host_binary" >>"$host_linkage_file"
  done
  : >"$extension_linkage_file"
  for extension_binary in \
    "$extension_path/$extension_executable" \
    "$extension_path/$extension_executable.debug.dylib"; do
    [ -f "$extension_binary" ] || continue
    otool -L "$extension_binary" >>"$extension_linkage_file"
  done
  local native_framework_link='@rpath/liboliphaunt[.]framework/liboliphaunt'
  local any_native_link='[/@]liboliphaunt([.]framework/liboliphaunt|[.]dylib)'
  ! grep -Eq "$any_native_link" "$host_linkage_file" || \
    fail "broker host unexpectedly links liboliphaunt"
  grep -Eq "$native_framework_link" "$extension_linkage_file" || \
    fail "broker extension does not load @rpath/liboliphaunt.framework/liboliphaunt"

  : >"$extension_host_sdk_symbol_file"
  for extension_binary in \
    "$extension_path/$extension_executable" \
    "$extension_path/$extension_executable.debug.dylib"; do
    [ -f "$extension_binary" ] || continue
    {
      nm "$extension_binary" 2>/dev/null || true
    } | xcrun swift-demangle >>"$extension_host_sdk_symbol_file"
  done
  local host_adapter_symbol_pattern='OliphauntIOSBroker[.]IOSBroker(Manager|Engine|Session)([ .:$]|$)'
  if grep -Eq "$host_adapter_symbol_pattern" "$extension_host_sdk_symbol_file"; then
    fail "broker extension still contains host-only IOSBrokerManager/Engine/Session symbols"
  fi
  printf 'PASS: no IOSBrokerManager/IOSBrokerEngine/IOSBrokerSession symbols\n' \
    >>"$extension_host_sdk_symbol_file"

  : >"$release_fault_symbol_file"
  for extension_binary in \
    "$app_path/$host_executable" \
    "$app_path/$host_executable.debug.dylib" \
    "$extension_path/$extension_executable" \
    "$extension_path/$extension_executable.debug.dylib"; do
    [ -f "$extension_binary" ] || continue
    {
      nm "$extension_binary" 2>/dev/null || true
    } | xcrun swift-demangle >>"$release_fault_symbol_file"
  done
  case "$validating_release_artifact" in
    1)
      if grep -Eq 'BrokerFaultInjector|WorkerCore.*injectFault|IOSBrokerSession.*injectFault|ExtendedFaultMatrix|HangFaultMatrix' \
        "$release_fault_symbol_file"; then
        fail "Release broker products still contain DEBUG fault-injection implementation symbols"
      fi
      printf 'PASS: no DEBUG fault-injection implementation symbols\n' \
        >>"$release_fault_symbol_file"
      ;;
    *)
      printf 'INFO: DEBUG product fault symbols intentionally not gated here\n' \
        >>"$release_fault_symbol_file"
      ;;
  esac

  if find "$app_path" -type f -name 'liboliphaunt.dylib' -print -quit | grep -q .; then
    fail "signed device app contains a forbidden loose liboliphaunt.dylib"
  fi
  if [ -d "$extension_path/Frameworks/liboliphaunt.framework" ]; then
    fail "device broker framework must be embedded by the host, not duplicated in the extension"
  fi
  [ -d "$app_path/Frameworks" ] || fail "signed device host is missing its Frameworks directory"
  find "$app_path/Frameworks" -type f -path '*/liboliphaunt.framework/liboliphaunt' \
    -print | LC_ALL=C sort >"$embedded_native_file"
  [ "$(wc -l <"$embedded_native_file" | tr -d '[:space:]')" = "1" ] || \
    fail "broker host must embed exactly one liboliphaunt framework"
  embedded_native_library="$(cat "$embedded_native_file")"
  embedded_native_framework="$(dirname "$embedded_native_library")"
  [ "$embedded_native_framework" = "$app_path/Frameworks/liboliphaunt.framework" ] || \
    fail "broker framework is not in the host Frameworks directory"
  [ "$(xcrun vtool -show-build "$embedded_native_library" 2>/dev/null | awk '/platform / { print $2; exit }')" = "IOS" ] || \
    fail "embedded liboliphaunt is not an iOS device binary"

  local resource_root="$extension_path/oliphaunt"
  local relative resource_file
  : >"$extension_resources_file"
  for relative in \
    runtime/manifest.properties \
    template-pgdata/manifest.properties \
    static-registry/manifest.properties \
    runtime/files/share/postgresql/postgres.bki \
    runtime/files/share/postgresql/extension/vector.control \
    runtime/files/share/postgresql/extension/pg_trgm.control \
    template-pgdata/files/PG_VERSION; do
    resource_file="$resource_root/$relative"
    [ -f "$resource_file" ] || fail "embedded broker extension resource is missing: $relative"
    printf '%s\t%s\t%s\n' "$relative" \
      "$(wc -c <"$resource_file" | tr -d '[:space:]')" \
      "$(shasum -a 256 "$resource_file" | awk '{ print $1 }')" \
      >>"$extension_resources_file"
  done
  grep -Fqx 'brokerDatabaseRole=oliphaunt_broker' \
    "$resource_root/template-pgdata/manifest.properties" || \
    fail "embedded broker template lost its restricted database role"
  if find "$resource_root" -type f \( -name '*.dylib' -o -name '*.so' \) -print -quit | grep -q .; then
    fail "embedded broker resource tree contains a dynamic extension module"
  fi

  for resource_file in \
    "$app_path/embedded.mobileprovision" \
    "$extension_path/embedded.mobileprovision"; do
    [ -f "$resource_file" ] || fail "signed device bundle is missing $(basename "$resource_file")"
  done
  codesign --verify --deep --strict "$app_path" >"$signing_validation_file" 2>&1 || \
    fail "host app failed strict code-signature verification"
  codesign --verify --strict "$extension_path" >>"$signing_validation_file" 2>&1 || \
    fail "extension failed strict code-signature verification"
  codesign --verify --strict "$embedded_native_framework" >>"$signing_validation_file" 2>&1 || \
    fail "embedded liboliphaunt failed strict code-signature verification"
  local signed_item observed_team
  for signed_item in "$app_path" "$extension_path" "$embedded_native_framework"; do
    observed_team="$(codesign -dv --verbose=4 "$signed_item" 2>&1 | sed -n 's/^TeamIdentifier=//p' | tail -1)"
    [ "$observed_team" = "$development_team" ] || \
      fail "signed product team does not match OLIPHAUNT_IOS_BROKER_DEVELOPMENT_TEAM"
    printf '%s\tteam-match\n' "$signed_item" >>"$signing_validation_file"
  done
}

extract_console_report() {
  local console_log="$1"
  local output_report="$2"
  ruby -rjson - "$console_log" "$output_report" "$json_marker" <<'RUBY' 2>/dev/null
log_path, output_path, marker = ARGV
line = File.foreach(log_path).select { |candidate| candidate.include?(marker) }.last
exit 1 unless line
payload = line.split(marker, 2).fetch(1).strip
report = JSON.parse(payload)
File.write(output_path, JSON.generate(report) + "\n")
RUBY
}

latest_console_marker() {
  local marker="$1"
  local console_log="$2"
  grep -F "$marker " "$console_log" 2>/dev/null | tail -1 || true
}

validate_app_report() {
  local report_path="$1"
  local validation_path="$2"
  ruby -rjson - "$report_path" "$validation_path" <<'RUBY'
report_path, validation_path = ARGV
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
uuid = /\A[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\z/
raise "app report has invalid epoch" unless epoch.is_a?(String) && epoch.match?(uuid)
expected_checks = %w[
  extensionDiscovery separatePID xpcSession fdTransfer workerDiagnostics
  openedIdleMemory capabilities realSelect ddl write parameterizedQuery
  pgdataPathConfidentiality
  postgresErrorRecovery vectorExtension pgTrgmExtension fragmentedFrame
  boundedRequestAssembly multiFrameRequest streamingResponse simultaneousHandles
  fifoSerialization referenceCounting transactionHandlePinning cancellation
  postCancelLiveness checkpointControl backgroundLifecycle sameRootReopen
  outcomeUnknown postCommitAmbiguity crashRecovery preCommitRollbackRecovery
  noAutomaticReplay
]
checks = result["checks"]
raise "app report checks must be an array" unless checks.is_a?(Array)
missing = expected_checks - checks
raise "app report is missing checks: #{missing.join(",")}" unless missing.empty?
unexpected = checks - expected_checks
raise "app report has unexpected checks: #{unexpected.join(",")}" unless unexpected.empty?
raise "app report check matrix contains duplicates" unless checks.uniq.length == expected_checks.length

recovered_epochs = result["recoveredEpochs"]
raise "app report must contain exactly three recovered epochs" unless recovered_epochs.is_a?(Array) && recovered_epochs.length == 3
raise "app report recovered epochs are not unique" unless recovered_epochs.uniq.length == 3
raise "app report contains an invalid recovered epoch" unless recovered_epochs.all? { |value| value.is_a?(String) && value.match?(uuid) }
raise "initial epoch appears in recovered epochs" if recovered_epochs.include?(epoch)

diagnostics = result["diagnostics"]
raise "app report diagnostics must be an array" unless diagnostics.is_a?(Array)
recovery_phases = %w[openedIdle sameRootReopen postCommitRecovery preCommitRecovery]
recovery_evidence = recovery_phases.map do |phase|
  matches = diagnostics.select { |entry| entry["phase"] == phase }
  raise "app report must contain exactly one #{phase} diagnostic" unless matches.length == 1
  matches.fetch(0)
end
diagnostic_epochs = recovery_evidence.map { |entry| entry["epoch"] }
raise "diagnostic recovery epochs are invalid" unless diagnostic_epochs.all? { |value| value.is_a?(String) && value.match?(uuid) }
raise "diagnostic recovery epochs are not unique" unless diagnostic_epochs.uniq.length == 4
raise "initial epoch disagrees with openedIdle diagnostic" unless diagnostic_epochs.first == epoch
raise "diagnostic recovered epochs disagree with result" unless diagnostic_epochs.drop(1).sort == recovered_epochs.sort
diagnostic_pids = recovery_evidence.map { |entry| entry["workerPID"] }
raise "diagnostic worker PIDs are invalid" unless diagnostic_pids.all? { |value| value.is_a?(Integer) && value.positive? && value != host_pid }
raise "initial worker PID disagrees with openedIdle diagnostic" unless diagnostic_pids.first == worker_pid
raise "same-root reopen did not reuse the live worker process" unless diagnostic_pids[1] == diagnostic_pids[0]
raise "post-commit recovery did not start a fresh worker process" if diagnostic_pids[2] == diagnostic_pids[0]
raise "pre-commit recovery did not start a fresh worker process" if diagnostic_pids[3] == diagnostic_pids[0]
raise "crash recovery cycles reused a worker process" if diagnostic_pids[3] == diagnostic_pids[2]
raise "recovery diagnostics must prove exactly three worker processes" unless diagnostic_pids.uniq.length == 3

observations = result["observations"]
raise "app report observations must be an object" unless observations.is_a?(Hash)
raise "app report used the wrong database role" unless observations["restrictedDatabaseRole"] == "oliphaunt_broker"
raise "app report assigned the database to the broker role" unless observations["databaseOwner"] == "postgres"
raise "app report assigned selected extensions to the broker role" unless observations["selectedExtensionOwners"] == "pg_trgm:postgres,vector:postgres"
raise "app report omitted the broker-owned working schema" unless observations["brokerSchemaOwner"] == "oliphaunt_broker"
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
  raise "app report did not deny #{key}" unless observations[key] == "42501"
end
raise "app report did not preserve the sanitized backend SQLSTATE" unless observations["sanitizedBackendErrorSQLState"] == "F0000"
raise "app report did not restore the broker search path after DISCARD ALL" unless observations["afterDiscardSearchPath"] == "{oliphaunt_broker,public}"
raise "app report exposed data_directory through pg_settings" unless observations["pgSettingsDataDirectoryRows"] == "0"
%w[
  restrictedFunctionExecuteCount restrictedViewSelectCount
  pgSettingsSourcePathRows visiblePrivatePathSettingRows
].each do |key|
  raise "app report exposed private catalog/path evidence through #{key}" unless observations[key] == "0"
end
raise "app report found a non-default tablespace" unless observations["nonDefaultTablespaceCount"] == "0"
raise "manager launch count is not 4" unless Integer(observations.fetch("launchCount"), 10) == 4
raise "manager interruption count is not 2" unless Integer(observations.fetch("interruptionCount"), 10) == 2
streamed_bytes = Integer(observations.fetch("streamedBytes"), 10)
streamed_chunks = Integer(observations.fetch("streamedChunks"), 10)
raise "streamed response byte evidence is too small" unless streamed_bytes > 2 * 1024 * 1024
raise "streamed response was not delivered in multiple chunks" unless streamed_chunks > 1
File.write(validation_path, JSON.pretty_generate({
  status: "PASS",
  hostPID: host_pid,
  workerPID: worker_pid,
  epoch: epoch,
  recoveredEpochs: recovered_epochs,
  recoveryWorkerPIDs: diagnostic_pids,
  checks: checks,
  launchCount: 4,
  interruptionCount: 2,
  streamedBytes: streamed_bytes,
  streamedChunks: streamed_chunks,
}) + "\n")
RUBY
}

pull_app_report() {
  local launch_index="$1"
  local destination_report="$2"
  local copy_result="$3"
  local copy_log="$4"
  local pull_directory="$reports_dir/pulled-launch-$launch_index-$$"
  local pulled_report="$pull_directory/broker-spike-report.json"
  mkdir -p "$pull_directory"
  if ! xcrun devicectl device copy from \
    --device "$selected_device_id" \
    --source "Documents/broker-spike-report.json" \
    --destination "$pulled_report" \
    --domain-type appDataContainer \
    --domain-identifier "$app_bundle_id" \
    --timeout 30 \
    --json-output "$copy_result" \
    >"$copy_log" 2>&1; then
    tail -80 "$copy_log" >&2 || true
    fail "failed to pull launch $launch_index app report from the device"
  fi
  [ -f "$pulled_report" ] || \
    fail "device copy did not produce the launch $launch_index broker report"
  cp "$pulled_report" "$destination_report"
}

is_explicit_locked_launch_failure() {
  local launch_json="$1"
  [ -s "$launch_json" ] || return 1
  ruby -rjson - "$launch_json" <<'RUBY' >/dev/null 2>&1
report = JSON.parse(File.read(ARGV.fetch(0)))
error = report["error"] || {}
exit 1 unless report.dig("info", "outcome") == "failed"
exit 1 unless error["domain"] == "com.apple.dt.CoreDeviceError"
exit 1 unless error["code"] == 10_002
exit 1 if report.key?("result")

domains = []
strings = []
walk = lambda do |value|
  case value
  when Hash
    domains << value["domain"] if value["domain"].is_a?(String)
    value.each_value { |child| walk.call(child) }
  when Array
    value.each { |child| walk.call(child) }
  when String
    strings << value
  end
end
walk.call(error)
exit 1 unless domains.include?("FBSOpenApplicationServiceErrorDomain")
exit 1 unless domains.include?("FBSOpenApplicationErrorDomain")
locked = strings.any? do |value|
  value.include?("reason: Locked") ||
    value.include?("because the device was not, or could not be, unlocked")
end
exit(locked ? 0 : 1)
RUBY
}

run_probe_launch() {
  local launch_index="$1"
  local app_report="$2"
  local console_report="$3"
  local validation_report="$4"
  local console_log="$5"
  local launch_json="$6"
  local copy_json="$7"
  local copy_log="$8"
  local pass_marker="$9"
  local deadline report_valid pass_line failure_line
  local lock_retry_deadline launch_attempt

  : >"$console_log"
  : >"$console_report"
  : >"$app_report"
  : >"$validation_report"
  : >"$pass_marker"
  printf 'Launching physical-device probe %s of 2 without reinstall...\n' "$launch_index"
  lock_retry_deadline=$((SECONDS + 120))
  launch_attempt=0
  while :; do
    launch_attempt=$((launch_attempt + 1))
    : >"$console_log"
    : >"$launch_json"
    xcrun devicectl device process launch \
      --device "$selected_device_id" \
      --terminate-existing \
      --console \
      --environment-variables "{\"NSUnbufferedIO\":\"YES\",\"OLIPHAUNT_BROKER_DEVICE_LAUNCH_INDEX\":\"$launch_index\",\"OLIPHAUNT_BROKER_FIXTURE_DISABLE_IDLE_TIMER\":\"YES\"}" \
      --timeout "$((timeout_seconds + 60))" \
      --json-output "$launch_json" \
      "$app_bundle_id" >"$console_log" 2>&1 &
    console_pid=$!

    deadline=$((SECONDS + timeout_seconds))
    report_valid=0
    pass_line=""
    while [ "$SECONDS" -lt "$deadline" ]; do
      failure_line="$(latest_console_marker "$failure_marker" "$console_log")"
      [ -z "$failure_line" ] || \
        fail "broker spike launch $launch_index emitted failure marker: $failure_line"
      if [ "$report_valid" = "0" ] && extract_console_report "$console_log" "$console_report"; then
        validate_app_report "$console_report" "$validation_report" || \
          fail "broker spike launch $launch_index emitted an invalid console report"
        report_valid=1
      fi
      pass_line="$(latest_console_marker "$success_marker" "$console_log")"
      if [ "$report_valid" = "1" ] && [ -n "$pass_line" ]; then
        break
      fi
      if ! kill -0 "$console_pid" 2>/dev/null; then
        wait "$console_pid" 2>/dev/null || true
        console_pid=""
        if [ "$report_valid" = "0" ] && [ -z "$pass_line" ] && \
          is_explicit_locked_launch_failure "$launch_json"; then
          [ "$SECONDS" -lt "$lock_retry_deadline" ] || \
            fail "device remained locked for the bounded pre-launch retry window"
          printf 'Device explicitly rejected probe %s pre-launch as Locked; waiting to retry (%s)...\n' \
            "$launch_index" "$launch_attempt"
          sleep 2
          continue 2
        fi
        fail "physical-device app or console ended before launch $launch_index PASS"
      fi
      sleep 1
    done
    [ "$report_valid" = "1" ] || \
      fail "timed out waiting for physical-device launch $launch_index console report"
    [ -n "$pass_line" ] || \
      fail "timed out waiting for launch $launch_index authoritative $success_marker marker"

    pull_app_report "$launch_index" "$app_report" "$copy_json" "$copy_log"
    validate_app_report "$app_report" "$validation_report" || \
      fail "pulled launch $launch_index app report is invalid"
    ruby -rjson - "$console_report" "$app_report" <<'RUBY' || \
      fail "launch $launch_index console and pulled reports disagree"
console_path, pulled_path = ARGV
console = JSON.parse(File.read(console_path))
pulled = JSON.parse(File.read(pulled_path))
raise "console/pulled report mismatch" unless console == pulled
RUBY
    printf '%s\n' "$pass_line" >"$pass_marker"
    stop_device_console
    [ -s "$launch_json" ] || fail "devicectl did not write launch $launch_index result JSON"
    sleep 2
    return 0
  done
}

copy_lifecycle_report() {
  local launch_index="$1"
  local attempt="$2"
  local destination_report="$3"
  local poll_directory="$reports_dir/lifecycle-pulls-$launch_index-$$/attempt-$attempt"
  local pulled_report="$poll_directory/broker-lifecycle-report.json"
  local copy_result="$poll_directory/devicectl-copy.json"
  local copy_log="$poll_directory/devicectl-copy.log"
  mkdir -p "$poll_directory"
  xcrun devicectl device copy from \
    --device "$selected_device_id" \
    --source "Documents/broker-lifecycle-report.json" \
    --destination "$pulled_report" \
    --domain-type appDataContainer \
    --domain-identifier "$app_bundle_id" \
    --timeout 15 \
    --json-output "$copy_result" \
    >"$copy_log" 2>&1 || return 1
  [ -f "$pulled_report" ] || return 1
  cp "$pulled_report" "$destination_report"
}

wait_for_lifecycle_phase() {
  local launch_index="$1"
  local expected_phase="$2"
  local destination_report="$3"
  local deadline=$((SECONDS + timeout_seconds))
  local attempt=0 state
  while [ "$SECONDS" -lt "$deadline" ]; do
    attempt=$((attempt + 1))
    if copy_lifecycle_report "$launch_index" "$attempt" "$destination_report"; then
      state="$(ruby -rjson - "$destination_report" "$lifecycle_run_token" \
        "$launch_index" "$expected_phase" <<'RUBY' 2>/dev/null || true
path, token, launch_index, expected_phase = ARGV
report = JSON.parse(File.read(path))
exit 1 unless report["runToken"] == token
exit 1 unless report["launchIndex"] == Integer(launch_index, 10)
if report["status"] == "fail" || report["phase"] == "failed"
  puts "FAIL:#{report["error"] || "unspecified lifecycle failure"}"
elsif report["phase"] == expected_phase
  puts "MATCH"
else
  puts "WAIT:#{report["phase"]}"
end
RUBY
      )"
      case "$state" in
        MATCH) return 0 ;;
        FAIL:*) fail "lifecycle launch $launch_index failed: ${state#FAIL:}" ;;
      esac
    fi
    sleep 1
  done
  fail "timed out waiting for lifecycle launch $launch_index phase $expected_phase"
}

wait_for_lifecycle_foreground_active() {
  local launch_index="$1"
  local destination_report="$2"
  local deadline=$((SECONDS + 30))
  local attempt=0 state
  while [ "$SECONDS" -lt "$deadline" ]; do
    attempt=$((attempt + 1))
    if copy_lifecycle_report \
      "$launch_index" "foreground-active-$attempt" "$destination_report"; then
      state="$(ruby -rjson - "$destination_report" "$lifecycle_run_token" \
        "$launch_index" <<'RUBY' 2>/dev/null || true
path, token, launch_index = ARGV
report = JSON.parse(File.read(path))
exit 1 unless report["runToken"] == token
exit 1 unless report["launchIndex"] == Integer(launch_index, 10)
if report["status"] == "fail" || report["phase"] == "failed"
  puts "FAIL:#{report["error"] || "unspecified lifecycle failure"}"
elsif Array(report["events"]).last&.fetch("kind", nil) == "active"
  puts "MATCH"
else
  puts "WAIT"
end
RUBY
      )"
      case "$state" in
        MATCH) return 0 ;;
        FAIL:*) fail "lifecycle launch $launch_index failed: ${state#FAIL:}" ;;
      esac
    fi
    sleep 1
  done
  fail "lifecycle launch $launch_index never entered an active foreground scene"
}

lifecycle_report_integer() {
  ruby -rjson -e '
    value = ARGV.drop(1).reduce(JSON.parse(File.read(ARGV.fetch(0)))) { |memo, key| memo.fetch(key) }
    abort("lifecycle report value is not a positive integer") unless value.is_a?(Integer) && value.positive?
    puts value
  ' "$@"
}

lifecycle_report_string() {
  ruby -rjson -e '
    value = ARGV.drop(1).reduce(JSON.parse(File.read(ARGV.fetch(0)))) { |memo, key| memo.fetch(key) }
    abort("lifecycle report value is not a string") unless value.is_a?(String) && !value.empty?
    puts value
  ' "$@"
}

classify_suspended_process_inventory() {
  local inventory_path="$1"
  local host_pid="$2"
  local worker_pid="$3"
  local expected_device_id="$4"
  ruby -rjson - "$inventory_path" "$host_pid" "$worker_pid" \
    "$expected_device_id" <<'RUBY'
inventory_path, host_pid, worker_pid, expected_device_id = ARGV
host_pid = Integer(host_pid, 10)
worker_pid = Integer(worker_pid, 10)
raise "host and worker PIDs collide" if host_pid == worker_pid

inventory = JSON.parse(File.read(inventory_path))
raise "process inventory outcome was not success" unless inventory.dig("info", "outcome") == "success"
raise "process inventory belongs to a different device" unless inventory.dig("result", "deviceIdentifier") == expected_device_id
processes = inventory.dig("result", "runningProcesses")
raise "process inventory omitted runningProcesses" unless processes.is_a?(Array)
process_ids = processes.map do |process|
  raise "process inventory entry is not an object" unless process.is_a?(Hash)
  pid = process["processIdentifier"]
  raise "process inventory entry has an invalid PID" unless pid.is_a?(Integer) && pid.positive?
  pid
end
raise "process inventory contains duplicate PIDs" unless process_ids.uniq.length == process_ids.length
unexpected_pids = process_ids - [host_pid, worker_pid]
raise "process inventory contains unexpected PIDs" unless unexpected_pids.empty?
raise "suspended host is absent from process inventory" unless process_ids.include?(host_pid)

case process_ids.sort
when [host_pid].sort
  puts "workerAbsent"
when [host_pid, worker_pid].sort
  puts "workerPresent"
else
  raise "process inventory has an unrecognized host/worker state"
end
RUBY
}

is_exact_devicectl_esrch_failure() {
  ruby -rjson -e '
    result = JSON.parse(File.read(ARGV.fetch(0)))
    exact_esrch = result.dig("info", "outcome") == "failed" &&
      result.dig("error", "domain") == "NSPOSIXErrorDomain" &&
      result.dig("error", "code") == 3
    exit(exact_esrch ? 0 : 1)
  ' "$1" 2>/dev/null
}

validate_lifecycle_report() {
  local report_path="$1"
  local validation_path="$2"
  local launch_index="$3"
  local expect_worker_kill="$4"
  local worker_termination_mode="$5"
  local foreground_inventory_path="$6"
  local suspend_result_path="$7"
  local suspended_inventory_path="$8"
  local worker_terminate_result_path="$9"
  local post_terminate_inventory_path="${10}"
  local expected_device_id="${11}"
  ruby -rjson - "$report_path" "$validation_path" "$lifecycle_run_token" \
    "$launch_index" "$expect_worker_kill" "$worker_termination_mode" \
    "$timeout_seconds" "$foreground_inventory_path" "$suspend_result_path" \
    "$suspended_inventory_path" "$worker_terminate_result_path" \
    "$post_terminate_inventory_path" "$expected_device_id" <<'RUBY'
report_path, validation_path, run_token, launch_index, expect_worker_kill,
  worker_termination_mode, runner_timeout_seconds, foreground_inventory_path,
  suspend_result_path, suspended_inventory_path,
  worker_terminate_result_path, post_terminate_inventory_path,
  expected_device_id = ARGV
launch_index = Integer(launch_index, 10)
expect_worker_kill = expect_worker_kill == "YES"
runner_timeout_seconds = Integer(runner_timeout_seconds, 10)
report = JSON.parse(File.read(report_path))
raise "lifecycle schema mismatch" unless report["schemaVersion"] == 1
raise "lifecycle run token mismatch" unless report["runToken"] == run_token
raise "lifecycle launch index mismatch" unless report["launchIndex"] == launch_index
raise "lifecycle report did not pass: #{report["error"]}" unless report["status"] == "pass" && report["phase"] == "completed"
raise "lifecycle worker-kill expectation mismatch" unless report["expectWorkerKill"] == expect_worker_kill
accepted_worker_termination_modes = %w[
  explicitSIGKILL workerAbsentAtPostSuspendInventory exitedDuringKillRace
]
if expect_worker_kill
  raise "worker termination mode did not prove suspended unavailability" unless accepted_worker_termination_modes.include?(worker_termination_mode)
else
  raise "ordinary resume unexpectedly recorded worker termination" unless worker_termination_mode == "notRequested"
end

uuid = /\A[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\z/
host_pid = report.fetch("hostPID")
initial_pid = report.fetch("initialWorkerPID")
resumed_pid = report.fetch("currentWorkerPID")
initial_epoch = report.fetch("initialEpoch")
resumed_epoch = report.fetch("currentEpoch")
raise "invalid lifecycle host/worker PID" unless [host_pid, initial_pid, resumed_pid].all? { |pid| pid.is_a?(Integer) && pid.positive? }
raise "host and lifecycle worker PID collide" if host_pid == initial_pid || host_pid == resumed_pid
raise "invalid lifecycle epoch" unless [initial_epoch, resumed_epoch].all? { |epoch| epoch.is_a?(String) && epoch.match?(uuid) }
if expect_worker_kill
  raise "killed background worker reused its PID" if resumed_pid == initial_pid
  raise "killed background worker reused its epoch" if resumed_epoch == initial_epoch
else
  same_worker = resumed_pid == initial_pid && resumed_epoch == initial_epoch
  fresh_worker = resumed_pid != initial_pid && resumed_epoch != initial_epoch
  raise "resume produced a mixed stale PID/epoch identity" unless same_worker || fresh_worker
end
raise "lifecycle report omitted its manifest digest" if report.fetch("manifestDigest").to_s.empty?

parse_inventory = lambda do |path|
  inventory = JSON.parse(File.read(path))
  raise "process inventory outcome was not success" unless inventory.dig("info", "outcome") == "success"
  raise "process inventory belongs to a different device" unless inventory.dig("result", "deviceIdentifier") == expected_device_id
  processes = inventory.dig("result", "runningProcesses")
  raise "process inventory omitted runningProcesses" unless processes.is_a?(Array)
  process_ids = processes.map do |process|
    raise "process inventory entry is not an object" unless process.is_a?(Hash)
    pid = process["processIdentifier"]
    raise "process inventory entry has an invalid PID" unless pid.is_a?(Integer) && pid.positive?
    pid
  end
  raise "process inventory contains duplicate PIDs" unless process_ids.uniq.length == process_ids.length
  raise "process inventory contains unexpected PIDs" unless (process_ids - [host_pid, initial_pid]).empty?
  raise "suspended host is not present exactly once" unless process_ids.count(host_pid) == 1
  process_ids
end

foreground_process_ids = parse_inventory.call(foreground_inventory_path)
raise "foreground-ready inventory did not include the worker" unless foreground_process_ids.include?(initial_pid)
suspend_result = JSON.parse(File.read(suspend_result_path))
raise "suspend command outcome was not success" unless suspend_result.dig("info", "outcome") == "success"
raise "suspend result belongs to a different device" unless suspend_result.dig("result", "deviceIdentifier") == expected_device_id
raise "suspend result names the wrong host PID" unless suspend_result.dig("result", "process", "processIdentifier") == host_pid
suspend_signal = suspend_result.dig("result", "signal")
raise "suspend result has an invalid signal object" unless suspend_signal.is_a?(Hash)
raise "suspend result did not deliver SIGSTOP" unless suspend_signal["name"] == "SIGSTOP" && suspend_signal["value"] == 17
suspended_process_ids = parse_inventory.call(suspended_inventory_path)
worker_present_at_post_suspend_inventory = suspended_process_ids.include?(initial_pid)

post_terminate_process_ids = nil
worker_terminate_result = nil
case worker_termination_mode
when "explicitSIGKILL"
  worker_terminate_result = JSON.parse(File.read(worker_terminate_result_path))
  raise "worker terminate command outcome was not success" unless worker_terminate_result.dig("info", "outcome") == "success"
  raise "worker terminate result belongs to a different device" unless worker_terminate_result.dig("result", "deviceIdentifier") == expected_device_id
  raise "worker terminate result names the wrong PID" unless worker_terminate_result.dig("result", "process", "processIdentifier") == initial_pid
  terminate_signal = worker_terminate_result.dig("result", "signal")
  raise "worker terminate result has an invalid signal object" unless terminate_signal.is_a?(Hash)
  raise "worker terminate result did not deliver SIGKILL" unless terminate_signal["name"] == "SIGKILL" && terminate_signal["value"] == 9
  post_terminate_process_ids = parse_inventory.call(post_terminate_inventory_path)
  raise "explicitly killed worker remained in the post-terminate inventory" if post_terminate_process_ids.include?(initial_pid)
when "workerAbsentAtPostSuspendInventory"
  raise "absent-worker mode found the worker in the post-suspend inventory" if worker_present_at_post_suspend_inventory
  worker_terminate_result = JSON.parse(File.read(worker_terminate_result_path))
  exact_esrch = worker_terminate_result.dig("info", "outcome") == "failed" &&
    worker_terminate_result.dig("error", "domain") == "NSPOSIXErrorDomain" &&
    worker_terminate_result.dig("error", "code") == 3
  raise "absent-worker mode did not record exact ESRCH" unless exact_esrch
  post_terminate_process_ids = parse_inventory.call(post_terminate_inventory_path)
  raise "worker appeared in the post-ESRCH inventory" if post_terminate_process_ids.include?(initial_pid)
when "exitedDuringKillRace"
  raise "kill-race mode began with an absent worker" unless worker_present_at_post_suspend_inventory
  worker_terminate_result = JSON.parse(File.read(worker_terminate_result_path))
  exact_esrch = worker_terminate_result.dig("info", "outcome") == "failed" &&
    worker_terminate_result.dig("error", "domain") == "NSPOSIXErrorDomain" &&
    worker_terminate_result.dig("error", "code") == 3
  raise "kill-race mode did not record exact ESRCH" unless exact_esrch
  post_terminate_process_ids = parse_inventory.call(post_terminate_inventory_path)
  raise "worker remained in the post-ESRCH inventory" if post_terminate_process_ids.include?(initial_pid)
when "notRequested"
  raise "ordinary resume unexpectedly attempted worker termination" unless File.zero?(worker_terminate_result_path)
  raise "ordinary resume unexpectedly wrote a post-terminate inventory" unless File.zero?(post_terminate_inventory_path)
else
  raise "unrecognized worker termination evidence mode"
end
if !expect_worker_kill && !worker_present_at_post_suspend_inventory
  raise "worker absent before ordinary resume reused its PID" if resumed_pid == initial_pid
  raise "worker absent before ordinary resume reused its epoch" if resumed_epoch == initial_epoch
end

checks = Array(report["checks"])
required_checks = %w[
  extensionDiscovery separatePID workerDiagnostics backgroundContinuableFalse
  openedIdleMemory availableMemory capabilities crossLaunchPersistence sizableRelation
  protocolRTT cancellation postCancelLiveness executingMemory slowStreamThroughput
  slowStreamTwoSizes slowStreamBoundedHeadroom
  checkpointControl checkpointDiagnostics expiredDeadlineAdmission
  backgroundCancellation backgroundAdmissionClosed backgroundDeadline
  recursiveStorageProtection relationAndWALFreshness actualBackground
  backgroundResume postResumeHealth postResumeMemory postResumePersistence
]
if expect_worker_kill
  required_checks << "backgroundWorkerKillRecovery"
elsif !(checks.include?("backgroundSameWorkerResume") || checks.include?("backgroundFreshWorkerResume"))
  raise "ordinary resume proved neither same-worker liveness nor fresh-worker recovery"
end
missing = required_checks - checks
raise "lifecycle report is missing checks: #{missing.join(",")}" unless missing.empty?
raise "lifecycle checks contain duplicates" unless checks.uniq.length == checks.length

events = Array(report["events"])
scene_phases = events.map { |event| event["kind"] }
event_uptimes = events.map { |event| Integer(event.fetch("observedAtUptimeNanoseconds")) }
raise "lifecycle event uptimes are not strictly monotonic" unless event_uptimes.each_cons(2).all? { |left, right| left < right }
application_state_events = events.reject { |event| event["kind"] == "memoryWarning" }
application_state_kinds = application_state_events.map { |event| event["kind"] }
raise "lifecycle application-state events contain adjacent duplicates" unless application_state_kinds.each_cons(2).all? { |left, right| left != right }
raise "app did not observe inactive lifecycle phase" unless scene_phases.include?("inactive")
raise "app did not observe background lifecycle phase" unless scene_phases.include?("background")
raise "app did not observe foreground resume" unless scene_phases.count("active") >= 2

observations = report.fetch("observations")
foreground_active_uptime = Integer(observations.fetch("foregroundActiveUptimeNanoseconds"), 10)
background_cutoff_uptime = Integer(
  observations.fetch("backgroundTransitionNotBeforeUptimeNanoseconds"), 10
)
background_transition_uptime = Integer(
  observations.fetch("backgroundTransitionUptimeNanoseconds"), 10
)
background_observed_uptime = Integer(
  observations.fetch("backgroundObservedUptimeNanoseconds"), 10
)
resumed_active_uptime = Integer(
  observations.fetch("resumedActiveUptimeNanoseconds"), 10
)
initial_active = events.find do |event|
  event["kind"] == "active" && event["observedAtUptimeNanoseconds"] == foreground_active_uptime
end
raise "initial foreground-active observation is inconsistent" unless initial_active
latest_state_at_cutoff = application_state_events
  .select { |event| event["observedAtUptimeNanoseconds"].to_i <= background_cutoff_uptime }
  .last
raise "host was not active when the background handoff was armed" unless latest_state_at_cutoff&.fetch("kind") == "active"
transition = events.find do |event|
  event["kind"] == "inactive" &&
    event["observedAtUptimeNanoseconds"].to_i == background_transition_uptime &&
    background_transition_uptime > background_cutoff_uptime
end
raise "no deliberate post-ready background transition was observed" unless transition
background = events.find do |event|
  event["kind"] == "background" &&
    event["observedAtUptimeNanoseconds"].to_i == background_observed_uptime &&
    background_observed_uptime > background_transition_uptime
end
raise "no actual background event followed the deliberate transition" unless background
foregrounding = events.find do |event|
  event["kind"] == "inactive" &&
    event["observedAtUptimeNanoseconds"].to_i > background_observed_uptime &&
    event["observedAtUptimeNanoseconds"].to_i < resumed_active_uptime
end
raise "no inactive foregrounding transition followed actual background" unless foregrounding
resumed_active = events.find do |event|
  event["kind"] == "active" &&
    event["observedAtUptimeNanoseconds"].to_i == resumed_active_uptime &&
    resumed_active_uptime > background_observed_uptime
end
raise "no foreground-active event followed actual background" unless resumed_active

raise "lifecycle qualification was not a Release build" unless observations.fetch("buildConfiguration") == "release"
orchestration_timeout = Integer(observations.fetch("orchestrationTimeoutSeconds"), 10)
background_work_seconds = Integer(observations.fetch("backgroundActiveWorkSeconds"), 10)
request_deadline_seconds = Integer(observations.fetch("requestDeadlineSeconds"), 10)
raise "fixture orchestration timeout disagrees with the runner" unless orchestration_timeout == runner_timeout_seconds
raise "background active-work duration is not twice the orchestration window" unless background_work_seconds == 2 * orchestration_timeout
raise "broker request deadline is not three times the orchestration window" unless request_deadline_seconds == 3 * orchestration_timeout
large_stream_bytes = Integer(observations.fetch("slowStreamBytes"), 10)
small_stream_bytes = Integer(observations.fetch("smallSlowStreamBytes"), 10)
small_stream_deadline_seconds = Integer(observations.fetch("smallSlowStreamSamplingDeadlineSeconds"), 10)
large_stream_deadline_seconds = Integer(observations.fetch("slowStreamSamplingDeadlineSeconds"), 10)
small_stream_elapsed_nanoseconds = Integer(observations.fetch("smallSlowStreamElapsedNanoseconds"), 10)
large_stream_elapsed_nanoseconds = Integer(observations.fetch("slowStreamElapsedNanoseconds"), 10)
raise "small slow-reader sampling deadline is not the reviewed 30-second bound" unless small_stream_deadline_seconds == 30
raise "large slow-reader sampling deadline is not the reviewed 120-second bound" unless large_stream_deadline_seconds == 120
raise "small slow-reader exceeded its sampling deadline" unless small_stream_elapsed_nanoseconds <= (small_stream_deadline_seconds + 1) * 1_000_000_000
raise "large slow-reader exceeded its sampling deadline" unless large_stream_elapsed_nanoseconds <= (large_stream_deadline_seconds + 1) * 1_000_000_000
raise "streaming byte evidence is too small" unless large_stream_bytes > 32 * 1024 * 1024
raise "streaming chunk evidence is not framed" unless Integer(observations.fetch("slowStreamChunks"), 10) > 1
raise "small slow-reader byte evidence is too small" unless small_stream_bytes > 8 * 1024 * 1024
raise "small slow-reader response is not framed" unless Integer(observations.fetch("smallSlowStreamChunks"), 10) > 1
raise "small slow-reader run lacks repeated active samples" unless Integer(observations.fetch("smallSlowStreamActiveSampleCount"), 10) > 1
raise "large slow-reader run lacks repeated active samples" unless Integer(observations.fetch("slowStreamActiveSampleCount"), 10) > 1
raise "protocol RTT was not measured" unless Float(observations.fetch("protocolRTTMedianMilliseconds")) > 0
raise "stream throughput was not measured" unless Integer(observations.fetch("slowStreamBytesPerSecond"), 10) > 0
queue_ceiling = Integer(observations.fetch("declaredQueueCeilingBytes"), 10)
maximum_footprint_delta = Integer(observations.fetch("maximumSlowStreamFootprintDeltaBytes"), 10)
required_headroom = Integer(observations.fetch("requiredSlowStreamAvailableMemoryHeadroomBytes"), 10)
minimum_headroom = Integer(observations.fetch("minimumSlowStreamAvailableMemoryBytes"), 10)
small_footprint = Integer(observations.fetch("smallSlowStreamPhysFootprintBytes"), 10)
large_footprint = Integer(observations.fetch("largeSlowStreamPhysFootprintBytes"), 10)
observed_delta = Integer(observations.fetch("slowStreamFootprintDeltaBytes"), 10)
peak_footprint = Integer(observations.fetch("slowStreamPeakPhysFootprintBytes"), 10)
response_size_delta = Integer(observations.fetch("slowStreamResponseSizeDeltaBytes"), 10)
raise "slow-reader footprint samples were not recorded" unless small_footprint.positive? && large_footprint.positive?
raise "declared slow-reader queue ceiling is not exactly 8 MiB" unless queue_ceiling == 8 * 1024 * 1024
raise "declared slow-reader footprint delta is not exactly two queue ceilings" unless maximum_footprint_delta == 2 * queue_ceiling
raise "slow-reader response-size delta is inconsistent" unless response_size_delta == large_stream_bytes - small_stream_bytes
raise "slow-reader response-size delta does not exceed footprint bound" unless response_size_delta > maximum_footprint_delta
raise "slow-reader footprint delta is inconsistent" unless observed_delta == [large_footprint - small_footprint, 0].max
raise "slow-reader footprint delta exceeds its declared bound" unless observed_delta <= maximum_footprint_delta
raise "slow-reader headroom bound is not exactly one full queue ceiling" unless required_headroom == queue_ceiling
raise "slow-reader available headroom did not exceed its declared bound" unless minimum_headroom > required_headroom
raise "slow-reader peak footprint is inconsistent" unless peak_footprint == [small_footprint, large_footprint].max
prior_checkpoint_sample_sequence = Integer(observations.fetch("priorCheckpointMemorySampleSequence"), 10)
checkpoint_sample_sequence = Integer(observations.fetch("checkpointMemorySampleSequence"), 10)
checkpoint_started_at = Integer(observations.fetch("checkpointMemorySampleStartedAtUptimeNanoseconds"), 10)
checkpoint_sampled_at = Integer(observations.fetch("checkpointMemorySampledAtUptimeNanoseconds"), 10)
checkpoint_completed_at = Integer(observations.fetch("checkpointMemorySampleCompletedAtUptimeNanoseconds"), 10)
raise "checkpoint memory evidence was stale" unless checkpoint_sample_sequence > prior_checkpoint_sample_sequence
raise "checkpoint memory sample predates the checkpoint interval" unless checkpoint_started_at <= checkpoint_sampled_at
raise "checkpoint memory sample follows checkpoint completion" unless checkpoint_sampled_at <= checkpoint_completed_at
raise "checkpoint live flag remained set after completion" unless observations.fetch("checkpointInProgressAfterCompletion") == "false"

diagnostics = Array(report["diagnostics"])
required_phases = %w[openedIdle executingBeforeCancel slowStreaming8MiB slowStreaming32MiB checkpointMemorySample afterCheckpoint quiesced resumed]
missing_phases = required_phases - diagnostics.map { |entry| entry["phase"] }
raise "lifecycle memory evidence is missing phases: #{missing_phases.join(",")}" unless missing_phases.empty?
%w[slowStreaming8MiB slowStreaming32MiB].each do |phase|
  entry = diagnostics.find { |candidate| candidate["phase"] == phase }
  raise "#{phase} did not overlap an active request" unless entry["activeRequestID"].to_i.positive?
  raise "#{phase} did not overlap native dispatch" unless entry["nativeDispatchStarted"] == true
end
checkpoint_entry = diagnostics.find { |entry| entry["phase"] == "checkpointMemorySample" }
raise "checkpoint live flag was reported as sticky" unless checkpoint_entry["checkpointInProgress"] == false
diagnostics.each do |entry|
  next unless required_phases.include?(entry["phase"])
  raise "#{entry["phase"]} lacks physical-footprint evidence" unless entry["currentPhysFootprintBytes"].to_i.positive?
  raise "#{entry["phase"]} lacks resident-memory evidence" unless entry["currentResidentBytes"].to_i.positive?
  raise "#{entry["phase"]} lacks available-memory headroom" unless entry["availableMemoryBytes"].to_i.positive?
end

protection = report.fetch("storageProtection")
expected_protection = "NSFileProtectionCompleteUntilFirstUserAuthentication"
raise "recursive protection expected the wrong protection class" unless protection.fetch("expectedProtection") == expected_protection
raise "recursive protection enumeration failed" if protection["enumerationFailed"]
raise "recursive protection evidence is empty" unless protection["entryCount"].to_i.positive?
raise "recursive protection found symlinks" unless protection["symbolicLinkCount"].to_i.zero?
raise "recursive protection has unreadable entries" unless protection["unreadableEntryCount"].to_i.zero?
raise "recursive protection is missing metadata" unless protection["missingProtectionCount"].to_i.zero?
raise "recursive protection has mismatches" unless protection["mismatchedProtectionCount"].to_i.zero?
raise "recursive protection metadata was unavailable" unless protection["protectionMetadataUnavailableCount"].to_i.zero?
raise "recursive protection count does not cover every entry" unless protection["matchingProtectionCount"] == protection["entryCount"]
raise "no relation files were audited" unless protection["relationFileCount"].to_i.positive?
raise "no WAL files were audited" unless protection["walFileCount"].to_i.positive?
write_started = report.fetch("writeStartedAtUnixNanoseconds")
raise "lifecycle write timestamp is invalid" unless write_started.is_a?(Integer) && write_started.positive?
timestamp_tolerance = 2_000_000_000
earliest_fresh_modification = [write_started - timestamp_tolerance, 0].max
newest_relation = protection.fetch("newestRelationModificationUnixNanoseconds")
newest_wal = protection.fetch("newestWALModificationUnixNanoseconds")
raise "newest relation timestamp is invalid" unless newest_relation.is_a?(Integer) && newest_relation.positive?
raise "newest WAL timestamp is invalid" unless newest_wal.is_a?(Integer) && newest_wal.positive?
raise "newest relation predates the lifecycle write" unless newest_relation >= earliest_fresh_modification
raise "newest WAL predates the lifecycle write" unless newest_wal >= earliest_fresh_modification

worker_termination_evidence = case worker_termination_mode
when "explicitSIGKILL"
  {
    workerAbsentAtPostSuspendInventory: !worker_present_at_post_suspend_inventory,
    workerLossWindow: "explicitSIGKILLAfterPostSuspendInventory",
    terminationCause: "explicitSIGKILL",
    intentionalSIGKILLDelivered: true,
    workerUnavailableBeforeResume: true,
    postTerminationInventoryConfirmed: true,
  }
when "workerAbsentAtPostSuspendInventory"
  {
    workerAbsentAtPostSuspendInventory: true,
    workerLossWindow: "afterQuiescedEvidenceThroughPostSuspendInventory",
    terminationCause: "unattributed",
    intentionalSIGKILLDelivered: false,
    workerUnavailableBeforeResume: true,
    postTerminationInventoryConfirmed: true,
  }
when "exitedDuringKillRace"
  {
    workerAbsentAtPostSuspendInventory: false,
    workerLossWindow: "afterPostSuspendInventoryThroughPostESRCHInventory",
    terminationCause: "unattributed",
    intentionalSIGKILLDelivered: false,
    workerUnavailableBeforeResume: true,
    postTerminationInventoryConfirmed: true,
  }
when "notRequested"
  {
    workerAbsentAtPostSuspendInventory: !worker_present_at_post_suspend_inventory,
    workerLossWindow: worker_present_at_post_suspend_inventory ?
      "notApplicable" : "afterQuiescedEvidenceThroughPostSuspendInventory",
    terminationCause: worker_present_at_post_suspend_inventory ?
      "notRequested" : "unattributed",
    intentionalSIGKILLDelivered: false,
    workerUnavailableBeforeResume: !worker_present_at_post_suspend_inventory,
    postTerminationInventoryConfirmed: false,
  }
else
  raise "unrecognized worker termination evidence mode"
end

File.write(validation_path, JSON.pretty_generate({
  status: "PASS",
  launchIndex: launch_index,
  expectedWorkerKill: expect_worker_kill,
  workerTerminationMode: worker_termination_mode,
  workerTerminationEvidence: worker_termination_evidence,
  suspensionEvidence: {
    externallyConfirmed: true,
    deviceIdentifier: expected_device_id,
    hostPID: host_pid,
    signalName: suspend_signal&.fetch("name", nil),
    signalValue: suspend_signal&.fetch("value", nil),
    hostCountAtPostSuspendInventory: suspended_process_ids.count(host_pid),
    workerCountAtPostSuspendInventory: suspended_process_ids.count(initial_pid),
    foregroundInventoryPath: foreground_inventory_path,
    foregroundHostCount: foreground_process_ids.count(host_pid),
    foregroundWorkerCount: foreground_process_ids.count(initial_pid),
    suspendResultPath: suspend_result_path,
    postSuspendInventoryPath: suspended_inventory_path,
    workerTerminateResultPath: worker_terminate_result_path,
    postTerminateInventoryPath: post_terminate_inventory_path,
  },
  hostPID: host_pid,
  initialWorkerPID: initial_pid,
  resumedWorkerPID: resumed_pid,
  initialEpoch: initial_epoch,
  resumedEpoch: resumed_epoch,
  checks: checks,
  diagnosticPhases: diagnostics.map { |entry| entry["phase"] },
  storageProtection: protection,
}) + "\n")
RUBY
}

run_lifecycle_launch() {
  local launch_index="$1"
  local expect_worker_kill="$2"
  local report_path validation_path launch_json lifecycle_log
  if [ "$launch_index" = "1" ]; then
    report_path="$lifecycle_launch_one_report"
    validation_path="$lifecycle_launch_one_validation"
    launch_json="$lifecycle_launch_one_result"
    lifecycle_log="$lifecycle_launch_one_log"
  else
    report_path="$lifecycle_launch_two_report"
    validation_path="$lifecycle_launch_two_validation"
    launch_json="$lifecycle_launch_two_result"
    lifecycle_log="$lifecycle_launch_two_log"
  fi
  local background_json="$reports_dir/devicectl-lifecycle-background-$launch_index.json"
  local foreground_processes_json="$reports_dir/devicectl-lifecycle-processes-foreground-$launch_index.json"
  local suspend_json="$reports_dir/devicectl-lifecycle-suspend-$launch_index.json"
  local suspended_processes_json="$reports_dir/devicectl-lifecycle-processes-suspended-$launch_index.json"
  local kill_json="$reports_dir/devicectl-lifecycle-worker-kill-$launch_index.json"
  local post_kill_processes_json="$reports_dir/devicectl-lifecycle-processes-post-worker-termination-$launch_index.json"
  local resume_json="$reports_dir/devicectl-lifecycle-resume-$launch_index.json"
  local activate_json="$reports_dir/devicectl-lifecycle-reactivate-$launch_index.json"
  local terminate_json="$reports_dir/devicectl-lifecycle-terminate-$launch_index.json"
  local host_pid worker_pid activated_pid foreground_worker_state
  local suspended_worker_state post_kill_worker_state
  local worker_termination_mode="notRequested"
  local launch_attempt=0
  local lock_retry_deadline=$((SECONDS + 120))

  printf 'Launching detached Release lifecycle probe %s of 2 (workerKill=%s)...\n' \
    "$launch_index" "$expect_worker_kill"
  : >"$kill_json"
  : >"$post_kill_processes_json"
  while :; do
    launch_attempt=$((launch_attempt + 1))
    : >"$launch_json"
    : >"$lifecycle_log"
    if xcrun devicectl device process launch \
      --device "$selected_device_id" \
      --terminate-existing \
      --activate \
      --environment-variables "{\"NSUnbufferedIO\":\"YES\",\"OLIPHAUNT_BROKER_FIXTURE_MODE\":\"lifecycle\",\"OLIPHAUNT_BROKER_FIXTURE_DISABLE_IDLE_TIMER\":\"YES\",\"OLIPHAUNT_BROKER_LIFECYCLE_RUN_TOKEN\":\"$lifecycle_run_token\",\"OLIPHAUNT_BROKER_LIFECYCLE_LAUNCH_INDEX\":\"$launch_index\",\"OLIPHAUNT_BROKER_LIFECYCLE_EXPECT_WORKER_KILL\":\"$expect_worker_kill\",\"OLIPHAUNT_BROKER_LIFECYCLE_ORCHESTRATION_TIMEOUT_SECONDS\":\"$timeout_seconds\",\"OLIPHAUNT_BROKER_BUILD_CONFIGURATION\":\"$lifecycle_configuration\"}" \
      --timeout 30 \
      --json-output "$launch_json" \
      "$app_bundle_id" >"$lifecycle_log" 2>&1; then
      break
    fi
    if is_explicit_locked_launch_failure "$launch_json"; then
      [ "$SECONDS" -lt "$lock_retry_deadline" ] || \
        fail "device remained locked for the bounded lifecycle pre-launch retry window"
      printf 'Device explicitly rejected lifecycle probe %s pre-launch as Locked; waiting to retry (%s)...\n' \
        "$launch_index" "$launch_attempt"
      sleep 2
      continue
    fi
    fail "failed to launch detached lifecycle probe $launch_index"
  done
  host_pid="$(ruby -rjson -e 'puts JSON.parse(File.read(ARGV.fetch(0))).dig("result", "process", "processIdentifier")' "$launch_json")"
  case "$host_pid" in ''|*[!0-9]*) fail "lifecycle launch $launch_index returned an invalid host PID" ;; esac

  wait_for_lifecycle_foreground_active "$launch_index" "$report_path"
  wait_for_lifecycle_phase "$launch_index" readyForBackground "$report_path"
  [ "$(lifecycle_report_integer "$report_path" hostPID)" = "$host_pid" ] || \
    fail "lifecycle launch $launch_index report host PID disagrees with devicectl"
  worker_pid="$(lifecycle_report_integer "$report_path" initialWorkerPID)"

  : >"$foreground_processes_json"
  xcrun devicectl device info processes \
    --device "$selected_device_id" \
    --filter "processIdentifier == $host_pid OR processIdentifier == $worker_pid" \
    --columns '*' \
    --timeout 30 \
    --json-output "$foreground_processes_json" \
    >>"$lifecycle_log" 2>&1 || \
    fail "failed to inventory lifecycle processes while foreground-ready"
  if ! foreground_worker_state="$(classify_suspended_process_inventory \
    "$foreground_processes_json" "$host_pid" "$worker_pid" \
    "$selected_device_id")"; then
    fail "invalid lifecycle process inventory while foreground-ready"
  fi
  [ "$foreground_worker_state" = "workerPresent" ] || \
    fail "foreground-ready inventory did not prove worker PID $worker_pid visibility"

  # Activating a different public system app causes a real scene transition.
  # The fixture disables only the display idle timer while its scene is active;
  # inactive/background phases disable it and request no background execution.
  xcrun devicectl device process launch \
    --device "$selected_device_id" \
    --terminate-existing \
    --activate \
    --timeout 30 \
    --json-output "$background_json" \
    com.apple.Preferences >>"$lifecycle_log" 2>&1 || \
    fail "failed to foreground Settings for lifecycle launch $launch_index"
  wait_for_lifecycle_phase "$launch_index" quiesced "$report_path"

  xcrun devicectl device process suspend \
    --device "$selected_device_id" \
    --pid "$host_pid" \
    --timeout 30 \
    --json-output "$suspend_json" \
    >>"$lifecycle_log" 2>&1 || \
    fail "failed to suspend backgrounded broker host PID $host_pid"
  sleep 4
  : >"$suspended_processes_json"
  xcrun devicectl device info processes \
    --device "$selected_device_id" \
    --filter "processIdentifier == $host_pid OR processIdentifier == $worker_pid" \
    --columns '*' \
    --timeout 30 \
    --json-output "$suspended_processes_json" \
    >>"$lifecycle_log" 2>&1 || \
    fail "failed to inventory lifecycle processes while suspended"
  if ! suspended_worker_state="$(classify_suspended_process_inventory \
    "$suspended_processes_json" "$host_pid" "$worker_pid" \
    "$selected_device_id")"; then
    fail "invalid lifecycle process inventory while host PID $host_pid was suspended"
  fi

  if [ "$expect_worker_kill" = "YES" ]; then
    if xcrun devicectl device process terminate \
      --device "$selected_device_id" \
      --pid "$worker_pid" \
      --kill \
      --timeout 30 \
      --json-output "$kill_json" \
      >>"$lifecycle_log" 2>&1; then
      worker_termination_mode="explicitSIGKILL"
    elif is_exact_devicectl_esrch_failure "$kill_json"; then
      case "$suspended_worker_state" in
        workerAbsent)
          worker_termination_mode="workerAbsentAtPostSuspendInventory"
          ;;
        workerPresent)
          worker_termination_mode="exitedDuringKillRace"
          ;;
        *)
          fail "unrecognized suspended worker inventory state: $suspended_worker_state"
          ;;
      esac
    else
      fail "failed to SIGKILL background worker PID $worker_pid"
    fi

    : >"$post_kill_processes_json"
    xcrun devicectl device info processes \
      --device "$selected_device_id" \
      --filter "processIdentifier == $host_pid OR processIdentifier == $worker_pid" \
      --columns '*' \
      --timeout 30 \
      --json-output "$post_kill_processes_json" \
      >>"$lifecycle_log" 2>&1 || \
      fail "failed to inventory lifecycle processes after worker termination"
    if ! post_kill_worker_state="$(classify_suspended_process_inventory \
      "$post_kill_processes_json" "$host_pid" "$worker_pid" \
      "$selected_device_id")"; then
      fail "invalid lifecycle process inventory after worker termination"
    fi
    [ "$post_kill_worker_state" = "workerAbsent" ] || \
      fail "background worker PID $worker_pid remained present after worker termination"
  fi

  xcrun devicectl device process resume \
    --device "$selected_device_id" \
    --pid "$host_pid" \
    --timeout 30 \
    --json-output "$resume_json" \
    >>"$lifecycle_log" 2>&1 || \
    fail "failed to resume lifecycle host PID $host_pid"
  xcrun devicectl device process launch \
    --device "$selected_device_id" \
    --activate \
    --timeout 30 \
    --json-output "$activate_json" \
    "$app_bundle_id" >>"$lifecycle_log" 2>&1 || \
    fail "failed to reactivate lifecycle host PID $host_pid"
  activated_pid="$(ruby -rjson -e 'puts JSON.parse(File.read(ARGV.fetch(0))).dig("result", "process", "processIdentifier")' "$activate_json")"
  [ "$activated_pid" = "$host_pid" ] || \
    fail "reactivation replaced lifecycle host PID $host_pid with $activated_pid"

  wait_for_lifecycle_phase "$launch_index" completed "$report_path"
  validate_lifecycle_report \
    "$report_path" "$validation_path" "$launch_index" "$expect_worker_kill" \
    "$worker_termination_mode" "$foreground_processes_json" "$suspend_json" \
    "$suspended_processes_json" "$kill_json" "$post_kill_processes_json" \
    "$selected_device_id" || \
    fail "lifecycle launch $launch_index report validation failed"
  xcrun devicectl device process terminate \
    --device "$selected_device_id" \
    --pid "$host_pid" \
    --timeout 30 \
    --json-output "$terminate_json" \
    >>"$lifecycle_log" 2>&1 || \
    fail "failed to terminate completed lifecycle host PID $host_pid"
}

validate_extension_private_persistence() {
  ruby -rjson - "$launch_one_app_report" "$launch_two_app_report" \
    "$persistence_report" <<'RUBY'
first_path, second_path, output_path = ARGV
reports = [first_path, second_path].map { |path| JSON.parse(File.read(path)) }
results = reports.map { |report| report.fetch("result") }
digests = results.map do |result|
  values = Array(result["diagnostics"]).map { |entry| entry["manifestDigest"] }.compact
    .reject(&:empty?).uniq
  raise "launch has no unique worker manifestDigest" unless values.length == 1
  values.fetch(0)
end
raise "two launches reused the same host process" if results[0]["hostPID"] == results[1]["hostPID"]
raise "extension-private manifest digest changed across launches" unless digests[0] == digests[1]
observations = results.map { |result| result.fetch("observations") }
first_marker = observations[0].fetch("currentLaunchMarker")
second_marker = observations[1].fetch("currentLaunchMarker")
raise "first launch marker is empty" if first_marker.empty?
raise "second launch marker is empty" if second_marker.empty?
raise "two launches reused the same durable marker" if first_marker == second_marker
second_prior_markers = observations[1].fetch("priorLaunchMarkers").split(",").reject(&:empty?)
raise "second launch did not observe the first launch marker" unless second_prior_markers.include?(first_marker)
File.write(output_path, JSON.pretty_generate({
  schema: "oliphaunt-ios-broker-device-persistence-v1",
  status: "PASS",
  evidence: "two-full-launches-without-reinstall",
  manifestDigest: digests.fetch(0),
  launchHostPIDs: results.map { |result| result.fetch("hostPID") },
  launchWorkerPIDs: results.map { |result| result.fetch("workerPID") },
  launchEpochs: results.map { |result| result.fetch("epoch") },
  firstLaunchMarker: first_marker,
  secondLaunchMarker: second_marker,
  secondLaunchPriorMarkers: second_prior_markers,
  cleanupRequestedByLaunch: 2,
  reports: [first_path, second_path],
}) + "\n")
RUBY
}

retain_semantic_debug_product() {
  local retained_root retained_app retained_extension
  local host_hash extension_hash
  [ -d "$semantic_app_path" ] || fail "semantic Debug app disappeared before retention"
  [ -d "$semantic_extension_path" ] || \
    fail "semantic Debug extension disappeared before retention"
  retained_root="$(mktemp -d "$build_root/retained-semantic-debug.XXXXXX")"
  retained_app="$retained_root/$app_product_name.app"
  retained_extension="$retained_app/Extensions/$extension_product_name.appex"
  ditto "$semantic_app_path" "$retained_app" || \
    fail "failed to retain the signed semantic Debug app"
  [ -d "$retained_extension" ] || \
    fail "retained semantic Debug app omitted its extension"
  codesign --verify --strict --deep "$retained_app" || \
    fail "retained semantic Debug app signature is invalid"
  codesign --verify --strict "$retained_extension" || \
    fail "retained semantic Debug extension signature is invalid"
  [ "$(plutil -extract CFBundleIdentifier raw -o - "$retained_app/Info.plist")" = \
    "$app_bundle_id" ] || fail "retained semantic Debug app has the wrong bundle identifier"
  [ "$(plutil -extract CFBundleIdentifier raw -o - "$retained_extension/Info.plist")" = \
    "$extension_bundle_id" ] || \
    fail "retained semantic Debug extension has the wrong bundle identifier"
  host_hash="$(shasum -a 256 "$retained_app/$host_executable" | awk '{print $1}')"
  extension_hash="$(shasum -a 256 \
    "$retained_extension/$extension_executable" | awk '{print $1}')"
  ruby -rjson - "$retained_semantic_product_validation" "$retained_app" \
    "$retained_extension" "$build_result_bundle" "$host_hash" \
    "$extension_hash" <<'RUBY'
output, app, extension, result_bundle, host_hash, extension_hash = ARGV
File.write(output, JSON.pretty_generate({
  schema: "oliphaunt-ios-broker-retained-semantic-debug-product-v1",
  status: "PASS",
  appPath: app,
  extensionPath: extension,
  resultBundle: result_bundle,
  hostExecutableSHA256: host_hash,
  extensionExecutableSHA256: extension_hash,
}) + "\n")
RUBY
  semantic_app_path="$retained_app"
  semantic_extension_path="$retained_extension"
}

load_retained_semantic_debug_product() {
  local expected_result_bundle="$1"
  local retained_result_bundle retained_host_hash retained_extension_hash
  [ -s "$retained_semantic_product_validation" ] || \
    fail "resume lifecycle requires a retained semantic Debug product report"
  semantic_app_path="$(ruby -rjson -e '
    report = JSON.parse(File.read(ARGV.fetch(0)))
    abort unless report["schema"] == "oliphaunt-ios-broker-retained-semantic-debug-product-v1"
    abort unless report["status"] == "PASS"
    puts report.fetch("appPath")
  ' "$retained_semantic_product_validation")"
  semantic_extension_path="$(ruby -rjson -e '
    puts JSON.parse(File.read(ARGV.fetch(0))).fetch("extensionPath")
  ' "$retained_semantic_product_validation")"
  retained_result_bundle="$(ruby -rjson -e '
    puts JSON.parse(File.read(ARGV.fetch(0))).fetch("resultBundle")
  ' "$retained_semantic_product_validation")"
  case "$semantic_app_path" in
    "$build_root"/retained-semantic-debug.*/*) ;;
    *) fail "retained semantic Debug app is outside the device build root" ;;
  esac
  [ "$semantic_extension_path" = \
    "$semantic_app_path/Extensions/$extension_product_name.appex" ] || \
    fail "retained semantic Debug extension path is inconsistent"
  [ "$retained_result_bundle" = "$expected_result_bundle" ] || \
    fail "retained semantic Debug product names a different result bundle"
  [ -d "$semantic_app_path" ] || fail "retained semantic Debug app is missing"
  [ -d "$semantic_extension_path" ] || \
    fail "retained semantic Debug extension is missing"
  codesign --verify --strict --deep "$semantic_app_path" || \
    fail "retained semantic Debug app signature is invalid"
  codesign --verify --strict "$semantic_extension_path" || \
    fail "retained semantic Debug extension signature is invalid"
  retained_host_hash="$(ruby -rjson -e '
    puts JSON.parse(File.read(ARGV.fetch(0))).fetch("hostExecutableSHA256")
  ' "$retained_semantic_product_validation")"
  retained_extension_hash="$(ruby -rjson -e '
    puts JSON.parse(File.read(ARGV.fetch(0))).fetch("extensionExecutableSHA256")
  ' "$retained_semantic_product_validation")"
  [ "$(shasum -a 256 "$semantic_app_path/$host_executable" | awk '{print $1}')" = \
    "$retained_host_hash" ] || fail "retained semantic Debug host executable changed"
  [ "$(shasum -a 256 \
    "$semantic_extension_path/$extension_executable" | awk '{print $1}')" = \
    "$retained_extension_hash" ] || \
    fail "retained semantic Debug extension executable changed"
}

write_release_product_sizes() {
  ruby -rjson - "$lifecycle_size_report" "$app_path" "$extension_path" \
    "$embedded_native_framework" "$app_path/$host_executable" \
    "$extension_path/$extension_executable" "$extension_path/oliphaunt" <<'RUBY'
output, app, extension, framework, host_executable, extension_executable, resources = ARGV
def allocated_bytes(path)
  paths = [path] + Dir.glob(File.join(path, "**", "*"), File::FNM_DOTMATCH)
  paths.uniq.sum do |entry|
    next 0 unless File.file?(entry)
    File.size(entry)
  rescue Errno::ENOENT
    0
  end
end
payload = {
  schema: "oliphaunt-ios-broker-release-product-sizes-v1",
  status: "PASS",
  appBundleBytes: allocated_bytes(app),
  extensionBundleBytes: allocated_bytes(extension),
  nativeFrameworkBytes: allocated_bytes(framework),
  runtimeResourcesBytes: allocated_bytes(resources),
  hostExecutableBytes: File.size(host_executable),
  extensionExecutableBytes: File.size(extension_executable),
}
raise "release size evidence contains an empty product" unless payload.values_at(
  :appBundleBytes, :extensionBundleBytes, :nativeFrameworkBytes,
  :runtimeResourcesBytes, :hostExecutableBytes, :extensionExecutableBytes
).all?(&:positive?)
File.write(output, JSON.pretty_generate(payload) + "\n")
RUBY
}

write_lifecycle_runner_report() {
  local completed_at
  completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  ruby -rjson - "$lifecycle_runner_report" "$lifecycle_launch_one_report" \
    "$lifecycle_launch_two_report" "$lifecycle_launch_one_validation" \
    "$lifecycle_launch_two_validation" "$lifecycle_size_report" \
    "$lifecycle_run_token" "$selected_device_id" "$selected_device_udid" \
    "$selected_device_name" "$selected_device_os" "$selected_device_product" \
    "$selected_device_transport" "$lifecycle_configuration" "$app_path" \
    "$extension_path" "$lifecycle_build_result_bundle" "$lifecycle_build_log" \
    "$lifecycle_install_log" "$lifecycle_release_build_app_path" \
    "$lifecycle_archive_path" "$lifecycle_archive_result_bundle" \
    "$lifecycle_archive_validation" "$lifecycle_archive_log" "$completed_at" <<'RUBY'
output, first_report, second_report, first_validation, second_validation, sizes,
  run_token, identifier, udid, name, os, product, transport, configuration,
  app_path, extension_path, result_bundle, build_log, install_log,
  release_build_app_path, archive_path, archive_result_bundle,
  archive_validation, archive_log, completed_at = ARGV
first = JSON.parse(File.read(first_report))
second = JSON.parse(File.read(second_report))
first_validation_payload = JSON.parse(File.read(first_validation))
second_validation_payload = JSON.parse(File.read(second_validation))
validations = [first_validation_payload, second_validation_payload]
reports = [first, second]
raise "lifecycle validation artifact did not pass" unless validations.all? { |validation| validation["status"] == "PASS" }
raise "launch one validation unexpectedly requested worker termination" unless first_validation_payload["expectedWorkerKill"] == false
raise "launch two validation omitted worker-unavailability recovery" unless second_validation_payload["expectedWorkerKill"] == true
raise "launch one validation recorded a termination mode" unless first_validation_payload["workerTerminationMode"] == "notRequested"
first_worker_termination_evidence = first_validation_payload.fetch("workerTerminationEvidence")
raise "launch one validation falsely claimed SIGKILL" unless first_worker_termination_evidence["intentionalSIGKILLDelivered"] == false
raise "launch one worker-unavailability evidence is inconsistent" unless first_worker_termination_evidence["workerUnavailableBeforeResume"] == first_worker_termination_evidence["workerAbsentAtPostSuspendInventory"]
reports.zip(validations).each_with_index do |(report, validation), index|
  raise "lifecycle validation launch index mismatch" unless validation["launchIndex"] == report["launchIndex"]
  raise "lifecycle validation ordinal mismatch" unless validation["launchIndex"] == index + 1
  raise "lifecycle validation host PID mismatch" unless validation["hostPID"] == report["hostPID"]
  raise "lifecycle validation initial worker PID mismatch" unless validation["initialWorkerPID"] == report["initialWorkerPID"]
  raise "lifecycle validation resumed worker PID mismatch" unless validation["resumedWorkerPID"] == report["currentWorkerPID"]
  raise "lifecycle validation initial epoch mismatch" unless validation["initialEpoch"] == report["initialEpoch"]
  raise "lifecycle validation resumed epoch mismatch" unless validation["resumedEpoch"] == report["currentEpoch"]
end
raise "lifecycle launches reused one host process" if first.fetch("hostPID") == second.fetch("hostPID")
raise "extension-private manifest changed across lifecycle launches" unless first.fetch("manifestDigest") == second.fetch("manifestDigest")
raise "lifecycle launch one found stale run-token markers" unless Integer(first.fetch("observations").fetch("priorLaunchMarkerCount"), 10) == 0
raise "lifecycle launch two did not observe launch one's marker" unless Integer(second.fetch("observations").fetch("priorLaunchMarkerCount"), 10) == 1
suspensions = validations.map { |validation| validation.fetch("suspensionEvidence") }
externally_confirmed_suspension = suspensions.all? do |evidence|
  evidence["externallyConfirmed"] == true &&
    evidence["deviceIdentifier"] == identifier &&
    evidence["signalName"] == "SIGSTOP" &&
    evidence["signalValue"] == 17 &&
    evidence["foregroundHostCount"] == 1 &&
    evidence["foregroundWorkerCount"] == 1 &&
    evidence["hostCountAtPostSuspendInventory"] == 1
end
raise "lifecycle validations did not independently confirm both suspensions" unless externally_confirmed_suspension
worker_termination_mode = second_validation_payload.fetch("workerTerminationMode")
worker_termination_evidence = second_validation_payload.fetch("workerTerminationEvidence")
case worker_termination_mode
when "explicitSIGKILL"
  raise "explicit SIGKILL validation denied delivery" unless worker_termination_evidence["intentionalSIGKILLDelivered"] == true
when "workerAbsentAtPostSuspendInventory"
  raise "absent-worker validation did not observe absence" unless worker_termination_evidence["workerAbsentAtPostSuspendInventory"] == true
  raise "absent-worker validation falsely claimed SIGKILL" unless worker_termination_evidence["intentionalSIGKILLDelivered"] == false
when "exitedDuringKillRace"
  raise "kill-race validation falsely claimed SIGKILL" unless worker_termination_evidence["intentionalSIGKILLDelivered"] == false
else
  raise "launch two validation has an unrecognized worker termination mode"
end
worker_unavailable_before_resume = worker_termination_evidence.fetch("workerUnavailableBeforeResume") == true
raise "launch two did not prove worker unavailability before resume" unless worker_unavailable_before_resume
actual_foreground_background_foreground = validations.all? do |validation|
  checks = Array(validation["checks"])
  checks.include?("actualBackground") && checks.include?("backgroundResume")
end
payload = {
  schema: "oliphaunt-ios-broker-device-lifecycle-run-v2",
  status: "PASS",
  evidenceType: "signed-release-physical-device-lifecycle",
  completedAt: completed_at,
  runToken: run_token,
  device: {
    coreDeviceIdentifier: identifier,
    udid: udid,
    name: name,
    os: os,
    productType: product,
    transport: transport,
  },
  build: {
    sdk: "iphoneos",
    architecture: "arm64",
    configuration: configuration,
    builtAppPath: release_build_app_path,
    appPath: app_path,
    extensionPath: extension_path,
    resultBundle: result_bundle,
    archivePath: archive_path,
    archiveResultBundle: archive_result_bundle,
  },
  scope: {
    actualForegroundBackgroundForeground: actual_foreground_background_foreground,
    externallyConfirmedSuspension: externally_confirmed_suspension,
    workerUnavailableBeforeResume: worker_unavailable_before_resume,
    workerTerminationMode: worker_termination_mode,
    workerKilledWhileHostSuspended:
      worker_termination_evidence.fetch("intentionalSIGKILLDelivered"),
    workerAbsentAtPostSuspendInventory:
      worker_termination_evidence.fetch("workerAbsentAtPostSuspendInventory"),
    workerLossWindow: worker_termination_evidence.fetch("workerLossWindow"),
    terminationCause: worker_termination_evidence.fetch("terminationCause"),
    intentionalSIGKILLDelivered:
      worker_termination_evidence.fetch("intentionalSIGKILLDelivered"),
    backgroundKeepaliveUsed: false,
    distributionQualification: false,
  },
  launches: [
    {
      ordinal: 1,
      workerTerminationMode: first_validation_payload.fetch("workerTerminationMode"),
      workerKilledWhileSuspended:
        first_validation_payload.fetch("workerTerminationEvidence").fetch("intentionalSIGKILLDelivered"),
      workerUnavailableBeforeResume:
        first_validation_payload.fetch("workerTerminationEvidence").fetch("workerUnavailableBeforeResume"),
      reportPath: first_report,
      report: first,
      validation: first_validation_payload,
    },
    {
      ordinal: 2,
      workerTerminationMode: worker_termination_mode,
      workerKilledWhileSuspended:
        worker_termination_evidence.fetch("intentionalSIGKILLDelivered"),
      workerUnavailableBeforeResume: worker_unavailable_before_resume,
      reportPath: second_report,
      report: second,
      validation: second_validation_payload,
    },
  ],
  productSizes: JSON.parse(File.read(sizes)),
  archiveValidation: JSON.parse(File.read(archive_validation)),
  performance: {
    broker: [first, second].map do |report|
      observations = report.fetch("observations")
      {
        launchIndex: report.fetch("launchIndex"),
        protocolRTTMedianMilliseconds:
          Float(observations.fetch("protocolRTTMedianMilliseconds")),
        protocolRTTSampleCount:
          Integer(observations.fetch("protocolRTTSampleCount"), 10),
        smallSlowStreamBytes:
          Integer(observations.fetch("smallSlowStreamBytes"), 10),
        smallSlowStreamActiveSampleCount:
          Integer(observations.fetch("smallSlowStreamActiveSampleCount"), 10),
        smallSlowStreamElapsedNanoseconds:
          Integer(observations.fetch("smallSlowStreamElapsedNanoseconds"), 10),
        smallSlowStreamSamplingDeadlineSeconds:
          Integer(observations.fetch("smallSlowStreamSamplingDeadlineSeconds"), 10),
        slowStreamBytes: Integer(observations.fetch("slowStreamBytes"), 10),
        slowStreamActiveSampleCount:
          Integer(observations.fetch("slowStreamActiveSampleCount"), 10),
        slowStreamElapsedNanoseconds:
          Integer(observations.fetch("slowStreamElapsedNanoseconds"), 10),
        slowStreamSamplingDeadlineSeconds:
          Integer(observations.fetch("slowStreamSamplingDeadlineSeconds"), 10),
        slowStreamBytesPerSecond:
          Integer(observations.fetch("slowStreamBytesPerSecond"), 10),
        declaredQueueCeilingBytes:
          Integer(observations.fetch("declaredQueueCeilingBytes"), 10),
        maximumSlowStreamFootprintDeltaBytes:
          Integer(observations.fetch("maximumSlowStreamFootprintDeltaBytes"), 10),
        slowStreamResponseSizeDeltaBytes:
          Integer(observations.fetch("slowStreamResponseSizeDeltaBytes"), 10),
        slowStreamFootprintDeltaBytes:
          Integer(observations.fetch("slowStreamFootprintDeltaBytes"), 10),
        minimumSlowStreamAvailableMemoryBytes:
          Integer(observations.fetch("minimumSlowStreamAvailableMemoryBytes"), 10),
        slowStreamPeakPhysFootprintBytes:
          Integer(observations.fetch("slowStreamPeakPhysFootprintBytes"), 10),
      }
    end,
    directModeComparison: {
      status: "not-run",
      reason: "the signed ExtensionFoundation fixture has no in-process nativeDirect host target; compare against the dedicated nativeDirect benchmark before production sizing",
    },
  },
  logs: { build: build_log, archive: archive_log, install: install_log },
}
File.write(output, JSON.pretty_generate(payload) + "\n")
RUBY
}

write_runner_report() {
  local completed_at
  completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  ruby -rjson - "$runner_report_path" "$launch_one_app_report" \
    "$launch_two_app_report" "$persistence_report" "$selected_device_id" \
    "$selected_device_udid" \
    "$selected_device_name" "$selected_device_os" "$selected_device_product" \
    "$selected_device_transport" "$scheme" "$configuration" "$app_bundle_id" \
    "$extension_bundle_id" "$app_path" "$extension_path" \
    "$OLIPHAUNT_IOS_BROKER_XCFRAMEWORK" "$OLIPHAUNT_IOS_BROKER_RESOURCES" \
    "$embedded_native_library" "$artifact_validation_file" "$host_linkage_file" \
    "$extension_linkage_file" "$extension_resources_file" "$signing_validation_file" \
    "$device_inventory" "$device_details" "$device_lock_state" "$installed_apps" \
    "$install_result" "$launch_one_result" "$launch_two_result" \
    "$launch_one_copy_result" "$launch_two_copy_result" \
    "$artifact_preparation_log" "$build_log" "$install_log" "$launch_one_log" \
    "$launch_two_log" "$build_result_bundle" "$launch_one_pass_marker" \
    "$launch_two_pass_marker" "$completed_at" <<'RUBY'
output, first_app_report, second_app_report, persistence_report, identifier,
  udid, name, os, product, transport, scheme,
  configuration, app_bundle_id, extension_bundle_id, app_path, extension_path,
  xcframework, runtime_resources, embedded_native_library, artifact_validation,
  host_linkage, extension_linkage, extension_resources, signing_validation,
  device_inventory, device_details, lock_state, installed_apps, install_result,
  first_launch_result, second_launch_result, first_copy_result, second_copy_result,
  artifact_preparation_log, build_log, install_log, first_console_log,
  second_console_log, result_bundle, first_pass_marker_path,
  second_pass_marker_path, completed_at = ARGV
payload = {
  schema: "oliphaunt-ios-broker-device-run-v1",
  status: "PASS",
  evidenceType: "physical-device",
  completedAt: completed_at,
  device: {
    coreDeviceIdentifier: identifier,
    udid: udid,
    name: name,
    os: os,
    productType: product,
    transport: transport,
  },
  build: {
    sdk: "iphoneos",
    architecture: "arm64",
    scheme: scheme,
    configuration: configuration,
    appPath: app_path,
    embeddedExtensionPath: extension_path,
    resultBundle: result_bundle,
  },
  bundleIdentifiers: { host: app_bundle_id, extension: extension_bundle_id },
  artifacts: {
    platform: "ios-device",
    xcframework: xcframework,
    runtimeResources: runtime_resources,
    embeddedNativeLibrary: embedded_native_library,
  },
  validations: {
    artifacts: artifact_validation,
    hostLinkage: host_linkage,
    extensionLinkage: extension_linkage,
    extensionResources: extension_resources,
    codeSigning: signing_validation,
  },
  evidence: {
    deviceInventory: device_inventory,
    deviceDetails: device_details,
    lockState: lock_state,
    installedApps: installed_apps,
    installResult: install_result,
    launchResults: [first_launch_result, second_launch_result],
    reportCopyResults: [first_copy_result, second_copy_result],
  },
  logs: {
    artifactPreparation: artifact_preparation_log,
    xcodebuild: build_log,
    install: install_log,
    deviceConsoles: [first_console_log, second_console_log],
  },
  launches: [
    {
      ordinal: 1,
      passMarker: File.read(first_pass_marker_path).strip,
      appReportPath: first_app_report,
      appReport: JSON.parse(File.read(first_app_report)),
    },
    {
      ordinal: 2,
      passMarker: File.read(second_pass_marker_path).strip,
      appReportPath: second_app_report,
      appReport: JSON.parse(File.read(second_app_report)),
    },
  ],
  persistence: JSON.parse(File.read(persistence_report)),
}
File.write(output, JSON.pretty_generate(payload) + "\n")
RUBY
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

resume_lifecycle_only="$(normalize_yes_no \
  "$resume_lifecycle_only" OLIPHAUNT_IOS_BROKER_RESUME_LIFECYCLE_ONLY)"
resume_after_debug_install="$(normalize_yes_no \
  "$resume_after_debug_install" OLIPHAUNT_IOS_BROKER_RESUME_AFTER_DEBUG_INSTALL)"
[ "$resume_lifecycle_only" != "YES" ] || [ "$resume_after_debug_install" != "YES" ] || \
  fail "resume-after-debug-install and resume-lifecycle are mutually exclusive"
mkdir -p "$build_root" "$derived_data" "$logs_dir" "$reports_dir"
if [ "$resume_lifecycle_only" = "YES" ]; then
  for output_file in \
    "$lifecycle_launch_one_log" "$lifecycle_launch_two_log" \
    "$lifecycle_launch_one_report" "$lifecycle_launch_two_report" \
    "$lifecycle_launch_one_validation" "$lifecycle_launch_two_validation" \
    "$lifecycle_launch_one_result" "$lifecycle_launch_two_result" \
    "$lifecycle_runner_report" "$runner_report_path" \
    "$device_inventory" "$device_details" "$device_lock_state" \
    "$preflight_report" "$artifact_validation_file" \
    "$embedded_extensions_file" "$host_linkage_file" "$extension_linkage_file" \
    "$embedded_native_file" "$extension_resources_file" "$signing_validation_file" \
    "$extension_host_sdk_symbol_file" "$release_fault_symbol_file" \
    "$reports_dir/failure.txt"; do
    : >"$output_file"
  done
elif [ "$resume_after_debug_install" = "YES" ]; then
  for output_file in \
    "$launch_one_log" "$launch_two_log" "$launch_one_copy_log" "$launch_two_copy_log" \
    "$artifact_validation_file" \
    "$embedded_extensions_file" "$host_linkage_file" "$extension_linkage_file" \
    "$embedded_native_file" "$extension_resources_file" "$signing_validation_file" \
    "$extension_host_sdk_symbol_file" \
    "$release_fault_symbol_file" \
    "$launch_one_pass_marker" "$launch_two_pass_marker" \
    "$launch_one_app_report" "$launch_two_app_report" \
    "$launch_one_console_report" "$launch_two_console_report" \
    "$launch_one_validation" "$launch_two_validation" "$persistence_report" \
    "$lifecycle_build_log" "$lifecycle_install_log" \
    "$lifecycle_archive_log" "$lifecycle_archive_validation" \
    "$lifecycle_launch_one_log" "$lifecycle_launch_two_log" \
    "$lifecycle_launch_one_report" "$lifecycle_launch_two_report" \
    "$lifecycle_launch_one_validation" "$lifecycle_launch_two_validation" \
    "$lifecycle_runner_report" "$lifecycle_size_report" "$lifecycle_install_result" \
    "$retained_semantic_product_validation" \
    "$runner_report_path" "$device_inventory" "$device_details" \
    "$device_lock_state" "$installed_apps" \
    "$preflight_report" "$launch_one_result" "$launch_two_result" \
    "$launch_one_copy_result" "$launch_two_copy_result" \
    "$reports_dir/failure.txt"; do
    : >"$output_file"
  done
else
  for output_file in \
    "$generator_log" "$artifact_preparation_log" "$build_log" "$install_log" \
    "$launch_one_log" "$launch_two_log" "$launch_one_copy_log" "$launch_two_copy_log" \
    "$artifact_validation_file" \
    "$embedded_extensions_file" "$host_linkage_file" "$extension_linkage_file" \
    "$embedded_native_file" "$extension_resources_file" "$signing_validation_file" \
    "$extension_host_sdk_symbol_file" \
    "$release_fault_symbol_file" \
    "$launch_one_pass_marker" "$launch_two_pass_marker" \
    "$launch_one_app_report" "$launch_two_app_report" \
    "$launch_one_console_report" "$launch_two_console_report" \
    "$launch_one_validation" "$launch_two_validation" "$persistence_report" \
    "$lifecycle_build_log" "$lifecycle_install_log" \
    "$lifecycle_archive_log" "$lifecycle_archive_validation" \
    "$lifecycle_launch_one_log" "$lifecycle_launch_two_log" \
    "$lifecycle_launch_one_report" "$lifecycle_launch_two_report" \
    "$lifecycle_launch_one_validation" "$lifecycle_launch_two_validation" \
    "$lifecycle_runner_report" "$lifecycle_size_report" "$lifecycle_install_result" \
    "$retained_semantic_product_validation" \
    "$runner_report_path" "$device_inventory" "$device_details" \
    "$device_lock_state" "$installed_apps" "$install_result" \
    "$preflight_report" "$launch_one_result" "$launch_two_result" \
    "$launch_one_copy_result" "$launch_two_copy_result" \
    "$reports_dir/failure.txt"; do
    : >"$output_file"
  done
fi

case "$minimum_ios_major" in
  ''|*[!0-9]*) fail "OLIPHAUNT_IOS_BROKER_MIN_IOS_MAJOR must be an integer" ;;
esac
[ "$minimum_ios_major" -ge 26 ] || fail "the broker fixture requires iOS 26 or newer"
case "$timeout_seconds" in
  ''|*[!0-9]*) fail "OLIPHAUNT_IOS_BROKER_TIMEOUT_SECONDS must be a positive integer" ;;
esac
[ "$timeout_seconds" -ge 30 ] && [ "$timeout_seconds" -le 600 ] || \
  fail "OLIPHAUNT_IOS_BROKER_TIMEOUT_SECONDS must be in 30...600"
prepare_artifacts="$(normalize_yes_no "$prepare_artifacts" OLIPHAUNT_IOS_BROKER_PREPARE_ARTIFACTS)"
preflight_only="$(normalize_yes_no "$preflight_only" OLIPHAUNT_IOS_BROKER_DEVICE_PREFLIGHT_ONLY)"
if [ "$resume_lifecycle_only" = "YES" ]; then
  [ -n "$lifecycle_run_token_from_environment" ] || \
    fail "--resume-lifecycle requires OLIPHAUNT_IOS_BROKER_LIFECYCLE_RUN_TOKEN"
  prepare_artifacts=NO
  clean_install=NO
fi
if [ "$resume_after_debug_install" = "YES" ]; then
  [ -n "$resume_debug_result_bundle_input" ] || \
    fail "--resume-after-debug-install requires OLIPHAUNT_IOS_BROKER_RESUME_DEBUG_RESULT_BUNDLE"
  prepare_artifacts=NO
  clean_install=NO
fi
case "$lifecycle_run_token" in
  ''|*[!A-Za-z0-9._:-]*) fail "unsafe lifecycle run token" ;;
esac
[ "${#lifecycle_run_token}" -le 256 ] || fail "lifecycle run token exceeds 256 characters"
clean_install="$(normalize_yes_no "$clean_install" OLIPHAUNT_IOS_BROKER_DEVICE_CLEAN_INSTALL)"
uninstall_after_run="$(normalize_yes_no "$uninstall_after_run" OLIPHAUNT_IOS_BROKER_UNINSTALL_AFTER_RUN)"
code_signing_allowed="$(normalize_yes_no "$code_signing_allowed" OLIPHAUNT_IOS_BROKER_CODE_SIGNING_ALLOWED)"
[ "$code_signing_allowed" = "YES" ] || fail "physical iOS install/launch requires code signing"
safe_bundle_identifier "$app_bundle_id" || fail "unsafe host bundle identifier: $app_bundle_id"
safe_bundle_identifier "$extension_bundle_id" || fail "unsafe extension bundle identifier: $extension_bundle_id"
[ "$app_bundle_id" = "dev.oliphaunt.brokerspike" ] || \
  fail "the ExtensionFoundation fixture requires host bundle ID dev.oliphaunt.brokerspike"
[ "$extension_bundle_id" = "dev.oliphaunt.brokerspike.extension" ] || \
  fail "the ExtensionFoundation fixture requires extension bundle ID dev.oliphaunt.brokerspike.extension"
case "$extension_bundle_id" in
  "$app_bundle_id".*) ;;
  *) fail "extension bundle identifier must be prefixed by the host bundle identifier" ;;
esac
safe_build_name "$scheme" || fail "unsafe Xcode scheme name: $scheme"
safe_build_name "$configuration" || fail "unsafe Xcode configuration name: $configuration"
[ "$configuration" = "Debug" ] || \
  fail "physical broker qualification requires Debug fault-injection coverage"
safe_build_name "$lifecycle_configuration" || \
  fail "unsafe lifecycle Xcode configuration name: $lifecycle_configuration"
[ "$lifecycle_configuration" = "Release" ] || \
  fail "physical lifecycle/memory qualification requires a Release build"
safe_build_name "$app_product_name" || fail "unsafe host product name: $app_product_name"
safe_build_name "$extension_product_name" || fail "unsafe extension product name: $extension_product_name"

[ "$(uname -s)" = "Darwin" ] || fail "the iOS device runner requires macOS"
for command_name in awk basename codesign cp date defaults dirname ditto find grep kill mktemp \
  nm otool plutil ruby security sed shasum sleep sort tail tee wc xcodebuild xcrun; do
  need_cmd "$command_name"
done
[ -f "$generator" ] || fail "missing project generator: $generator"
[ -x "$artifact_preparer" ] || fail "missing executable broker artifact preparer: $artifact_preparer"
if ! ruby -e 'require "xcodeproj"' >"$logs_dir/xcodeproj-preflight.log" 2>&1; then
  fail "Ruby xcodeproj is required to generate the fixture"
fi
xcode_major="$(xcodebuild -version | awk 'NR == 1 { split($2, version, "."); print version[1] }')"
case "$xcode_major" in
  ''|*[!0-9]*) fail "could not determine the Xcode major version" ;;
esac
[ "$xcode_major" -ge 26 ] || fail "the ExtensionFoundation fixture requires Xcode 26 or newer"

printf 'Selecting a paired physical iOS %s+ device...\n' "$minimum_ios_major"
select_physical_device
printf 'Selected device: %s (%s, iOS %s, %s)\n' \
  "$selected_device_name" "$selected_device_id" "$selected_device_os" "$selected_device_transport"
preflight_device
configure_broker_device_signing
identity_count="$(valid_code_signing_identity_count)"
write_preflight_report "$identity_count"
if [ "$preflight_only" = "YES" ]; then
  printf 'OLIPHAUNT_IOS_BROKER_DEVICE_PREFLIGHT_PASS report=%s\n' "$preflight_report"
  exit 0
fi

if [ "$prepare_artifacts" = "YES" ]; then
  printf 'Preparing arm64 iOS device broker artifacts...\n'
  if ! env \
    OLIPHAUNT_IOS_BROKER_ARTIFACT_PLATFORM=device \
    OLIPHAUNT_IOS_BROKER_ARTIFACT_ROOT="$artifact_root" \
    bash "$artifact_preparer" >"$artifact_preparation_log" 2>&1; then
    tail -120 "$artifact_preparation_log" >&2 || true
    fail "failed to prepare iOS device broker artifacts"
  fi
  [ -f "$artifact_environment" ] || \
    fail "device artifact preparer did not write its environment file"
  # shellcheck disable=SC1090
  . "$artifact_environment"
elif { [ -z "${OLIPHAUNT_IOS_BROKER_XCFRAMEWORK:-}" ] || \
  [ -z "${OLIPHAUNT_IOS_BROKER_RESOURCES:-}" ]; } && [ -f "$artifact_environment" ]; then
  # shellcheck disable=SC1090
  . "$artifact_environment"
fi
[ "${OLIPHAUNT_IOS_BROKER_ARTIFACT_PLATFORM:-device}" = "device" ] || \
  fail "configured broker artifacts are not marked for iOS device use"
export OLIPHAUNT_IOS_BROKER_ARTIFACT_PLATFORM=device
validate_broker_artifacts

if [ "$resume_lifecycle_only" = "YES" ]; then
  [ -s "$lifecycle_archive_validation" ] || \
    fail "resume lifecycle requires retained Release archive validation"
  lifecycle_archive_path="$(ruby -rjson -e '
    report = JSON.parse(File.read(ARGV.fetch(0)))
    abort unless report["schema"] == "oliphaunt-ios-broker-release-archive-validation-v1"
    abort unless report["status"] == "PASS"
    puts report.fetch("archivePath")
  ' "$lifecycle_archive_validation")"
  app_path="$(ruby -rjson -e 'puts JSON.parse(File.read(ARGV.fetch(0))).fetch("appPath")' \
    "$lifecycle_archive_validation")"
  lifecycle_archive_result_bundle="$(ruby -rjson -e \
    'puts JSON.parse(File.read(ARGV.fetch(0))).fetch("resultBundle")' \
    "$lifecycle_archive_validation")"
  case "$lifecycle_archive_path" in
    "$build_root"/archives/*.xcarchive) ;;
    *) fail "retained Release archive is outside the device build root" ;;
  esac
  [ "$app_path" = "$lifecycle_archive_path/Products/Applications/$app_product_name.app" ] || \
    fail "retained Release archive validation names an unexpected app"
  [ -d "$app_path" ] || fail "retained signed Release app is missing"
  [ -d "$lifecycle_archive_result_bundle" ] || \
    fail "retained Release archive result bundle is missing"
  ruby -rjson - "$lifecycle_install_result" "$app_path" "$selected_device_id" \
    "$app_bundle_id" <<'RUBY'
install_path, expected_app, expected_device, expected_bundle = ARGV
report = JSON.parse(File.read(install_path))
raise "retained Release install did not succeed" unless report.dig("info", "outcome") == "success"
raise "retained Release install used a different archive app" unless report.dig("info", "arguments")&.last == expected_app
raise "retained Release install targeted a different device" unless report.dig("result", "deviceIdentifier") == expected_device
bundles = Array(report.dig("result", "installedApplications")).map { |entry| entry["bundleID"] }
raise "retained Release install omitted the broker app" unless bundles.include?(expected_bundle)
RUBY
  xcrun devicectl device info apps \
    --device "$selected_device_id" \
    --bundle-id "$app_bundle_id" \
    --timeout 30 \
    --json-output "$installed_apps" \
    >"$logs_dir/devicectl-installed-apps-resume.log" 2>&1 || \
    fail "failed to verify the retained installed Release app"
  ruby -rjson -e '
    apps = JSON.parse(File.read(ARGV.fetch(0))).dig("result", "apps") || []
    matches = apps.select { |app| app["bundleIdentifier"] == ARGV.fetch(1) }
    abort unless matches.length == 1
  ' "$installed_apps" "$app_bundle_id" || \
    fail "retained Release broker app is not installed exactly once"

  validating_release_artifact=1
  validate_built_app
  write_release_product_sizes || fail "failed to refresh Release archive product sizes"
  lifecycle_release_build_app_path="$derived_data/Build/Products/$lifecycle_configuration-iphoneos/$app_product_name.app"
  build_result_bundle="$(find "$reports_dir" -mindepth 1 -maxdepth 1 \
    -type d -name 'device-build-*.xcresult' -print | LC_ALL=C sort | tail -1)"
  lifecycle_build_result_bundle="$(find "$reports_dir" -mindepth 1 -maxdepth 1 \
    -type d -name 'device-lifecycle-release-build-*.xcresult' -print | \
    LC_ALL=C sort | tail -1)"
  [ -d "$build_result_bundle" ] || fail "retained Debug result bundle is missing"
  [ -d "$lifecycle_build_result_bundle" ] || \
    fail "retained Release build result bundle is missing"
  load_retained_semantic_debug_product "$build_result_bundle"
  printf 'Resuming lifecycle qualification from installed audited archive (no build/install)...\n'
else
export OLIPHAUNT_BROKER_INCLUDE_SDK=1
export OLIPHAUNT_IOS_BROKER_BUNDLE_ID="$app_bundle_id"
export OLIPHAUNT_IOS_BROKER_EXTENSION_BUNDLE_ID="$extension_bundle_id"
export OLIPHAUNT_IOS_BROKER_DEVELOPMENT_TEAM="$development_team"
if [ "$resume_after_debug_install" = "YES" ]; then
  project_path="$(absolute_path "${OLIPHAUNT_IOS_BROKER_PROJECT_PATH:-$fixture_root/Generated/OliphauntBrokerSpike.xcodeproj}")"
  [ -d "$project_path" ] || fail "retained generated Xcode project is missing: $project_path"
  build_result_bundle="$(absolute_path "$resume_debug_result_bundle_input")"
  case "$build_result_bundle" in
    "$reports_dir"/device-build-*.xcresult) ;;
    *) fail "retained Debug result bundle is outside the device reports directory" ;;
  esac
  [ -d "$build_result_bundle" ] || fail "retained Debug result bundle is missing"
  grep -Fq '** BUILD SUCCEEDED **' "$build_log" || \
    fail "retained Debug build log does not record BUILD SUCCEEDED"

  app_path="$(absolute_path "${OLIPHAUNT_IOS_BROKER_DEVICE_APP_PATH:-$derived_data/Build/Products/$configuration-iphoneos/$app_product_name.app}")"
  [ -d "$app_path" ] || fail "retained Debug host app is missing: $app_path"
  validate_built_app
  semantic_app_path="$app_path"
  semantic_extension_path="$extension_path"

  [ -s "$install_result" ] || fail "retained Debug install result is missing"
  ruby -rjson - "$install_result" "$app_path" "$selected_device_id" \
    "$app_bundle_id" <<'RUBY'
install_path, expected_app, expected_device, expected_bundle = ARGV
report = JSON.parse(File.read(install_path))
raise "retained Debug install did not succeed" unless report.dig("info", "outcome") == "success"
raise "retained Debug install used a different built app" unless report.dig("info", "arguments")&.last == expected_app
raise "retained Debug install targeted a different device" unless report.dig("result", "deviceIdentifier") == expected_device
bundles = Array(report.dig("result", "installedApplications")).map { |entry| entry["bundleID"] }
raise "retained Debug install omitted the broker app" unless bundles.include?(expected_bundle)
RUBY
  xcrun devicectl device info apps \
    --device "$selected_device_id" \
    --bundle-id "$app_bundle_id" \
    --timeout 30 \
    --json-output "$installed_apps" \
    >"$logs_dir/devicectl-installed-apps-resume-debug.log" 2>&1 || \
    fail "failed to verify the retained installed Debug app"
  ruby -rjson - "$installed_apps" "$install_result" "$app_bundle_id" <<'RUBY'
installed_path, install_path, expected_bundle = ARGV
apps = JSON.parse(File.read(installed_path)).dig("result", "apps") || []
matches = apps.select { |app| app["bundleIdentifier"] == expected_bundle }
raise "retained Debug broker app is not installed exactly once" unless matches.length == 1
installed_url = matches.first.fetch("url")
recorded_url = JSON.parse(File.read(install_path)).dig(
  "result", "installedApplications", 0, "installationURL"
)
raise "installed Debug broker app no longer matches the retained install" unless installed_url == recorded_url
RUBY
  installed=1
  printf 'Resuming semantic qualification from retained signed Debug build/install (no rebuild/reinstall)...\n'
else
printf 'Generating signed device Xcode project...\n'
if ! ruby "$generator" >"$generator_log" 2>&1; then
  tail -120 "$generator_log" >&2 || true
  fail "failed to generate the broker spike Xcode project"
fi
generated_project="$(tail -1 "$generator_log")"
project_path="$(absolute_path "${OLIPHAUNT_IOS_BROKER_PROJECT_PATH:-$generated_project}")"
[ -d "$project_path" ] || fail "generated Xcode project is missing: $project_path"

build_result_bundle="$reports_dir/device-build-$(date -u +%Y%m%dT%H%M%SZ)-$$.xcresult"
xcodebuild_arguments=(
  -project "$project_path"
  -scheme "$scheme"
  -configuration "$configuration"
  -sdk iphoneos
  -destination "id=$selected_device_udid"
  -derivedDataPath "$derived_data"
  -resultBundlePath "$build_result_bundle"
)
if is_truthy "$allow_provisioning_updates"; then
  xcodebuild_arguments+=( -allowProvisioningUpdates )
fi
if is_truthy "$allow_device_registration"; then
  xcodebuild_arguments+=( -allowProvisioningDeviceRegistration )
fi
xcodebuild_arguments+=(
  CODE_SIGNING_ALLOWED=YES
  "DEVELOPMENT_TEAM=$development_team"
  "CODE_SIGN_STYLE=$code_sign_style"
  COMPILER_INDEX_STORE_ENABLE=NO
)
[ -z "$code_sign_identity" ] || xcodebuild_arguments+=( "CODE_SIGN_IDENTITY=$code_sign_identity" )
[ -z "$provisioning_profile_specifier" ] || \
  xcodebuild_arguments+=( "PROVISIONING_PROFILE_SPECIFIER=$provisioning_profile_specifier" )
printf 'Building %s for physical device %s (hardware UDID selected by Xcode)...\n' \
  "$scheme" "$selected_device_name"
if ! xcodebuild "${xcodebuild_arguments[@]}" clean build 2>&1 | tee "$build_log"; then
  fail "signed iPhoneOS xcodebuild failed; see $build_log"
fi

app_path="$(absolute_path "${OLIPHAUNT_IOS_BROKER_DEVICE_APP_PATH:-$derived_data/Build/Products/$configuration-iphoneos/$app_product_name.app}")"
[ -d "$app_path" ] || fail "built device host app is missing: $app_path"
validate_built_app
semantic_app_path="$app_path"
semantic_extension_path="$extension_path"

if [ "$clean_install" = "YES" ]; then
  xcrun devicectl device uninstall app \
    --device "$selected_device_id" \
    --timeout 30 \
    "$app_bundle_id" >/dev/null 2>&1 || true
fi
printf 'Installing signed host app on the physical device...\n'
if ! xcrun devicectl device install app \
  --device "$selected_device_id" \
  --timeout 120 \
  --json-output "$install_result" \
  "$app_path" >"$install_log" 2>&1; then
  tail -80 "$install_log" >&2 || true
  fail "failed to install $app_bundle_id on the selected device"
fi
installed=1
xcrun devicectl device info apps \
  --device "$selected_device_id" \
  --bundle-id "$app_bundle_id" \
  --timeout 30 \
  --json-output "$installed_apps" \
  >"$logs_dir/devicectl-installed-apps.log" 2>&1 || \
  fail "failed to verify the installed host app"
ruby -rjson -e '
  apps = JSON.parse(File.read(ARGV.fetch(0))).dig("result", "apps") || []
  matches = apps.select { |app| app["bundleIdentifier"] == ARGV.fetch(1) }
  abort("expected exactly one installed host app, found #{matches.length}") unless matches.length == 1
' "$installed_apps" "$app_bundle_id" || fail "devicectl did not report exactly one installed host app"
fi

run_probe_launch \
  1 \
  "$launch_one_app_report" \
  "$launch_one_console_report" \
  "$launch_one_validation" \
  "$launch_one_log" \
  "$launch_one_result" \
  "$launch_one_copy_result" \
  "$launch_one_copy_log" \
  "$launch_one_pass_marker"
run_probe_launch \
  2 \
  "$launch_two_app_report" \
  "$launch_two_console_report" \
  "$launch_two_validation" \
  "$launch_two_log" \
  "$launch_two_result" \
  "$launch_two_copy_result" \
  "$launch_two_copy_log" \
  "$launch_two_pass_marker"
validate_extension_private_persistence || \
  fail "extension-private root identity was not stable across two launches"
retain_semantic_debug_product

lifecycle_build_result_bundle="$reports_dir/device-lifecycle-release-build-$(date -u +%Y%m%dT%H%M%SZ)-$$.xcresult"
lifecycle_xcodebuild_arguments=(
  -project "$project_path"
  -scheme "$scheme"
  -configuration "$lifecycle_configuration"
  -sdk iphoneos
  -destination "id=$selected_device_udid"
  -derivedDataPath "$derived_data"
  -resultBundlePath "$lifecycle_build_result_bundle"
)
if is_truthy "$allow_provisioning_updates"; then
  lifecycle_xcodebuild_arguments+=( -allowProvisioningUpdates )
fi
if is_truthy "$allow_device_registration"; then
  lifecycle_xcodebuild_arguments+=( -allowProvisioningDeviceRegistration )
fi
lifecycle_xcodebuild_arguments+=(
  CODE_SIGNING_ALLOWED=YES
  "DEVELOPMENT_TEAM=$development_team"
  "CODE_SIGN_STYLE=$code_sign_style"
  COMPILER_INDEX_STORE_ENABLE=NO
)
[ -z "$code_sign_identity" ] || \
  lifecycle_xcodebuild_arguments+=( "CODE_SIGN_IDENTITY=$code_sign_identity" )
[ -z "$provisioning_profile_specifier" ] || \
  lifecycle_xcodebuild_arguments+=( "PROVISIONING_PROFILE_SPECIFIER=$provisioning_profile_specifier" )
printf 'Building signed Release lifecycle fixture for physical device %s...\n' \
  "$selected_device_name"
if ! xcodebuild "${lifecycle_xcodebuild_arguments[@]}" clean build 2>&1 | \
  tee "$lifecycle_build_log"; then
  fail "signed Release iPhoneOS lifecycle build failed; see $lifecycle_build_log"
fi
app_path="$(absolute_path "${OLIPHAUNT_IOS_BROKER_DEVICE_RELEASE_APP_PATH:-$derived_data/Build/Products/$lifecycle_configuration-iphoneos/$app_product_name.app}")"
[ -d "$app_path" ] || fail "built Release lifecycle host app is missing: $app_path"
validating_release_artifact=1
validate_built_app
lifecycle_release_build_app_path="$app_path"

mkdir -p "$build_root/archives"
lifecycle_archive_path="$build_root/archives/$app_product_name-$(date -u +%Y%m%dT%H%M%SZ)-$$.xcarchive"
lifecycle_archive_result_bundle="$reports_dir/device-lifecycle-release-archive-$(date -u +%Y%m%dT%H%M%SZ)-$$.xcresult"
lifecycle_archive_arguments=(
  -project "$project_path"
  -scheme "$scheme"
  -configuration "$lifecycle_configuration"
  -sdk iphoneos
  -destination "generic/platform=iOS"
  -derivedDataPath "$derived_data"
  -archivePath "$lifecycle_archive_path"
  -resultBundlePath "$lifecycle_archive_result_bundle"
)
if is_truthy "$allow_provisioning_updates"; then
  lifecycle_archive_arguments+=( -allowProvisioningUpdates )
fi
if is_truthy "$allow_device_registration"; then
  lifecycle_archive_arguments+=( -allowProvisioningDeviceRegistration )
fi
lifecycle_archive_arguments+=(
  CODE_SIGNING_ALLOWED=YES
  "DEVELOPMENT_TEAM=$development_team"
  "CODE_SIGN_STYLE=$code_sign_style"
  COMPILER_INDEX_STORE_ENABLE=NO
)
[ -z "$code_sign_identity" ] || \
  lifecycle_archive_arguments+=( "CODE_SIGN_IDENTITY=$code_sign_identity" )
[ -z "$provisioning_profile_specifier" ] || \
  lifecycle_archive_arguments+=( "PROVISIONING_PROFILE_SPECIFIER=$provisioning_profile_specifier" )
printf 'Archiving signed Release lifecycle fixture...\n'
if ! xcodebuild "${lifecycle_archive_arguments[@]}" archive 2>&1 | \
  tee "$lifecycle_archive_log"; then
  fail "signed Release iPhoneOS archive failed; see $lifecycle_archive_log"
fi
[ -f "$lifecycle_archive_path/Info.plist" ] || \
  fail "Release archive has no Info.plist"
archive_application_path="$(plutil -extract ApplicationProperties.ApplicationPath raw -o - \
  "$lifecycle_archive_path/Info.plist" 2>/dev/null || true)"
[ "$archive_application_path" = "Applications/$app_product_name.app" ] || \
  fail "Release archive records an unexpected application path: $archive_application_path"
app_path="$lifecycle_archive_path/Products/$archive_application_path"
[ -d "$app_path" ] || fail "Release archive is missing its application product"
validate_built_app
write_release_product_sizes || fail "failed to record Release archive product sizes"
ruby -rjson - "$lifecycle_archive_validation" "$lifecycle_archive_path" \
  "$app_path" "$extension_path" "$embedded_native_framework" \
  "$lifecycle_archive_result_bundle" "$signing_validation_file" \
  "$extension_host_sdk_symbol_file" "$release_fault_symbol_file" <<'RUBY'
output, archive, app, extension, framework, result_bundle, signing,
  extension_symbols, fault_symbols = ARGV
File.write(output, JSON.pretty_generate({
  schema: "oliphaunt-ios-broker-release-archive-validation-v1",
  status: "PASS",
  archivePath: archive,
  appPath: app,
  extensionPath: extension,
  nativeFrameworkPath: framework,
  resultBundle: result_bundle,
  validations: {
    recursiveCodeSigning: signing,
    extensionHostSDKSymbols: extension_symbols,
    releaseFaultSymbols: fault_symbols,
  },
  export: {
    status: "not-run",
    reason: "App Store/TestFlight export, upload, and review require distribution credentials and external service qualification",
  },
}) + "\n")
RUBY

# Upgrade in place: do not uninstall between Debug semantic smoke and Release
# lifecycle launches, because the extension-private root must survive.
printf 'Installing signed Release lifecycle fixture without uninstall...\n'
if ! xcrun devicectl device install app \
  --device "$selected_device_id" \
  --timeout 120 \
  --json-output "$lifecycle_install_result" \
  "$app_path" >"$lifecycle_install_log" 2>&1; then
  tail -80 "$lifecycle_install_log" >&2 || true
  fail "failed to install signed Release lifecycle fixture"
fi
fi

run_lifecycle_launch 1 NO
run_lifecycle_launch 2 YES
write_lifecycle_runner_report
write_runner_report

ruby -rjson - "$runner_report_path" "$lifecycle_runner_report" \
  "$semantic_app_path" "$semantic_extension_path" "$configuration" \
  "$app_path" "$extension_path" "$lifecycle_configuration" \
  "$build_result_bundle" "$lifecycle_build_result_bundle" \
  "$extension_host_sdk_symbol_file" "$release_fault_symbol_file" \
  "$retained_semantic_product_validation" <<'RUBY'
runner_path, lifecycle_path, debug_app, debug_extension, debug_configuration,
  release_app, release_extension, release_configuration, debug_result_bundle,
  release_result_bundle, extension_host_sdk_symbols, release_fault_symbols,
  retained_semantic_product = ARGV
runner = JSON.parse(File.read(runner_path))
runner["schema"] = "oliphaunt-ios-broker-device-run-v2"
runner["build"] = {
  "sdk" => "iphoneos",
  "architecture" => "arm64",
  "semanticDebug" => {
    "configuration" => debug_configuration,
    "appPath" => debug_app,
    "embeddedExtensionPath" => debug_extension,
    "resultBundle" => debug_result_bundle,
  },
  "lifecycleRelease" => {
    "configuration" => release_configuration,
    "appPath" => release_app,
    "embeddedExtensionPath" => release_extension,
    "resultBundle" => release_result_bundle,
  },
}
runner["lifecycleQualification"] = JSON.parse(File.read(lifecycle_path))
runner["validations"]["extensionHostSDKSymbols"] = extension_host_sdk_symbols
runner["validations"]["releaseFaultSymbols"] = release_fault_symbols
runner["validations"]["semanticDebugRetainedProduct"] = retained_semantic_product
File.write(runner_path, JSON.pretty_generate(runner) + "\n")
RUBY

printf 'OLIPHAUNT_IOS_BROKER_DEVICE_PASS report=%s launch1=%s launch2=%s persistence=%s lifecycle=%s logs=%s\n' \
  "$runner_report_path" "$launch_one_app_report" "$launch_two_app_report" \
  "$persistence_report" "$lifecycle_runner_report" "$logs_dir"
