#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="${OLIPHAUNT_REPO_ROOT:-$(cd "$script_dir/../../../.." && pwd)}"

fail() {
  failure_reason="$*"
  printf 'error: %s\n' "$failure_reason" >&2
  exit 1
}

absolute_path() {
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    *) printf '%s/%s\n' "$repo_root" "$1" ;;
  esac
}

validate_hang_report() {
  local report_path="$1"
  local validation_path="$2"
  local expected_host_pid="$3"
  ruby -rjson - "$report_path" "$validation_path" "$expected_host_pid" <<'RUBY'
report_path, validation_path, expected_host_pid = ARGV
expected_host_pid = Integer(expected_host_pid, 10)
report = JSON.parse(File.read(report_path))
raise "app report must be a JSON object" unless report.is_a?(Hash)
error = report["error"]
raise "app reported failure: #{error}" unless error.nil? || error.empty?
result = report["result"]
raise "app report is missing result" unless result.is_a?(Hash)

host_pid = result["hostPID"]
worker_pid = result["workerPID"]
raise "app report has an invalid host PID" unless host_pid.is_a?(Integer) && host_pid.positive?
raise "app report host PID disagrees with devicectl" unless host_pid == expected_host_pid
raise "app report has an invalid worker PID" unless worker_pid.is_a?(Integer) && worker_pid.positive?
raise "host and worker PIDs are identical" if host_pid == worker_pid

uuid = /\A[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\z/
epoch = result["epoch"]
raise "app report has an invalid epoch" unless epoch.is_a?(String) && epoch.match?(uuid)

expected_checks = %w[
  hangCapabilityConservative
  hangTimeout
  mainActorResponsiveDuringHang
  oldHangEpochInvalidated
  replacementLaunchAttempted
]
checks = result["checks"]
raise "app report checks must be an array" unless checks.is_a?(Array)
raise "app report check matrix contains duplicates" unless checks.uniq.length == checks.length
raise "app report checks differ from the exact hang matrix" unless checks.sort == expected_checks.sort

observations = result["observations"]
raise "hang observations must be an object" unless observations.is_a?(Hash)
raise "hang matrix overclaimed restartability" unless observations["hangRestartableCapability"] == "false"
raise "hang initial worker PID disagrees with the report" unless Integer(observations.fetch("initialWorkerPID"), 10) == worker_pid
raise "hang initial epoch disagrees with the report" unless observations.fetch("initialEpoch") == epoch
timeout = observations.fetch("timeout", "")
raise "hang matrix omitted its bounded terminal error" if timeout.empty?
raise "hang matrix terminal was not a deadline/interruption/outcome-unknown result" unless timeout.match?(/deadline|interrupt|outcome.*unknown/i)
raise "hang fault was not acknowledged before the trigger" unless observations["faultAcknowledged"] == "true"
raise "worker was not responsive after the fault acknowledgement" unless observations["postAckWorkerResponsive"] == "true"
raise "post-ack worker PID changed" unless Integer(observations.fetch("postAckWorkerPID"), 10) == worker_pid
raise "post-ack epoch changed" unless observations.fetch("postAckEpoch") == epoch

initial_attempt_count = Integer(observations.fetch("initialLaunchAttemptCount"), 10)
interrupted_attempt_count = Integer(observations.fetch("interruptedLaunchAttemptCount"), 10)
post_attempt_count = Integer(observations.fetch("postRecoveryLaunchAttemptCount"), 10)
attempt_delta = Integer(observations.fetch("replacementLaunchAttemptDelta"), 10)
initial_launch_count = Integer(observations.fetch("initialLaunchCount"), 10)
interrupted_launch_count = Integer(observations.fetch("interruptedLaunchCount"), 10)
post_launch_count = Integer(observations.fetch("postRecoveryLaunchCount"), 10)
successful_launch_delta = Integer(observations.fetch("successfulLaunchCountDelta"), 10)
raise "initial launch-attempt count is invalid" unless initial_attempt_count.positive?
raise "initial successful-launch count is invalid" unless initial_launch_count.positive?
raise "initial attempts are fewer than successful launches" unless initial_attempt_count >= initial_launch_count
raise "hang invalidation regressed launch attempts" unless interrupted_attempt_count >= initial_attempt_count
raise "hang invalidation regressed successful launches" unless interrupted_launch_count >= initial_launch_count
raise "post-hang query did not attempt a replacement" unless post_attempt_count > interrupted_attempt_count
raise "replacement attempt delta is inconsistent" unless attempt_delta == post_attempt_count - interrupted_attempt_count
raise "successful launch count regressed" unless post_launch_count >= interrupted_launch_count
raise "successful launch delta is inconsistent" unless successful_launch_delta == post_launch_count - interrupted_launch_count

fresh = observations["freshProcessObtained"]
raise "hang matrix omitted its fresh-process outcome" unless %w[true false].include?(fresh)
recovered_epochs = result["recoveredEpochs"]
raise "recoveredEpochs must be an array" unless recovered_epochs.is_a?(Array)
recovery_proven = false
recovery_outcome = "noFreshWorker"
recovered_pid = nil
recovered_epoch = nil

if fresh == "true"
  recovered_pid = Integer(observations.fetch("recoveredWorkerPID"), 10)
  recovered_epoch = observations.fetch("recoveredEpoch")
  raise "fresh worker PID is invalid" unless recovered_pid.positive?
  raise "fresh worker PID collides with the host" if recovered_pid == host_pid
  raise "fresh worker reused the initial PID" if recovered_pid == worker_pid
  raise "fresh worker has an invalid epoch" unless recovered_epoch.is_a?(String) && recovered_epoch.match?(uuid)
  raise "fresh worker reused the initial epoch" if recovered_epoch == epoch
  raise "fresh recovery list is inconsistent" unless recovered_epochs == [recovered_epoch]
  raise "fresh worker had no successful Ready launch" unless post_launch_count > interrupted_launch_count
  raise "fresh worker launch delta is not positive" unless successful_launch_delta.positive?
  raise "fresh recovery unexpectedly recorded a failure" if observations.key?("recoveryFailure")
  recovery_proven = true
  recovery_outcome = "freshWorkerObtained"
else
  raise "unavailable recovery omitted its failure" if observations.fetch("recoveryFailure", "").empty?
  raise "unavailable recovery published recovered epochs" unless recovered_epochs.empty?
  if observations.key?("recoveredWorkerPID") || observations.key?("recoveredEpoch")
    recovered_pid = Integer(observations.fetch("recoveredWorkerPID"), 10)
    recovered_epoch = observations.fetch("recoveredEpoch")
    raise "reported replacement PID is invalid" unless recovered_pid.positive?
    raise "reported replacement PID collides with the host" if recovered_pid == host_pid
    raise "reported replacement epoch is invalid" unless recovered_epoch.is_a?(String) && recovered_epoch.match?(uuid)
    both_fresh = recovered_pid != worker_pid && recovered_epoch != epoch
    raise "a fully fresh worker was mislabeled unavailable" if both_fresh
  end
end

payload = {
  schema: "oliphaunt-ios-broker-device-hang-validation-v1",
  status: "PASS",
  evidenceStatus: "PASS",
  recoveryProven: recovery_proven,
  recoveryOutcome: recovery_outcome,
  hostPID: host_pid,
  initialWorkerPID: worker_pid,
  initialEpoch: epoch,
  recoveredWorkerPID: recovered_pid,
  recoveredEpoch: recovered_epoch,
  checks: checks,
  timeout: timeout,
  launchCounters: {
    initialAttemptCount: initial_attempt_count,
    interruptedAttemptCount: interrupted_attempt_count,
    postRecoveryAttemptCount: post_attempt_count,
    replacementAttemptDelta: attempt_delta,
    initialSuccessfulLaunchCount: initial_launch_count,
    interruptedSuccessfulLaunchCount: interrupted_launch_count,
    postRecoverySuccessfulLaunchCount: post_launch_count,
    successfulLaunchDelta: successful_launch_delta,
  },
}
File.write(validation_path, JSON.pretty_generate(payload) + "\n")
RUBY
}

if [ "${1:-}" = "--validate-report" ]; then
  [ "$#" -eq 4 ] || fail "usage: $0 --validate-report REPORT VALIDATION EXPECTED_HOST_PID"
  validate_hang_report "$2" "$3" "$4"
  exit 0
fi
[ "$#" -eq 0 ] || fail "usage: $0 [--validate-report REPORT VALIDATION EXPECTED_HOST_PID]"

device_id="${OLIPHAUNT_IOS_BROKER_DEVICE_ID:-7C01EC26-8B01-56E6-872D-82BB72421567}"
expected_udid="${OLIPHAUNT_IOS_BROKER_DEVICE_UDID:-00008120-001474980C47C01E}"
app_bundle_id="${OLIPHAUNT_IOS_BROKER_BUNDLE_ID:-dev.oliphaunt.brokerspike}"
extension_bundle_id="${OLIPHAUNT_IOS_BROKER_EXTENSION_BUNDLE_ID:-dev.oliphaunt.brokerspike.extension}"
expected_team="${OLIPHAUNT_IOS_BROKER_DEVELOPMENT_TEAM:-LCXFQNDD46}"
timeout_seconds="${OLIPHAUNT_IOS_BROKER_HANG_TIMEOUT_SECONDS:-90}"
retained_manifest="$(absolute_path "${OLIPHAUNT_IOS_BROKER_RETAINED_DEBUG_PRODUCT:-target/ios-native-broker-device-spike/reports/retained-semantic-debug-product.json}")"
canonical_device_report="$(absolute_path "${OLIPHAUNT_IOS_BROKER_DEVICE_RUNNER_REPORT:-target/ios-native-broker-device-spike/reports/device-runner-report.json}")"
expected_host_debug_sha="${OLIPHAUNT_IOS_BROKER_HOST_DEBUG_DYLIB_SHA256:-}"
expected_extension_debug_sha="${OLIPHAUNT_IOS_BROKER_EXTENSION_DEBUG_DYLIB_SHA256:-}"
run_token="${OLIPHAUNT_IOS_BROKER_HANG_RUN_TOKEN:-device-hang-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
run_root="$(absolute_path "${OLIPHAUNT_IOS_BROKER_HANG_RUN_ROOT:-target/ios-native-broker-device-hang/$run_token}")"
reports_dir="$run_root/reports"
logs_dir="$run_root/logs"
mkdir -p "$reports_dir/pulled" "$reports_dir/cleanup" "$logs_dir"

device_details="$reports_dir/devicectl-device-details.json"
device_lock_state="$reports_dir/devicectl-lock-state.json"
installed_apps_before="$reports_dir/devicectl-installed-apps-before.json"
artifact_validation="$reports_dir/retained-debug-validation.json"
install_json="$reports_dir/devicectl-install-debug.json"
install_log="$logs_dir/devicectl-install-debug.log"
launch_json="$reports_dir/devicectl-launch-hang.json"
console_log="$logs_dir/devicectl-console-hang.log"
console_report="$reports_dir/console-app-report.json"
pulled_report="$reports_dir/pulled/broker-spike-report.json"
copy_json="$reports_dir/devicectl-copy-report.json"
copy_log="$logs_dir/devicectl-copy-report.log"
validation_report="$reports_dir/hang-validation.json"
process_inventory="$reports_dir/devicectl-processes-after-report.json"
pass_marker="$reports_dir/pass-marker.txt"
runner_report="$reports_dir/device-hang-runner-report.json"
failure_file="$reports_dir/failure.txt"

success_marker="OLIPHAUNT_BROKER_SPIKE PASS"
failure_marker="OLIPHAUNT_BROKER_SPIKE FAIL"
json_marker="OLIPHAUNT_BROKER_SPIKE_JSON "
failure_reason=""
console_pid=""
cleanup_complete=0

[ -n "$expected_host_debug_sha" ] || fail "OLIPHAUNT_IOS_BROKER_HOST_DEBUG_DYLIB_SHA256 is required"
[ -n "$expected_extension_debug_sha" ] || fail "OLIPHAUNT_IOS_BROKER_EXTENSION_DEBUG_DYLIB_SHA256 is required"

stop_console() {
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

terminate_exact_app_processes() {
  local phase="$1"
  local installation_url="$2"
  local before_inventory="$reports_dir/cleanup/$phase-processes-before.json"
  local after_inventory="$reports_dir/cleanup/$phase-processes-after.json"

  xcrun devicectl device info processes \
    --device "$device_id" \
    --columns '*' \
    --timeout 30 \
    --json-output "$before_inventory" \
    >"$logs_dir/$phase-processes-before.log" 2>&1 || return 1

  ruby -rjson - "$before_inventory" "$installation_url" "$device_id" <<'RUBY' >"$reports_dir/cleanup/$phase-validated-pids.txt" || return 1
inventory_path, installation_url, device_id = ARGV
inventory = JSON.parse(File.read(inventory_path))
raise "process inventory outcome was not success" unless inventory.dig("info", "outcome") == "success"
raise "process inventory targeted a different device" unless inventory.dig("result", "deviceIdentifier") == device_id
processes = inventory.dig("result", "runningProcesses")
raise "process inventory omitted runningProcesses" unless processes.is_a?(Array)
if installation_url.empty?
  exit 0
end
root = installation_url.sub(%r{/\z}, "")
expected = {
  "#{root}/OliphauntBrokerSpike" => "host",
  "#{root}/Extensions/BrokerAppExtension.appex/BrokerAppExtension" => "extension",
}
seen = []
relevant = processes.select do |process|
  executable = process["executable"].to_s
  executable.end_with?("/OliphauntBrokerSpike.app/OliphauntBrokerSpike") ||
    executable.end_with?("/BrokerAppExtension.appex/BrokerAppExtension")
end
relevant.each do |process|
  pid = process["processIdentifier"]
  executable = process["executable"]
  raise "app process has an invalid PID" unless pid.is_a?(Integer) && pid.positive?
  kind = expected[executable]
  raise "spike process does not belong to the current exact installed URL" unless kind
  raise "duplicate app process PID" if seen.include?(pid)
  seen << pid
  puts [pid, kind].join("\t")
end
RUBY

  while IFS=$'\t' read -r cleanup_pid cleanup_kind; do
    [ -n "$cleanup_pid" ] || continue
    xcrun devicectl device process terminate \
      --device "$device_id" \
      --pid "$cleanup_pid" \
      --kill \
      --timeout 30 \
      --json-output "$reports_dir/cleanup/$phase-terminate-$cleanup_kind-$cleanup_pid.json" \
      >"$logs_dir/$phase-terminate-$cleanup_kind-$cleanup_pid.log" 2>&1 || true
  done <"$reports_dir/cleanup/$phase-validated-pids.txt"

  sleep 1
  xcrun devicectl device info processes \
    --device "$device_id" \
    --columns '*' \
    --timeout 30 \
    --json-output "$after_inventory" \
    >"$logs_dir/$phase-processes-after.log" 2>&1 || return 1
  ruby -rjson - "$after_inventory" "$device_id" "$installation_url" <<'RUBY' || return 1
inventory_path, device_id, installation_url = ARGV
inventory = JSON.parse(File.read(inventory_path))
raise "post-cleanup inventory outcome was not success" unless inventory.dig("info", "outcome") == "success"
raise "post-cleanup inventory targeted a different device" unless inventory.dig("result", "deviceIdentifier") == device_id
processes = inventory.dig("result", "runningProcesses")
raise "post-cleanup inventory omitted runningProcesses" unless processes.is_a?(Array)
unless installation_url.empty?
  root = installation_url.sub(%r{/\z}, "")
  expected = [
    "#{root}/OliphauntBrokerSpike",
    "#{root}/Extensions/BrokerAppExtension.appex/BrokerAppExtension",
  ]
  survivors = processes.select do |process|
    executable = process["executable"].to_s
    executable.end_with?("/OliphauntBrokerSpike.app/OliphauntBrokerSpike") ||
      executable.end_with?("/BrokerAppExtension.appex/BrokerAppExtension")
  end
  unless survivors.all? { |process| expected.include?(process["executable"]) }
    raise "stale spike process survived under a non-current install URL"
  end
  raise "an app or extension process survived cleanup" unless survivors.empty?
end
RUBY
}

post_evidence_cleanup() {
  [ "$cleanup_complete" = "0" ] || return 0
  set +e
  stop_console
  cleanup_installation_url=""
  if [ -s "$install_json" ]; then
    cleanup_installation_url="$(ruby -rjson -e '
      report = JSON.parse(File.read(ARGV.fetch(0)))
      puts report.dig("result", "installedApplications", 0, "installationURL").to_s
    ' "$install_json")"
  fi
  if terminate_exact_app_processes post-evidence "$cleanup_installation_url"; then
    printf 'PASS\n' >"$reports_dir/cleanup/status.txt"
    cleanup_complete=1
  else
    printf 'FAIL\n' >"$reports_dir/cleanup/status.txt"
  fi
  set -e
}

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM
  set +e
  post_evidence_cleanup
  if [ "$exit_code" -ne 0 ]; then
    [ -n "$failure_reason" ] || failure_reason="physical hang runner failed with status $exit_code"
    printf '%s\n' "$failure_reason" >"$failure_file"
    tail -120 "$console_log" "$copy_log" "$install_log" 2>/dev/null >&2
  fi
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

[ -f "$retained_manifest" ] || fail "retained Debug manifest is missing: $retained_manifest"
artifact_fields="$(ruby -rjson - "$retained_manifest" <<'RUBY'
manifest = JSON.parse(File.read(ARGV.fetch(0)))
raise "retained Debug manifest schema mismatch" unless manifest["schema"] == "oliphaunt-ios-broker-retained-semantic-debug-product-v1"
raise "retained Debug manifest did not pass" unless manifest["status"] == "PASS"
puts [
  manifest.fetch("appPath"), manifest.fetch("extensionPath"),
  manifest.fetch("resultBundle"), manifest.fetch("hostExecutableSHA256"),
  manifest.fetch("extensionExecutableSHA256")
].join("\t")
RUBY
)" || fail "retained Debug manifest validation failed"
IFS=$'\t' read -r app_path extension_path result_bundle expected_host_sha expected_extension_sha <<EOF
$artifact_fields
EOF

[ -f "$canonical_device_report" ] || fail "canonical physical-device report is missing: $canonical_device_report"
ruby -rjson - "$canonical_device_report" "$retained_manifest" "$device_id" "$expected_udid" \
  "$app_path" "$extension_path" "$result_bundle" <<'RUBY' || \
  fail "retained Debug artifact does not match the canonical physical-device evidence"
report_path, retained_manifest, device_id, udid, app, extension, result_bundle = ARGV
report = JSON.parse(File.read(report_path))
raise "canonical device report schema mismatch" unless report["schema"] == "oliphaunt-ios-broker-device-run-v2"
raise "canonical device report did not pass" unless report["status"] == "PASS"
raise "canonical device CoreDevice ID mismatch" unless report.dig("device", "coreDeviceIdentifier") == device_id
raise "canonical device hardware UDID mismatch" unless report.dig("device", "udid") == udid
debug = report.dig("build", "semanticDebug") || {}
raise "canonical Debug configuration mismatch" unless debug["configuration"] == "Debug"
raise "canonical Debug app path mismatch" unless debug["appPath"] == app
raise "canonical Debug extension path mismatch" unless debug["embeddedExtensionPath"] == extension
raise "canonical Debug result bundle mismatch" unless debug["resultBundle"] == result_bundle
raise "canonical retained validation path mismatch" unless report.dig("validations", "semanticDebugRetainedProduct") == retained_manifest
RUBY

[ -d "$app_path" ] || fail "retained Debug app is missing: $app_path"
[ -d "$extension_path" ] || fail "retained Debug extension is missing: $extension_path"
[ -d "$result_bundle" ] || fail "retained Debug xcresult is missing: $result_bundle"
host_executable="$app_path/OliphauntBrokerSpike"
extension_executable="$extension_path/BrokerAppExtension"
host_debug_dylib="$app_path/OliphauntBrokerSpike.debug.dylib"
extension_debug_dylib="$extension_path/BrokerAppExtension.debug.dylib"
for file in "$host_executable" "$extension_executable" "$host_debug_dylib" "$extension_debug_dylib"; do
  [ -f "$file" ] || fail "retained Debug artifact is missing: $file"
done

codesign --verify --deep --strict "$app_path" >"$logs_dir/codesign.log" 2>&1 || \
  fail "retained Debug app failed strict code-signature verification"
codesign --verify --strict "$extension_path" >>"$logs_dir/codesign.log" 2>&1 || \
  fail "retained Debug extension failed strict code-signature verification"
host_identifier="$(codesign -dv --verbose=4 "$app_path" 2>&1 | sed -n 's/^Identifier=//p' | tail -1)"
extension_identifier="$(codesign -dv --verbose=4 "$extension_path" 2>&1 | sed -n 's/^Identifier=//p' | tail -1)"
host_team="$(codesign -dv --verbose=4 "$app_path" 2>&1 | sed -n 's/^TeamIdentifier=//p' | tail -1)"
extension_team="$(codesign -dv --verbose=4 "$extension_path" 2>&1 | sed -n 's/^TeamIdentifier=//p' | tail -1)"
[ "$host_identifier" = "$app_bundle_id" ] || fail "retained Debug host bundle identifier changed"
[ "$extension_identifier" = "$extension_bundle_id" ] || fail "retained Debug extension bundle identifier changed"
[ "$host_team" = "$expected_team" ] || fail "retained Debug host signing team changed"
[ "$extension_team" = "$expected_team" ] || fail "retained Debug extension signing team changed"

host_sha="$(shasum -a 256 "$host_executable" | awk '{print $1}')"
extension_sha="$(shasum -a 256 "$extension_executable" | awk '{print $1}')"
host_debug_sha="$(shasum -a 256 "$host_debug_dylib" | awk '{print $1}')"
extension_debug_sha="$(shasum -a 256 "$extension_debug_dylib" | awk '{print $1}')"
[ "$host_sha" = "$expected_host_sha" ] || fail "retained Debug host executable hash changed"
[ "$extension_sha" = "$expected_extension_sha" ] || fail "retained Debug extension executable hash changed"
[ "$host_debug_sha" = "$expected_host_debug_sha" ] || fail "retained Debug host code dylib hash changed since preflight"
[ "$extension_debug_sha" = "$expected_extension_debug_sha" ] || fail "retained Debug extension code dylib hash changed since preflight"
nm "$host_debug_dylib" | xcrun swift-demangle >"$logs_dir/host-debug-symbols.txt"
nm "$extension_debug_dylib" | xcrun swift-demangle >"$logs_dir/extension-debug-symbols.txt"
strings "$host_debug_dylib" >"$logs_dir/host-debug-strings.txt"
grep -Fq 'HangFaultMatrix' "$logs_dir/host-debug-symbols.txt" || fail "retained Debug host omits HangFaultMatrix"
grep -Fq 'OLIPHAUNT_BROKER_FIXTURE_MODE' "$logs_dir/host-debug-strings.txt" || fail "retained Debug host omits fixture-mode selection"
grep -Fq 'armDeadlockAfterNativeRequestRegistration' "$logs_dir/extension-debug-symbols.txt" || fail "retained Debug extension omits the armed deadlock fault"

ruby -rjson - "$artifact_validation" "$retained_manifest" "$app_path" "$extension_path" \
  "$result_bundle" "$host_sha" "$extension_sha" "$host_debug_sha" "$extension_debug_sha" \
  "$host_team" <<'RUBY'
output, manifest, app, extension, result, host_sha, extension_sha, host_debug_sha,
  extension_debug_sha, team = ARGV
payload = {
  schema: "oliphaunt-ios-broker-retained-debug-hang-artifact-v1",
  status: "PASS",
  manifest: manifest,
  appPath: app,
  extensionPath: extension,
  resultBundle: result,
  teamIdentifier: team,
  hostExecutableSHA256: host_sha,
  extensionExecutableSHA256: extension_sha,
  hostDebugDylibSHA256: host_debug_sha,
  extensionDebugDylibSHA256: extension_debug_sha,
  faultSymbolsPresent: true,
}
File.write(output, JSON.pretty_generate(payload) + "\n")
RUBY

xcrun devicectl device info details \
  --device "$device_id" \
  --timeout 20 \
  --json-output "$device_details" \
  >"$logs_dir/devicectl-device-details.log" 2>&1 || \
  fail "failed to inspect the pinned physical device"
xcrun devicectl device info lockState \
  --device "$device_id" \
  --timeout 20 \
  --json-output "$device_lock_state" \
  >"$logs_dir/devicectl-lock-state.log" 2>&1 || true
ruby -rjson - "$device_details" "$device_id" "$expected_udid" <<'RUBY' || \
  fail "pinned physical-device preflight failed"
path, identifier, udid = ARGV
report = JSON.parse(File.read(path))
raise "device details outcome was not success" unless report.dig("info", "outcome") == "success"
device = report["result"] || {}
hardware = device["hardwareProperties"] || {}
properties = device["deviceProperties"] || {}
connection = device["connectionProperties"] || {}
raise "CoreDevice identifier mismatch" unless device["identifier"] == identifier
raise "hardware UDID mismatch" unless hardware["udid"] == udid
raise "target is not a physical iOS device" unless hardware["platform"] == "iOS" && hardware["reality"] == "physical"
raise "target is not booted" unless properties["bootState"] == "booted"
raise "Developer Mode is not enabled" unless properties["developerModeStatus"] == "enabled"
raise "DDI services are unavailable" unless properties["ddiServicesAvailable"] == true
raise "device is not paired" unless connection["pairingState"] == "paired"
raise "device tunnel is not connected" unless connection["tunnelState"] == "connected"
RUBY

printf 'Removing only exact pre-existing spike processes before Debug replacement...\n'
xcrun devicectl device info apps \
  --device "$device_id" \
  --bundle-id "$app_bundle_id" \
  --timeout 30 \
  --json-output "$installed_apps_before" \
  >"$logs_dir/devicectl-installed-apps-before.log" 2>&1 || \
  fail "failed to inspect the currently installed spike app"
existing_installation_url="$(ruby -rjson - "$installed_apps_before" "$device_id" "$app_bundle_id" <<'RUBY'
path, device_id, bundle_id = ARGV
report = JSON.parse(File.read(path))
raise "installed-app inventory outcome was not success" unless report.dig("info", "outcome") == "success"
raise "installed-app inventory targeted a different device" unless report.dig("result", "deviceIdentifier") == device_id
apps = report.dig("result", "apps")
raise "installed-app inventory omitted apps" unless apps.is_a?(Array)
raise "multiple apps matched the exact bundle ID" if apps.length > 1
unless apps.empty?
  raise "installed app bundle ID mismatch" unless apps.first["bundleIdentifier"] == bundle_id
  puts apps.first.fetch("url")
end
RUBY
)" || fail "installed spike app identity validation failed"
terminate_exact_app_processes setup "$existing_installation_url" || \
  fail "failed to prove a clean pre-launch host/extension process state"

