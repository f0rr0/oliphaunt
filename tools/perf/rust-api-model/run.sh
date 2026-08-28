#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
root="$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null)" || {
  echo "unable to determine the Oliphaunt repository root" >&2
  exit 1
}
cd "$root"

runtime=""
iterations=200
warmup=20
run_id="$(date -u +%Y%m%dT%H%M%SZ)"
output_dir=""

usage() {
  cat >&2 <<'USAGE'
usage: tools/perf/rust-api-model/run.sh --runtime native|wasix [options]

Options:
  --iterations N     Measured calls per operation and API model. Default: 200.
  --warmup N         Warmup calls per operation and API model. Default: 20.
  --run-id ID        Output run identifier. Defaults to the current UTC time.
  --output-dir DIR   Explicit output directory.
  -h, --help         Show this help.

This is a diagnostic-only paired run. It is not release performance evidence.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --runtime)
      runtime="${2:?--runtime requires a value}"
      shift 2
      ;;
    --iterations)
      iterations="${2:?--iterations requires a value}"
      shift 2
      ;;
    --warmup)
      warmup="${2:?--warmup requires a value}"
      shift 2
      ;;
    --run-id)
      run_id="${2:?--run-id requires a value}"
      shift 2
      ;;
    --output-dir)
      output_dir="${2:?--output-dir requires a value}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

case "$runtime" in
  native|wasix)
    ;;
  *)
    echo "--runtime must be native or wasix" >&2
    usage
    exit 2
    ;;
esac
case "$iterations" in
  ''|*[!0-9]*|0)
    echo "--iterations must be a positive integer" >&2
    exit 2
    ;;
esac
case "$warmup" in
  ''|*[!0-9]*|0)
    echo "--warmup must be a positive integer" >&2
    exit 2
    ;;
esac
if [[ -z "$run_id" || "$run_id" == */* || "$run_id" == *..* ]]; then
  echo "--run-id must be a non-empty path segment" >&2
  exit 2
fi

if [[ -z "$output_dir" ]]; then
  output_dir="$root/target/perf/rust-api-model/$runtime-$run_id"
elif [[ "$output_dir" != /* ]]; then
  output_dir="$root/$output_dir"
fi
mkdir -p "$output_dir"
for output in sync.json async.json summary.json report.md; do
  if [[ -e "$output_dir/$output" ]]; then
    echo "refusing to overwrite existing diagnostic output: $output_dir/$output" >&2
    exit 1
  fi
done

# Runtime artifact checks stay outside the measured processes. Cargo output is
# also on stderr, so each redirected stdout file contains only one JSON run.
. "$root/tools/runtime/preflight.sh"
features="rust-api-model"
if [[ "$runtime" == native ]]; then
  oliphaunt_runtime_native_host_require basic
else
  oliphaunt_runtime_wasm_require smoke
  host="$(oliphaunt_runtime_wasm_host_triple)"
  cargo run -p xtask -- assets install-local --target-triple "$host"
  export OLIPHAUNT_WASIX_GENERATED_ASSETS_DIR="$root/target/oliphaunt-wasix/assets"
  export OLIPHAUNT_WASM_GENERATED_AOT_DIR="$root/target/oliphaunt-wasix/aot"
  features="rust-api-model-wasix"
fi

for api in sync async; do
  cargo run --release --locked -p oliphaunt-perf \
    --features "$features" \
    --bin oliphaunt-rust-api-model -- \
    --runtime "$runtime" \
    --api "$api" \
    --iterations "$iterations" \
    --warmup "$warmup" >"$output_dir/$api.json"
done

tools/dev/bun.sh tools/perf/rust-api-model/summarize.mjs \
  --runtime "$runtime" \
  --sync "$output_dir/sync.json" \
  --async "$output_dir/async.json" \
  --output-dir "$output_dir"

printf 'diagnostic-only report: %s\n' "$output_dir/report.md"
