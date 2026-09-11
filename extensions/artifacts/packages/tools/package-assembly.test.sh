#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
if [[ "${1:-}" != --context ]]; then
  exec bash tools/ci/with-projects.sh --exec bash extensions/artifacts/packages/tools/package-assembly.test.sh --context
fi
root="$PWD"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
mkdir -p "$scratch/repo/tools/dev" "$scratch/wasix"
git -C "$scratch/repo" init -q
cat > "$scratch/repo/tools/dev/bun.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$OLIPHAUNT_TEST_CALLS_FILE"
[[ "${OLIPHAUNT_TEST_FAIL_TOOL:-}" != "$1" ]] || exit 73
SH
chmod +x "$scratch/repo/tools/dev/bun.sh"
export OLIPHAUNT_TEST_CALLS_FILE="$scratch/calls"
producer=extensions/artifacts/packages/tools/build-extension-ci-artifacts.mts
validator=extensions/artifacts/packages/tools/check-carriers.mts
release_script="$root/extensions/artifacts/packages/tools/package-release-assets.sh"
mobile_script="$root/extensions/artifacts/packages/tools/package-mobile-release-assets.sh"
run() {
  : > "$OLIPHAUNT_TEST_CALLS_FILE"
  (cd "$scratch/repo" && bash "$@") > "$scratch/output" 2>&1
}
reject() {
  local status=0
  run "$@" || status=$?
  [[ "$status" != 0 ]] || { echo 'Invalid assembly succeeded' >&2; exit 1; }
}
OLIPHAUNT_EXTENSION_PACKAGE_PRODUCTS='oliphaunt-extension-postgis, oliphaunt-extension-vector' run "$release_script"
grep -Fxq "$validator --require-full-extension-targets oliphaunt-extension-postgis oliphaunt-extension-vector" "$OLIPHAUNT_TEST_CALLS_FILE"
run "$release_script"
grep -Fxq "$validator --require-full-extension-targets all" "$OLIPHAUNT_TEST_CALLS_FILE"
OLIPHAUNT_TEST_FAIL_TOOL="$producer" reject "$release_script"
[[ "$(wc -l < "$OLIPHAUNT_TEST_CALLS_FILE")" -eq 1 ]]
if grep -Fq "$validator" "$OLIPHAUNT_TEST_CALLS_FILE"; then
  echo 'Validator ran after producer failure' >&2; exit 1
fi
OLIPHAUNT_TEST_FAIL_TOOL="$validator" reject "$release_script"
grep -Fq "$producer" "$OLIPHAUNT_TEST_CALLS_FILE"
OLIPHAUNT_EXTENSION_PACKAGE_PRODUCTS=oliphaunt-extension-contrib-pg18 \
  OLIPHAUNT_EXTENSION_PACKAGE_NATIVE_TARGETS=android-arm64-v8a,ios-xcframework run "$mobile_script"
grep -Fxq "$producer --output-root target/mobile-extension-artifacts --family native oliphaunt-extension-contrib-pg18 --require-native-target android-arm64-v8a --require-native-target ios-xcframework" "$OLIPHAUNT_TEST_CALLS_FILE"
grep -Fxq "$validator --family native oliphaunt-extension-contrib-pg18" "$OLIPHAUNT_TEST_CALLS_FILE"
OLIPHAUNT_EXTENSION_PACKAGE_PRODUCTS=', ,' OLIPHAUNT_EXTENSION_PACKAGE_NATIVE_TARGETS=android-arm64-v8a reject "$mobile_script"
grep -Fq 'did not contain any products' "$scratch/output"
OLIPHAUNT_EXTENSION_PACKAGE_PRODUCTS=oliphaunt-extension-postgis OLIPHAUNT_EXTENSION_PACKAGE_NATIVE_TARGETS=', ,' reject "$mobile_script"
grep -Fq 'did not contain any targets' "$scratch/output"
if grep -Fq 'unbound variable' "$scratch/output"; then
  echo 'Invalid selection triggered an unbound variable' >&2; exit 1
fi

test_file=extensions/artifacts/packages/tools/package-assembly.test.mts
bun "$test_file" prepare "$scratch/wasix"
bun extensions/artifacts/wasix/tools/package-release-assets.mts \
  --root "$root" --asset-root "$scratch/wasix/assets" --metadata "$scratch/wasix/extensions.json" \
  --manifest "$scratch/wasix/manifest.json" --out-dir "$scratch/wasix/out" \
  --target wasix-portable --extension-products oliphaunt-extension-contrib-pg18
OLIPHAUNT_EXTENSION_ASSEMBLY_TEST_ROOT="$scratch/wasix" bun test "./$test_file"
