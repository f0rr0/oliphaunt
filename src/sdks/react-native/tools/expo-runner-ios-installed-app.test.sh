#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
. "$root/src/sdks/react-native/tools/expo-runner-ios-installed-app.sh"
. "$root/src/sdks/react-native/tools/expo-runner-reporting.sh"

test_root="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-ios-maestro-test.XXXXXX")"
scratch_root="$test_root/scratch"
maestro_flow="$test_root/installed-smoke.yaml"
app_id="dev.oliphaunt.test"
runner="smoke"
mobile_platform="ios"
timeout_seconds=600
success_tag="OLIPHAUNT_EXPO_SMOKE_PASS"
failure_tag="OLIPHAUNT_EXPO_SMOKE_FAIL"
ios_simulator_log_pid=""
ios_simulator_log_file=""
fake_bin="$test_root/bin"
fake_maestro="$fake_bin/maestro"
fake_xcrun="$fake_bin/xcrun"
export FAKE_IOS_LOG_INPUT="$test_root/app-log-input"
export FAKE_MAESTRO_STARTED="$test_root/maestro-started"
export FAKE_MAESTRO_TERMINATED="$test_root/maestro-terminated"
export FAKE_MAESTRO_PID="$test_root/maestro-pid"
export FAKE_MAESTRO_MODE=success
export FAKE_MAESTRO_RECEIPT=""
export OLIPHAUNT_EXPO_IOS_LOG_CAPTURE_STARTUP_SECONDS=0.1
export OLIPHAUNT_EXPO_IOS_RECEIPT_GRACE_SECONDS=3
export CI_HEAD_SHA="$(git rev-parse HEAD)"

receipt_json_for_platform() {
  node - "$root/src/extensions/generated/sdk/react-native.json" "$1" <<'NODE'
const fs = require('node:fs');
const metadata = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const platform = process.argv[3];
const extensions = (metadata.extensions ?? [])
  .filter(row => row['mobile-release-ready'] === true && (
    row.support?.mobile?.[platform] === undefined || row.support.mobile[platform] === 'supported'
  ))
  .map(row => row['sql-name'])
  .sort();
process.stdout.write(JSON.stringify({
  schema: 'oliphaunt-expo-smoke-pass-v1',
  runner: 'smoke',
  platform,
  extensionCount: extensions.length,
  extensionProofCount: extensions.length + 1,
  extensionCatalogSha256: metadata['extension-catalog-sha256'],
}));
NODE
}

valid_receipt_json="$(receipt_json_for_platform ios)"
valid_pass_event="$success_tag $valid_receipt_json"
valid_pass_line="07-18 12:00:03.244 ReactNativeJS: '$success_tag', '$valid_receipt_json'"

cleanup_test() {
  stop_ios_simulator_log_capture >/dev/null 2>&1 || true
  rm -rf "$test_root"
}
trap cleanup_test EXIT

mkdir -p "$scratch_root" "$fake_bin"
printf 'appId: dev.oliphaunt.test\n---\n- assertVisible: smoke\n' >"$maestro_flow"

cat >"$fake_xcrun" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -ge 7 ] && [ "$1" = "simctl" ] && [ "$2" = "spawn" ] &&
  [ "$4" = "log" ] && [ "$5" = "stream" ]; then
  printf 'Filtering the log data using the requested predicate\n'
  if [ "${FAKE_XCRUN_LOG_MODE:-stream}" = "exit" ]; then
    exit 9
  fi
  previous=""
  while :; do
    current=""
    if [ -f "$FAKE_IOS_LOG_INPUT" ]; then
      current="$(cat "$FAKE_IOS_LOG_INPUT")"
    fi
    if [ -n "$current" ] && [ "$current" != "$previous" ]; then
      printf '%s\n' "$current"
      previous="$current"
    fi
    sleep 0.05
  done
