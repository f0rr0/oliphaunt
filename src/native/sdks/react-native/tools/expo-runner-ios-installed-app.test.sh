#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
. "$root/src/native/sdks/react-native/tools/expo-runner-ios-installed-app.sh"
. "$root/src/native/sdks/react-native/tools/expo-runner-reporting.sh"
. "$root/src/native/sdks/react-native/tools/expo-runner-common.sh"

test_root="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-ios-runner-test.XXXXXX")"
trap 'rm -rf "$test_root"' EXIT
app="$test_root/fixture.app"
for profile in standard icu; do
  rm -rf "$app"
  runtime_manifest="$app/OliphauntReactNativeResources.bundle/oliphaunt/runtime/manifest.properties"
  mkdir -p "$(dirname "$runtime_manifest")"
  printf 'selectedExtensions=vector\n' >"$runtime_manifest"
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
  [ "$OLIPHAUNT_MOBILE_E2E_EXPECT_EXTENSIONS" = vector ]
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
runner=smoke
mobile_platform=ios
success_tag=OLIPHAUNT_EXPO_SMOKE_PASS
export CI_HEAD_SHA="$(git rev-parse HEAD)"
export OLIPHAUNT_MOBILE_E2E_EXPECT_ICU=0
export OLIPHAUNT_MOBILE_E2E_EXPECT_CATALOG_PROFILE=standard
export OLIPHAUNT_MOBILE_E2E_EXPECT_LIFECYCLE=0
export OLIPHAUNT_MOBILE_E2E_EXPECT_EXTENSIONS="$(
  bun -e 'const metadata = await Bun.file(process.argv[1]).json(); console.log(metadata.extensions.map((row) => row["sql-name"]).join(","));' \
    "$root/src/extensions/generated/sdk/extensions.json"
)"
receipt_json="$(
  bun "$root/src/native/sdks/react-native/tools/expo-runner-ios-installed-app.fixture.mts" receipt "$root/src/extensions/generated/sdk/extensions.json"
)"
write_runner_report "$success_tag $receipt_json"
verify_mobile_e2e_smoke_receipt ios "$scratch_root"

bun "$root/src/native/sdks/react-native/tools/expo-runner-ios-installed-app.fixture.mts" tamper "$scratch_root/reports/smoke-extension-receipt.json"
if verify_mobile_e2e_smoke_receipt ios "$scratch_root" >/dev/null 2>&1; then
  echo "tampered mobile receipt was accepted" >&2
  exit 1
fi

echo "iOS runner failure and receipt checks passed"

# Release must deliver a registered-scheme URL through UIKit. Debug retains
# the development launcher's supported argument; neither changes bundle flags.
calls="$test_root/launch-calls"
app_id=dev.oliphaunt.fixture
openurl_failure=0
xcrun() {
  printf '%s\n' "$*" >>"$calls"
  if [ "$2" = openurl ] && [ "$openurl_failure" = 1 ]; then return 7; fi
  if [ "$2" = launch ]; then printf '%s: %s\n' "$app_id" "$$"; fi
}
uses_ios_metro() { [ "$configuration" = Debug ]; }
configuration=Release
launch_ios_simulator_runner owned-simulator 'fixture://smoke?liboliphauntLifecycle=1' >"$test_root/launch-output"
grep -Fxq 'simctl openurl owned-simulator fixture://smoke?liboliphauntLifecycle=1' "$calls"
grep -Fxq 'simctl launch owned-simulator dev.oliphaunt.fixture' "$calls"
[ "$(wc -l <"$calls" | tr -d '[:space:]')" = 2 ]
if grep -Fq -- '--initialUrl' "$calls"; then
  echo 'Release forwarded an unsupported initialUrl argument' >&2
  exit 1
fi
: >"$calls"
openurl_failure=1
status=0
launch_output="$(launch_ios_simulator_runner owned-simulator 'fixture://smoke')" || status=$?
[ "$status" = 7 ]
[ "$(wc -l <"$calls" | tr -d '[:space:]')" = 1 ]
if grep -Fq 'simctl launch ' "$calls"; then
  echo 'failed registered URL launch fell through to ordinary launch' >&2
  exit 1
fi
openurl_failure=0
: >"$calls"
configuration=Debug
launch_ios_simulator_runner owned-simulator 'fixture://development' >"$test_root/launch-output"
grep -Fxq 'simctl launch owned-simulator dev.oliphaunt.fixture --initialUrl fixture://development' "$calls"
[ "$(wc -l <"$calls" | tr -d '[:space:]')" = 1 ]

