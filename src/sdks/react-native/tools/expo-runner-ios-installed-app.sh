#!/usr/bin/env bash
# Shared iOS installed-app, lifecycle, crash, log, and process-metric helpers
# for the Expo iOS runner. This file is sourced by expo-ios-runner.sh.

latest_metro_runner_pass() {
  local scratch_offset="$1"
  local dev_offset="$2"
  {
    file_from_offset "$scratch_root/metro.log" "$scratch_offset"
    file_from_offset "$metro_dev_log" "$dev_offset"
  } | grep -F "$success_tag" | tail -1 || true
}

latest_metro_tag() {
  local scratch_offset="$1"
  local dev_offset="$2"
  local tag="$3"
  {
    file_from_offset "$scratch_root/metro.log" "$scratch_offset"
    file_from_offset "$metro_dev_log" "$dev_offset"
  } | grep -F "$tag" | tail -1 || true
}

latest_metro_runner_failure() {
  local scratch_offset="$1"
  local dev_offset="$2"
  {
    file_from_offset "$scratch_root/metro.log" "$scratch_offset"
    file_from_offset "$metro_dev_log" "$dev_offset"
  } | grep -E "$failure_tag|metro:bundling:failed|Unable to resolve" | tail -20 || true
}

should_use_maestro_e2e() {
  [ "$runner" = "smoke" ] || return 1
  [ "$sdk" = "iphonesimulator" ] || return 1
  case "$e2e_assertion_runner" in
    maestro)
      maestro_binary >/dev/null || fail "missing required command: maestro; run tools/dev/setup-maestro.sh"
      return 0
      ;;
    auto)
      maestro_binary >/dev/null
      return
      ;;
    *)
      return 1
      ;;
  esac
}

run_maestro_installed_smoke() {
  local device_udid="$1"
  local reports_dir="$scratch_root/reports"
  [ -f "$maestro_flow" ] || fail "missing Maestro installed-app smoke flow: $maestro_flow"
  local maestro
  maestro="$(maestro_binary)" || fail "missing required command: maestro; run tools/dev/setup-maestro.sh"
  mkdir -p "$reports_dir"
  echo "==> $maestro --device $device_udid test $maestro_flow"
  MAESTRO_CLI_NO_ANALYTICS=true \
    MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true \
    "$maestro" --device "$device_udid" test \
      -e APP_ID="$app_id" \
      -e SMOKE_TIMEOUT_MS="$((timeout_seconds * 1000))" \
      "$maestro_flow" \
      >"$reports_dir/maestro.log" 2>&1 &
  local maestro_pid=$!
  local failure_receipt=""
  local capture_failed=0
  while kill -0 "$maestro_pid" 2>/dev/null; do
    failure_receipt="$(latest_ios_simulator_capture_tag "$failure_tag")"
    [ -z "$failure_receipt" ] || break
    if ! ios_simulator_log_capture_is_alive; then
      capture_failed=1
      break
    fi
    sleep 1
  done
  if [ -z "$failure_receipt" ]; then
    # Close the race where the app emits its terminal receipt as Maestro exits
    # after observing the corresponding UI state.
    failure_receipt="$(latest_ios_simulator_capture_tag "$failure_tag")"
  fi
  if [ -n "$failure_receipt" ]; then
    {
      printf '%s\n' "$failure_receipt"
      printf 'maestroPid=%s\n' "$maestro_pid"
      printf 'simulatorLog=%s\n' "${ios_simulator_log_file:-}"
    } >"$reports_dir/maestro-authoritative-failure.txt"
    terminate_ios_maestro_process "$maestro_pid"
    wait "$maestro_pid" 2>/dev/null || true
    printf '%s\n' "$failure_receipt" >&2
    tail -160 "$reports_dir/maestro.log" >&2 || true
    return 2
  fi
  if [ "$capture_failed" = "1" ]; then
    {
      printf 'maestroPid=%s\n' "$maestro_pid"
      printf 'simulatorLog=%s\n' "${ios_simulator_log_file:-}"
      printf 'reason=unified-log-capture-ended-before-maestro\n'
    } >"$reports_dir/maestro-log-capture-failure.txt"
    terminate_ios_maestro_process "$maestro_pid"
    wait "$maestro_pid" 2>/dev/null || true
    tail -160 "$reports_dir/maestro.log" >&2 || true
    [ -z "${ios_simulator_log_file:-}" ] || tail -160 "$ios_simulator_log_file" >&2 || true
    return 3
  fi
  local maestro_status=0
  wait "$maestro_pid" || maestro_status=$?
  if [ "$maestro_status" -ne 0 ]; then
    tail -160 "$reports_dir/maestro.log" >&2 || true
    return 1
  fi
  tail -80 "$reports_dir/maestro.log" >&2 || true
}

terminate_ios_maestro_process() {
  local maestro_pid="$1"
  kill -0 "$maestro_pid" 2>/dev/null || return 0
  # The checksum-pinned Maestro launcher ends with `exec "$JAVACMD" "$@"`,
  # so this PID is the JVM rather than a shell wrapper that could orphan it.
  kill -TERM "$maestro_pid" 2>/dev/null || true
  sleep 0.2
  kill -KILL "$maestro_pid" 2>/dev/null || true
}

