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
. "$root/tools/test/cargo-test-filter.sh"

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
    # Full evidence enables every catalogued extension plus the tool features
    # needed by the separate extension and logical dump/restore proofs below.
    cargo test -p oliphaunt-wasix --locked --no-default-features \
      --features "$full_evidence_features" "$@"
  else
    cargo test -p oliphaunt-wasix --locked --no-default-features "$@"
  fi
}

oliphaunt_wasix_counted_library_tests() {
  local expected="$1"
  local filter="$2"
  local command=(oliphaunt_wasix_cargo_test --lib "$filter")
  oliphaunt_assert_cargo_test_filter_count "$expected" "$filter" "${command[@]}"
  "${command[@]}" -- --nocapture --test-threads=1
}

cargo run -p xtask -- assets install-local --target-triple "$host"
if [ "$mode" = "core-smoke" ]; then
  # Validate the installed AOT manifest against the asset set that actually
  # produced it, then narrow only the smoke workload. A full manifest still
  # contains the split pg_dump/psql tools even when this run skips their tests.
  export OLIPHAUNT_WASM_SKIP_EXTENSIONS_FOR_PERF=1
fi
export OLIPHAUNT_WASIX_GENERATED_ASSETS_DIR="$root/target/oliphaunt-wasix/assets"
export OLIPHAUNT_WASM_GENERATED_AOT_DIR="$root/target/oliphaunt-wasix/aot"
export RUST_BACKTRACE="${RUST_BACKTRACE:-full}"

oliphaunt_wasix_cargo_test \
  --test runtime_smoke \
  --test proxy_smoke \
  --test cli_smoke \
  --test extensions_smoke \
  --test postgres_regression \
  -- --nocapture --test-threads=1
if [ "$asset_mode" = "full" ]; then
  # The three exhaustive tests cover every catalogued extension through direct,
  # restart, server, and materialization paths. Logical dump/restore is a
  # separate shared-fixture proof below; it does not claim every extension.
  oliphaunt_wasix_counted_library_tests 3 extension_tests::public_extensions
  if [ "$mode" = "regression" ]; then
    oliphaunt_wasix_cargo_test --test client_compat -- --nocapture --test-threads=1
  fi
  tools_filter="oliphaunt::tools::tests::public_tools_round_trip_shared_logical_fixture"
  tools_command=(oliphaunt_wasix_cargo_test --lib "$tools_filter")
  oliphaunt_assert_cargo_test_filter_count 1 "$tools_filter" "${tools_command[@]}"
  "${tools_command[@]}" -- --exact --nocapture --test-threads=1
else
  echo "core-only WASIX assets detected; skipping extension and frontend-tool smoke tests"
fi
