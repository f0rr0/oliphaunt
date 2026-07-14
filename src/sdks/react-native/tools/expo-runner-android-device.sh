#!/usr/bin/env bash
# Shared Android device, logcat, lifecycle, and installed-app helpers for the
# Expo Android runner. This file is sourced by expo-android-runner.sh.

should_use_maestro_e2e() {
  [ "$runner" = "smoke" ] || return 1
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
  local device_id="$1"
  local reports_dir="$scratch_root/reports"
  [ -f "$maestro_flow" ] || fail "missing Maestro installed-app smoke flow: $maestro_flow"
  local maestro
  maestro="$(maestro_binary)" || fail "missing required command: maestro; run tools/dev/setup-maestro.sh"
  mkdir -p "$reports_dir"
  echo "==> $maestro --device $device_id test $maestro_flow"
  MAESTRO_CLI_NO_ANALYTICS=true \
    MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true \
    "$maestro" --device "$device_id" test \
      -e APP_ID="$app_id" \
      -e SMOKE_TIMEOUT_MS="$((timeout_seconds * 1000))" \
      "$maestro_flow" \
      >"$reports_dir/maestro.log" 2>&1 || {
        tail -160 "$reports_dir/maestro.log" >&2 || true
        return 1
      }
  tail -80 "$reports_dir/maestro.log" >&2 || true
}

latest_metro_tag() {
  local offset="$1"
  local tag="$2"
  file_from_offset "$scratch_root/metro.log" "$offset" | grep -F "$tag" | tail -1 || true
}

write_android_process_metrics() {
  local adb="$1"
  local reports_dir="$scratch_root/reports"
  mkdir -p "$reports_dir"
  "$adb" shell dumpsys meminfo "$app_id" >"$reports_dir/$runner-meminfo.txt"
  sed -n '/TOTAL PSS/p;/TOTAL RSS/p' "$reports_dir/$runner-meminfo.txt"
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

android_failure_log_pattern() {
  local fail_tag="$1"
  printf '%s\n' "$fail_tag|ANR in Window.*$app_id|Process: $app_id|$app_id.*FATAL EXCEPTION|\\sE AndroidRuntime:.*$app_id"
}

print_android_timeout_diagnostics() {
  local adb="$1"
  local logs
  logs="$("$adb" logcat -d)"
  printf '%s\n' "$logs" |
    grep -E "DevLauncherErrorActivity|Couldn't connect to ws://10\\.0\\.2\\.2:$metro_port|Couldn't connect to ws://127\\.0\\.0\\.1:$metro_port" |
    tail -40 >&2 || true
  printf '%s\n' "$logs" | tail -200 >&2
}

write_android_e2e_diagnostics() {
  local adb="$1"
  local reason="${2:-failure}"
  local reports_dir="$scratch_root/reports"
  local log_file ui_file screenshot_file
  mkdir -p "$reports_dir"
  log_file="$reports_dir/$runner-logcat-$reason.txt"
  ui_file="$reports_dir/$runner-window-$reason.xml"
  screenshot_file="$reports_dir/$runner-screen-$reason.png"

  "$adb" logcat -d >"$log_file" 2>/dev/null || true
  "$adb" shell dumpsys activity top >"$reports_dir/$runner-activity-$reason.txt" 2>/dev/null || true
  "$adb" shell uiautomator dump /sdcard/liboliphaunt-window.xml >/dev/null 2>&1 || true
  "$adb" pull /sdcard/liboliphaunt-window.xml "$ui_file" >/dev/null 2>&1 || true
  "$adb" exec-out screencap -p >"$screenshot_file" 2>/dev/null || true
  [ -s "$screenshot_file" ] || rm -f "$screenshot_file"

  if [ -s "$log_file" ]; then
    tail -200 "$log_file" >&2 || true
  fi
}

exercise_android_lifecycle() {
  local adb="$1"
  local task_id=""
  echo
  echo "==> Android lifecycle: HOME, wait ${background_seconds}s, foreground $app_id"
  task_id="$(android_task_id "$adb" || true)"
  run "$adb" shell input keyevent KEYCODE_HOME
  sleep "$background_seconds"
  wake_android_device "$adb"
  foreground_android_app "$adb" "$task_id"
}

android_task_id() {
  local adb="$1"
  "$adb" shell dumpsys activity activities |
    sed -n "s/.*Task{[^#]*#\\([0-9][0-9]*\\).*${app_id}.*/\\1/p" |
    head -1 |
    tr -d '\r'
}

foreground_android_app() {
  local adb="$1"
  local task_id="${2:-}"

  # Bring the existing task to the foreground. Relaunching the Expo dev-client
  # deep link here reloads the JS bundle and turns a resume smoke into a restart.
  if [ -n "$task_id" ]; then
    if "$adb" shell cmd activity task lock "$task_id" >/dev/null 2>&1; then
      sleep 1
      "$adb" shell cmd activity task lock stop >/dev/null 2>&1 || true
      return
    fi
  fi

  run "$adb" shell am start -W \
    -a android.intent.action.MAIN \
    -c android.intent.category.LAUNCHER \
    --activity-reorder-to-front \
    -n "$app_id/.MainActivity"
}

android_runner_url() {
  local selected_runner="$1"
  local root_arg="${2:-}"
  local url="$scheme://oliphaunt-smoke?liboliphauntRunner=$selected_runner&liboliphauntLifecycle=$lifecycle_smoke&liboliphauntDurability=$(urlencode "$durability_profile")&liboliphauntRuntimeFootprint=$(urlencode "$runtime_footprint")"
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
  if [ "$build_type" = "debug" ]; then
    local metro_url
    metro_url="http://$metro_host:$metro_port"
    url="$dev_client_scheme://expo-development-client/?url=$(urlencode "$metro_url")&disableOnboarding=1&liboliphauntRunner=$selected_runner&liboliphauntLifecycle=$lifecycle_smoke&liboliphauntDurability=$(urlencode "$durability_profile")&liboliphauntRuntimeFootprint=$(urlencode "$runtime_footprint")"
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
  fi
  printf '%s' "$url"
}

wait_for_android_tag() {
  local adb="$1"
  local tag="$2"
  local fail_tag="$3"
  local deadline=$((SECONDS + timeout_seconds))
  local logs pass fail_line
  while [ "$SECONDS" -lt "$deadline" ]; do
    logs="$("$adb" logcat -d)"
    pass="$(printf '%s\n' "$logs" | grep -F "$tag" | tail -1 || true)"
    if [ -n "$pass" ]; then
      printf '\n%s\n' "$pass"
      return 0
    fi
    fail_line="$(
      printf '%s\n' "$logs" |
        grep -E "$(android_failure_log_pattern "$fail_tag")" |
        tail -20 || true
    )"
    if [ -n "$fail_line" ]; then
      printf '%s\n' "$fail_line" >&2
      return 1
    fi
    sleep 2
  done
  print_android_timeout_diagnostics "$adb"
  return 1
}