resolve_ios_app_process_name() {
  local app="$1"
  local plist="$app/Info.plist"
  [ -f "$plist" ] || {
    echo "iOS app is missing Info.plist: $plist" >&2
    return 1
  }
  local process_name
  process_name="$(plutil -extract CFBundleExecutable raw -o - "$plist" 2>/dev/null)" || {
    echo "iOS app Info.plist is missing CFBundleExecutable: $plist" >&2
    return 1
  }
  case "$process_name" in
    ''|*[!A-Za-z0-9._-]*)
      echo "iOS app has an unsafe CFBundleExecutable for unified-log capture: $process_name" >&2
      return 1
      ;;
  esac
  [ -x "$app/$process_name" ] || {
    echo "iOS app CFBundleExecutable is not executable: $app/$process_name" >&2
    return 1
  }
  printf '%s\n' "$process_name"
}

ios_simulator_log_capture_is_alive() {
  [ -n "${ios_simulator_log_pid:-}" ] && kill -0 "$ios_simulator_log_pid" 2>/dev/null
}

start_ios_simulator_log_capture() {
  local device_udid="$1"
  local process_name="$2"
  [ -z "${ios_simulator_log_pid:-}" ] || {
    echo "iOS simulator unified-log capture is already running: $ios_simulator_log_pid" >&2
    return 1
  }
  case "$process_name" in
    ''|*[!A-Za-z0-9._-]*)
      echo "unsafe iOS process name for unified-log predicate: $process_name" >&2
      return 1
      ;;
  esac

  local logs_dir="$scratch_root/logs"
  mkdir -p "$logs_dir"
  ios_simulator_log_file="$logs_dir/$runner-simulator-unified.log"
  : >"$ios_simulator_log_file"
  xcrun simctl spawn "$device_udid" log stream \
    --style compact \
    --level debug \
    --predicate "process == '$process_name'" \
    >"$ios_simulator_log_file" 2>&1 &
  ios_simulator_log_pid=$!

  # Start the stream before launching the app so a fast Release smoke cannot
  # age out while Maestro starts its driver. The scoped file is also durable
  # evidence and cannot contain a receipt from an already-terminated launch.
  sleep "${OLIPHAUNT_EXPO_IOS_LOG_CAPTURE_STARTUP_SECONDS:-1}"
  if ! ios_simulator_log_capture_is_alive; then
    local capture_status=0
    wait "$ios_simulator_log_pid" || capture_status=$?
    echo "iOS simulator unified-log capture exited during startup with status $capture_status" >&2
    tail -80 "$ios_simulator_log_file" >&2 || true
    ios_simulator_log_pid=""
    return 1
  fi
}

stop_ios_simulator_log_capture() {
  local capture_pid="${ios_simulator_log_pid:-}"
  [ -n "$capture_pid" ] || return 0
  local was_alive=0
  if kill -0 "$capture_pid" 2>/dev/null; then
    was_alive=1
    kill -TERM "$capture_pid" 2>/dev/null || true
    local stop_attempts=20
    while [ "$stop_attempts" -gt 0 ]; do
      kill -0 "$capture_pid" 2>/dev/null || break
      sleep 0.1
      stop_attempts=$((stop_attempts - 1))
    done
    kill -KILL "$capture_pid" 2>/dev/null || true
  fi
  local capture_status=0
  wait "$capture_pid" 2>/dev/null || capture_status=$?
  ios_simulator_log_pid=""
  if [ "$was_alive" = "0" ]; then
    echo "iOS simulator unified-log capture ended unexpectedly with status $capture_status" >&2
    return 1
  fi
  return 0
}

latest_ios_simulator_capture_tag() {
  local tag="$1"
  [ -n "${ios_simulator_log_file:-}" ] && [ -f "$ios_simulator_log_file" ] || return 0
  grep -F "$tag" "$ios_simulator_log_file" | tail -1 || true
}

wait_for_ios_simulator_maestro_receipt() {
  local grace_seconds="${OLIPHAUNT_EXPO_IOS_RECEIPT_GRACE_SECONDS:-15}"
  case "$grace_seconds" in
    ''|*[!0-9]*)
      echo "OLIPHAUNT_EXPO_IOS_RECEIPT_GRACE_SECONDS must be a nonnegative integer, got $grace_seconds" >&2
      return 4
      ;;
  esac
  local deadline=$((SECONDS + grace_seconds))
  local pass failure_receipt
  while :; do
    failure_receipt="$(latest_ios_simulator_capture_tag "$failure_tag")"
    if [ -n "$failure_receipt" ]; then
      printf '%s\n' "$failure_receipt" >&2
      return 2
    fi
    pass="$(latest_ios_simulator_capture_tag "$success_tag")"
    if [ -n "$pass" ]; then
      printf '%s\n' "$pass"
      return 0
    fi
    ios_simulator_log_capture_is_alive || return 3
    [ "$SECONDS" -lt "$deadline" ] || return 1
    sleep 1
  done
}