fi
printf 'unexpected fake xcrun invocation: %s\n' "$*" >&2
exit 64
SH

cat >"$fake_maestro" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$$" >"$FAKE_MAESTRO_PID"
printf 'started\n' >"$FAKE_MAESTRO_STARTED"
if [ -n "${FAKE_MAESTRO_RECEIPT:-}" ]; then
  printf '%s\n' "$FAKE_MAESTRO_RECEIPT" >"$FAKE_IOS_LOG_INPUT"
fi
case "$FAKE_MAESTRO_MODE" in
  success)
    # Deliberately outlive the app receipt. This models the hosted two-minute
    # Maestro startup delay that exposed the old retrospective log window.
    sleep 1
    printf 'simulated Maestro success\n'
    ;;
  error)
    printf 'simulated Maestro failure\n' >&2
    exit 7
    ;;
  slow)
    trap 'printf "terminated\n" >"$FAKE_MAESTRO_TERMINATED"; exit 143' TERM INT
    count=0
    while [ "$count" -lt 100 ]; do
      sleep 0.1
      count=$((count + 1))
    done
    ;;
  *)
    exit 64
    ;;
esac
SH
chmod +x "$fake_xcrun" "$fake_maestro"
PATH="$fake_bin:$PATH"
export PATH

maestro_binary() {
  printf '%s\n' "$fake_maestro"
}

fail_test() {
  echo "expo-runner-ios-installed-app.test.sh: $*" >&2
  exit 1
}

reset_fixture() {
  stop_ios_simulator_log_capture >/dev/null 2>&1 || true
  ios_simulator_log_pid=""
  ios_simulator_log_file=""
  rm -rf "$scratch_root"
  rm -f \
    "$FAKE_IOS_LOG_INPUT" \
    "$FAKE_MAESTRO_STARTED" \
    "$FAKE_MAESTRO_TERMINATED" \
    "$FAKE_MAESTRO_PID"
  mkdir -p "$scratch_root/logs"
  unset FAKE_XCRUN_LOG_MODE
  export FAKE_MAESTRO_MODE=success
  export FAKE_MAESTRO_RECEIPT=""
}

# A stale line from a previous process must never authorize the new launch.
reset_fixture
printf '%s\n' "stale $success_tag {\"stale\":true}" >"$scratch_root/logs/smoke-simulator-unified.log"
start_ios_simulator_log_capture simulator-1 reactnativeoliphauntexpo ||
  fail_test "failed to start the scoped simulator log capture"
[ -z "$(latest_ios_simulator_capture_tag "$success_tag")" ] ||
  fail_test "log capture retained a stale PASS receipt"
capture_pid="$ios_simulator_log_pid"
kill -0 "$capture_pid" 2>/dev/null || fail_test "capture process was not alive after startup"
stop_ios_simulator_log_capture || fail_test "failed to stop a live log capture"
if kill -0 "$capture_pid" 2>/dev/null; then
  fail_test "stopped capture process $capture_pid is still running"
fi

# The app can finish immediately and Maestro can return much later; the exact
# launch stream must retain the authoritative receipt without a time window.
reset_fixture
export FAKE_MAESTRO_MODE=success
export FAKE_MAESTRO_RECEIPT="$valid_pass_line"
start_ios_simulator_log_capture simulator-1 reactnativeoliphauntexpo ||
  fail_test "failed to start PASS capture"
run_maestro_installed_smoke simulator-1 >"$test_root/pass.stdout" 2>"$test_root/pass.stderr" ||
  fail_test "successful delayed Maestro run was rejected"
pass="$(wait_for_ios_simulator_maestro_receipt)" ||
  fail_test "early authoritative PASS was not retained through Maestro completion"
printf '%s\n' "$pass" | grep -Fq "$success_tag" ||
  fail_test "collected PASS line omitted the authoritative tag"
grep -Fq "$success_tag" "$ios_simulator_log_file" ||
  fail_test "durable simulator log omitted the authoritative PASS"