printf 'Installing exact retained Debug app for the one-shot physical hang lane...\n'
xcrun devicectl device install app \
  --device "$device_id" \
  --timeout 120 \
  --json-output "$install_json" \
  "$app_path" >"$install_log" 2>&1 || fail "failed to install the retained Debug app"
installation_url="$(ruby -rjson - "$install_json" "$device_id" "$app_bundle_id" "$app_path" <<'RUBY'
path, device_id, bundle_id, app_path = ARGV
report = JSON.parse(File.read(path))
raise "install outcome was not success" unless report.dig("info", "outcome") == "success"
raise "install targeted a different device" unless report.dig("result", "deviceIdentifier") == device_id
arguments = report.dig("info", "arguments")
raise "install command omitted its exact source app" unless arguments.is_a?(Array) && arguments.last == app_path
apps = report.dig("result", "installedApplications")
raise "install returned the wrong app" unless apps.is_a?(Array) && apps.length == 1 && apps.first["bundleID"] == bundle_id
raise "install omitted its device URL" if apps.first.fetch("installationURL", "").empty?
puts apps.first.fetch("installationURL")
RUBY
)" || fail "retained Debug install result validation failed"

extract_console_report() {
  ruby -rjson - "$console_log" "$console_report" "$json_marker" <<'RUBY' 2>/dev/null
log_path, output_path, marker = ARGV
line = File.foreach(log_path).select { |candidate| candidate.include?(marker) }.last
exit 1 unless line
payload = line.split(marker, 2).fetch(1).strip
report = JSON.parse(payload)
File.write(output_path, JSON.generate(report) + "\n")
RUBY
}

