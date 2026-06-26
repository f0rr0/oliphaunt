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

electron="$root/node_modules/electron/dist/electron"
if [ ! -x "$electron" ]; then
  fail "missing Electron executable at $electron; run pnpm install"
fi

examples/tools/with-local-registries.sh pnpm --filter "./$app_dir" install --no-frozen-lockfile
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