wake_android_device() {
  local adb="$1"
  "$adb" shell settings put secure screensaver_enabled 0 >/dev/null 2>&1 || true
  "$adb" shell settings put system screen_off_timeout 2147483647 >/dev/null 2>&1 || true
  "$adb" shell svc power stayon true >/dev/null 2>&1 || true
  "$adb" shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1 || true
  "$adb" shell wm dismiss-keyguard >/dev/null 2>&1 || true
  "$adb" shell input keyevent 82 >/dev/null 2>&1 || true
}

exercise_android_crash_recovery() {
  local adb="$1"
  local write_url verify_url write_line pass
  if [ -z "$crash_root_override" ]; then
    run "$adb" shell rm -rf "$crash_root" || true
  fi
  start_metro_if_needed crash-write "$crash_root"
  if [ "$build_type" = "debug" ]; then
    run "$adb" reverse "tcp:$metro_port" "tcp:$metro_port"
  fi
  write_url="$(android_runner_url crash-write "$crash_root")"

  echo
  echo "==> Android crash recovery: write phase"
  run "$adb" shell am force-stop "$app_id"
  run "$adb" shell am start -a android.intent.action.VIEW -d "'$write_url'" "$app_id"
  if [ "$build_type" = "debug" ]; then
    dismiss_expo_dev_menu_onboarding "$adb"
  fi
  write_line="$(wait_for_android_tag "$adb" OLIPHAUNT_EXPO_CRASH_WRITE_READY "$failure_tag")" ||
    fail "Expo Android crash recovery write phase failed"
  mkdir -p "$scratch_root/reports"
  printf '%s\n' "$write_line" >"$scratch_root/reports/crash-write-ready.log"

  echo
  echo "==> Android crash recovery: force-stop app process, then verify phase"
  run "$adb" shell am force-stop "$app_id"
  stop_owned_metro
  run "$adb" logcat -c
  start_metro_if_needed crash-verify "$crash_root"
  if [ "$build_type" = "debug" ]; then
    run "$adb" reverse "tcp:$metro_port" "tcp:$metro_port"
  fi
  verify_url="$(android_runner_url crash-verify "$crash_root")"
  run "$adb" shell am start -a android.intent.action.VIEW -d "'$verify_url'" "$app_id"
  if [ "$build_type" = "debug" ]; then
    dismiss_expo_dev_menu_onboarding "$adb"
  fi
  pass="$(wait_for_android_tag "$adb" "$success_tag" "$failure_tag")" ||
    fail "Expo Android crash recovery verify phase failed"
  write_runner_report "$pass"
  write_android_process_metrics "$adb"
}