is_explicit_locked_launch_failure() {
  [ -s "$launch_json" ] || return 1
  ruby -rjson - "$launch_json" <<'RUBY' >/dev/null 2>&1
report = JSON.parse(File.read(ARGV.fetch(0)))
error = report["error"] || {}
exit 1 unless report.dig("info", "outcome") == "failed"
exit 1 unless error["domain"] == "com.apple.dt.CoreDeviceError" && error["code"] == 10_002
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
locked = domains.include?("FBSOpenApplicationServiceErrorDomain") &&
  domains.include?("FBSOpenApplicationErrorDomain") &&
  strings.any? { |value| value.include?("reason: Locked") || value.include?("because the device was not, or could not be, unlocked") }
exit(locked ? 0 : 1)
RUBY
}

lock_retry_deadline=$((SECONDS + 120))
launch_attempt=0
while :; do
  launch_attempt=$((launch_attempt + 1))
  : >"$launch_json"
  : >"$console_log"
  printf 'Launching deliberate-hang attempt %s on the physical device...\n' "$launch_attempt"
  xcrun devicectl device process launch \
    --device "$device_id" \
    --terminate-existing \
    --activate \
    --console \
    --environment-variables '{"NSUnbufferedIO":"YES","OLIPHAUNT_BROKER_FIXTURE_DISABLE_IDLE_TIMER":"YES","OLIPHAUNT_BROKER_FIXTURE_MODE":"hang"}' \
    --timeout "$((timeout_seconds + 60))" \
    --json-output "$launch_json" \
    "$app_bundle_id" >"$console_log" 2>&1 &
  console_pid=$!

  deadline=$((SECONDS + timeout_seconds))
  report_ready=0
  pass_line=""
  while [ "$SECONDS" -lt "$deadline" ]; do
    failure_line="$(grep -F "$failure_marker " "$console_log" 2>/dev/null | tail -1 || true)"
    [ -z "$failure_line" ] || fail "hang fixture emitted failure: $failure_line"
    if [ "$report_ready" = "0" ] && extract_console_report; then
      report_ready=1
    fi
    pass_line="$(grep -F "$success_marker " "$console_log" 2>/dev/null | tail -1 || true)"
    if [ "$report_ready" = "1" ] && [ -n "$pass_line" ]; then
      break
    fi
    if ! kill -0 "$console_pid" 2>/dev/null; then
      wait "$console_pid" 2>/dev/null || true
      console_pid=""
      if [ "$report_ready" = "0" ] && [ -z "$pass_line" ] && is_explicit_locked_launch_failure; then
        [ "$SECONDS" -lt "$lock_retry_deadline" ] || fail "device remained locked for the bounded pre-launch retry window"
        printf 'Device explicitly rejected the hang launch as Locked; waiting to retry...\n'
        sleep 2
        continue 2
      fi
      fail "hang app or console ended before authoritative evidence"
    fi
    sleep 1
  done
  [ "$report_ready" = "1" ] || fail "timed out without a structured physical hang report"
  [ -n "$pass_line" ] || fail "timed out without the authoritative physical hang PASS marker"
  break
