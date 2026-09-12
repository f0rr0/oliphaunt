#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
root="$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null)" || {
  echo "unable to determine repository root from $script_dir; run this script from a Git checkout" >&2
  exit 1
}
[ -f "$root/package.json" ] && [ -d "$root/runtimes/liboliphaunt-wasix" ] || {
  echo "must run inside the Oliphaunt workspace" >&2
  exit 1
}
cd "$root"

. "$root/runtimes/liboliphaunt-wasix/tools/runtime-preflight.sh"
. "$root/runtimes/liboliphaunt-wasix/tools/cargo-test-filter.sh"

mode="${1:-smoke}"
case "$mode" in
  smoke|regression|core-smoke)
    ;;
  *)
    echo "usage: runtimes/liboliphaunt-wasix/tools/runtime-smoke.sh [smoke|regression|core-smoke]" >&2
    exit 2
    ;;
esac

host="$(oliphaunt_runtime_wasm_host_triple)"
preflight_mode="$mode"
if [ "$mode" = "core-smoke" ]; then
  preflight_mode="smoke"
fi
oliphaunt_runtime_wasm_require "$preflight_mode"
asset_mode=core
if [ "$mode" = "regression" ]; then asset_mode=full; fi
full_evidence_features=""
if [ "$asset_mode" = "full" ]; then
  if [ -z "${OLIPHAUNT_WASIX_EXTENSION_ARTIFACT_ROOT:-}" ]; then
    export OLIPHAUNT_WASIX_EXTENSION_ARTIFACT_ROOT="$root/target/wasix-smoke/extension-artifacts"
    OLIPHAUNT_WASIX_GENERATED_ASSET_ROOT="$root/target/extensions/wasix/assets" \
    OLIPHAUNT_WASIX_EXTENSION_AOT_ARTIFACT_ROOT="$root/target/extensions/wasix/aot-artifacts" \
      tools/dev/bun.sh extensions/artifacts/packages/tools/build-extension-ci-artifacts.mts \
        --output-root "$OLIPHAUNT_WASIX_EXTENSION_ARTIFACT_ROOT" \
        --all --family wasix --require-wasix
  fi
  full_evidence_features="$(
    tools/dev/bun.sh runtimes/liboliphaunt-wasix/tools/wasix-extension-features.mts \
      "$root/target/extensions/wasix/assets/manifest.json"
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
export OLIPHAUNT_WASIX_GENERATED_ASSETS_DIR="$root/target/oliphaunt-wasix/assets"
export OLIPHAUNT_WASM_GENERATED_AOT_DIR="$root/target/oliphaunt-wasix/aot"
export RUST_BACKTRACE="${RUST_BACKTRACE:-full}"

oliphaunt_wasix_cargo_test \
  --test runtime_smoke \
  --test extensions_smoke \
  --test postgres_regression \
  -- --nocapture --test-threads=1
if [ "$asset_mode" = "full" ]; then
  # Each extension must pass direct execution, restart, physical backup/restore,
  # server execution and materialization. Tests record only completed modes.
  oliphaunt_wasix_counted_library_tests 3 extension_tests::public_extensions
  tools_filter="oliphaunt::tools::tests::public_tools_round_trip_shared_logical_fixture"
  tools_command=(oliphaunt_wasix_cargo_test --lib "$tools_filter")
  oliphaunt_assert_cargo_test_filter_count 1 "$tools_filter" "${tools_command[@]}"
  "${tools_command[@]}" -- --exact --nocapture --test-threads=1
else
  echo "runtime smoke complete; extension and tools behavior belongs to regression and owner consumer tasks"
fi
