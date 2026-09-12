#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
product_tools="$root/sdks/react-native/tools"
fixture="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-rn-package-inputs.XXXXXX")"
trap 'rm -rf "$fixture"' EXIT

fixture_root="$fixture/repo"
rn_dir="$fixture_root/sdks/react-native"
source_example_dir="$fixture_root/examples/react-native-expo"
scratch_root="$fixture/scratch"
package_work="$scratch_root/sdks/react-native"
mkdir -p \
  "$rn_dir/src" \
  "$rn_dir/node_modules" \
  "$source_example_dir" \
  "$fixture_root/extensions/generated/sdk"
printf '{"name":"fixture"}\n' >"$rn_dir/package.json"
printf 'export const fixture = 1;\n' >"$rn_dir/src/index.ts"
printf '{"name":"example"}\n' >"$source_example_dir/package.json"
printf '{"extensions":[]}\n' >"$fixture_root/extensions/generated/sdk/extensions.json"
printf '{"extensions":[]}\n' >"$fixture_root/extensions/generated/sdk/ios-static-dependencies.json"

# shellcheck source=sdks/react-native/tools/expo-runner-workspace.sh
. "$product_tools/expo-runner-workspace.sh"
root="$fixture_root"
need_cmd() { command -v "$1" >/dev/null; }
write_scratch_bun_workspace() { mkdir -p "$scratch_root"; }

prepare_react_native_package_worktree
cmp "$root/extensions/generated/sdk/extensions.json" "$package_work/src/generated/extensions.json"
cmp "$root/extensions/generated/sdk/ios-static-dependencies.json" "$package_work/src/generated/ios-static-dependencies.json"
[ -L "$package_work/node_modules" ]

fingerprint() {
  bun "$product_tools/react-native-package-inputs.mts" \
    --root "$root" \
    --rn-dir "$rn_dir" \
    --example-package "$source_example_dir/package.json"
}

assert_fingerprint_changes() {
  local file="$1"
  local before after
  before="$(fingerprint)"
  printf '\nmutation\n' >>"$file"
  touch -t 200001010000 "$file"
  after="$(fingerprint)"
  [ "$before" != "$after" ] || {
    echo "package fingerprint ignored changed input: $file" >&2
    exit 1
  }
}

assert_fingerprint_changes "$rn_dir/src/index.ts"
assert_fingerprint_changes "$root/extensions/generated/sdk/extensions.json"
assert_fingerprint_changes "$root/extensions/generated/sdk/ios-static-dependencies.json"
assert_fingerprint_changes "$source_example_dir/package.json"

first="$(fingerprint)"
second="$(fingerprint)"
[ "$first" = "$second" ] || {
  echo "package fingerprint is nondeterministic" >&2
  exit 1
}

echo "React Native source-package staging and content fingerprint tests passed"

# Resource assembly consumes data without executing or repairing source tools.
root="$(cd "$product_tools/../../.." && pwd)"
script_path="$product_tools/expo-android-runner.sh"
# shellcheck source=sdks/react-native/tools/expo-runner-common.sh
. "$product_tools/expo-runner-common.sh"
# shellcheck source=sdks/react-native/tools/mobile-extension-runtime.sh
. "$product_tools/mobile-extension-runtime.sh"
# shellcheck source=sdks/react-native/tools/expo-runner-runtime-resources.sh
. "$product_tools/expo-runner-runtime-resources.sh"
runtime_source="$fixture/runtime"
seed="$fixture/seed"
mkdir -p "$runtime_source/share/postgresql" "$runtime_source/bin" "$seed/files"
printf 'fixture catalog\n' >"$runtime_source/share/postgresql/postgres.bki"
printf 'fixture settings\n' >"$runtime_source/share/postgresql/postgresql.conf.sample"
bun -e '
  const [module, runtime] = process.argv.splice(1);
  const { CORE_SNOWBALL_RUNTIME_DATA_FILES } = await import(module);
  for (const file of CORE_SNOWBALL_RUNTIME_DATA_FILES) {
    await Bun.write(`${runtime}/${file}`, "fixture Snowball data\n");
  }
' "$product_tools/validate-mobile-runtime-files.mts" "$runtime_source"
printf 'must never execute\n' >"$runtime_source/bin/initdb"
chmod 0444 "$runtime_source/bin/initdb"
printf 'catalogProfile=standard\ntarget=android-datum64\n' >"$seed/manifest.properties"
printf '18\n' >"$seed/files/PG_VERSION"
before="$(directory_fingerprint "$runtime_source")"
require_mobile_runtime_data "$runtime_source" OLIPHAUNT_EXPO_ANDROID_RUNTIME_DIR \
  liboliphaunt-native:build-runtime-android-x86_64
package_root="$fixture/mobile-package"
prepare_mobile_runtime_resource_package Android "$runtime_source" "$seed" '' '' 1 "$package_root"
cmp "$runtime_source/share/postgresql/postgres.bki" "$package_root/oliphaunt/runtime/files/share/postgresql/postgres.bki"
cmp "$seed/files/PG_VERSION" "$package_root/oliphaunt/cluster-seed/files/PG_VERSION"
[ ! -e "$package_root/oliphaunt/runtime/files/bin/initdb" ]
[ ! -x "$runtime_source/bin/initdb" ]
[ "$before" = "$(directory_fingerprint "$runtime_source")" ]
if (require_mobile_runtime_data "$fixture/missing" OLIPHAUNT_EXPO_ANDROID_RUNTIME_DIR \
  liboliphaunt-native:build-runtime-android-x86_64) >"$fixture/missing.log" 2>&1; then
  echo 'missing mobile runtime data unexpectedly accepted' >&2
  exit 1
fi
grep -Fq 'moon run liboliphaunt-native:build-runtime-android-x86_64' "$fixture/missing.log"
echo "Mobile resource assembly preserves producer inputs and rejects missing data"
