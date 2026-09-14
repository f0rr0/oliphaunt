#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
. "$root/sdks/react-native/tools/expo-runner-ios-installed-app.sh"
. "$root/sdks/react-native/tools/expo-runner-reporting.sh"

test_root="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-ios-runner-test.XXXXXX")"
trap 'rm -rf "$test_root"' EXIT
app="$test_root/fixture.app"
for profile in standard icu; do
  rm -rf "$app"
  seed_name=Standard
  seed_resource=cluster-seed
  expected_icu=0
  if [ "$profile" = icu ]; then
    seed_name=ICU
    seed_resource=cluster-seed-icu
    expected_icu=1
    mkdir -p "$app/OliphauntICU.bundle/share/icu"
    printf data >"$app/OliphauntICU.bundle/share/icu/icudt.dat"
    printf receipt >"$app/OliphauntICU.bundle/manifest.properties"
  fi
  seed="$app/OliphauntSeedNativeIOS$seed_name.bundle/$seed_resource"
  mkdir -p "$seed/files"
  printf '18\n' >"$seed/files/PG_VERSION"
  printf 'catalogProfile=%s\n' "$profile" >"$seed/manifest.properties"
  export_mobile_e2e_icu_expectation_from_ios_app "$app"
  [ "$OLIPHAUNT_MOBILE_E2E_EXPECT_ICU" = "$expected_icu" ]
  [ "$OLIPHAUNT_MOBILE_E2E_EXPECT_CATALOG_PROFILE" = "$profile" ]
  other=ICU
  [ "$seed_name" != ICU ] || other=Standard
  mkdir "$app/OliphauntSeedNativeIOS$other.bundle"
  if export_mobile_e2e_icu_expectation_from_ios_app "$app" >/dev/null 2>&1; then
    echo "iOS app accepted two seed carriers" >&2
    exit 1
  fi
  rmdir "$app/OliphauntSeedNativeIOS$other.bundle"
  printf 'catalogProfile=wrong\n' >"$seed/manifest.properties"
  if export_mobile_e2e_icu_expectation_from_ios_app "$app" >/dev/null 2>&1; then
    echo "iOS app accepted a mismatched seed profile" >&2
    exit 1
  fi
  printf 'catalogProfile=%s\n' "$profile" >"$seed/manifest.properties"
  rm "$seed/files/PG_VERSION"
  if export_mobile_e2e_icu_expectation_from_ios_app "$app" >/dev/null 2>&1; then
    echo "iOS app accepted missing seed data" >&2
    exit 1
  fi
  if [ "$profile" = icu ]; then
    printf '18\n' >"$seed/files/PG_VERSION"
    rm "$app/OliphauntICU.bundle/share/icu/icudt.dat"
    if export_mobile_e2e_icu_expectation_from_ios_app "$app" >/dev/null 2>&1; then
      echo "iOS app accepted empty ICU data" >&2
      exit 1
    fi
  fi
done
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

receipt_json="$(
  bun "$root/sdks/react-native/tools/expo-runner-ios-installed-app.fixture.mts" receipt "$root/extensions/generated/sdk/extensions.json"
)"
write_runner_report "$success_tag $receipt_json"
verify_mobile_e2e_smoke_receipt ios "$scratch_root"

bun "$root/sdks/react-native/tools/expo-runner-ios-installed-app.fixture.mts" tamper "$scratch_root/reports/smoke-extension-receipt.json"
if verify_mobile_e2e_smoke_receipt ios "$scratch_root" >/dev/null 2>&1; then
  echo "tampered mobile receipt was accepted" >&2
  exit 1
fi

echo "iOS runner failure and receipt checks passed"
