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

# Release passes its URL through NSArgumentDomain without a scheme confirmation.
# Debug retains the development launcher's supported argument.
calls="$test_root/launch-calls"
app_id=dev.oliphaunt.fixture
launch_failure=0
xcrun() {
  printf '%s\n' "$*" >>"$calls"
  printf '%s\n' "$@" >"$test_root/launch-argv"
  if [ "$2" = launch ] && [ "$launch_failure" = 1 ]; then return 7; fi
  if [ "$2" = launch ]; then printf '%s: %s\n' "$app_id" "$$"; fi
}
uses_ios_metro() { [ "$configuration" = Debug ]; }
configuration=Release
for launch_url in \
  'fixture://oliphaunt-smoke?liboliphauntRunner=smoke&liboliphauntLifecycle=1' \
  'fixture://oliphaunt-smoke?liboliphauntRunner=benchmark&liboliphauntBenchmarkPreset=short%20read&liboliphauntStartupGUCs=work_mem%3D4MB%26search_path%3Dpublic' \
  'fixture://oliphaunt-smoke?liboliphauntRunner=crash-verify&liboliphauntStorageDirectory=%2Ftmp%2Fcrash%20data&label=two words'; do
  : >"$calls"
  launch_ios_simulator_runner owned-simulator "$launch_url" >"$test_root/launch-output"
  [ "$(cat "$test_root/launch-argv")" = "$(printf '%s\n' simctl launch owned-simulator "$app_id" -liboliphauntLaunchURL "$launch_url")" ]
  [ "$(wc -l <"$calls" | tr -d '[:space:]')" = 1 ]
  if grep -Fq 'simctl openurl ' "$calls"; then
    echo 'Release initial launch requested a custom-scheme confirmation' >&2
    exit 1
  fi
done
: >"$calls"
launch_failure=1
status=0
launch_output="$(launch_ios_simulator_runner owned-simulator 'fixture://smoke')" || status=$?
[ "$status" = 7 ]
[ -z "$launch_output" ]
[ "$(wc -l <"$calls" | tr -d '[:space:]')" = 1 ]
grep -Fxq 'simctl launch owned-simulator dev.oliphaunt.fixture -liboliphauntLaunchURL fixture://smoke' "$calls"
launch_failure=0
: >"$calls"
configuration=Debug
launch_ios_simulator_runner owned-simulator 'fixture://development' >"$test_root/launch-output"
grep -Fxq 'simctl launch owned-simulator dev.oliphaunt.fixture --initialUrl fixture://development' "$calls"
[ "$(wc -l <"$calls" | tr -d '[:space:]')" = 1 ]
: >"$calls"
background_seconds=0
scheme=fixture
exercise_ios_lifecycle owned-simulator >"$test_root/lifecycle-output"
grep -Fxq 'simctl launch owned-simulator com.apple.mobilesafari' "$calls"
grep -Fxq 'simctl launch owned-simulator dev.oliphaunt.fixture' "$calls"
[ "$(wc -l <"$calls" | tr -d '[:space:]')" = 2 ]