done

mkdir -p "$(dirname "$pulled_report")"
xcrun devicectl device copy from \
  --device "$device_id" \
  --source "Documents/broker-spike-report.json" \
  --destination "$pulled_report" \
  --domain-type appDataContainer \
  --domain-identifier "$app_bundle_id" \
  --timeout 30 \
  --json-output "$copy_json" >"$copy_log" 2>&1 || fail "failed to pull the physical hang report"
[ -f "$pulled_report" ] || fail "device copy omitted the physical hang report"
ruby -rjson - "$console_report" "$pulled_report" <<'RUBY' || fail "console and pulled hang reports disagree"
console, pulled = ARGV.map { |path| JSON.parse(File.read(path)) }
raise "console/pulled report mismatch" unless console == pulled
RUBY

report_identity="$(ruby -rjson -e '
  result = JSON.parse(File.read(ARGV.fetch(0))).fetch("result")
  observations = result.fetch("observations")
  puts [result.fetch("hostPID"), result.fetch("workerPID"), observations["recoveredWorkerPID"]].join("\t")
' "$pulled_report")"
IFS=$'\t' read -r report_host_pid initial_worker_pid recovered_worker_pid <<EOF
$report_identity
EOF
case "$report_host_pid" in ''|*[!0-9]*) fail "hang report returned an invalid host PID" ;; esac
case "$initial_worker_pid" in ''|*[!0-9]*) fail "hang report returned an invalid initial worker PID" ;; esac