stop_ios_simulator_log_capture || fail_test "failed to stop PASS capture"

# An app-side failure is stronger than a still-running UI assertion. It must
# terminate Maestro promptly and preserve both receipt and process evidence.
reset_fixture
export FAKE_MAESTRO_MODE=slow
export FAKE_MAESTRO_RECEIPT="07-18 12:00:04.244 ReactNativeJS: $failure_tag {\"error\":\"fixture\"}"
start_ios_simulator_log_capture simulator-1 reactnativeoliphauntexpo ||
  fail_test "failed to start failure capture"
start_seconds=$SECONDS
set +e
run_maestro_installed_smoke simulator-1 >"$test_root/fail.stdout" 2>"$test_root/fail.stderr"
status=$?
set -e
[ "$status" -eq 2 ] || fail_test "authoritative app failure returned $status instead of 2"
[ $((SECONDS - start_seconds)) -lt 4 ] || fail_test "authoritative failure did not stop Maestro promptly"
[ -f "$FAKE_MAESTRO_TERMINATED" ] || fail_test "authoritative failure did not terminate Maestro"
grep -Fq "$failure_tag" "$scratch_root/reports/maestro-authoritative-failure.txt" ||
  fail_test "authoritative failure report omitted the app receipt"
stop_ios_simulator_log_capture || fail_test "failed to stop failure capture"

# Losing the evidence collector is a distinct fail-closed result; a Maestro UI
# success can never compensate for the missing exact-launch receipt channel.
reset_fixture
export FAKE_MAESTRO_MODE=slow
start_ios_simulator_log_capture simulator-1 reactnativeoliphauntexpo ||
  fail_test "failed to start collector-death fixture"
kill -TERM "$ios_simulator_log_pid"
wait "$ios_simulator_log_pid" 2>/dev/null || true
set +e
run_maestro_installed_smoke simulator-1 >"$test_root/capture-death.stdout" 2>"$test_root/capture-death.stderr"
status=$?
set -e
[ "$status" -eq 3 ] || fail_test "collector death returned $status instead of 3"
grep -Fq 'reason=unified-log-capture-ended-before-maestro' \
  "$scratch_root/reports/maestro-log-capture-failure.txt" ||
  fail_test "collector-death report omitted the typed reason"
ios_simulator_log_pid=""

# A collector that cannot survive startup is rejected before app launch, and
# predicate input cannot escape the exact executable-name grammar.
reset_fixture
export FAKE_XCRUN_LOG_MODE=exit
set +e
start_ios_simulator_log_capture simulator-1 reactnativeoliphauntexpo \
  >"$test_root/startup-death.stdout" 2>"$test_root/startup-death.stderr"
status=$?
set -e
[ "$status" -eq 1 ] || fail_test "startup collector death returned $status instead of 1"
[ -z "$ios_simulator_log_pid" ] || fail_test "startup failure retained a stale capture PID"
set +e
start_ios_simulator_log_capture simulator-1 "unsafe' OR true" \
  >"$test_root/unsafe.stdout" 2>"$test_root/unsafe.stderr"
status=$?
set -e
[ "$status" -eq 1 ] || fail_test "unsafe process predicate was accepted"

# The real catalog receipt must remain below the unified-log event budget and
# produce atomic, candidate-bound report and receipt artifacts.
reset_fixture
event_bytes="$(printf '%s' "$valid_pass_event" | wc -c | tr -d '[:space:]')"
[ "$event_bytes" -le 768 ] ||
  fail_test "authoritative PASS event is $event_bytes bytes and exceeds its 768-byte budget"
if ! write_runner_report "$valid_pass_line"; then
  fail_test "valid compact PASS failed when write_runner_report ran under if !"
fi
require_nonempty_json_file "$scratch_root/reports/smoke-report.json" "test smoke report" ||
  fail_test "valid PASS did not produce a nonempty JSON report"
