#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$root" ]; then
  root="$(cd "$script_dir/../../../../.." && pwd -P)"
fi
[ -f "$root/package.json" ] && [ -d "$root/src/runtimes/liboliphaunt/wasix" ] || {
  echo "must run inside the Oliphaunt workspace" >&2
  exit 1
}
cd "$root"

. "$root/tools/runtime/preflight.sh"

mode="${1:-smoke}"
case "$mode" in
  smoke|regression)
    ;;
  *)
    echo "usage: src/runtimes/liboliphaunt/wasix/tools/runtime-smoke.sh [smoke|regression]" >&2
    exit 2
    ;;
esac

host="$(oliphaunt_runtime_wasm_host_triple)"
oliphaunt_runtime_wasm_require "$mode"
asset_mode="$OLIPHAUNT_RUNTIME_WASM_ASSET_MODE"

cargo run -p xtask -- assets install-local --target-triple "$host"
export OLIPHAUNT_WASM_GENERATED_ASSETS_DIR="$root/target/oliphaunt-wasix/assets"
export OLIPHAUNT_WASM_GENERATED_AOT_DIR="$root/target/oliphaunt-wasix/aot"
export RUST_BACKTRACE="${RUST_BACKTRACE:-full}"

cargo test -p oliphaunt-wasix --locked \
  --test runtime_smoke \
  --test proxy_smoke \
  --test cli_smoke \
  --test performance_smoke \
  --test postgres_regression \
  -- --nocapture --test-threads=1
if [ "$asset_mode" = "full" ]; then
  if [ "$mode" = "regression" ]; then
    cargo test -p oliphaunt-wasix --locked --test client_compat -- --nocapture --test-threads=1
  fi
  cargo test -p oliphaunt-wasix --locked --test extensions_smoke -- --nocapture --test-threads=1
  cargo test -p oliphaunt-wasix --locked --lib public_extensions -- --nocapture --test-threads=1
  cargo test -p oliphaunt-wasix --locked --lib pg_dump -- --nocapture
else
  echo "core-only WASIX assets detected; skipping extension and pg_dump smoke tests"
fi
