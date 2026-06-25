#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

fail() {
  echo "run-tauri-webdriver-smoke.sh: $*" >&2
  exit 1
}

app_dir="${1:-}"
if [ -z "$app_dir" ]; then
  fail "usage: examples/tools/run-tauri-webdriver-smoke.sh <tauri-example-dir>"
fi
if [ ! -f "$app_dir/src-tauri/Cargo.toml" ]; then
  fail "$app_dir does not look like a Tauri example directory"
fi

command -v node >/dev/null 2>&1 || fail "missing node"
command -v pnpm >/dev/null 2>&1 || fail "missing pnpm"
command -v WebKitWebDriver >/dev/null 2>&1 ||
  fail "missing WebKitWebDriver; install webkit2gtk-driver on Debian/Ubuntu"

driver="$root/target/e2e-tools/bin/tauri-driver"
if [ ! -x "$driver" ]; then
  cargo install tauri-driver --locked --version 2.0.6 --root "$root/target/e2e-tools"
fi

examples/tools/with-local-registries.sh pnpm --dir "$app_dir" tauri build --debug

package_name="$(
  awk -F'"' '
    $0 ~ /^\[package\]/ { in_package = 1; next }
    $0 ~ /^\[/ && $0 !~ /^\[package\]/ { in_package = 0 }
    in_package && $1 ~ /^name = / { print $2; exit }
  ' "$app_dir/src-tauri/Cargo.toml"
)"
if [ -z "$package_name" ]; then
  fail "could not read package name from $app_dir/src-tauri/Cargo.toml"
fi
application="$root/$app_dir/src-tauri/target/debug/$package_name"
if [ ! -x "$application" ]; then
  fail "missing built Tauri application: $application"
fi

run_smoke=(
  env
  "OLIPHAUNT_E2E_TAURI_DRIVER=$driver"
  "OLIPHAUNT_E2E_TAURI_APP=$application"
  examples/tools/with-local-registries.sh
  node
  "$root/examples/tools/tauri-webdriver-smoke.mjs"
)

if command -v xvfb-run >/dev/null 2>&1; then
  xvfb-run -a "${run_smoke[@]}"
else
  "${run_smoke[@]}"
fi