write_ios_maestro_diagnostics() {
  local device_udid="$1"
  local process_name="$2"
  local reason="$3"
  local reports_dir="$scratch_root/reports"
  mkdir -p "$reports_dir"
  {
    printf 'reason=%s\n' "$reason"
    printf 'deviceUdid=%s\n' "$device_udid"
    printf 'processName=%s\n' "$process_name"
    printf 'simulatorLog=%s\n' "${ios_simulator_log_file:-}"
  } >"$reports_dir/maestro-$reason.txt"
  xcrun simctl spawn "$device_udid" log show \
    --style compact \
    --last 15m \
    --predicate "process == '$process_name'" \
    >"$reports_dir/maestro-unified-log-$reason.txt" 2>&1 || true
  xcrun simctl io "$device_udid" screenshot \
    "$reports_dir/maestro-screen-$reason.png" >/dev/null 2>&1 || true
  [ -s "$reports_dir/maestro-screen-$reason.png" ] || rm -f "$reports_dir/maestro-screen-$reason.png"
  tail -200 "$reports_dir/maestro-unified-log-$reason.txt" >&2 || true
}

write_ios_process_metrics() {
  local launch_pid="$1"
  [ -n "$launch_pid" ] || return 0
  local metrics
  metrics="$(ps -o pid=,rss=,pcpu=,comm= -p "$launch_pid" 2>/dev/null || true)"
  [ -n "$metrics" ] || return 0
  local reports_dir="$scratch_root/reports"
  mkdir -p "$reports_dir"
  {
    printf 'pid\trss_kb\tcpu_percent\tcommand\n'
    printf '%s\n' "$metrics" | awk '{
      pid=$1; rss=$2; cpu=$3; $1=""; $2=""; $3="";
      sub(/^[[:space:]]+/, "", $0);
      printf "%s\t%s\t%s\t%s\n", pid, rss, cpu, $0
    }'
  } >"$reports_dir/$runner-process.tsv"
  cat "$reports_dir/$runner-process.tsv" >&2
}

resolve_prebuilt_ios_app() {
  local configured="${OLIPHAUNT_EXPO_IOS_APP:-}"
  if [ -n "$configured" ]; then
    [ -d "$configured" ] || fail "OLIPHAUNT_EXPO_IOS_APP is not an .app directory: $configured"
    printf '%s\n' "$configured"
    return
  fi
  local artifact_app
  artifact_app="$(find "$build_artifact_dir" -maxdepth 1 -name '*.app' -type d 2>/dev/null | head -1 || true)"
  if [ -n "$artifact_app" ]; then
    printf '%s\n' "$artifact_app"
    return
  fi
  artifact_app="$(find "$derived_data/Build/Products" -path "*$configuration-*" -name '*.app' -type d 2>/dev/null | head -1 || true)"
  [ -n "$artifact_app" ] ||
    fail "iOS E2E-only mode requires OLIPHAUNT_EXPO_IOS_APP or a previous mobile-build:ios artifact under $build_artifact_dir"
  printf '%s\n' "$artifact_app"
}

