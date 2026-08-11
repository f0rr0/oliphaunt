#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
helper="$script_dir/quarantine-ios-broker-simulator-storage.sh"
test_root="$(mktemp -d /private/tmp/oliphaunt-simulator-quarantine.XXXXXX)"
stub_bin="$test_root/bin"
udid="11111111-2222-3333-4444-555555555555"
data_root="$test_root/CoreSimulator/Devices/$udid/data"
report="$test_root/report.txt"
xcrun_log="$test_root/xcrun.log"
lock_pid=""

cleanup() {
  if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then
    kill "$lock_pid" 2>/dev/null || true
    wait "$lock_pid" 2>/dev/null || true
  fi
  rm -rf "$test_root"
}
trap cleanup EXIT INT TERM

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

mkdir -p "$stub_bin"
cat >"$stub_bin/xcrun" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$TEST_XCRUN_LOG"
if [ "${1:-}" = "simctl" ] && [ "${2:-}" = "getenv" ]; then
  printf '%s\n' "$TEST_SIMULATOR_DATA_ROOT"
fi
STUB
cat >"$stub_bin/ps" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
case "${TEST_PS_MODE:-inactive}" in
  inactive) ;;
  active)
    printf '101 %s/Containers/Bundle/Application/ABC/OliphauntBrokerSpike.app/OliphauntBrokerSpike\n' \
      "$TEST_SIMULATOR_DATA_ROOT"
    printf '102 %s/Containers/Bundle/Application/ABC/OliphauntBrokerSpike.app/Extensions/BrokerAppExtension.appex/BrokerAppExtension -LaunchArguments value\n' \
      "$TEST_SIMULATOR_DATA_ROOT"
    ;;
  unrelated)
    printf '103 /private/tmp/unrelated/OliphauntBrokerSpike.app/OliphauntBrokerSpike\n'
    ;;
  *) exit 2 ;;
esac
STUB
cat >"$stub_bin/sleep" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
chmod +x "$stub_bin/xcrun" "$stub_bin/ps" "$stub_bin/sleep"

broker_parent() {
  printf '%s/Library/Application Support/Oliphaunt\n' "$1"
}

broker_root() {
  printf '%s/default\n' "$(broker_parent "$1")"
}

write_manifest() {
  local target_data_root="$1"
  local digest="$2"
  local target_root
  target_root="$(broker_root "$target_data_root")"
  mkdir -p "$target_root/pgdata"
  printf '18\n' >"$target_root/pgdata/PG_VERSION"
  ruby -rjson -e '
    digest, path = ARGV
    manifest = {
      "cABIVersion" => 6,
      "dataProtectionPolicy" => "completeUntilFirstUserAuthentication",
      "formatVersion" => 1,
      "liboliphauntVersion" => "0.1.1",
      "postgresMajorVersion" => 18,
      "rootUUID" => "A6237639-3166-43A8-91D5-5ABCE2A04187",
      "selectedPostgresExtensions" => ["pg_trgm", "vector"],
      "startupConfigurationDigest" => digest,
    }
    File.binwrite(path, JSON.generate(manifest))
  ' "$digest" "$target_root/manifest.json"
}

reset_case() {
  rm -rf "$data_root"
  mkdir -p "$data_root"
  : >"$report"
  : >"$xcrun_log"
}

run_helper() {
  local process_mode="${1:-inactive}"
  PATH="$stub_bin:$PATH" \
    TEST_XCRUN_LOG="$xcrun_log" \
    TEST_SIMULATOR_DATA_ROOT="$data_root" \
    TEST_PS_MODE="$process_mode" \
    OLIPHAUNT_IOS_BROKER_QUARANTINE_PROCESS_WAIT_ATTEMPTS=3 \
    bash "$helper" \
      "$udid" \
      dev.oliphaunt.brokerspike \
      dev.oliphaunt.brokerspike.extension \
      OliphauntBrokerSpike \
      OliphauntBrokerSpike \
      BrokerAppExtension \
      BrokerAppExtension \
      "$report"
}

reset_case
write_manifest "$data_root" "ios-native-broker-spike-v1"
run_helper unrelated
stale_root="$(broker_root "$data_root")"
stale_parent="$(broker_parent "$data_root")"
[ ! -e "$stale_root" ] || fail "recognized stale root was not quarantined"
quarantine_count="$(
  find "$stale_parent" -mindepth 1 -maxdepth 1 -type d \
    -name '.oliphaunt-quarantine-default-*' | wc -l | tr -d '[:space:]'
)"
[ "$quarantine_count" = "1" ] || fail "stale root was not renamed exactly once"
grep -Fqx 'status=quarantined' "$report" || fail "stale report did not record quarantine"
grep -Fqx 'startupConfigurationDigest=ios-native-broker-spike-v1' "$report" || \
  fail "stale report lost the recognized digest"
