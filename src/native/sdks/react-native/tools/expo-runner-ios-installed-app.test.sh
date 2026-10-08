#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
. "$root/src/native/sdks/react-native/tools/expo-runner-ios-installed-app.sh"
. "$root/src/native/sdks/react-native/tools/expo-runner-reporting.sh"

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