install_and_launch() {
  local adb="$ANDROID_HOME/platform-tools/adb"
  "$adb" devices | grep -Eq 'device$' || fail "no Android emulator/device is connected"
  local device_id
  device_id="$("$adb" devices | awk 'NR > 1 && $2 == "device" {print $1; exit}')"
  [ -n "$device_id" ] || fail "failed to resolve connected Android device id"

  run "$adb" install -r "$apk"
  run "$adb" shell am force-stop "$app_id"
  run "$adb" shell pm clear "$app_id"
  run "$adb" logcat -c
  wake_android_device "$adb"

  if [ "$build_type" = "debug" ] && [ "$runner" != "crash" ]; then
    start_metro_if_needed "$runner"
    run "$adb" reverse "tcp:$metro_port" "tcp:$metro_port"
  fi
  if [ "$runner" = "crash" ]; then
    exercise_android_crash_recovery "$adb"
    return
  fi
  local metro_offset=0
  if [ "$build_type" = "debug" ]; then
    metro_offset="$(file_bytes "$scratch_root/metro.log")"
  fi
  local url
  url="$(android_runner_url "$runner")"
  local shell_url="'$url'"
  run "$adb" shell am start -a android.intent.action.VIEW -d "$shell_url" "$app_id"
  if [ "$build_type" = "debug" ]; then
    dismiss_expo_dev_menu_onboarding "$adb"
  fi

  local logs pass
  if should_use_maestro_e2e; then
    [ "$lifecycle_smoke" != "1" ] ||
      fail "Maestro mobile E2E does not drive lifecycle transitions; use mobile-drill or set OLIPHAUNT_EXPO_ANDROID_LIFECYCLE_SMOKE=0"
    if ! run_maestro_installed_smoke "$device_id"; then
      write_android_e2e_diagnostics "$adb" "maestro-failure"
      fail "Expo Android installed-app Maestro smoke failed"
    fi
    logs="$("$adb" logcat -d)"
    pass="$(latest_metro_tag "$metro_offset" "$success_tag")"
    if [ -z "$pass" ]; then
      pass="$(printf '%s\n' "$logs" | grep -F "$success_tag" | tail -1 || true)"
    fi
    if [ -n "$pass" ]; then
      printf '\n%s\n' "$pass"
      write_runner_report "$pass"
    else
      write_maestro_runner_report android
    fi
    write_android_process_metrics "$adb"
    return
  fi

  local deadline=$((SECONDS + timeout_seconds))
  local fail_line lifecycle_exercised=0
  while [ "$SECONDS" -lt "$deadline" ]; do
    logs="$("$adb" logcat -d)"
    if [ "$lifecycle_smoke" = "1" ] &&
      [ "$lifecycle_exercised" = "0" ] &&
      logs_have_lifecycle_ready "$logs"; then
      exercise_android_lifecycle "$adb"
      lifecycle_exercised=1
      sleep 2
      continue
    fi
    pass="$(latest_metro_tag "$metro_offset" "$success_tag")"
    if [ -z "$pass" ]; then
      pass="$(printf '%s\n' "$logs" | grep -F "$success_tag" | tail -1 || true)"
    fi
    if [ -n "$pass" ]; then
      printf '\n%s\n' "$pass"
      write_runner_report "$pass"
      write_android_process_metrics "$adb"
      return
    fi
    fail_line="$(
      printf '%s\n' "$logs" |
        grep -E "$(android_failure_log_pattern "$failure_tag")" |
        tail -20 || true
    )"
    if [ -n "$fail_line" ]; then
      printf '%s\n' "$fail_line" >&2
      fail "Expo Android $runner failed"
    fi
    sleep 2
  done

  write_android_e2e_diagnostics "$adb" "timeout"
  print_android_timeout_diagnostics "$adb"
  fail "timed out waiting for $success_tag"
}

dismiss_expo_dev_menu_onboarding() {
  local adb="$1"
  local width height size xml
  size="$("$adb" shell wm size 2>/dev/null | tr -d '\r' || true)"
  width="$(printf '%s\n' "$size" | sed -n 's/.*Physical size: \([0-9][0-9]*\)x\([0-9][0-9]*\).*/\1/p')"
  height="$(printf '%s\n' "$size" | sed -n 's/.*Physical size: \([0-9][0-9]*\)x\([0-9][0-9]*\).*/\2/p')"
  [ -n "$width" ] || width=1080
  [ -n "$height" ] || height=2424

  for _ in $(seq 1 20); do
    sleep 1
    "$adb" shell uiautomator dump /sdcard/liboliphaunt-window.xml >/dev/null 2>&1 || continue
    xml="$("$adb" exec-out cat /sdcard/liboliphaunt-window.xml 2>/dev/null | tr -d '\r' || true)"
    if printf '%s\n' "$xml" | grep -Eq 'This is the developer menu|text="Continue"'; then
      "$adb" shell input tap "$((width / 2))" "$((height * 91 / 100))"
      sleep 1
      return
    fi
    if printf '%s\n' "$xml" | grep -Eq 'OLIPHAUNT REACT NATIVE|Embedded Postgres smoke'; then
      return
    fi
  done
}
