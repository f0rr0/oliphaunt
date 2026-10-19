#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"

iterations="${WASIX_INITDB_STRESS_ITERATIONS:-20}"
label="${WASIX_INITDB_STRESS_LABEL:-wasix-initdb-stress}"

usage() {
  cat <<'USAGE'
Usage: stress-wasix-initdb.sh [--iterations N] [--label NAME]

Repeatedly creates a clean PostgreSQL cluster under the patched WASIX runtime.
Every iteration must pass and produce a log without lifecycle/runtime warnings.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --iterations)
      [ "$#" -ge 2 ] || { echo '--iterations requires a value' >&2; exit 2; }
      iterations="$2"
      shift 2
      ;;
    --label)
      [ "$#" -ge 2 ] || { echo '--label requires a value' >&2; exit 2; }
      label="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case "$iterations" in ''|*[!0-9]*|0) echo '--iterations requires a positive integer' >&2; exit 2 ;; esac
case "$label" in ''|[!A-Za-z0-9]*|*[!A-Za-z0-9._-]*) echo '--label must start with a letter or number and contain only safe characters' >&2; exit 2 ;; esac

fresh_ensure_dirs
wasmer_bin="$(fresh_wasmer_bin)"
stress_report_dir="$REPORT_DIR/$label"
stress_run_dir="$RUN_DIR/$label"
summary="$stress_report_dir/summary.md"
forbidden='WARNING|ERROR|FATAL|PANIC|proc_join failed|uninitialized element|signal handler runtime error'

mkdir -p "$stress_report_dir/iterations" "$stress_run_dir/iterations"

for ((iteration = 1; iteration <= iterations; iteration++)); do
  iteration_report="$stress_report_dir/iterations/$iteration"
  iteration_run="$stress_run_dir/iterations/$iteration"

  REPORT_DIR="$iteration_report" \
    RUN_DIR="$iteration_run" \
    WASIX_SKIP_PREWARM=1 \
    "$FRESH_ROOT/bin/smoke-wasix-core.sh"

  if grep -En "$forbidden" "$iteration_report/wasix-initdb.log"; then
    printf 'initdb stress iteration %s produced a forbidden runtime warning\n' "$iteration" >&2
    exit 1
  fi
done

{
  printf '# WASIX initdb lifecycle stress\n\n'
  printf -- '- Generated: `%s`\n' "$(fresh_timestamp)"
  printf -- '- Iterations: `%s`\n' "$iterations"
  printf -- '- Passed: `%s`\n' "$iterations"
  printf -- '- Clean logs: `%s`\n' "$iterations"
  printf -- '- Wasmer binary: `%s`\n' "$wasmer_bin"
  printf -- '- Wasmer SHA-256: `%s`\n' "$(fresh_wasmer_bin_hash "$wasmer_bin")"
  printf -- '- Exact libc sysroot: `%s`\n' "$WASIXCC_SYSROOT"
  printf -- '- Result: `pass`\n'
} >"$summary"

printf 'passed: %s/%s clean WASIX initdb iterations; see %s\n' "$iterations" "$iterations" "$summary"
