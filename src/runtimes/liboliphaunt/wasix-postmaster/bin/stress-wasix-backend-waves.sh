#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"

attempts="${WASIX_BACKEND_WAVE_ATTEMPTS:-10}"
client_iterations="${WASIX_BACKEND_WAVE_ITERATIONS:-100000}"
timeout_seconds="${WASIX_BACKEND_WAVE_TIMEOUT:-30}"
start_port="${PGPORT:-55820}"
wait_sample_interval="${WASIX_BACKEND_WAVE_WAIT_SAMPLE_INTERVAL:-0}"
memory_map_snapshots="${WASIX_BACKEND_WAVE_MEMORY_MAP_SNAPSHOTS:-0}"
label="${WASIX_BACKEND_WAVE_LABEL:-backend-wave-$(date -u +%Y%m%dT%H%M%SZ)}"
wasmer_args=()

usage() {
  cat <<'USAGE'
Usage: stress-wasix-backend-waves.sh [options]

Repeat the sustained read -> mixed-write -> indexed-update sequence in one
WASIX postmaster per attempt. This targets nondeterministic logical-backend,
WAL-wakeup, and wait-registration liveness failures. The first failed attempt
stops the gate while preserving its PGDATA, logs, resource samples, and client
statuses below target/oliphaunt-wasix-postmaster/.

Options:
  --attempts N              Number of fresh-postmaster attempts. Default: 10.
  --iterations N            Operations per client/workload. Default: 100000.
  --timeout SECONDS         Per phase/client timeout. Default: 30.
  --start-port PORT         PostgreSQL port. Default: PGPORT or 55820.
  --wait-sample-interval S  pg_stat_activity sample interval; 0 disables it.
  --memory-map-snapshots    Capture pmap/vmmap at workload boundaries.
  --wasmer-arg ARG          Extra Wasmer run argument. May repeat.
  --label NAME              Unique report label. Default: timestamped.
  -h, --help                Show this help.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --attempts)
      [ "$#" -ge 2 ] || { echo '--attempts requires a value' >&2; exit 2; }
      attempts="$2"
      shift 2
      ;;
    --iterations)
      [ "$#" -ge 2 ] || { echo '--iterations requires a value' >&2; exit 2; }
      client_iterations="$2"
      shift 2
      ;;
    --timeout)
      [ "$#" -ge 2 ] || { echo '--timeout requires a value' >&2; exit 2; }
      timeout_seconds="$2"
      shift 2
      ;;
    --start-port)
      [ "$#" -ge 2 ] || { echo '--start-port requires a value' >&2; exit 2; }
      start_port="$2"
      shift 2
      ;;
    --wait-sample-interval)
      [ "$#" -ge 2 ] || { echo '--wait-sample-interval requires a value' >&2; exit 2; }
      wait_sample_interval="$2"
      shift 2
      ;;
    --memory-map-snapshots)
      memory_map_snapshots=1
      shift
      ;;
    --wasmer-arg)
      [ "$#" -ge 2 ] || { echo '--wasmer-arg requires a value' >&2; exit 2; }
      wasmer_args+=("$2")
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

case "$attempts" in ''|*[!0-9]*|0) echo '--attempts requires a positive integer' >&2; exit 2 ;; esac
case "$client_iterations" in ''|*[!0-9]*|0) echo '--iterations requires a positive integer' >&2; exit 2 ;; esac
case "$timeout_seconds" in ''|*[!0-9]*|0) echo '--timeout requires a positive integer' >&2; exit 2 ;; esac
case "$start_port" in ''|*[!0-9]*|0) echo '--start-port requires a port from 1 through 65535' >&2; exit 2 ;; esac
[ "$start_port" -le 65535 ] || { echo '--start-port requires a port from 1 through 65535' >&2; exit 2; }
awk -v value="$wait_sample_interval" 'BEGIN {
  exit !(value ~ /^([0-9]+([.][0-9]*)?|[.][0-9]+)$/ && value + 0 >= 0)
}' || { echo '--wait-sample-interval requires a non-negative number' >&2; exit 2; }
case "$label" in ''|[!A-Za-z0-9]*|*[!A-Za-z0-9._-]*) echo '--label must start with a letter or number and contain only safe characters' >&2; exit 2 ;; esac
case "$memory_map_snapshots" in 0|1) ;; *) echo 'memory-map snapshots must be 0 or 1' >&2; exit 2 ;; esac