require_nonempty_json_file "$scratch_root/reports/smoke-extension-receipt.json" "test extension receipt" ||
  fail_test "valid PASS did not produce a nonempty JSON receipt"
verify_mobile_e2e_smoke_receipt ios "$scratch_root" ||
  fail_test "valid report and receipt failed the outer mobile E2E postcondition"

# A truncated unified-log payload must return nonzero even though Bash disables
# errexit inside a function used by `if !`; no stale report may survive.
truncated_pass="${valid_pass_line%?}<…>"
rejected=0
if ! write_runner_report "$truncated_pass" \
  >"$test_root/truncated-pass.stdout" 2>"$test_root/truncated-pass.stderr"; then
  rejected=1
fi
[ "$rejected" -eq 1 ] || fail_test "truncated PASS was accepted under if !"
grep -Fq 'failed to parse the authoritative smoke PASS payload' "$test_root/truncated-pass.stderr" ||
  fail_test "truncated PASS rejection omitted its typed parse diagnostic"
[ ! -e "$scratch_root/reports/smoke-pass.log" ] ||
  fail_test "truncated PASS retained a canonical PASS log"
[ ! -e "$scratch_root/reports/smoke-report.json" ] ||
  fail_test "truncated PASS retained a report"
[ ! -e "$scratch_root/reports/smoke-extension-receipt.json" ] ||
  fail_test "truncated PASS retained an extension receipt"

# Syntactically valid rich/unknown PASS fields are forbidden, so diagnostics
# cannot silently grow the authoritative event back past the OS log limit.
rich_receipt_json="${valid_receipt_json%?},\"elapsedMs\":1}"
rich_pass_line="07-18 12:00:03.244 ReactNativeJS: '$success_tag', '$rich_receipt_json'"
rejected=0
if ! write_runner_report "$rich_pass_line" \
  >"$test_root/rich-pass.stdout" 2>"$test_root/rich-pass.stderr"; then
  rejected=1
fi
[ "$rejected" -eq 1 ] || fail_test "PASS with unknown rich fields was accepted"
grep -Fq 'app PASS receipt keys mismatch' "$test_root/rich-pass.stderr" ||
  fail_test "rich PASS rejection omitted its exact-key diagnostic"
[ ! -e "$scratch_root/reports/smoke-pass.log" ] ||
  fail_test "semantically invalid PASS retained a canonical PASS log"
[ ! -e "$scratch_root/reports/smoke-report.json" ] ||
  fail_test "semantically invalid PASS retained a report"
[ ! -e "$scratch_root/reports/smoke-extension-receipt.json" ] ||
  fail_test "semantically invalid PASS retained an extension receipt"

# The outer postcondition independently binds the durable receipt to its exact
# parsed report and candidate. Tampering either side must fail closed.
write_runner_report "$valid_pass_line" || fail_test "failed to recreate valid report fixture"
node - "$scratch_root/reports/smoke-report.json" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const report = JSON.parse(fs.readFileSync(file, 'utf8'));
const reordered = {
  runner: report.runner,
  schema: report.schema,
  platform: report.platform,
  extensionProofCount: report.extensionProofCount,
  extensionCount: report.extensionCount,
  extensionCatalogSha256: report.extensionCatalogSha256,
};
fs.writeFileSync(file, `${JSON.stringify(reordered, null, 2)}\n`);
NODE
rejected=0
if ! verify_mobile_e2e_smoke_receipt ios "$scratch_root" \
  >"$test_root/report-hash.stdout" 2>"$test_root/report-hash.stderr"; then
  rejected=1
fi
[ "$rejected" -eq 1 ] || fail_test "outer postcondition accepted a report/receipt hash mismatch"
grep -Fq 'mobile E2E report/receipt digest mismatch' "$test_root/report-hash.stderr" ||
  fail_test "report/receipt mismatch omitted its typed digest diagnostic"

