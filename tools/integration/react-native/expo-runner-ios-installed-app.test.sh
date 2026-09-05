#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
. "$root/src/sdks/react-native/tools/expo-runner-ios-installed-app.sh"
. "$root/src/sdks/react-native/tools/expo-runner-reporting.sh"

test_root="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-ios-runner-test.XXXXXX")"
trap 'rm -rf "$test_root"' EXIT
scratch_root="$test_root/scratch"
maestro_flow="$test_root/installed-smoke.yaml"
app_id="dev.oliphaunt.test"
runner="smoke"
mobile_platform="ios"
timeout_seconds=600
success_tag="OLIPHAUNT_EXPO_SMOKE_PASS"
failure_tag="OLIPHAUNT_EXPO_SMOKE_FAIL"
ios_simulator_log_pid=""
ios_simulator_log_file="$test_root/simulator.log"
export CI_HEAD_SHA="$(git rev-parse HEAD)"
export OLIPHAUNT_MOBILE_E2E_EXPECT_ICU=0
export OLIPHAUNT_MOBILE_E2E_EXPECT_CATALOG_PROFILE=standard
export FAKE_MAESTRO_STARTED="$test_root/maestro-started"
export FAKE_MAESTRO_TERMINATED="$test_root/maestro-terminated"

mkdir -p "$scratch_root/reports"
printf 'appId: dev.oliphaunt.test\n---\n- assertVisible: smoke\n' >"$maestro_flow"
fake_maestro="$test_root/maestro"
cat >"$fake_maestro" <<'SH'
#!/usr/bin/env bash
trap 'printf "terminated\n" >"$FAKE_MAESTRO_TERMINATED"; exit 143' TERM INT
printf 'started\n' >"$FAKE_MAESTRO_STARTED"
while :; do sleep 0.1; done
SH
chmod +x "$fake_maestro"

maestro_binary() { printf '%s\n' "$fake_maestro"; }
ios_simulator_log_capture_is_alive() { return 0; }
latest_ios_simulator_capture_tag() {
  [ "$1" = "$failure_tag" ] || return 0
  local attempts=100
  while [ "$attempts" -gt 0 ] && [ ! -f "$FAKE_MAESTRO_STARTED" ]; do
    command sleep 0.01
    attempts=$((attempts - 1))
  done
  printf '%s fixture\n' "$failure_tag"
}

set +e
run_maestro_installed_smoke simulator-1 >"$test_root/fail.stdout" 2>"$test_root/fail.stderr"
status=$?
set -e
[ "$status" -eq 2 ]
[ -f "$FAKE_MAESTRO_TERMINATED" ]
grep -Fq "$failure_tag" "$scratch_root/reports/maestro-authoritative-failure.txt"

receipt_json="$(node - "$root/src/extensions/generated/sdk/extensions.json" <<'NODE'
const fs = require('node:fs');
const metadata = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const extensions = (metadata.extensions ?? []).map(row => row['sql-name']).sort();
process.stdout.write(JSON.stringify({
  schema: 'oliphaunt-expo-smoke-pass-v4',
  runner: 'smoke',
  platform: 'ios',
  extensionCount: extensions.length,
  allExtensionsActivated: true,
  extensionCatalogComplete: true,
  pgTextsearchEnglishBm25: extensions.includes('pg_textsearch'),
  extensionCatalogSha256: metadata['extension-catalog-sha256'],
  catalogProfile: 'standard',
  icuRuntimeProof: false,
}));
NODE
)"
write_runner_report "$success_tag $receipt_json"
verify_mobile_e2e_smoke_receipt ios "$scratch_root"

node - "$scratch_root/reports/smoke-extension-receipt.json" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
receipt.candidateTree = '0'.repeat(40);
fs.writeFileSync(file, `${JSON.stringify(receipt)}\n`);
NODE
if verify_mobile_e2e_smoke_receipt ios "$scratch_root" >/dev/null 2>&1; then
  echo "tampered mobile receipt was accepted" >&2
  exit 1
fi

echo "iOS runner failure and receipt checks passed"