fresh_ensure_dirs
stress_report_dir="$REPORT_DIR/backend-wave-stress/$label"
summary="$stress_report_dir/summary.md"
attempts_tsv="$stress_report_dir/attempts.tsv"
[ ! -e "$stress_report_dir" ] || {
  printf 'refusing to overwrite backend-wave evidence: %s\n' "$stress_report_dir" >&2
  exit 2
}
mkdir -p "$stress_report_dir"
printf 'attempt\tstatus\treport\n' >"$attempts_tsv"

write_summary() {
  local result="$1"
  local passed="$2"
  local failed_attempt="${3:-}"

  {
    printf '# WASIX backend-wave liveness stress\n\n'
    printf -- '- Generated: `%s`\n' "$(fresh_timestamp)"
    printf -- '- Result: `%s`\n' "$result"
    printf -- '- Attempts requested: `%s`\n' "$attempts"
    printf -- '- Attempts passed: `%s`\n' "$passed"
    printf -- '- First failed attempt: `%s`\n' "${failed_attempt:-none}"
    printf -- '- Connections: `4`\n'
    printf -- '- Client iterations: `%s`\n' "$client_iterations"
    printf -- '- Workload sequence: `indexed-read mixed-write indexed-update`\n'
    printf -- '- Per-phase timeout: `%s seconds`\n' "$timeout_seconds"
    printf -- '- pg_stat_activity sample interval: `%s seconds`\n' "$wait_sample_interval"
    printf -- '- pg_stat_activity sampler: `persistent-connection`\n'
    printf -- '- Memory-map snapshots: `%s`\n' "$memory_map_snapshots"
    if [ "${#wasmer_args[@]}" -eq 0 ]; then
      printf -- '- Extra Wasmer run arguments: `none`\n'
    else
      printf -- '- Extra Wasmer run arguments: `%s`\n' "${wasmer_args[*]}"
    fi
    printf -- '- Wasmer SHA-256: `%s`\n' "$(fresh_wasmer_bin_hash "$(fresh_wasmer_bin)")"
    printf -- '- Attempt index: `%s`\n' "$attempts_tsv"
  } >"$summary"
}

for ((attempt = 1; attempt <= attempts; attempt++)); do
  attempt_label="$label-attempt-$attempt"
  command=(
    "$FRESH_ROOT/bin/bench-wasix-concurrent-query-suite.sh"
    --connections 4
    --iterations "$client_iterations"
    --rows 100000
    --workloads 'indexed-read mixed-write indexed-update'
    --skip-native
    --skip-build
    --skip-precompile
    --timeout "$timeout_seconds"
    --resource-interval 0.2
    --pg-wait-sample-interval "$wait_sample_interval"
    --postgres-guc log_lock_waits=on
    --postgres-guc deadlock_timeout=100ms
    --start-port "$start_port"
    --label "$attempt_label"
  )
  [ "$memory_map_snapshots" -eq 0 ] || command+=(--memory-map-snapshots)
  for wasmer_arg in "${wasmer_args[@]}"; do
    command+=(--wasmer-arg "$wasmer_arg")
  done

  set +e
  "${command[@]}"
  status=$?
  set -e
  report="$REPORT_DIR/concurrent-query-suite/$attempt_label/summary.md"
  printf '%s\t%s\t%s\n' "$attempt" "$status" "$report" >>"$attempts_tsv"
  if [ "$status" -ne 0 ]; then
    write_summary fail $((attempt - 1)) "$attempt"
    printf 'failed backend-wave attempt %s/%s; preserved evidence at %s\n' \
      "$attempt" "$attempts" "$report" >&2
    exit "$status"
  fi
done

write_summary pass "$attempts"
printf 'passed: %s/%s backend-wave attempts; see %s\n' "$attempts" "$attempts" "$summary"
