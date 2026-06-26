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

allowed_root_examples='^(examples/moon\.yml|examples/README\.md|examples/tools/[^/]+|examples/(tauri|tauri-wasix|electron|electron-wasix)(/.*)?)$'
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

require_wasix_tools_smoke() {
  local path="$1"
  require_text "$path" 'preflight_tools\(\)'
  require_text "$path" 'dump_sql'
  require_text "$path" 'psql\(|PsqlOptions::new\(\)'
}

reject_text() {
  local path="$1"
  local pattern="$2"
  if grep -Eq "$pattern" "$path"; then
    echo "forbidden example local dependency pattern in $path: $pattern" >&2
    exit 1
  fi
}

reject_file() {
  local path="$1"
  if [[ -e "$path" ]]; then
    echo "forbidden stale example file: $path" >&2
    exit 1
  fi
}

require_file "src/bindings/wasix-rust/examples/tauri-sqlx-vanilla/package.json"
require_file "src/bindings/wasix-rust/examples/tauri-sqlx-vanilla/src-tauri/Cargo.toml"
require_text "src/bindings/wasix-rust/moon.yml" '^  example-check:$'
require_text "src/bindings/wasix-rust/moon.yml" 'tags: \["examples", "quality", "ci-wasm-regression"\]'
require_text "src/bindings/wasix-rust/tools/check-examples.sh" 'examples/tools/with-local-registries\.sh bash "\$0"'
require_text "src/bindings/wasix-rust/tools/check-examples.sh" 'PNPM_CONFIG_LOCKFILE'

require_file "examples/tools/with-local-registries.sh"
require_text "examples/tools/with-local-registries.sh" 'export CARGO_HOME="\$cargo_home"'
require_file "examples/tools/run-tauri-webdriver-smoke.sh"
require_file "examples/tools/tauri-webdriver-smoke.mjs"
require_file "examples/tools/run-electron-driver-smoke.sh"
require_file "examples/tools/electron-driver-smoke.mjs"
require_file "examples/tools/electron-test-driver.mjs"
require_text "examples/tools/run-tauri-webdriver-smoke.sh" 'cargo install tauri-driver --locked --version 2\.0\.6'
require_text "examples/tools/tauri-webdriver-smoke.mjs" 'tauri webdriver todo smoke passed'
require_text "examples/tools/electron-driver-smoke.mjs" 'electron driver todo smoke passed'
require_text "examples/tools/electron-test-driver.mjs" 'installElectronTodoTestDriver'
for example in tauri tauri-wasix electron electron-wasix; do
  require_file "examples/$example/package.json"
  require_file "examples/$example/README.md"
  require_file "examples/$example/.npmrc"
  require_text "examples/$example/.npmrc" '^registry=http://127\.0\.0\.1:4873/$'
  require_text "examples/$example/.npmrc" '^link-workspace-packages=false$'
  require_text "examples/$example/.npmrc" '^prefer-workspace-packages=false$'
