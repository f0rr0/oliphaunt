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

source_app_dir="${1:-}"
if [ -z "$source_app_dir" ]; then
  fail "usage: examples/tools/run-tauri-webdriver-smoke.sh <tauri-example-dir>"
fi
if [[ "$source_app_dir" = /* ]]; then
  source_app_path="$(realpath -m "$source_app_dir")"
else
  source_app_path="$(realpath -m "$root/$source_app_dir")"
fi
case "$source_app_path" in
  "$root"/*) ;;
  *) fail "example path must remain inside the repository: $source_app_dir" ;;
esac
if [ ! -f "$source_app_path/src-tauri/Cargo.toml" ]; then
  fail "$source_app_dir does not look like a Tauri example directory"
fi

command -v node >/dev/null 2>&1 || fail "missing node"
command -v pnpm >/dev/null 2>&1 || fail "missing pnpm"
command -v WebKitWebDriver >/dev/null 2>&1 ||
  fail "missing WebKitWebDriver; install webkit2gtk-driver on Debian/Ubuntu"

driver="$root/target/e2e-tools/bin/tauri-driver"
if [ ! -x "$driver" ]; then
  cargo install tauri-driver --locked --version 2.0.6 --root "$root/target/e2e-tools"
fi

source_app_relative="${source_app_path#"$root"/}"
scratch="$root/target/e2e/tauri-apps/${source_app_relative//\//-}/$$"
trap 'rm -rf "$scratch"' EXIT
rm -rf "$scratch"
app_dir="$(examples/tools/stage-tauri-webdriver-app.sh "$source_app_path" "$scratch")"
rm -f "$app_dir/src-tauri/Cargo.lock"

examples/tools/with-local-registries.sh pnpm --dir "$app_dir" install --no-frozen-lockfile
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
application="$app_dir/src-tauri/target/debug/$package_name"
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
