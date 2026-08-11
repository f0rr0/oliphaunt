#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bench="$root/bin/bench-wasix-concurrent-query-suite.sh"
validator="$root/bin/validate-wasix-lifecycle-memory-plateau.py"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-lifecycle-memory.XXXXXX")"
trap 'rm -rf -- "$tmp"' EXIT

expect_usage_failure() {
  local label="$1"
  shift
  set +e
  "$bench" "$@" >"$tmp/$label.log" 2>&1
  local status=$?
  set -e
  if [ "$status" -ne 2 ]; then
    printf '%s: expected usage exit 2, got %s\n' "$label" "$status" >&2
    sed -n '1,100p' "$tmp/$label.log" >&2
    exit 1
  fi
}

help_output="$("$bench" --help)"
grep -Fq -- '--wasix-lifecycle-memory-checkpoint-every N' <<<"$help_output"
grep -Fq -- '--max-lifecycle-pss-anon-growth-kib N' <<<"$help_output"
grep -Fq -- '--max-lifecycle-late-pss-slope-kib-per-1000 N' <<<"$help_output"

common_memory_args=(
  --wasix-lifecycle-memory-checkpoint-every 16
  --max-lifecycle-pss-growth-kib 1024
  --max-lifecycle-pss-anon-growth-kib 1024
  --max-lifecycle-heap-growth-kib 1024
  --max-lifecycle-late-pss-slope-kib-per-1000 1024
  --max-lifecycle-late-pss-anon-slope-kib-per-1000 1024
  --max-lifecycle-late-heap-slope-kib-per-1000 1024
)
expect_usage_failure without-lifecycle "${common_memory_args[@]}"
expect_usage_failure incomplete-budgets \
  --wasix-lifecycle-plateau \
  --wasix-lifecycle-memory-checkpoint-every 16 \
  --max-lifecycle-pss-growth-kib 1024
expect_usage_failure interval-not-smaller \
  --wasix-lifecycle-plateau \
  --wasix-lifecycle-reconnects 16 \
  "${common_memory_args[@]}"
expect_usage_failure budgets-without-checkpoints \
  --max-lifecycle-pss-growth-kib 1024 \
  --max-lifecycle-pss-anon-growth-kib 1024 \
  --max-lifecycle-heap-growth-kib 1024 \
  --max-lifecycle-late-pss-slope-kib-per-1000 1024 \
  --max-lifecycle-late-pss-anon-slope-kib-per-1000 1024 \
  --max-lifecycle-late-heap-slope-kib-per-1000 1024

sed -n '/^initialize_lifecycle_memory_checkpoints()/,/^run_wasix_lifecycle_plateau()/p' \
  "$bench" | sed '$d' >"$tmp/checkpoint-functions.sh"
# shellcheck source=/dev/null
source "$root/lib/process-supervision.sh"
# shellcheck source=/dev/null
source "$tmp/checkpoint-functions.sh"

now_ns() {
  perl -MTime::HiRes=clock_gettime,CLOCK_MONOTONIC \
    -e 'printf "%.0f\n", clock_gettime(CLOCK_MONOTONIC) * 1000000000'
}

# Referenced by the dynamically extracted capture function.
# shellcheck disable=SC2034
wasix_lifecycle_reconnects=100
# shellcheck disable=SC2034
wasix_lifecycle_memory_checkpoint_every=25
raw="$tmp/checkpoints.tsv"
result="$tmp/result.tsv"
runtime_plateau="$tmp/runtime-plateau.tsv"
nonce=0123456789abcdef0123456789abcdef
server_pid="$$"
server_birth_identity="$(fresh_process_birth_identity "$server_pid")"
initialize_lifecycle_memory_checkpoints "$raw"

sequence=0
for completed in 0 25 50 75 100; do
  if [ "$completed" -eq 0 ]; then
    stage=baseline-fenced
  elif [ "$completed" -eq 100 ]; then
    stage=final-fenced
  else
    stage=wave-quiescent
  fi
  quiescence_start_ns="$(now_ns)"
  sleep 0.01
  quiescence_end_ns="$(now_ns)"
  capture_lifecycle_memory_checkpoint "$raw" "$nonce" "$sequence" "$stage" \
    "$completed" "$server_pid" "$server_birth_identity" 0.01 \
    "$quiescence_start_ns" "$quiescence_end_ns"
  sequence=$((sequence + 1))
done

python3 - "$raw" "$runtime_plateau" "$nonce" <<'PY'
import csv
from pathlib import Path
import sys

with Path(sys.argv[1]).open(encoding="utf-8", newline="") as stream:
    rows = list(csv.DictReader(stream, delimiter="\t"))
header = (
    "schema_version\ttarget\tstatus\tnonce\tevidence_sha256\t"
    "freeze_receipt_sha256\treconnect_requested\treconnect_completed\t"
    "reconnect_start_mono_ns\treconnect_end_mono_ns\t"
    "readiness_fence_mono_ns\tpost_quiescence_fence_mono_ns\n"
)
row = (
    f"6\twasix\tpassed\t{sys.argv[3]}\t{'1' * 64}\t{'2' * 64}\t100\t100\t"
    f"{int(rows[0]['monotonic_after_ns']) + 1}\t"
    f"{int(rows[-1]['quiescence_start_ns']) - 1}\t"
    f"{rows[0]['quiescence_end_ns']}\t{rows[-1]['quiescence_end_ns']}\n"
)
Path(sys.argv[2]).write_text(header + row, encoding="utf-8")
PY

python3 "$validator" \
  --input "$raw" \
  --runtime-plateau "$runtime_plateau" \
  --output "$result" \
  --nonce "$nonce" \
  --server-pid "$server_pid" \
  --requested-reconnects 100 \
  --checkpoint-every 25 \
  --min-quiescence-seconds 0.005 \
  --max-pss-growth-kib 1048576 \
  --max-pss-anon-growth-kib 1048576 \
  --max-heap-growth-kib 1048576 \
  --max-late-pss-slope-kib-per-1000-reconnects 1048576 \
  --max-late-pss-anon-slope-kib-per-1000-reconnects 1048576 \
  --max-late-heap-slope-kib-per-1000-reconnects 1048576

awk -F '\t' '
  NR == 1 {
    for (column = 1; column <= NF; column++) field[$column] = column
    next
  }
  NR == 2 {
    if ($(field["status"]) != "passed" ||
        $(field["checkpoint_count"]) != 5 ||
        $(field["server_birth_identity"]) !~ /^linux-starttime:[1-9][0-9]*$/ ||
        $(field["input_sha256"]) !~ /^[0-9a-f]{64}$/ ||
        $(field["validator_sha256"]) !~ /^[0-9a-f]{64}$/) exit 1
    valid = 1
  }
  END { exit !valid }
' "$result"

printf 'passed: opt-in quiescent lifecycle PSS/anonymous/heap checkpoints\n'