done
require_file "examples/tauri/src-tauri/Cargo.toml"
require_file "examples/tauri-wasix/src-tauri/Cargo.toml"
require_file "examples/electron-wasix/src-wasix/Cargo.toml"
require_text "examples/electron/package.json" '"@oliphaunt/ts": "0\.1\.0"'
require_text "examples/electron/package.json" '"@oliphaunt/extension-hstore": "0\.1\.0"'
require_text "examples/electron/package.json" '"@oliphaunt/extension-pg-trgm": "0\.1\.0"'
require_text "examples/electron/package.json" '"@oliphaunt/extension-unaccent": "0\.1\.0"'
require_text "examples/electron/package.json" '"pg": "\^8\.16\.3"'
reject_file "examples/electron/src/oliphaunt-kysely.ts"
require_text "examples/tauri/src-tauri/Cargo.toml" 'registry = "oliphaunt-local"'
require_text "examples/tauri/src-tauri/Cargo.toml" 'oliphaunt-tools-linux-x64-gnu'
require_text "examples/tauri/src-tauri/Cargo.toml" 'oliphaunt-extension-hstore-linux-x64-gnu'
require_text "examples/tauri/src-tauri/Cargo.toml" 'oliphaunt-extension-pg-trgm-linux-x64-gnu'
require_text "examples/tauri/src-tauri/Cargo.toml" 'oliphaunt-extension-unaccent-linux-x64-gnu'
require_text "examples/tauri-wasix/src-tauri/Cargo.toml" 'registry = "oliphaunt-local"'
require_text "examples/tauri-wasix/src-tauri/Cargo.toml" '"tools"'
require_text "examples/tauri-wasix/src-tauri/Cargo.toml" 'oliphaunt-wasix-tools'
require_text "examples/tauri-wasix/src-tauri/Cargo.toml" 'liboliphaunt-wasix-aot-x86_64-unknown-linux-gnu'
require_text "examples/tauri-wasix/src-tauri/Cargo.toml" 'oliphaunt-wasix-tools-aot-x86_64-unknown-linux-gnu'
require_text "examples/tauri-wasix/src-tauri/Cargo.lock" 'oliphaunt-extension-hstore-wasix-aot-x86_64-unknown-linux-gnu'
require_text "examples/tauri-wasix/src-tauri/Cargo.lock" 'oliphaunt-extension-pg-trgm-wasix-aot-x86_64-unknown-linux-gnu'
require_text "examples/tauri-wasix/src-tauri/Cargo.lock" 'oliphaunt-extension-unaccent-wasix-aot-x86_64-unknown-linux-gnu'
require_wasix_tools_smoke "examples/tauri-wasix/src-tauri/src/lib.rs"
require_text "examples/electron-wasix/src-wasix/Cargo.toml" 'registry = "oliphaunt-local"'
require_text "examples/electron-wasix/src-wasix/Cargo.toml" '"tools"'
require_text "examples/electron-wasix/src-wasix/Cargo.toml" 'oliphaunt-wasix-tools'
require_text "examples/electron-wasix/src-wasix/Cargo.toml" 'liboliphaunt-wasix-aot-x86_64-unknown-linux-gnu'
require_text "examples/electron-wasix/src-wasix/Cargo.toml" 'oliphaunt-wasix-tools-aot-x86_64-unknown-linux-gnu'
require_text "examples/electron-wasix/src-wasix/Cargo.lock" 'oliphaunt-extension-hstore-wasix-aot-x86_64-unknown-linux-gnu'
require_text "examples/electron-wasix/src-wasix/Cargo.lock" 'oliphaunt-extension-pg-trgm-wasix-aot-x86_64-unknown-linux-gnu'
require_text "examples/electron-wasix/src-wasix/Cargo.lock" 'oliphaunt-extension-unaccent-wasix-aot-x86_64-unknown-linux-gnu'
require_wasix_tools_smoke "examples/electron-wasix/src-wasix/src/main.rs"
require_text "src/bindings/wasix-rust/examples/tauri-sqlx-vanilla/src-tauri/Cargo.toml" 'registry = "oliphaunt-local"'
require_text "src/bindings/wasix-rust/examples/tauri-sqlx-vanilla/src-tauri/Cargo.toml" '"tools"'
require_text "src/bindings/wasix-rust/examples/tauri-sqlx-vanilla/src-tauri/Cargo.toml" 'oliphaunt-wasix-tools'
require_text "src/bindings/wasix-rust/examples/tauri-sqlx-vanilla/src-tauri/Cargo.toml" 'oliphaunt-wasix-tools-aot-x86_64-unknown-linux-gnu'
require_wasix_tools_smoke "src/bindings/wasix-rust/examples/tauri-sqlx-vanilla/src-tauri/src/bench.rs"
reject_text "examples/electron/package.json" '"@oliphaunt/ts": "workspace:\*"'
reject_text "examples/tauri/src-tauri/Cargo.toml" 'path = "../../../src/sdks/rust'
reject_text "examples/tauri-wasix/src-tauri/Cargo.toml" 'path = "../../../src/bindings/wasix-rust'
reject_text "examples/electron-wasix/src-wasix/Cargo.toml" 'path = "../../../src/bindings/wasix-rust'
reject_text "src/bindings/wasix-rust/examples/tauri-sqlx-vanilla/src-tauri/Cargo.toml" 'path = "../../../crates/oliphaunt-wasix"'

require_file "src/sdks/react-native/examples/expo/package.json"
require_file "src/sdks/react-native/examples/expo/maestro/installed-smoke.yaml"
require_text "src/sdks/react-native/moon.yml" '^  mobile-build-android:$'
require_text "src/sdks/react-native/moon.yml" '^  mobile-e2e-android:$'
require_text "src/sdks/react-native/moon.yml" '^  mobile-build-ios:$'
require_text "src/sdks/react-native/moon.yml" '^  mobile-e2e-ios:$'

echo "example ownership and scheduling policy verified"