inventory_filter="processIdentifier == $report_host_pid"
inventory_filter="$inventory_filter OR processIdentifier == $initial_worker_pid"
if [ -n "$recovered_worker_pid" ]; then
  inventory_filter="$inventory_filter OR processIdentifier == $recovered_worker_pid"
fi
xcrun devicectl device info processes \
  --device "$device_id" \
  --filter "$inventory_filter" \
  --columns '*' \
  --timeout 30 \
  --json-output "$process_inventory" \
  >"$logs_dir/devicectl-processes-after-report.log" 2>&1 || fail "failed to inventory the physical hang processes"
ruby -rjson - "$process_inventory" "$pulled_report" "$installation_url" "$device_id" <<'RUBY' || \
  fail "physical process inventory did not corroborate the hang report"
inventory_path, report_path, installation_url, expected_device = ARGV
inventory = JSON.parse(File.read(inventory_path))
result = JSON.parse(File.read(report_path)).fetch("result")
observations = result.fetch("observations")
raise "process inventory outcome was not success" unless inventory.dig("info", "outcome") == "success"
raise "process inventory targeted a different device" unless inventory.dig("result", "deviceIdentifier") == expected_device
processes = inventory.dig("result", "runningProcesses")
raise "process inventory omitted runningProcesses" unless processes.is_a?(Array)
root = installation_url.sub(%r{/\z}, "")
host_pid = result.fetch("hostPID")
initial_worker_pid = result.fetch("workerPID")
recovered_worker_pid = observations["recoveredWorkerPID"]&.then { |value| Integer(value, 10) }
expected_pids = [host_pid, initial_worker_pid, recovered_worker_pid].compact
pids = processes.map do |process|
  pid = process.fetch("processIdentifier")
  executable = process.fetch("executable")
  raise "process inventory contains an unexpected PID" unless expected_pids.include?(pid)
  expected_executable = if pid == host_pid
    "#{root}/OliphauntBrokerSpike"
  else
    "#{root}/Extensions/BrokerAppExtension.appex/BrokerAppExtension"
  end
  raise "process executable does not belong to the exact installed product" unless executable == expected_executable
  pid
