#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

fail() {
  echo "run-electron-driver-smoke.sh: $*" >&2
  exit 1
}

app_dir="${1:-}"
if [ -z "$app_dir" ]; then
  fail "usage: examples/tools/run-electron-driver-smoke.sh <electron-example-dir>"
fi
if [ ! -f "$app_dir/package.json" ] || [ ! -f "$app_dir/src/main-process.ts" ]; then
  fail "$app_dir does not look like an Electron example directory"
fi

command -v node >/dev/null 2>&1 || fail "missing node"
command -v pnpm >/dev/null 2>&1 || fail "missing pnpm"

assert_npm_package() {
  local package_name="$1"
  local expected_version="$2"
  examples/tools/with-local-registries.sh pnpm --dir "$app_dir" exec node - "$package_name" "$expected_version" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const [packageName, expectedVersion] = process.argv.slice(2);
const packageJson = require.resolve(`${packageName}/package.json`);
const data = JSON.parse(fs.readFileSync(packageJson, 'utf8'));
if (data.version !== expectedVersion) {
  throw new Error(`${packageName} resolved version ${data.version}, expected ${expectedVersion}`);
}
const normalized = packageJson.split(path.sep).join('/');
if (!normalized.includes('/node_modules/')) {
  throw new Error(`${packageName} resolved outside node_modules: ${packageJson}`);
}
NODE
}

electron="$root/node_modules/electron/dist/electron"
if [ ! -x "$electron" ]; then
  fail "missing Electron executable at $electron; run pnpm install"
fi

examples/tools/with-local-registries.sh pnpm --filter "./$app_dir" install --no-frozen-lockfile
if [ "$app_dir" = "examples/electron" ]; then
  assert_npm_package "@oliphaunt/ts" "0.1.0"
  assert_npm_package "@oliphaunt/liboliphaunt-linux-x64-gnu" "0.1.0"
  assert_npm_package "@oliphaunt/tools-linux-x64-gnu" "0.1.0"
  assert_npm_package "@oliphaunt/extension-hstore" "0.1.0"
fi
examples/tools/with-local-registries.sh pnpm --dir "$app_dir" build

run_smoke=(
  env
  "OLIPHAUNT_E2E_ELECTRON=$electron"
  "OLIPHAUNT_E2E_ELECTRON_APP=$root/$app_dir"
  examples/tools/with-local-registries.sh
  node
  "$root/examples/tools/electron-driver-smoke.mjs"
)

if command -v xvfb-run >/dev/null 2>&1; then
  xvfb-run -a "${run_smoke[@]}"
else
  "${run_smoke[@]}"
fi
