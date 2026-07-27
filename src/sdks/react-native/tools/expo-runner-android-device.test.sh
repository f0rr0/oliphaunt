#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
. "$root/src/sdks/react-native/tools/expo-runner-android-device.sh"

test_root="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-android-maestro-test.XXXXXX")"
trap 'rm -rf "$test_root"' EXIT

scratch_root="$test_root/scratch"
maestro_flow="$test_root/installed-smoke.yaml"
app_id="dev.oliphaunt.test"
timeout_seconds=600
failure_tag="OLIPHAUNT_EXPO_SMOKE_FAIL"
fake_maestro="$test_root/maestro"
fake_adb="$test_root/adb"
export FAKE_MAESTRO_STARTED="$test_root/maestro-started"
export FAKE_MAESTRO_TERMINATED="$test_root/maestro-terminated"
export FAKE_MAESTRO_PID="$test_root/maestro-pid"
export FAKE_MAESTRO_MODE=slow
export FAKE_ADB_FAILURE_FILE="$test_root/adb-failure"

mkdir -p "$scratch_root"
printf 'appId: dev.oliphaunt.test\n---\n- assertVisible: smoke\n' >"$maestro_flow"

cat >"$fake_maestro" <<'SH'
#!/usr/bin/env sh
printf '%s\n' "$$" >"$FAKE_MAESTRO_PID"
printf 'started\n' >"$FAKE_MAESTRO_STARTED"
case "$FAKE_MAESTRO_MODE" in
  success)
    printf 'simulated Maestro success\n'
    exit 0
    ;;
  error)
    printf 'simulated Maestro failure\n' >&2
    exit 7
    ;;
  slow)
    trap 'printf "terminated\n" >"$FAKE_MAESTRO_TERMINATED"; exit 143' TERM INT
    count=0
    while [ "$count" -lt 50 ]; do
      sleep 0.1
      count=$((count + 1))
    done
    exit 0
    ;;
  *)
    exit 64
    ;;
esac
SH
chmod +x "$fake_maestro"

cat >"$fake_adb" <<'SH'
#!/usr/bin/env sh
if [ "$*" = "logcat -d -v raw ReactNativeJS:I *:S" ] &&
  [ -f "$FAKE_MAESTRO_STARTED" ] && [ -s "$FAKE_ADB_FAILURE_FILE" ]; then
  cat "$FAKE_ADB_FAILURE_FILE"
fi
SH
chmod +x "$fake_adb"

maestro_binary() {
  printf '%s\n' "$fake_maestro"
}

fail_test() {
  echo "expo-runner-android-device.test.sh: $*" >&2
  exit 1
}

reset_fixture() {
  rm -rf "$scratch_root/reports"
  rm -f \
    "$FAKE_MAESTRO_STARTED" \
    "$FAKE_MAESTRO_TERMINATED" \
    "$FAKE_MAESTRO_PID" \
    "$FAKE_ADB_FAILURE_FILE"
}

reset_fixture
printf '%s\n' "07-18 12:00:03.244 I ReactNativeJS: $failure_tag {\"error\":\"fixture\"}" \
  >"$FAKE_ADB_FAILURE_FILE"
start_seconds=$SECONDS
set +e
run_maestro_installed_smoke emulator-5554 "$fake_adb" \
  >"$test_root/fail-fast.stdout" 2>"$test_root/fail-fast.stderr"
status=$?
set -e
[ "$status" -eq 2 ] || fail_test "authoritative failure returned $status instead of 2"
[ $((SECONDS - start_seconds)) -lt 4 ] || fail_test "authoritative failure did not terminate Maestro promptly"
[ -f "$FAKE_MAESTRO_TERMINATED" ] || fail_test "authoritative failure did not terminate Maestro"
maestro_pid="$(cat "$FAKE_MAESTRO_PID")"
if kill -0 "$maestro_pid" 2>/dev/null; then
  fail_test "terminated Maestro process $maestro_pid is still running"
fi
grep -Fq "$failure_tag" "$scratch_root/reports/maestro-authoritative-failure.txt" ||
  fail_test "authoritative failure report omitted the app receipt"
grep -Fq "$failure_tag" "$test_root/fail-fast.stderr" ||
  fail_test "authoritative failure was not printed to stderr"

reset_fixture
export FAKE_MAESTRO_MODE=success
run_maestro_installed_smoke emulator-5554 "$fake_adb" \
  >"$test_root/success.stdout" 2>"$test_root/success.stderr" ||
  fail_test "successful Maestro run was rejected"
grep -Fq "simulated Maestro success" "$scratch_root/reports/maestro.log" ||
  fail_test "successful Maestro output was not preserved"

reset_fixture
export FAKE_MAESTRO_MODE=error
set +e
run_maestro_installed_smoke emulator-5554 "$fake_adb" \
  >"$test_root/error.stdout" 2>"$test_root/error.stderr"
status=$?
set -e
[ "$status" -eq 1 ] || fail_test "failed Maestro run returned $status instead of 1"
grep -Fq "simulated Maestro failure" "$scratch_root/reports/maestro.log" ||
  fail_test "failed Maestro output was not preserved"

# Exercise the final logcat read after an immediate Maestro exit. This closes
# the race between the UI assertion ending and the authoritative app receipt.
reset_fixture
export FAKE_MAESTRO_MODE=success
printf '%s\n' "07-18 12:00:03.244 I ReactNativeJS: $failure_tag {\"error\":\"race\"}" \
  >"$FAKE_ADB_FAILURE_FILE"
set +e
run_maestro_installed_smoke emulator-5554 "$fake_adb" \
  >"$test_root/race.stdout" 2>"$test_root/race.stderr"
status=$?
set -e
[ "$status" -eq 2 ] || fail_test "final authoritative failure read returned $status instead of 2"

echo "Android Maestro fail-fast tests passed"
