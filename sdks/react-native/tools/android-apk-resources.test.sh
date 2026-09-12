#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
# shellcheck source=sdks/react-native/tools/expo-runner-reporting.sh
source "$root/sdks/react-native/tools/expo-runner-reporting.sh"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
fixture="$scratch/apk"
resources="$fixture/assets/oliphaunt"
pack() {
  rm -f "$scratch/app.apk"
  (cd "$fixture" && zip -qr "$scratch/app.apk" assets)
}
for profile in standard icu; do
  rm -rf "$fixture"
  mkdir -p "$resources/runtime"
  features=''
  seed=cluster-seed
  if [[ "$profile" == icu ]]; then features=icu; seed=cluster-seed-icu; fi
  printf 'runtimeFeatures=%s\n' "$features" >"$resources/runtime/manifest.properties"
  # Existing storage requires no seed dependency, with or without ICU data.
  pack
  export_mobile_e2e_icu_expectation_from_android_apk "$scratch/app.apk" fixture
  [[ "$OLIPHAUNT_MOBILE_E2E_EXPECT_CATALOG_PROFILE" == "$profile" ]]
  [[ "$OLIPHAUNT_MOBILE_E2E_EXPECT_ICU" == "$([[ "$profile" == icu ]] && echo 1 || echo 0)" ]]
  mkdir -p "$resources/$seed"
  printf 'catalogProfile=%s\n' "$profile" >"$resources/$seed/manifest.properties"
  pack
  export_mobile_e2e_icu_expectation_from_android_apk "$scratch/app.apk" fixture
  printf 'catalogProfile=invalid\n' >"$resources/$seed/manifest.properties"
  pack
  if export_mobile_e2e_icu_expectation_from_android_apk "$scratch/app.apk" fixture 2>"$scratch/error"; then
    echo 'accepted an incompatible selected seed' >&2; exit 1
  fi
  grep -q 'does not declare catalogProfile' "$scratch/error"
done
# A carrier cannot silently select both profiles or the opposite profile.
printf 'catalogProfile=icu\n' >"$resources/cluster-seed-icu/manifest.properties"
mkdir -p "$resources/cluster-seed"
printf 'catalogProfile=standard\n' >"$resources/cluster-seed/manifest.properties"
pack
if export_mobile_e2e_icu_expectation_from_android_apk "$scratch/app.apk" fixture 2>"$scratch/error"; then exit 1; fi
grep -q 'incompatible with catalogProfile' "$scratch/error"
rm "$resources/runtime/manifest.properties"
pack
if export_mobile_e2e_icu_expectation_from_android_apk "$scratch/app.apk" fixture 2>"$scratch/error"; then exit 1; fi
grep -q 'could not be read' "$scratch/error"