if grep -Fq "$test_root" "$report"; then
  fail "storage report exposed an absolute host path"
fi
grep -Fqx "simctl terminate $udid dev.oliphaunt.brokerspike" "$xcrun_log" || \
  fail "host termination was not attempted"
grep -Fqx "simctl terminate $udid dev.oliphaunt.brokerspike.extension" "$xcrun_log" || \
  fail "extension termination was not attempted"
grep -Fqx "simctl uninstall $udid dev.oliphaunt.brokerspike" "$xcrun_log" || \
  fail "host uninstall was not attempted"

reset_case
write_manifest "$data_root" "ios-native-broker-spike-v2-restricted-role"
run_helper
[ -d "$(broker_root "$data_root")" ] || fail "current root was moved"
grep -Fqx 'status=retained-current' "$report" || fail "current root was not retained"

reset_case
write_manifest "$data_root" "unknown-fixture-digest"
if run_helper >"$test_root/unknown.stdout" 2>"$test_root/unknown.stderr"; then
  fail "unknown root was accepted"
fi
[ -d "$(broker_root "$data_root")" ] || fail "unknown root was moved"
grep -Fqx 'reason=unrecognized-manifest' "$report" || \
  fail "unknown root refusal was not recorded"

reset_case
write_manifest "$data_root" "ios-native-broker-spike-v1"
root="$(broker_root "$data_root")"
parent="$(broker_parent "$data_root")"
lock_suffix="$(printf '%s' "$root" | shasum -a 256 | awk '{ print substr($1, 1, 32) }')"
lock_path="$parent/.oliphaunt-root-$lock_suffix.lock"
lock_ready="$test_root/lock-ready"
ruby -e '
  lock_path, ready = ARGV
  File.open(lock_path, File::RDWR | File::CREAT, 0o600) do |file|
    abort("lock failed") unless file.flock(File::LOCK_EX | File::LOCK_NB)
    File.binwrite(ready, "ready")
    sleep 30
  end
' "$lock_path" "$lock_ready" &
lock_pid=$!
for _ in $(seq 1 100); do
  [ -f "$lock_ready" ] && break
  /bin/sleep 0.01
done
[ -f "$lock_ready" ] || fail "lock holder did not start"
if run_helper >"$test_root/lock.stdout" 2>"$test_root/lock.stderr"; then
  fail "busy native root lock was ignored"
fi
[ -d "$root" ] || fail "locked root was moved"
grep -Fqx 'reason=root-lock-busy' "$report" || fail "busy lock refusal was not recorded"
kill "$lock_pid"
wait "$lock_pid" 2>/dev/null || true
lock_pid=""

reset_case
write_manifest "$data_root" "ios-native-broker-spike-v1"
if run_helper active >"$test_root/active.stdout" 2>"$test_root/active.stderr"; then
  fail "active target processes were ignored"
fi
[ -d "$(broker_root "$data_root")" ] || fail "active-process root was moved"
grep -Fqx 'reason=active-target-processes' "$report" || \
  fail "active target process refusal was not recorded"

real_root="$test_root/real-root"
symlink_root="$test_root/symlink-root"
symlink_data_root="$symlink_root/CoreSimulator/Devices/$udid/data"
mkdir -p "$real_root/CoreSimulator/Devices/$udid/data"
ln -s "$real_root" "$symlink_root"
: >"$report"
if PATH="$stub_bin:$PATH" \
  TEST_XCRUN_LOG="$xcrun_log" \
  TEST_SIMULATOR_DATA_ROOT="$symlink_data_root" \
  TEST_PS_MODE=inactive \
  OLIPHAUNT_IOS_BROKER_QUARANTINE_PROCESS_WAIT_ATTEMPTS=3 \
  bash "$helper" \
    "$udid" \
    dev.oliphaunt.brokerspike \
    dev.oliphaunt.brokerspike.extension \
    OliphauntBrokerSpike \
    OliphauntBrokerSpike \
    BrokerAppExtension \
    BrokerAppExtension \
    "$report" >"$test_root/symlink.stdout" 2>"$test_root/symlink.stderr"; then
  fail "symlinked simulator ancestry was accepted"
fi
grep -Fqx 'reason=unsafe-data-root' "$report" || \
  fail "symlink ancestry refusal was not recorded"

reset_case
run_helper
grep -Fqx 'status=absent' "$report" || fail "absent root was not reported"

printf 'simulator storage quarantine synthetic tests passed\n'
