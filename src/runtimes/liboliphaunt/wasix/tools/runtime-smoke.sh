#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
root="$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null)" || {
  echo "unable to determine repository root from $script_dir; run this script from a Git checkout" >&2
  exit 1
}
[ -f "$root/package.json" ] && [ -d "$root/src/runtimes/liboliphaunt/wasix" ] || {
  echo "must run inside the Oliphaunt workspace" >&2
  exit 1
}
cd "$root"

. "$root/tools/runtime/preflight.sh"

mode="${1:-smoke}"
case "$mode" in
  smoke|regression|core-smoke)
    ;;
  *)
    echo "usage: src/runtimes/liboliphaunt/wasix/tools/runtime-smoke.sh [smoke|regression|core-smoke]" >&2
    exit 2
    ;;
esac

host="$(oliphaunt_runtime_wasm_host_triple)"
preflight_mode="$mode"
if [ "$mode" = "core-smoke" ]; then
  preflight_mode="smoke"
fi
oliphaunt_runtime_wasm_require "$preflight_mode"
if [ "$mode" = "core-smoke" ]; then
  export OLIPHAUNT_RUNTIME_WASM_ASSET_MODE="core"
  export OLIPHAUNT_WASM_SKIP_EXTENSIONS_FOR_PERF=1
fi
asset_mode="$OLIPHAUNT_RUNTIME_WASM_ASSET_MODE"
full_evidence_features=""
if [ "$asset_mode" = "full" ]; then
  full_evidence_features="$(
    tools/dev/bun.sh tools/release/wasix-extension-features.mjs \
      "$root/target/oliphaunt-wasix/assets/manifest.json"
  )"
fi

oliphaunt_wasix_cargo_test() {
  if [ "$asset_mode" = "full" ]; then
    # The public extension evidence contract includes pg_dump/restore.  Keep the
    # tools feature and every promoted extension feature enabled whenever the
    # full extension asset set is under test.
    cargo test -p oliphaunt-wasix --locked --no-default-features \
      --features "$full_evidence_features" "$@"
  else
    cargo test -p oliphaunt-wasix --locked --no-default-features "$@"
  fi
}

cargo run -p xtask -- assets install-local --target-triple "$host"
export OLIPHAUNT_WASM_GENERATED_ASSETS_DIR="$root/target/oliphaunt-wasix/assets"
export OLIPHAUNT_WASM_GENERATED_AOT_DIR="$root/target/oliphaunt-wasix/aot"
export RUST_BACKTRACE="${RUST_BACKTRACE:-full}"

oliphaunt_wasix_cargo_test \
  --test runtime_smoke \
  --test proxy_smoke \
  --test cli_smoke \
  --test extensions_smoke \
  --test performance_smoke \
  --test postgres_regression \
  -- --nocapture --test-threads=1
if [ "$asset_mode" = "full" ]; then
  # These library tests iterate every promoted extension through direct,
  # server, restart, materialization, and dump/restore paths.  Do not replace
  # this with a small representative integration-test subset: the evidence
  # matrix makes product-by-product claims.
  oliphaunt_wasix_cargo_test \
    --lib candidate_tests::public_extensions \
    -- --nocapture --test-threads=1
  if [ "$mode" = "regression" ]; then
    oliphaunt_wasix_cargo_test --test client_compat -- --nocapture --test-threads=1
  fi
  oliphaunt_wasix_cargo_test --lib pg_dump -- --nocapture
else
  echo "core-only WASIX assets detected; skipping extension and pg_dump smoke tests"
fi
