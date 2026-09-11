#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$root"
fixture="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-mobile-selection.XXXXXX")"
trap 'rm -rf "$fixture"' EXIT
fail() { printf '%s\n' "$*" >&2; exit 1; }
source "$root/sdks/react-native/tools/mobile-extension-runtime.sh"
bun sdks/react-native/tools/mobile-extension-selection-fixture.mts "$fixture"
expect_failure() {
  local message="$1"
  shift
  if ( "$@" ) >"$fixture/error.log" 2>&1; then
    fail "expected failure: $*"
  fi
  grep -Fq "$message" "$fixture/error.log" || { cat "$fixture/error.log" >&2; fail "missing diagnostic: $message"; }
}
for platform in Android iOS; do
  selected="$(oliphaunt_dev_normalize_mobile_extensions ' pgtap,pgtap ' "$platform")"
  [ "$selected" = pgtap ] || fail 'SQL-only selection was not normalized'
  [ -z "$(oliphaunt_dev_mobile_static_extensions_for_selection "$selected")" ] || fail 'SQL-only extension requested static registration'
  [ -z "$(oliphaunt_dev_mobile_module_stems_for_selection "$selected")" ] || fail 'SQL-only extension requested module stems'
  [ -z "$(oliphaunt_dev_mobile_module_extensions_for_selection "$selected")" ] || fail 'SQL-only extension requested native module registration'
  selected="$(oliphaunt_dev_normalize_mobile_extensions earthdistance "$platform")"
  [ "$selected" = cube,earthdistance ] || fail 'dependency was not selected before its consumer'
  [ "$(oliphaunt_dev_mobile_static_extensions_for_selection "$selected")" = "$selected" ] || fail 'native dependency missing from static selection'
done
(
  oliphaunt_dev_prebuilt_extension_asset_paths_for_selection() { printf '%s|%s|%s\n' "$1" "$2" "$3"; }
  [ "$(oliphaunt_dev_prebuilt_ios_extension_framework_zips_for_selection pgtap,vector)" = 'vector|ios-xcframework|ios-xcframework' ] || fail 'SQL-only extension requested framework'
)
(
  oliphaunt_dev_prebuilt_extension_asset_paths_for_selection() { fail 'SQL-only selection requested a native framework'; }
  mkdir -p "$fixture/frameworks/stale.xcframework"
  oliphaunt_dev_unpack_ios_extension_frameworks_for_selection pgtap "$fixture/frameworks"
  [ ! -e "$fixture/frameworks" ] || fail 'SQL-only selection retained stale native frameworks'
)
expect_failure 'unsupported mobile extension for Android Expo smoke: not_a_real_extension' oliphaunt_dev_normalize_mobile_extensions vector,not_a_real_extension Android
expect_failure 'unsupported mobile extension platform: desktop' oliphaunt_dev_normalize_mobile_extensions vector desktop
oliphaunt_dev_assert_runtime_file_list pgtap Android <"$fixture/pgtap.txt"
oliphaunt_dev_assert_runtime_file_list postgis iOS <"$fixture/postgis.txt"
expect_failure 'unselected PostgreSQL extension asset:' oliphaunt_dev_assert_runtime_file_list '' Android <"$fixture/unselected.txt"
expect_failure 'undeclared PostgreSQL extension asset' oliphaunt_dev_assert_runtime_file_list '' Android <"$fixture/undeclared.txt"
expect_failure 'missing selected pgtap canonical install SQL file' oliphaunt_dev_assert_runtime_file_list pgtap Android <"$fixture/ancillary-only.txt"
(
  oliphaunt_dev_sdk_extension_json() { printf '%s\n' "$fixture/ambiguous.json"; }
  expect_failure 'ambiguous ownership' oliphaunt_dev_assert_runtime_file_list pgtap Android <"$fixture/pgtap.txt"
)
oliphaunt_dev_assert_runtime_extension_tree "$fixture/runtime" pgtap Android
printf '%s\n' 'React Native extension selection and runtime inventory checks passed'
