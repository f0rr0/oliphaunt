#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
builder="$root/src/runtimes/liboliphaunt/native/bin/build-ios-extension-xcframeworks.sh"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-ios-extension-packager-test.XXXXXX")"
trap 'rm -rf "$test_root"' EXIT HUP INT TERM

fail() {
  echo "iOS extension XCFramework packager test failed: $*" >&2
  exit 1
}

resources="$test_root/resources"
runtime_manifest="$resources/oliphaunt/runtime/manifest.properties"
work_root="$test_root/output"
mkdir -p "$(dirname "$runtime_manifest")"
printf '%s\n' \
  'schema=oliphaunt-runtime-resources-v1' \
  'layout=postgres-runtime-files-v1' \
  'selectedExtensions=' \
  'extensions=' \
  >"$runtime_manifest"

run_builder() {
  env \
    OLIPHAUNT_IOS_EXTENSION_XCFRAMEWORK_ROOT="$work_root" \
    OLIPHAUNT_IOS_SIMULATOR_OUT="$test_root/ios-simulator" \
    OLIPHAUNT_IOS_DEVICE_OUT="$test_root/ios-device" \
    OLIPHAUNT_MACOS_EXTENSION_OUT="$test_root/macos" \
    "$builder" "$@"
}

run_builder --runtime-resources "$resources" >/dev/null
output_manifest="$work_root/out/manifest.properties"
[ -f "$output_manifest" ] || fail "build did not emit a manifest"
grep -Fx 'packageLayout=oliphaunt-ios-extension-xcframeworks-v1' "$output_manifest" >/dev/null ||
  fail "manifest has the wrong package layout"
grep -Fx 'extensions=' "$output_manifest" >/dev/null ||
  fail "empty selection was not preserved"
run_builder --check-current --runtime-resources "$resources" >/dev/null

awk '{ if ($0 == "extensions=") print "extensions=vector"; else print }' \
  "$output_manifest" >"$output_manifest.stale"
mv "$output_manifest.stale" "$output_manifest"
if run_builder --check-current --runtime-resources "$resources" >/dev/null 2>&1; then
  fail "check-current accepted a stale selection manifest"
fi

invalid_resources="$test_root/invalid-resources"
mkdir -p "$invalid_resources/oliphaunt/runtime"
printf '%s\n' \
  'schema=oliphaunt-runtime-resources-v0' \
  'layout=postgres-runtime-files-v1' \
  'extensions=' \
  >"$invalid_resources/oliphaunt/runtime/manifest.properties"
if run_builder --runtime-resources "$invalid_resources" >/dev/null 2>&1; then
  fail "build accepted an unsupported runtime-resource schema"
fi

printf 'iOS extension XCFramework packager behavior verified.\n'