end
raise "process inventory has duplicate PIDs" unless pids.uniq.length == pids.length
raise "host process is absent after report publication" unless pids.include?(host_pid)
RUBY

stop_console
[ -s "$launch_json" ] || fail "devicectl omitted the finalized hang launch JSON"
launch_host_pid="$(ruby -rjson - "$launch_json" "$device_id" "$installation_url" <<'RUBY'
path, device_id, installation_url = ARGV
report = JSON.parse(File.read(path))
raise "launch outcome was not success" unless report.dig("info", "outcome") == "success"
raise "launch targeted a different device" unless report.dig("result", "deviceIdentifier") == device_id
host_pid = report.dig("result", "process", "processIdentifier")
raise "launch returned an invalid host PID" unless host_pid.is_a?(Integer) && host_pid.positive?
expected_executable = "#{installation_url.sub(%r{/\z}, "")}/OliphauntBrokerSpike"
raise "launch executable does not belong to the exact installed product" unless report.dig("result", "process", "executable") == expected_executable
options = report.dig("result", "launchOptions") || {}
raise "hang fixture mode was not supplied" unless options.dig("environmentVariables", "OLIPHAUNT_BROKER_FIXTURE_MODE") == "hang"
raise "hang launch was not activated" unless options["activatedWhenStarted"] == true
puts host_pid
RUBY
)" || fail "devicectl hang launch result validation failed"
validate_hang_report "$pulled_report" "$validation_report" "$launch_host_pid" || \
  fail "physical hang report validation failed"
