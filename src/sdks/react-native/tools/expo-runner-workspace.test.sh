#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fixture="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-rn-package-inputs.XXXXXX")"
trap 'rm -rf "$fixture"' EXIT

root="$fixture/repo"
rn_dir="$root/src/sdks/react-native"
source_example_dir="$root/examples/react-native-expo"
scratch_root="$fixture/scratch"
package_work="$scratch_root/src/sdks/react-native"
mkdir -p \
  "$rn_dir/src" \
  "$rn_dir/node_modules" \
  "$source_example_dir" \
  "$root/src/extensions/generated/sdk" \
  "$root/tools/dev"
printf '{"name":"fixture"}\n' >"$rn_dir/package.json"
printf 'export const fixture = 1;\n' >"$rn_dir/src/index.ts"
printf '{"name":"example"}\n' >"$source_example_dir/package.json"
printf '{"extensions":[]}\n' >"$root/src/extensions/generated/sdk/extensions.json"
printf '{"extensions":[]}\n' >"$root/src/extensions/generated/sdk/ios-static-dependencies.json"
printf 'fixture helper\n' >"$root/tools/dev/clean-package-lib.mjs"

# shellcheck source=src/sdks/react-native/tools/expo-runner-workspace.sh
. "$script_dir/expo-runner-workspace.sh"
need_cmd() { command -v "$1" >/dev/null; }
write_scratch_pnpm_workspace() { mkdir -p "$scratch_root"; }

prepare_react_native_package_worktree
cmp "$root/tools/dev/clean-package-lib.mjs" "$scratch_root/tools/dev/clean-package-lib.mjs"
cmp "$root/src/extensions/generated/sdk/extensions.json" "$package_work/src/generated/extensions.json"
cmp "$root/src/extensions/generated/sdk/ios-static-dependencies.json" "$package_work/src/generated/ios-static-dependencies.json"
[ -L "$package_work/node_modules" ]

fingerprint() {
  node "$script_dir/react-native-package-inputs.mjs" \
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
assert_fingerprint_changes "$root/tools/dev/clean-package-lib.mjs"
assert_fingerprint_changes "$root/src/extensions/generated/sdk/extensions.json"
assert_fingerprint_changes "$root/src/extensions/generated/sdk/ios-static-dependencies.json"
assert_fingerprint_changes "$source_example_dir/package.json"

first="$(fingerprint)"
second="$(fingerprint)"
[ "$first" = "$second" ] || {
  echo "package fingerprint is nondeterministic" >&2
  exit 1
}

echo "React Native source-package staging and content fingerprint tests passed"