write_runner_report "$valid_pass_line" || fail_test "failed to recreate candidate fixture"
node - "$scratch_root/reports/smoke-extension-receipt.json" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
receipt.candidateTree = '0'.repeat(40);
fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`);
NODE
rejected=0
if ! verify_mobile_e2e_smoke_receipt ios "$scratch_root" \
  >"$test_root/candidate-tree.stdout" 2>"$test_root/candidate-tree.stderr"; then
  rejected=1
fi
[ "$rejected" -eq 1 ] || fail_test "outer postcondition accepted a different candidate tree"
grep -Fq 'receipt is not bound to the exact candidate commit and tree' "$test_root/candidate-tree.stderr" ||
  fail_test "candidate-tree mismatch omitted its typed binding diagnostic"

# The shared outer postcondition protects both mobile wrappers. Missing,
# malformed, or report/receipt-incoherent JSON must fail for each identity.
for platform in ios android; do
  platform_receipt_json="$(receipt_json_for_platform "$platform")"
  platform_pass_line="07-18 12:00:03.244 ReactNativeJS: '$success_tag', '$platform_receipt_json'"
  mobile_platform="$platform"

  write_runner_report "$platform_pass_line" ||
    fail_test "failed to create $platform empty-report fixture"
  : >"$scratch_root/reports/smoke-report.json"
  rejected=0
  if ! verify_mobile_e2e_smoke_receipt "$platform" "$scratch_root" \
    >"$test_root/$platform-empty-report.stdout" 2>"$test_root/$platform-empty-report.stderr"; then
    rejected=1
  fi
  [ "$rejected" -eq 1 ] || fail_test "$platform outer postcondition accepted an empty report"
  grep -Fq 'mobile E2E PASS report is missing or empty' "$test_root/$platform-empty-report.stderr" ||
    fail_test "$platform empty report omitted its typed diagnostic"

  write_runner_report "$platform_pass_line" ||
    fail_test "failed to create $platform malformed-report fixture"
  printf '{\n' >"$scratch_root/reports/smoke-report.json"
  rejected=0
  if ! verify_mobile_e2e_smoke_receipt "$platform" "$scratch_root" \
    >"$test_root/$platform-malformed-report.stdout" 2>"$test_root/$platform-malformed-report.stderr"; then
    rejected=1
  fi
  [ "$rejected" -eq 1 ] || fail_test "$platform outer postcondition accepted malformed JSON"
  grep -Fq 'mobile E2E PASS report is not valid JSON' "$test_root/$platform-malformed-report.stderr" ||
    fail_test "$platform malformed report omitted its typed diagnostic"

  write_runner_report "$platform_pass_line" ||
    fail_test "failed to create $platform report-hash fixture"
  node - "$scratch_root/reports/smoke-report.json" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const report = JSON.parse(fs.readFileSync(file, 'utf8'));
const reordered = {
  runner: report.runner,
  schema: report.schema,
  platform: report.platform,
  extensionProofCount: report.extensionProofCount,
  extensionCount: report.extensionCount,
  extensionCatalogSha256: report.extensionCatalogSha256,
};
fs.writeFileSync(file, `${JSON.stringify(reordered, null, 2)}\n`);
NODE
  rejected=0
  if ! verify_mobile_e2e_smoke_receipt "$platform" "$scratch_root" \
    >"$test_root/$platform-report-hash.stdout" 2>"$test_root/$platform-report-hash.stderr"; then
    rejected=1
  fi
  [ "$rejected" -eq 1 ] || fail_test "$platform outer postcondition accepted a report hash mismatch"
  grep -Fq 'mobile E2E report/receipt digest mismatch' "$test_root/$platform-report-hash.stderr" ||
    fail_test "$platform report hash mismatch omitted its typed diagnostic"
done
mobile_platform="ios"

echo "iOS Maestro exact-launch receipt tests passed"