printf '%s\n' "$pass_line" >"$pass_marker"
post_evidence_cleanup
[ "$(cat "$reports_dir/cleanup/status.txt" 2>/dev/null || true)" = "PASS" ] || \
  fail "post-evidence app/extension cleanup was not proven complete"

ruby -rjson - "$runner_report" "$run_token" "$device_details" "$device_lock_state" \
  "$artifact_validation" "$install_json" "$launch_json" "$console_report" "$pulled_report" \
  "$validation_report" "$process_inventory" "$pass_marker" "$canonical_device_report" \
  "$reports_dir/cleanup/status.txt" "$reports_dir/cleanup/post-evidence-processes-after.json" <<'RUBY'
output, token, device_details_path, lock_path, artifact_path, install_path,
  launch_path, console_report_path, pulled_report_path, validation_path,
  process_inventory_path, pass_marker_path, canonical_device_report,
  cleanup_status_path, cleanup_inventory_path = ARGV
details = JSON.parse(File.read(device_details_path)).fetch("result")
validation = JSON.parse(File.read(validation_path))
artifact = JSON.parse(File.read(artifact_path))
device_properties = details.fetch("deviceProperties")
hardware = details.fetch("hardwareProperties")
connection = details.fetch("connectionProperties")
payload = {
  schema: "oliphaunt-ios-broker-physical-hang-run-v1",
  status: "PASS",
  evidenceStatus: validation.fetch("evidenceStatus"),
  recoveryProven: validation.fetch("recoveryProven"),
  recoveryOutcome: validation.fetch("recoveryOutcome"),
  completedAt: Time.now.utc.strftime("%Y-%m-%dT%H:%M:%SZ"),
  runToken: token,
  evidenceType: "signed-debug-physical-device-deliberate-hang",
  device: {
    coreDeviceIdentifier: details.fetch("identifier"),
    udid: hardware.fetch("udid"),
    name: device_properties.fetch("name"),
    os: device_properties.fetch("osVersionNumber"),
    osBuild: device_properties.fetch("osBuildUpdate"),
    productType: hardware.fetch("productType"),
    transport: connection.fetch("transportType"),
    developerMode: device_properties.fetch("developerModeStatus"),
    ddiServicesAvailable: device_properties.fetch("ddiServicesAvailable"),
  },
  artifact: artifact,
  report: JSON.parse(File.read(pulled_report_path)),
  validation: validation,
  evidence: {
    deviceDetails: device_details_path,
    lockState: File.size?(lock_path) ? lock_path : nil,
    install: install_path,
    launch: launch_path,
    consoleReport: console_report_path,
    pulledReport: pulled_report_path,
    processInventoryAfterReport: process_inventory_path,
    passMarker: pass_marker_path,
    canonicalDeviceRunnerReport: canonical_device_report,
    cleanupStatus: cleanup_status_path,
    processInventoryAfterCleanup: cleanup_inventory_path,
  },
  interpretation: {
    genericFixturePassMeansRecovery: false,
    oneSuccessfulRecoveryProvesReliability: false,
    releaseOrDistributionQualified: false,
  },
}
File.write(output, JSON.pretty_generate(payload) + "\n")
RUBY

rm -f "$failure_file"
printf 'Physical deliberate-hang evidence: %s\n' "$runner_report"
ruby -rjson -e '
  report = JSON.parse(File.read(ARGV.fetch(0)))
  puts "Recovery outcome: #{report.fetch("recoveryOutcome")}"
  puts "Recovery proven in this run: #{report.fetch("recoveryProven")}"
' "$runner_report"