# Exercise the actual simulator runner loop: an ordinary PASS before readiness
# cannot stand in for lifecycle, while a completed requested exercise succeeds.
configuration=Release
sdk=iphonesimulator
runner=smoke
lifecycle_smoke=1
clean_simulator_install=0
scheme=fixture
startup_gucs=""
failure_tag=OLIPHAUNT_EXPO_SMOKE_FAIL
timeout_seconds=5
metro_dev_log="$test_root/no-metro.log"
select_ios_simulator_udid() { printf 'owned-simulator'; }
boot_ios_simulator() { :; }
resolve_ios_app_process_name() { printf 'fixture'; }
write_ios_process_metrics() { :; }
start_ios_simulator_log_capture() {
  mkdir -p "$scratch_root/logs"
  ios_simulator_log_file="$scratch_root/logs/smoke-simulator-unified.log"
  : >"$ios_simulator_log_file"
  if [ "$scenario" = dead-capture ]; then
    ( : ) &
  else
    sleep 60 &
  fi
  ios_simulator_log_pid=$!
  if [ "$scenario" = dead-capture ]; then wait "$ios_simulator_log_pid"; fi
}
completed_receipt="$(bun "$root/src/native/sdks/react-native/tools/expo-runner-ios-installed-app.fixture.mts" receipt "$root/src/extensions/generated/sdk/extensions.json" lifecycle)"
exercise_ios_lifecycle() {
  printf 'exercised\n' >"$test_root/lifecycle-exercised"
  printf '%s\n' \
    'OLIPHAUNT_EXPO_SMOKE_STAGE {"stage":"lifecycle:state","state":"background"}' \
    'OLIPHAUNT_EXPO_SMOKE_STAGE {"stage":"lifecycle:state","state":"active"}' \
    'OLIPHAUNT_EXPO_SMOKE_STAGE {"stage":"lifecycle:sql:done"}' \
    "$success_tag $completed_receipt" >>"$ios_simulator_log_file"
}
xcrun() {
  if [ "$2" = openurl ]; then
    if [ "$scenario" = complete ]; then
      printf 'OLIPHAUNT_EXPO_SMOKE_STAGE {"stage":"lifecycle:ready","state":"active"}\n' >>"$ios_simulator_log_file"
    elif [ "$scenario" = ordinary ]; then
      printf '%s %s\n' "$success_tag" "$receipt_json" >>"$ios_simulator_log_file"
    else
      printf 'OLIPHAUNT_EXPO_SMOKE_STAGE {"stage":"open:start","fixture":"scoped-diagnostic"}\n' >>"$ios_simulator_log_file"
    fi
  elif [ "$2" = launch ]; then
    if [ "$scenario" = dead-app ]; then
      ( : ) &
      local dead_pid=$!
      wait "$dead_pid"
      printf '%s: %s\n' "$app_id" "$dead_pid"
    else
      printf '%s: %s\n' "$app_id" "$$"
    fi
  fi
}
export OLIPHAUNT_MOBILE_E2E_EXPECT_LIFECYCLE=1
for scenario in ordinary complete dead-capture dead-app timeout; do
  scratch_root="$test_root/$scenario"
  timeout_seconds=5
  [ "$scenario" != timeout ] || timeout_seconds=1
  status=0
  (
    ios_simulator_log_pid=""
    trap 'stop_mobile_log_capture "$ios_simulator_log_pid"' EXIT
    install_and_launch "$app"
  ) >"$test_root/$scenario.log" 2>&1 || status=$?
  if [ "$scenario" = ordinary ]; then
    [ "$status" != 0 ]
    grep -Fq 'PASS preceded the requested lifecycle exercise' "$test_root/$scenario.log"
    [ ! -e "$test_root/lifecycle-exercised" ]
  elif [ "$scenario" = complete ]; then
    [ "$status" = 0 ] || { cat "$test_root/$scenario.log" >&2; exit 1; }
    [ -s "$test_root/lifecycle-exercised" ]
    verify_mobile_e2e_smoke_receipt ios "$scratch_root"
  else
    [ "$status" != 0 ]
    grep -Fq '"fixture":"scoped-diagnostic"' "$test_root/$scenario.log"
    case "$scenario" in
      dead-capture) grep -Fq 'iOS smoke receipt failed (status 3:' "$test_root/$scenario.log" ;;
      dead-app) grep -Fq 'iOS smoke receipt failed (status 4:' "$test_root/$scenario.log" ;;
      timeout) grep -Fq "timed out waiting for $success_tag" "$test_root/$scenario.log" ;;
    esac
  fi
done
echo 'iOS registered URL launch, lifecycle receipt, liveness, and scoped diagnostics passed'
