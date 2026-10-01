#!/usr/bin/env bash
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
source "$root/src/native/sdks/react-native/tools/expo-runner-common.sh"
scratch="$(mktemp -d)"
capture_pid=""
trap 'stop_mobile_log_capture "$capture_pid"; rm -rf "$scratch"' EXIT
success_tag=OLIPHAUNT_EXPO_SMOKE_PASS
failure_tag=OLIPHAUNT_EXPO_SMOKE_FAIL
timeout_seconds=0
mobile_app_is_alive() { [ "$app_alive" = true ]; }
sleep 60 &
capture_pid=$!
app_alive=true
for scenario in pass fail crash missing dead-capture dead-app; do
  printf '%s valid-receipt\n' "$success_tag" >"$scratch/log"
  expected=0
  pid="$capture_pid"
  app_alive=true
  case "$scenario" in
    fail) printf '%s explicit-failure\n' "$failure_tag" >>"$scratch/log"; expected=2 ;;
    crash) printf 'FATAL EXCEPTION\n' >>"$scratch/log"; expected=2 ;;
    missing) : >"$scratch/log"; expected=1 ;;
    dead-capture) pid=99999999; expected=3 ;;
    dead-app) app_alive=false; expected=4 ;;
  esac
  status=0
  wait_for_mobile_receipt "$scratch/log" "$pid" >"$scratch/out" 2>"$scratch/err" || status=$?
  [ "$status" = "$expected" ] || { echo "$scenario: expected $expected, got $status" >&2; exit 1; }
done
# A fast terminal receipt remains readable while the current capture is alive.
timeout_seconds=5
app_alive=true
: >"$scratch/log"
(sleep 0.1; printf '%s valid-receipt\n' "$success_tag" >>"$scratch/log") &
writer=$!
wait_for_mobile_receipt "$scratch/log" "$capture_pid" >"$scratch/out"
wait "$writer"
grep -Fq "$success_tag" "$scratch/out"
stop_mobile_log_capture "$capture_pid"
if kill -0 "$capture_pid" 2>/dev/null; then exit 1; fi
capture_pid=""
echo 'Mobile receipts: failure precedence, crash, missing receipt, capture/app death and cleanup passed'


# Exercise the installed-app entry point: logcat clearing must discard an old
# PASS, and only this app's receipt emitted after this launch can succeed.
source "$root/src/native/sdks/react-native/tools/expo-runner-android-device.sh"
mkdir -p "$scratch/sdk/platform-tools" "$scratch/app"
cat > "$scratch/sdk/platform-tools/adb" <<'ADB'
#!/usr/bin/env bash
set -eu
case "$*" in
  devices) printf 'List of devices attached\nfixture\tdevice\n' ;;
  'install -r '*|'shell am force-stop '*|'shell pm clear '*|'shell pidof '*) ;;
  'shell pm list packages -U --user current dev.oliphaunt.fixture')
    printf 'package:dev.oliphaunt.fixture.other uid:10099\r\n'
    case "$ADB_SCENARIO" in
      missing-uid) ;;
      invalid-uid) printf 'package:dev.oliphaunt.fixture uid:invalid\r\n' ;;
      *) printf 'package:dev.oliphaunt.fixture uid:10042\r\n' ;;
    esac
    ;;
  'logcat -c') : > "$ADB_RECEIPT" ;;
  'logcat -v '*)
    trap 'exit 0' TERM
    uid_filter=""
    for arg in "$@"; do
      case "$arg" in --uid=*) uid_filter="${arg#--uid=}" ;; esac
    done
    while [ ! -s "$ADB_RECEIPT" ]; do sleep 0.05; done
    awk -v uid="$uid_filter" 'uid == "" || $1 == uid {sub(/^[0-9]+ /, ""); print}' "$ADB_RECEIPT"
    while :; do sleep 0.05; done
    ;;
  'shell am start -W '*)
    case "$ADB_SCENARIO" in
      stale) ;;
      unrelated-pass) printf '10099 %s\n' "$ADB_CURRENT_RECEIPT" > "$ADB_RECEIPT" ;;
      *)
        {
          case "$ADB_SCENARIO" in
            unrelated-crash) printf '10099 FATAL EXCEPTION: main\n' ;;
            app-crash) printf '10042 FATAL EXCEPTION: main\n' ;;
          esac
          printf '10042 %s\n' "$ADB_CURRENT_RECEIPT"
        } > "$ADB_RECEIPT"
        ;;
    esac
    ;;
  *) echo "unexpected adb invocation: $*" >&2; exit 9 ;;
esac
ADB
chmod +x "$scratch/sdk/platform-tools/adb"
export ADB_RECEIPT="$scratch/adb-receipt"
export ADB_CURRENT_RECEIPT="$success_tag current-launch"
ANDROID_HOME="$scratch/sdk"
app_id=dev.oliphaunt.fixture
apk="$scratch/app.apk"
build_type=release
runner=smoke
lifecycle_smoke=0
scratch_root="$scratch/app"
timeout_seconds=3
wake_android_device() { :; }
android_runner_url() { printf 'fixture://smoke'; }
write_android_process_metrics() { :; }
write_android_e2e_diagnostics() { :; }
write_runner_report() { [ "$1" = "$ADB_CURRENT_RECEIPT" ]; }
for scenario in pass unrelated-crash app-crash stale unrelated-pass missing-uid invalid-uid; do
  printf '10042 %s stale-launch\n' "$success_tag" > "$ADB_RECEIPT"
  export ADB_SCENARIO="$scenario"
  status=0
  (
    android_log_pid=""
    trap 'stop_mobile_log_capture "$android_log_pid"' EXIT
    install_and_launch
  ) > "$scratch/$scenario-launch.log" 2>&1 || status=$?
  case "$scenario" in
    pass|unrelated-crash) [ "$status" = 0 ] ;;
    *) [ "$status" != 0 ] ;;
  esac || { cat "$scratch/$scenario-launch.log" >&2; echo "unexpected $scenario status: $status" >&2; exit 1; }
done
echo 'Android installed-app capture scopes receipts and crashes to the current app and launch'