# Exercise the actual simulator runner loop: an ordinary PASS before readiness
# cannot stand in for lifecycle, while a completed requested exercise succeeds.
configuration=Release
sdk=iphonesimulator
runner=smoke
lifecycle_smoke=1
background_seconds=0
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
  [ "$lifecycle_smoke" != 1 ] || [ -s "$test_root/safari-prewarmed" ] || return 9
  printf 'capture:start\n' >>"$calls"
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
xcrun() {
  printf '%s\n' "$*" >>"$calls"
  if [ "$2" = openurl ]; then
    return 9
  elif [ "$2" = io ] && [ "$4" = screenshot ]; then
    [ "$scenario" != dead-capture ] || return 7
    printf 'fixture PNG\n' >"$5"
  elif [ "$2" = launch ]; then
    if [ "$4" = com.apple.mobilesafari ]; then
      [ "$#" = 4 ] || return 9
      if [ ! -s "$test_root/safari-prewarmed" ]; then
        [ ! -e "$test_root/tested-app-launched" ] || return 9
        if grep -Fxq 'capture:start' "$calls"; then return 9; fi
        [ "$scenario" != prewarm-failure ] || return 7
        printf 'prepared\n' >"$test_root/safari-prewarmed"
      else
        [ -s "$test_root/tested-app-launched" ] || return 9
        [ ! -e "$test_root/lifecycle-exercised" ] || return 9
        logs_have_lifecycle_ready <"$ios_simulator_log_file" || return 9
        [ "$scenario" != background-failure ] || return 7
        printf 'exercised\n' >"$test_root/lifecycle-exercised"
        printf 'OLIPHAUNT_EXPO_SMOKE_STAGE {"stage":"lifecycle:state","state":"background"}\n' >>"$ios_simulator_log_file"
      fi
      printf 'com.apple.mobilesafari: %s\n' "$$"
      return
    fi
    [ "$4" = "$app_id" ] || return 9
    if [ "${5:-}" = -liboliphauntLaunchURL ]; then
      [ "$#" = 6 ] && [ "$6" = "$(ios_runner_url "$runner")" ] || return 9
      [ ! -e "$test_root/tested-app-launched" ] || return 9
      grep -Fxq 'capture:start' "$calls" || return 9
      printf 'launched\n' >"$test_root/tested-app-launched"
      if [ "$scenario" = async-ready ]; then
        (
          sleep 0.1
          printf 'OLIPHAUNT_EXPO_SMOKE_STAGE {"stage":"lifecycle:ready","state":"active"}\n' >>"$ios_simulator_log_file"
        ) </dev/null >/dev/null 2>&1 &
      elif [ "$scenario" = complete ] || [ "$scenario" = lifecycle-js-fatal-pass ] || [ "$scenario" = lifecycle-timeout ] || [ "$scenario" = background-failure ]; then
        if [ "$scenario" = complete ]; then
          printf 'Warning: Cannot find native module ExpoAsset\n' >>"$ios_simulator_log_file"
        fi
        if [ "$scenario" = lifecycle-timeout ]; then
          printf 'OLIPHAUNT_EXPO_SMOKE_STAGE {"stage":"open:start","fixture":"scoped-diagnostic"}\n' >>"$ios_simulator_log_file"
        fi
        printf 'OLIPHAUNT_EXPO_SMOKE_STAGE {"stage":"lifecycle:ready","state":"inactive"}\n' >>"$ios_simulator_log_file"
      elif [ "$scenario" = js-fatal ] || [ "$scenario" = lifecycle-js-fatal ]; then
        printf 'Unhandled JS Exception: [runtime not ready]: Error: Cannot find native module ExpoAsset\n' >>"$ios_simulator_log_file"
        printf 'OLIPHAUNT_EXPO_SMOKE_STAGE {"stage":"lifecycle:ready","state":"active"}\n' >>"$ios_simulator_log_file"
      elif [ "$scenario" = ordinary ]; then
        printf '%s %s\n' "$success_tag" "$receipt_json" >>"$ios_simulator_log_file"
      else
        printf 'OLIPHAUNT_EXPO_SMOKE_STAGE {"stage":"open:start","fixture":"scoped-diagnostic"}\n' >>"$ios_simulator_log_file"
      fi
    elif [ -s "$test_root/lifecycle-exercised" ]; then
      [ "$#" = 4 ] || return 9
      [ ! -e "$test_root/tested-app-resumed" ] || return 9
      printf 'resumed\n' >"$test_root/tested-app-resumed"
      if [ "$scenario" = lifecycle-timeout ]; then
        printf '%s lifecycle timeout states=inactive>background\n' "$failure_tag" >>"$ios_simulator_log_file"
        local noise
        for ((noise = 0; noise < 210; noise++)); do
          printf 'fixture debug noise\n' >>"$ios_simulator_log_file"
        done
      else
        if [ "$scenario" = lifecycle-js-fatal-pass ]; then
          printf 'Unhandled JS Exception: [runtime not ready]: Error: Cannot find native module ExpoAsset\n' >>"$ios_simulator_log_file"
        fi
        printf '%s\n' \
          'OLIPHAUNT_EXPO_SMOKE_STAGE {"stage":"lifecycle:state","state":"active"}' \
          'OLIPHAUNT_EXPO_SMOKE_STAGE {"stage":"lifecycle:sql:done"}' \
          "$success_tag $completed_receipt" >>"$ios_simulator_log_file"
      fi
    else
      return 9
    fi
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
for scenario in ordinary complete async-ready prewarm-failure background-failure js-fatal lifecycle-js-fatal lifecycle-js-fatal-pass dead-capture dead-app timeout lifecycle-timeout; do
  scratch_root="$test_root/$scenario"
  rm -f "$test_root/safari-prewarmed" "$test_root/tested-app-launched" "$test_root/lifecycle-exercised" "$test_root/tested-app-resumed"
  : >"$calls"
  lifecycle_smoke=1
  [ "$scenario" != js-fatal ] || lifecycle_smoke=0
  timeout_seconds=5
  [ "$scenario" != async-ready ] || timeout_seconds=8
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
  elif [ "$scenario" = complete ] || [ "$scenario" = async-ready ]; then
    [ "$status" = 0 ] || { cat "$test_root/$scenario.log" >&2; exit 1; }
    [ -s "$test_root/lifecycle-exercised" ]
    [ ! -e "$scratch_root/logs/smoke-lifecycle-failure.png" ]
    verify_mobile_e2e_smoke_receipt ios "$scratch_root"
  elif [ "$scenario" = prewarm-failure ] || [ "$scenario" = background-failure ]; then
    [ "$status" != 0 ]
    [ ! -e "$test_root/lifecycle-exercised" ]
    [ ! -e "$test_root/tested-app-resumed" ]
    [ ! -e "$scratch_root/reports/smoke-extension-receipt.json" ]
    if [ "$scenario" = prewarm-failure ]; then
      grep -Fq 'failed to prepare the iOS lifecycle background app' "$test_root/$scenario.log"
      [ ! -e "$test_root/tested-app-launched" ]
      if grep -Fxq 'capture:start' "$calls"; then exit 1; fi
    else
      grep -Fq 'failed to exercise the iOS lifecycle transition' "$test_root/$scenario.log"
      [ -s "$test_root/tested-app-launched" ]
    fi
  elif [ "$scenario" = js-fatal ] || [ "$scenario" = lifecycle-js-fatal ] || [ "$scenario" = lifecycle-js-fatal-pass ]; then
    [ "$status" != 0 ]
    grep -Fq 'iOS smoke receipt failed (status 2:' "$test_root/$scenario.log"
    grep -Fq 'Unhandled JS Exception: [runtime not ready]: Error: Cannot find native module ExpoAsset' "$test_root/$scenario.log"
    [ ! -e "$scratch_root/reports/smoke-extension-receipt.json" ]
    if [ "$scenario" = lifecycle-js-fatal-pass ]; then
      [ -s "$test_root/lifecycle-exercised" ]
      grep -Fq "$success_tag $completed_receipt" "$test_root/$scenario.log"
    else
      [ ! -e "$test_root/lifecycle-exercised" ]
    fi
    if [ "$scenario" = js-fatal ]; then
      [ ! -e "$scratch_root/logs/smoke-lifecycle-failure.png" ]
    fi
  else
    [ "$status" != 0 ]
    grep -Fq '"fixture":"scoped-diagnostic"' "$test_root/$scenario.log"
    case "$scenario" in
      dead-capture) grep -Fq 'iOS smoke receipt failed (status 3:' "$test_root/$scenario.log" ;;
      dead-app) grep -Fq 'iOS smoke receipt failed (status 4:' "$test_root/$scenario.log" ;;
      timeout) grep -Fq "timed out waiting for $success_tag" "$test_root/$scenario.log" ;;
      lifecycle-timeout)
        grep -Fq 'iOS smoke receipt failed (status 2:' "$test_root/$scenario.log"
        grep -Fq 'lifecycle timeout states=inactive>background' "$test_root/$scenario.log"
        grep -Fq '"stage":"lifecycle:ready"' "$test_root/$scenario.log"
        [ -s "$scratch_root/logs/smoke-lifecycle-failure.png" ]
        if grep -Fq '"stage":"lifecycle:state","state":"active"' "$test_root/$scenario.log"; then exit 1; fi
        [ ! -e "$scratch_root/reports/smoke-extension-receipt.json" ]
        ;;
    esac
  fi
  if grep -Fq 'simctl openurl ' "$calls"; then exit 1; fi
  if [ "$lifecycle_smoke" = 0 ]; then
    if grep -Fq com.apple.mobilesafari "$calls"; then exit 1; fi
  fi
  expected_initial_launches=1
  [ "$scenario" != prewarm-failure ] || expected_initial_launches=0
  [ "$(grep -Fc 'simctl launch owned-simulator dev.oliphaunt.fixture -liboliphauntLaunchURL ' "$calls")" = "$expected_initial_launches" ]
  expected_resume_launches=0
  [ ! -s "$test_root/lifecycle-exercised" ] || expected_resume_launches=1
  [ "$(grep -Fxc 'simctl launch owned-simulator dev.oliphaunt.fixture' "$calls")" = "$expected_resume_launches" ]
  if [ -s "$test_root/lifecycle-exercised" ]; then
    [ "$(grep -Fxc 'simctl launch owned-simulator com.apple.mobilesafari' "$calls")" = 2 ]
    grep -Fxq "simctl launch owned-simulator dev.oliphaunt.fixture -liboliphauntLaunchURL $(ios_runner_url "$runner")" "$calls"
  fi
done
echo 'iOS direct launch, lifecycle receipt, liveness, and scoped diagnostics passed'
