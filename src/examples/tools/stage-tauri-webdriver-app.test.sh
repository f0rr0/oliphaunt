#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "stage-tauri-webdriver-app.test.sh: must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

fail() {
  echo "stage-tauri-webdriver-app.test.sh: $*" >&2
  exit 1
}

scratch="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-tauri-stage-test.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT

stage_and_verify() {
  example="$1"
  destination="$scratch/$example"
  actual="$(src/examples/tools/stage-tauri-webdriver-app.sh "src/examples/$example" "$destination")"
  expected="$destination/worktree/src/examples/$example"
  [[ "$actual" = "$expected" ]] ||
    fail "$example staged at $actual, expected $expected"
  cmp "$root/src/examples/$example/package.json" "$actual/package.json" >/dev/null ||
    fail "$example package.json changed while staging"
  cmp "$root/src/examples/$example/src-tauri/Cargo.toml" "$actual/src-tauri/Cargo.toml" >/dev/null ||
    fail "$example Cargo.toml changed while staging"
  [[ -z "$(find "$destination/worktree" -type l -print -quit)" ]] ||
    fail "$example scratch closure contains a symlink into external state"
  [[ -z "$(find "$destination/worktree/src/examples" -type d \
    \( -name node_modules -o -name dist -o -path '*/src-tauri/gen' -o -path '*/src-tauri/target' \) \
    -print -quit)" ]] || fail "$example scratch closure contains generated dependencies or build output"
  printf '%s\n' "$actual"
}

tauri="$(stage_and_verify native/tauri)"
tauri_wasix="$(stage_and_verify wasix/tauri)"

shared_main="$tauri_wasix/src/../../../native/tauri/src/main.ts"
shared_styles="$tauri_wasix/src/../../../native/tauri/src/styles.css"
cmp "$root/src/examples/native/tauri/src/main.ts" "$shared_main" >/dev/null ||
  fail "tauri-wasix scratch tree is missing its shared TypeScript source"
cmp "$root/src/examples/native/tauri/src/styles.css" "$shared_styles" >/dev/null ||
  fail "tauri-wasix scratch tree is missing its shared stylesheet"

icon_relative='../../../assets/tauri-icon.png'
for app in "$tauri" "$tauri_wasix"; do
  icon="$app/src-tauri/$icon_relative"
  [[ -f "$icon" ]] || fail "$(basename "$app") scratch tree is missing its configured icon"
  cmp "$root/src/examples/assets/tauri-icon.png" "$icon" >/dev/null ||
    fail "$(basename "$app") scratch icon differs from its declared source"
done

if src/examples/tools/stage-tauri-webdriver-app.sh "$scratch" "$scratch/outside-source" >/dev/null 2>&1; then
  fail "stager accepted a source outside src/examples/"
fi

echo "Tauri webdriver clean-scratch staging passed"