extract_devicectl_pid() {
  local json="$1"
  [ -s "$json" ] || return 1
  node - "$json" <<'NODE'
const fs = require('fs');
const data = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const seen = new Set();
function visit(value) {
  if (value == null || typeof value !== 'object' || seen.has(value)) {
    return undefined;
  }
  seen.add(value);
  for (const key of ['processIdentifier', 'pid']) {
    if (Number.isInteger(value[key]) && value[key] > 0) {
      return value[key];
    }
  }
  for (const child of Object.values(value)) {
    const found = visit(child);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}
const pid = visit(data);
if (!pid) {
  process.exit(1);
}
process.stdout.write(String(pid));
NODE
}

write_ios_device_process_metrics() {
  local device_id="$1"
  local reports_dir="$scratch_root/reports"
  local json="$reports_dir/$runner-device-processes.json"
  mkdir -p "$reports_dir"
  xcrun devicectl device info processes \
    --device "$device_id" \
    --columns '*' \
    --timeout 30 \
    --json-output "$json" >/dev/null 2>&1 || true
  [ -s "$json" ] || return 0
  node - "$json" "$app_id" <<'NODE' >"$reports_dir/$runner-process.tsv" || true
const fs = require('node:fs');
const [file, bundleId] = process.argv.slice(2);
const processName = bundleId.split('.').slice(-1)[0]?.toLowerCase() ?? '';
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const rows = [];
const seen = new Set();

function visit(value) {
  if (value == null || typeof value !== 'object' || seen.has(value)) {
    return;
  }
  seen.add(value);
  if (!Array.isArray(value)) {
    const pid = integerFor(value, [
      'processIdentifier',
      'processID',
      'pid',
      'identifier',
    ]);
    if (pid != null && matchesProcess(value)) {
      rows.push({
        pid,
        rssKb: memoryKbFor(value),
        cpuPercent: numberFor(value, [
          'cpuPercent',
          'cpuPercentage',
          'cpuUsage',
          'percentCPU',
        ]),
        command: commandFor(value),
      });
    }
  }
  for (const child of Object.values(value)) {
    visit(child);
  }
}

function integerFor(record, names) {
  for (const name of names) {
    const value = valueFor(record, name);
    if (Number.isInteger(value) && value > 0) {
      return value;
    }
  }
  return null;
}

function numberFor(record, names) {
  for (const name of names) {
    const value = valueFor(record, name);
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function valueFor(record, wanted) {
  const normalizedWanted = normalizeKey(wanted);
  for (const [key, value] of Object.entries(record)) {
    if (normalizeKey(key) === normalizedWanted) {
      if (typeof value === 'object' && value != null && typeof value.value === 'number') {
        return value.value;
      }
      return value;
    }
  }
  return undefined;
}

function normalizeKey(key) {
  return String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function matchesProcess(record) {
  const haystack = Object.values(record)
    .filter(value => typeof value === 'string')
    .join('\n')
    .toLowerCase();
  return haystack.includes(bundleId.toLowerCase()) ||
    (processName.length > 0 && haystack.includes(processName)) ||
    haystack.includes('reactnativeoliphaunt');
}

function memoryKbFor(record) {
  for (const [key, value] of Object.entries(record)) {
    const normalized = normalizeKey(key);
    if (!/(rss|resident|memory)/.test(normalized)) {
      continue;
    }
    const number = typeof value === 'number'
      ? value
      : (typeof value === 'object' && value != null && typeof value.value === 'number'
        ? value.value
        : null);
    if (number == null || !Number.isFinite(number)) {
      continue;
    }
    const unit = typeof value === 'object' && value != null && typeof value.unit === 'string'
      ? value.unit.toLowerCase()
      : '';
    if (unit.includes('byte')) {
      return Math.round(number / 1024);
    }
    if (unit.includes('mb') || unit.includes('mib')) {
      return Math.round(number * 1024);
    }
    return Math.round(number);
  }
  return null;
}

function commandFor(record) {
  for (const name of ['executableName', 'name', 'command', 'bundleIdentifier', 'bundleID']) {
    const value = valueFor(record, name);
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return bundleId;
}

visit(data);
process.stdout.write('pid\trss_kb\tcpu_percent\tcommand\n');
for (const row of rows.slice(0, 1)) {
  process.stdout.write([
    row.pid,
    row.rssKb ?? '',
    row.cpuPercent ?? '',
    String(row.command).replace(/\t/g, ' '),
  ].join('\t') + '\n');
}
NODE
  if [ -s "$reports_dir/$runner-process.tsv" ]; then
    cat "$reports_dir/$runner-process.tsv" >&2
  fi
}

logs_have_lifecycle_ready() {
  local input="${1:-}"
  if [ "$#" -eq 0 ]; then
    input="$(cat)"
  fi
  case "$input" in
    *OLIPHAUNT_EXPO_SMOKE_STAGE*'"stage":"lifecycle:ready"'*) return 0 ;;
    *) return 1 ;;
  esac
}

exercise_ios_lifecycle() {
  local device_udid="$1"
  echo
  echo "==> iOS lifecycle: open Safari, wait ${background_seconds}s, foreground $app_id"
  run xcrun simctl openurl "$device_udid" "https://example.com/liboliphaunt-lifecycle-background"
  sleep "$background_seconds"
  run xcrun simctl launch "$device_udid" "$app_id"
}

exercise_ios_device_lifecycle() {
  local device_id="$1"
  echo
  echo "==> physical iOS lifecycle: open Safari, wait ${background_seconds}s, foreground $app_id"
  run xcrun devicectl device process launch \
    --device "$device_id" \
    --payload-url "https://example.com/liboliphaunt-lifecycle-background" \
    --timeout 30 \
    com.apple.mobilesafari
  sleep "$background_seconds"
  run xcrun devicectl device process launch \
    --device "$device_id" \
    --timeout 30 \
    "$app_id"
}

ios_metro_url() {
  if [ "$sdk" != "iphoneos" ]; then
    printf 'http://127.0.0.1:%s' "$metro_port"
    return
  fi
  if [ -n "${OLIPHAUNT_EXPO_IOS_METRO_URL:-}" ]; then
    printf '%s' "$OLIPHAUNT_EXPO_IOS_METRO_URL"
    return
  fi
  local host="${OLIPHAUNT_EXPO_IOS_METRO_HOST:-}"
  if [ -z "$host" ]; then
    host="$(ipconfig getifaddr en0 2>/dev/null || true)"
  fi
  if [ -z "$host" ]; then
    host="$(ipconfig getifaddr en1 2>/dev/null || true)"
  fi
  [ -n "$host" ] ||
    fail "failed to resolve host LAN address for physical iOS Metro; set OLIPHAUNT_EXPO_IOS_METRO_URL"
  printf 'http://%s:%s' "$host" "$metro_port"
}

ios_runner_url() {
  local selected_runner="$1"
  local root_arg="${2:-}"
  local url="$scheme://oliphaunt-smoke?liboliphauntRunner=$selected_runner&liboliphauntLifecycle=$lifecycle_smoke&liboliphauntDurability=$(urlencode "$durability_profile")&liboliphauntRuntimeFootprint=$(urlencode "$runtime_footprint")"
  if uses_ios_metro; then
    local metro_url encoded_metro_url
    metro_url="$(ios_metro_url)"
    encoded_metro_url="$(urlencode "$metro_url")"
    url="$scheme://expo-development-client/?url=$encoded_metro_url&disableOnboarding=1&liboliphauntRunner=$selected_runner&liboliphauntLifecycle=$lifecycle_smoke&liboliphauntDurability=$(urlencode "$durability_profile")&liboliphauntRuntimeFootprint=$(urlencode "$runtime_footprint")"
  fi
  if [ "$selected_runner" = "benchmark" ]; then
    url="$url&liboliphauntBenchmarkPreset=$(urlencode "$benchmark_preset")"
  fi
  if [ -n "$startup_gucs" ]; then
    url="$url&liboliphauntStartupGUCs=$(urlencode "$startup_gucs")"
  fi
  url="$url&liboliphauntWalSegsizeMB=$(urlencode "$wal_segsize_mb")"
  if [ -n "$root_arg" ]; then
    url="$url&liboliphauntRoot=$(urlencode "$root_arg")"
  fi
  printf '%s' "$url"
}

wait_for_ios_tag() {
  local device_udid="$1"
  local tag="$2"
  local fail_tag="$3"
  local scratch_offset="$4"
  local dev_offset="$5"
  local deadline=$((SECONDS + timeout_seconds))
  local logs pass fail_line
  while [ "$SECONDS" -lt "$deadline" ]; do
    logs="$(xcrun simctl spawn "$device_udid" log show --style compact --last 30s --predicate "process == 'reactnativeoliphauntexpo'" 2>/dev/null || true)"
    pass="$(printf '%s\n' "$logs" | grep -F "$tag" | tail -1 || true)"
    if [ -z "$pass" ]; then
      pass="$(latest_metro_tag "$scratch_offset" "$dev_offset" "$tag")"
    fi
    if [ -n "$pass" ]; then
      printf '\n%s\n' "$pass"
      return 0
    fi
    fail_line="$(printf '%s\n' "$logs" | grep -E "$fail_tag|Fatal error|terminating" | tail -20 || true)"
    if [ -z "$fail_line" ]; then
      fail_line="$(latest_metro_runner_failure "$scratch_offset" "$dev_offset")"
    fi
    if [ -n "$fail_line" ]; then
      printf '%s\n' "$fail_line" >&2
      return 1
    fi
    sleep 2
  done
  return 1
}

exercise_ios_crash_recovery() {
  local device_udid="$1"
  local root_path="$2"
  local write_url verify_url launch_output launch_pid write_line pass scratch_offset dev_offset

  if [ -z "$crash_root_override" ]; then
    case "$root_path" in
      app-support://*)
        ;;
      /*)
        rm -rf "$root_path"
        ;;
    esac
  fi

  start_metro_if_needed crash-write "$root_path"
  scratch_offset="$(file_bytes "$scratch_root/metro.log")"
  dev_offset="$(file_bytes "$metro_dev_log")"
  write_url="$(ios_runner_url crash-write "$root_path")"

  echo
  echo "==> iOS crash recovery: write phase"
  run xcrun simctl terminate "$device_udid" "$app_id" || true
  launch_output="$(xcrun simctl launch "$device_udid" "$app_id" --initialUrl "$write_url")"
  printf '%s\n' "$launch_output"
  launch_pid="$(printf '%s\n' "$launch_output" | awk -F': ' -v app_id="$app_id" '$1 == app_id {print $2; exit}')"
  write_line="$(wait_for_ios_tag "$device_udid" OLIPHAUNT_EXPO_CRASH_WRITE_READY "$failure_tag" "$scratch_offset" "$dev_offset")" ||
    fail "Expo iOS crash recovery write phase failed"
  mkdir -p "$scratch_root/reports"
  printf '%s\n' "$write_line" >"$scratch_root/reports/crash-write-ready.log"

  echo
  echo "==> iOS crash recovery: terminate app process, then verify phase"
  run xcrun simctl terminate "$device_udid" "$app_id" || true
  stop_owned_metro
  start_metro_if_needed crash-verify "$root_path"
  scratch_offset="$(file_bytes "$scratch_root/metro.log")"
  dev_offset="$(file_bytes "$metro_dev_log")"
  verify_url="$(ios_runner_url crash-verify "$root_path")"
  launch_output="$(xcrun simctl launch "$device_udid" "$app_id" --initialUrl "$verify_url")"
  printf '%s\n' "$launch_output"
  launch_pid="$(printf '%s\n' "$launch_output" | awk -F': ' -v app_id="$app_id" '$1 == app_id {print $2; exit}')"
  pass="$(wait_for_ios_tag "$device_udid" "$success_tag" "$failure_tag" "$scratch_offset" "$dev_offset")" ||
    fail "Expo iOS crash recovery verify phase failed"
  write_runner_report "$pass"
  write_ios_process_metrics "$launch_pid"
}

launch_ios_device_runner() {
  local device_id="$1"
  local selected_runner="$2"
  local root_arg="${3:-}"
  local json="$scratch_root/devicectl-launch-$selected_runner.json"
  local log="$scratch_root/devicectl-launch-$selected_runner.log"
  local url deadline attempt launch_timeout
  url="$(ios_runner_url "$selected_runner" "$root_arg")"
  deadline=$((SECONDS + timeout_seconds))
  attempt=1
  launch_timeout="${OLIPHAUNT_EXPO_IOS_DEVICE_LAUNCH_ATTEMPT_TIMEOUT_SECONDS:-20}"

  while [ "$SECONDS" -lt "$deadline" ]; do
    echo >&2
    echo "==> xcrun devicectl device process launch --device $device_id --terminate-existing --payload-url $url $app_id" >&2
    if xcrun devicectl device process launch \
      --device "$device_id" \
      --terminate-existing \
      --payload-url "$url" \
      --timeout "$launch_timeout" \
      --json-output "$json" \
      "$app_id" >"$log" 2>&1; then
      cat "$log" >&2
      extract_devicectl_pid "$json" 2>/dev/null || true
      return 0
    fi

    if grep -Eq 'Locked|could not be unlocked|device was not, or could not be, unlocked' "$log"; then
      echo "physical iOS device is locked; waiting for unlock before retrying launch (attempt $attempt)" >&2
      sleep 5
      attempt=$((attempt + 1))
      continue
    fi
    cat "$log" >&2
    return 1
  done

  cat "$log" >&2
  echo "physical iOS device stayed locked until launch timeout; unlock it and rerun with OLIPHAUNT_EXPO_IOS_REUSE_INSTALLED_APP=1" >&2
  return 1
}

wait_for_ios_device_runner() {
  local device_id="$1"
  local scratch_offset="$2"
  local dev_offset="$3"
  local deadline=$((SECONDS + timeout_seconds))
  local pass fail_line lifecycle_exercised=0 lifecycle_logs
  while [ "$SECONDS" -lt "$deadline" ]; do
    if [ "$lifecycle_smoke" = "1" ] && [ "$lifecycle_exercised" = "0" ]; then
      lifecycle_logs="$(
        {
          file_from_offset "$scratch_root/metro.log" "$scratch_offset"
          file_from_offset "$metro_dev_log" "$dev_offset"
        } || true
      )"
      if logs_have_lifecycle_ready "$lifecycle_logs"; then
        exercise_ios_device_lifecycle "$device_id"
        lifecycle_exercised=1
        sleep 2
        continue
      fi
    fi
    pass="$(latest_metro_runner_pass "$scratch_offset" "$dev_offset")"
    if [ -n "$pass" ]; then
      printf '\n%s\n' "$pass"
      write_runner_report "$pass"
      write_ios_device_process_metrics "$device_id"
      return 0
    fi
    fail_line="$(latest_metro_runner_failure "$scratch_offset" "$dev_offset")"
    if [ -n "$fail_line" ]; then
      printf '%s\n' "$fail_line" >&2
      return 1
    fi
    sleep 2
  done
  return 1
}

exercise_ios_device_crash_recovery() {
  local device_id="$1"
  local root_path="$2"
  local write_pid write_line pass scratch_offset dev_offset

  if [ -z "$crash_root_override" ]; then
    case "$root_path" in
      app-support://*)
        ;;
      /*)
        rm -rf "$root_path"
        ;;
    esac
  fi

  start_metro_if_needed crash-write "$root_path"
  scratch_offset="$(file_bytes "$scratch_root/metro.log")"
  dev_offset="$(file_bytes "$metro_dev_log")"
  write_pid="$(launch_ios_device_runner "$device_id" crash-write "$root_path")" ||
    fail "failed to launch iOS device crash recovery write phase"
  write_line="$(wait_for_ios_tag_from_metro OLIPHAUNT_EXPO_CRASH_WRITE_READY "$failure_tag" "$scratch_offset" "$dev_offset")" ||
    fail "Expo iOS device crash recovery write phase failed"
  mkdir -p "$scratch_root/reports"
  printf '%s\n' "$write_line" >"$scratch_root/reports/crash-write-ready.log"

  if [ -n "$write_pid" ]; then
    run xcrun devicectl device process terminate \
      --device "$device_id" \
      --pid "$write_pid" \
      --kill \
      --timeout 30 || true
  fi

  stop_owned_metro
  start_metro_if_needed crash-verify "$root_path"
  scratch_offset="$(file_bytes "$scratch_root/metro.log")"
  dev_offset="$(file_bytes "$metro_dev_log")"
  launch_ios_device_runner "$device_id" crash-verify "$root_path" >/dev/null ||
    fail "failed to launch iOS device crash recovery verify phase"
  pass="$(wait_for_ios_tag_from_metro "$success_tag" "$failure_tag" "$scratch_offset" "$dev_offset")" ||
    fail "Expo iOS device crash recovery verify phase failed"
  write_runner_report "$pass"
  write_ios_device_process_metrics "$device_id"
}

wait_for_ios_tag_from_metro() {
  local tag="$1"
  local fail_tag="$2"
  local scratch_offset="$3"
  local dev_offset="$4"
  local deadline=$((SECONDS + timeout_seconds))
  local pass fail_line
  while [ "$SECONDS" -lt "$deadline" ]; do
    pass="$(latest_metro_tag "$scratch_offset" "$dev_offset" "$tag")"
    if [ -n "$pass" ]; then
      printf '\n%s\n' "$pass"
      return 0
    fi
    fail_line="$(latest_metro_runner_failure "$scratch_offset" "$dev_offset")"
    if [ -n "$fail_line" ]; then
      printf '%s\n' "$fail_line" >&2
      return 1
    fi
    sleep 2
  done
  return 1
}

install_and_launch() {
  local app="$1"
  if [ "${OLIPHAUNT_EXPO_IOS_BUILD_ONLY:-0}" = "1" ]; then
    echo "iOS build-only smoke complete: $app"
    return
  fi

  if [ "$sdk" = "iphoneos" ]; then
    local device_id
    device_id="$(select_ios_physical_device_id)" ||
      fail "failed to resolve a paired physical iOS device; set OLIPHAUNT_EXPO_IOS_DEVICE_ID"
    echo "Using physical iOS device: $device_id"
    run xcrun devicectl device install app \
      --device "$device_id" \
      --timeout 120 \
      --json-output "$scratch_root/devicectl-install.json" \
      "$app"

    if [ "$runner" = "crash" ]; then
      local crash_root="$crash_root_override"
      [ -n "$crash_root" ] || crash_root="app-support://oliphaunt-crash-recovery-root-$crash_root_suffix"
      exercise_ios_device_crash_recovery "$device_id" "$crash_root"
      return
    fi

    if uses_ios_metro; then
      start_metro_if_needed "$runner"
    fi
    local scratch_metro_offset dev_metro_offset
    scratch_metro_offset="$(file_bytes "$scratch_root/metro.log")"
    dev_metro_offset="$(file_bytes "$metro_dev_log")"
    launch_ios_device_runner "$device_id" "$runner" >/dev/null ||
      fail "failed to launch Expo iOS $runner on physical device"
    wait_for_ios_device_runner "$device_id" "$scratch_metro_offset" "$dev_metro_offset" ||
      fail "timed out waiting for $success_tag from physical iOS device"
    return
  fi

  local device_udid
  device_udid="$(select_ios_simulator_udid)" ||
    fail "failed to resolve an available iOS simulator for installed-app smoke"
  boot_ios_simulator "$device_udid"
  if is_truthy "$clean_simulator_install"; then
    run xcrun simctl uninstall "$device_udid" "$app_id" || true
  fi
  run xcrun simctl install "$device_udid" "$app"
  run xcrun simctl terminate "$device_udid" "$app_id" || true

  if [ "$runner" = "crash" ]; then
    local crash_root="$crash_root_override"
    if [ -z "$crash_root" ]; then
      local container
      container="$(xcrun simctl get_app_container "$device_udid" "$app_id" data)" ||
        fail "failed to resolve iOS app data container for crash recovery"
      crash_root="$container/Documents/oliphaunt-crash-recovery-root-$crash_root_suffix"
    fi
    exercise_ios_crash_recovery "$device_udid" "$crash_root"
    return
  fi

  if uses_ios_metro; then
    start_metro_if_needed "$runner"
  fi
  local scratch_metro_offset dev_metro_offset
  scratch_metro_offset="$(file_bytes "$scratch_root/metro.log")"
  dev_metro_offset="$(file_bytes "$metro_dev_log")"
  local use_maestro_e2e=0 app_process_name=""
  if should_use_maestro_e2e; then
    [ "$lifecycle_smoke" != "1" ] ||
      fail "Maestro mobile E2E does not drive lifecycle transitions; use mobile-drill or set OLIPHAUNT_EXPO_IOS_LIFECYCLE_SMOKE=0"
    app_process_name="$(resolve_ios_app_process_name "$app")" ||
      fail "failed to resolve the installed iOS app executable for unified-log capture"
    start_ios_simulator_log_capture "$device_udid" "$app_process_name" ||
      fail "failed to start exact-launch iOS unified-log capture"
    use_maestro_e2e=1
  fi
  local url
  url="$(ios_runner_url "$runner")"
  local launch_output launch_pid
  echo
  echo "==> xcrun simctl launch $device_udid $app_id --initialUrl $url"
  launch_output="$(xcrun simctl launch "$device_udid" "$app_id" --initialUrl "$url")"
  printf '%s\n' "$launch_output"
  launch_pid="$(printf '%s\n' "$launch_output" | awk -F': ' -v app_id="$app_id" '$1 == app_id {print $2; exit}')"
  if [ "${OLIPHAUNT_EXPO_IOS_OPENURL_FALLBACK:-0}" = "1" ]; then
    sleep 2
    run xcrun simctl openurl "$device_udid" "$url" || true
  fi

  local logs pass
  if [ "$use_maestro_e2e" = "1" ]; then
    local maestro_status=0
    run_maestro_installed_smoke "$device_udid" || maestro_status=$?
    if [ "$maestro_status" -ne 0 ]; then
      stop_ios_simulator_log_capture || true
      if [ "$maestro_status" = "2" ]; then
        write_ios_maestro_diagnostics "$device_udid" "$app_process_name" "authoritative-smoke-failure"
        fail "Expo iOS installed app emitted $failure_tag while Maestro was running"
      fi
      if [ "$maestro_status" = "3" ]; then
        write_ios_maestro_diagnostics "$device_udid" "$app_process_name" "log-capture-failure"
        fail "Expo iOS exact-launch unified-log capture ended while Maestro was running"
      fi
      write_ios_maestro_diagnostics "$device_udid" "$app_process_name" "maestro-failure"
      fail "Expo iOS installed-app Maestro smoke failed"
    fi

    local receipt_status=0
    pass="$(wait_for_ios_simulator_maestro_receipt)" || receipt_status=$?
    stop_ios_simulator_log_capture || true
    if [ "$receipt_status" = "0" ]; then
      printf '\n%s\n' "$pass"
      if ! write_runner_report "$pass"; then
        write_ios_maestro_diagnostics "$device_udid" "$app_process_name" "invalid-authoritative-pass-receipt"
        fail "Expo iOS app emitted an invalid authoritative OLIPHAUNT_EXPO_SMOKE_PASS receipt"
      fi
    elif [ "$receipt_status" = "2" ]; then
      write_ios_maestro_diagnostics "$device_udid" "$app_process_name" "authoritative-smoke-failure"
      fail "Expo iOS installed app emitted $failure_tag after Maestro observed the UI"
    elif [ "$receipt_status" = "3" ]; then
      write_ios_maestro_diagnostics "$device_udid" "$app_process_name" "log-capture-failure"
      fail "Expo iOS exact-launch unified-log capture ended before the app receipt was collected"
    elif [ "$receipt_status" = "4" ]; then
      write_ios_maestro_diagnostics "$device_udid" "$app_process_name" "invalid-receipt-grace"
      fail "Expo iOS receipt grace configuration is invalid"
    else
      write_ios_maestro_diagnostics "$device_udid" "$app_process_name" "missing-authoritative-pass-receipt"
      fail "Expo iOS installed-app smoke UI passed without an authoritative OLIPHAUNT_EXPO_SMOKE_PASS receipt"
    fi
    write_ios_process_metrics "$launch_pid"
    return
  fi

  local deadline=$((SECONDS + timeout_seconds))
  local fail_line lifecycle_exercised=0
  while [ "$SECONDS" -lt "$deadline" ]; do
    logs="$(xcrun simctl spawn "$device_udid" log show --style compact --last 30s --predicate "process == 'reactnativeoliphauntexpo'" 2>/dev/null || true)"
    if [ "$lifecycle_smoke" = "1" ] && [ "$lifecycle_exercised" = "0" ]; then
      if {
        printf '%s\n' "$logs"
        file_from_offset "$scratch_root/metro.log" "$scratch_metro_offset"
        file_from_offset "$metro_dev_log" "$dev_metro_offset"
      } | logs_have_lifecycle_ready; then
        exercise_ios_lifecycle "$device_udid"
        lifecycle_exercised=1
        sleep 2
        continue
      fi
    fi
    pass="$(printf '%s\n' "$logs" | grep -F "$success_tag" | tail -1 || true)"
    if [ -n "$pass" ]; then
      printf '\n%s\n' "$pass"
      write_runner_report "$pass"
      write_ios_process_metrics "$launch_pid"
      return
    fi
    if uses_ios_metro; then
      pass="$(latest_metro_runner_pass "$scratch_metro_offset" "$dev_metro_offset")"
      if [ -n "$pass" ]; then
        printf '\n%s\n' "$pass"
        write_runner_report "$pass"
        write_ios_process_metrics "$launch_pid"
        return
      fi
    fi
    fail_line="$(printf '%s\n' "$logs" | grep -E "$failure_tag|Fatal error|terminating" | tail -20 || true)"
    if [ -n "$fail_line" ]; then
      printf '%s\n' "$fail_line" >&2
      fail "Expo iOS $runner failed"
    fi
    if uses_ios_metro; then
      fail_line="$(latest_metro_runner_failure "$scratch_metro_offset" "$dev_metro_offset")"
      if [ -n "$fail_line" ]; then
        printf '%s\n' "$fail_line" >&2
        fail "Expo iOS $runner failed"
      fi
    fi
    sleep 2
  done

  xcrun simctl spawn "$device_udid" log show --style compact --last 2m 2>/dev/null | tail -200 >&2 || true
  file_from_offset "$scratch_root/metro.log" "$scratch_metro_offset" | tail -120 >&2 || true
  file_from_offset "$metro_dev_log" "$dev_metro_offset" | tail -120 >&2 || true
  fail "timed out waiting for $success_tag"
}
