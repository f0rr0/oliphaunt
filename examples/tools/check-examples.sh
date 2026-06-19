#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

run() {
  printf '\n==> %s\n' "$*"
  "$@"
}

run examples/tools/check-lockfiles.sh --check

allowed_root_examples='^(examples/moon\.yml|examples/tools/[^/]+)$'
violations="$(
  git ls-files examples | grep -Ev "$allowed_root_examples" || true
)"
if [[ -n "$violations" ]]; then
  echo "root examples/ may contain only cross-product example policy/tooling" >&2
  echo "$violations" >&2
  exit 1
fi

tracked_node_modules="$(
  git ls-files 'examples/**/node_modules/**' 'src/**/examples/**/node_modules/**' || true
)"
if [[ -n "$tracked_node_modules" ]]; then
  echo "example dependencies must not be tracked" >&2
  echo "$tracked_node_modules" >&2
  exit 1
fi

require_file() {
  local path="$1"
  if [[ ! -f "$path" ]]; then
    echo "missing required product-local example file: $path" >&2
    exit 1
  fi
}

require_text() {
  local path="$1"
  local pattern="$2"
  if ! grep -Eq "$pattern" "$path"; then
    echo "missing required example scheduling pattern in $path: $pattern" >&2
    exit 1
  fi
}

require_file "src/bindings/wasix-rust/examples/tauri-sqlx-vanilla/package.json"
require_file "src/bindings/wasix-rust/examples/tauri-sqlx-vanilla/src-tauri/Cargo.toml"
require_text "src/bindings/wasix-rust/moon.yml" '^  example-check:$'
require_text "src/bindings/wasix-rust/moon.yml" 'tags: \["examples", "quality", "ci-wasm-regression"\]'

require_file "src/sdks/react-native/examples/expo/package.json"
require_file "src/sdks/react-native/examples/expo/maestro/installed-smoke.yaml"
require_text "src/sdks/react-native/moon.yml" '^  mobile-build-android:$'
require_text "src/sdks/react-native/moon.yml" '^  mobile-e2e-android:$'
require_text "src/sdks/react-native/moon.yml" '^  mobile-build-ios:$'
require_text "src/sdks/react-native/moon.yml" '^  mobile-e2e-ios:$'

echo "example ownership and scheduling policy verified"
