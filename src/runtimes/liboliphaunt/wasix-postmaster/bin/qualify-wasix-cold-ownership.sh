#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"
source "$FRESH_ROOT/lib/sealed-carrier.sh"
source "$FRESH_ROOT/lib/qualification-identities.sh"

usage() {
  cat <<'USAGE'
Usage: qualify-wasix-cold-ownership.sh --sealed-carrier DIR --immutable-carrier-receipt FILE [options]

Repeat independently initialized WASIX cold postmaster launches. Each block
uses targeted per-file eviction plus a mincore zero-residency proof immediately
before launch, then validates first-query latency and whole-cgroup memory,
dirty/writeback, pressure, and explicitly statused I/O evidence. A delegated
cgroup without io.stat remains valid memory/cold evidence but makes no I/O
first-touch claim. This never writes drop_caches.

Options:
  --sealed-carrier DIR      Compiler-free, read-only carrier. Required.
  --immutable-carrier-receipt FILE
                            External Linux immutable-deployment receipt.
                            Required; the cold lane always enforces direct
                            immutable, zero-write AOT/image activation.
  --blocks N                Independent cold launches. Default: 10; minimum: 5.
  --timeout SECONDS         Initdb/readiness/control timeout. Default: 300.
  --start-port PORT         Reused after verified clean shutdown. Default: 56020.
  --label NAME              Default: UTC timestamp.
  --runtime-footprint ID    Default: embedded-concurrent.
  --durability ID           Default: safe.
  --memory-max SIZE         Default: 256M.
  --memory-high SIZE        Default: 224M.
  --swap-max SIZE           Default: 0.
  --resource-interval S     Full sampler interval. Default: 0.05.
  --max-p95-ms MS           Optional cold spawn-to-first-query p95 ceiling.
  --skip-build              Require the existing native psql client/install.
  --keep-pgdata             Retain successful initialized roots.
  --print-plan              Validate options and print the exact campaign plan.
  -h, --help                Show this help.

The result is bounded, non-release evidence for Linux page-cache ownership. It
makes no aggregate runtime or other-platform claim.
USAGE
}

sealed_carrier=""
immutable_carrier_receipt=""
blocks="${WASIX_COLD_BLOCKS:-10}"
timeout_seconds="${WASIX_COLD_TIMEOUT:-300}"
start_port="${WASIX_COLD_PORT:-56020}"
run_label="${WASIX_COLD_LABEL:-$(date -u +%Y%m%dT%H%M%SZ)}"
runtime_footprint="${WASIX_RUNTIME_FOOTPRINT:-embedded-concurrent}"
durability="${WASIX_DURABILITY_PROFILE:-safe}"
memory_max="${WASIX_COLD_MEMORY_MAX:-256M}"
memory_high="${WASIX_COLD_MEMORY_HIGH:-224M}"
swap_max="${WASIX_COLD_SWAP_MAX:-0}"
resource_interval="${WASIX_COLD_RESOURCE_INTERVAL:-0.05}"
max_p95_ms="${WASIX_COLD_MAX_P95_MS:-}"
skip_build=0
discard_pgdata=1
print_plan=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --sealed-carrier) shift; [ "$#" -gt 0 ] || { echo "--sealed-carrier requires a value" >&2; exit 2; }; sealed_carrier="$1" ;;
    --immutable-carrier-receipt) shift; [ "$#" -gt 0 ] || { echo "--immutable-carrier-receipt requires a value" >&2; exit 2; }; [ -z "$immutable_carrier_receipt" ] || { echo "--immutable-carrier-receipt may only be specified once" >&2; exit 2; }; immutable_carrier_receipt="$1" ;;
    --blocks) shift; [ "$#" -gt 0 ] || { echo "--blocks requires a value" >&2; exit 2; }; blocks="$1" ;;
    --timeout) shift; [ "$#" -gt 0 ] || { echo "--timeout requires a value" >&2; exit 2; }; timeout_seconds="$1" ;;
    --start-port) shift; [ "$#" -gt 0 ] || { echo "--start-port requires a value" >&2; exit 2; }; start_port="$1" ;;
    --label) shift; [ "$#" -gt 0 ] || { echo "--label requires a value" >&2; exit 2; }; run_label="$1" ;;
    --runtime-footprint) shift; [ "$#" -gt 0 ] || { echo "--runtime-footprint requires a value" >&2; exit 2; }; runtime_footprint="$1" ;;
    --durability) shift; [ "$#" -gt 0 ] || { echo "--durability requires a value" >&2; exit 2; }; durability="$1" ;;
    --memory-max) shift; [ "$#" -gt 0 ] || { echo "--memory-max requires a value" >&2; exit 2; }; memory_max="$1" ;;
    --memory-high) shift; [ "$#" -gt 0 ] || { echo "--memory-high requires a value" >&2; exit 2; }; memory_high="$1" ;;
    --swap-max) shift; [ "$#" -gt 0 ] || { echo "--swap-max requires a value" >&2; exit 2; }; swap_max="$1" ;;
    --resource-interval) shift; [ "$#" -gt 0 ] || { echo "--resource-interval requires a value" >&2; exit 2; }; resource_interval="$1" ;;
    --max-p95-ms) shift; [ "$#" -gt 0 ] || { echo "--max-p95-ms requires a value" >&2; exit 2; }; max_p95_ms="$1" ;;
    --skip-build) skip_build=1 ;;
    --keep-pgdata) discard_pgdata=0 ;;
    --print-plan) print_plan=1 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if ! [[ "$blocks" =~ ^[1-9][0-9]*$ ]] || [ "$blocks" -lt 5 ]; then
  echo "--blocks requires an integer of at least 5" >&2
  exit 2
fi
[[ "$timeout_seconds" =~ ^[1-9][0-9]*$ ]] || { echo "--timeout requires a positive integer" >&2; exit 2; }
if ! [[ "$start_port" =~ ^[1-9][0-9]*$ ]] || [ "$start_port" -gt 65535 ]; then
  echo "--start-port requires a port from 1 through 65535" >&2
  exit 2
fi
case "$run_label" in
  ""|[!A-Za-z0-9]*|*[!A-Za-z0-9._-]*)
    echo "--label must start with a letter or number and contain only letters, numbers, '.', '_', and '-'" >&2
    exit 2
    ;;
esac
for value in "$memory_max" "$memory_high" "$swap_max"; do
  [[ "$value" =~ ^[0-9]+([KMGTPE]([i]?B)?)?$ ]] || {
    printf 'invalid cgroup size: %s\n' "$value" >&2
    exit 2
  }
done
awk -v value="$resource_interval" 'BEGIN { exit !(value > 0) }' || {
  echo "--resource-interval requires a positive number" >&2
  exit 2
}
if [ -n "$max_p95_ms" ]; then
  awk -v value="$max_p95_ms" 'BEGIN { exit !(value > 0) }' || {
    echo "--max-p95-ms requires a positive number" >&2
    exit 2
  }
fi
[ "$(uname -s)" = Linux ] || { echo "cold ownership qualification requires Linux" >&2; exit 2; }
[ -r /sys/fs/cgroup/cgroup.controllers ] || { echo "cold ownership qualification requires cgroup v2" >&2; exit 2; }
command -v systemd-run >/dev/null 2>&1 || { echo "cold ownership qualification requires systemd-run" >&2; exit 127; }
[ -n "$sealed_carrier" ] || { echo "--sealed-carrier is required" >&2; exit 2; }
[ -n "$immutable_carrier_receipt" ] || { echo "--immutable-carrier-receipt is required" >&2; exit 2; }
if [ ! -d "$sealed_carrier" ] || [ -L "$sealed_carrier" ]; then
  printf 'sealed carrier must be a non-symlink directory: %s\n' "$sealed_carrier" >&2
  exit 2
fi
sealed_carrier="$(cd "$sealed_carrier" && pwd -P)"
receipt_parent="$(dirname "$immutable_carrier_receipt")"
[ -d "$receipt_parent" ] && [ ! -L "$receipt_parent" ] || {
  printf 'immutable carrier receipt parent must be a non-symlink directory: %s\n' \
    "$receipt_parent" >&2
  exit 2
}
immutable_carrier_receipt="$(cd "$receipt_parent" && pwd -P)/$(basename "$immutable_carrier_receipt")"
[ "$(id -u)" -ne 0 ] || {
  echo 'cold ownership qualification must run unprivileged after deployment' >&2
  exit 2
}
cap_eff="$(awk '$1 == "CapEff:" { print $2 }' /proc/self/status)"
[[ "$cap_eff" =~ ^[0-9a-fA-F]+$ ]] || {
  echo 'could not read exact CapEff for cold immutable qualification' >&2
  exit 2
}
if (( (16#$cap_eff & (1 << 9)) != 0 )); then
  echo 'cold ownership qualification refuses effective CAP_LINUX_IMMUTABLE' >&2
  exit 2
fi

fresh_capture_qualification_carrier_identity "$sealed_carrier"
frozen_carrier_identity="$FRESH_QUALIFICATION_CARRIER_CLOSURE_IDENTITY"
frozen_core_profile="$FRESH_QUALIFICATION_CORE_PROFILE"
frozen_guest_build_recipe_sha256="$FRESH_QUALIFICATION_GUEST_BUILD_RECIPE_SHA256"
"$FRESH_ROOT/bin/verify-immutable-sealed-carrier.sh" \
  --sealed-carrier "$sealed_carrier" \
  --receipt "$immutable_carrier_receipt" --fast
immutable_receipt_sha256="$(fresh_wasmer_bin_hash "$immutable_carrier_receipt")"
read -r immutable_receipt_dev immutable_receipt_ino < <(
  stat -c '%d %i' -- "$immutable_carrier_receipt"
)

printf 'schema_version\toliphaunt.wasix-postmaster.cold-ownership-plan.v2\n'
printf 'classification\tresearch-only-non-release\n'
printf 'blocks\t%s\n' "$blocks"
printf 'carrier\t%s\n' "$sealed_carrier"
printf 'runtime_footprint\t%s\n' "$runtime_footprint"
printf 'durability\t%s\n' "$durability"
printf 'memory_max\t%s\n' "$memory_max"
printf 'memory_high\t%s\n' "$memory_high"
printf 'swap_max\t%s\n' "$swap_max"
printf 'resource_detail\tfull\n'
printf 'resource_interval\t%s\n' "$resource_interval"
printf 'eviction\tper-file-posix-fadvise-dontneed\n'
printf 'residency_proof\tmincore-zero-pages\n'
printf 'global_drop_caches\tforbidden\n'
printf 'require_zero_write_aot\t1\n'
printf 'required_snapshot_mode\tdirect-immutable-inode\n'
printf 'carrier_closure_identity\t%s\n' "$frozen_carrier_identity"
printf 'immutable_receipt_path\t%s\n' "$immutable_carrier_receipt"
printf 'immutable_receipt_sha256\t%s\n' "$immutable_receipt_sha256"
printf 'immutable_receipt_dev\t%s\n' "$immutable_receipt_dev"
printf 'immutable_receipt_ino\t%s\n' "$immutable_receipt_ino"
printf 'core_profile\t%s\n' "$frozen_core_profile"
printf 'guest_build_recipe_sha256\t%s\n' "$frozen_guest_build_recipe_sha256"
printf 'immutable_verification_scope\tcampaign-boundary-full-fast-samples\n'
printf 'max_p95_ms\t%s\n' "${max_p95_ms:-report-only}"
[ "$print_plan" -eq 0 ] || exit 0

qualification_root="$REPORT_DIR/cold-ownership-qualification/$run_label"
qualification_runs="$RUN_DIR/cold-ownership-qualification/$run_label"
fresh_claim_generated_directories "$qualification_root" "$qualification_runs" || {
  printf 'qualification label already exists: %s\n' "$run_label" >&2
  exit 2
}
plan="$qualification_root/qualification-plan.tsv"
sealed_loader_verification="$qualification_root/sealed-loader-verification.tsv"
qualification_result="$qualification_root/qualification-result.tsv"
# The plan was already resolved against the one full campaign-start capture.
{
  printf 'schema_version\toliphaunt.wasix-postmaster.cold-ownership-plan.v2\n'
  printf 'classification\tresearch-only-non-release\n'
  printf 'blocks\t%s\n' "$blocks"
  printf 'carrier\t%s\n' "$sealed_carrier"
  printf 'runtime_footprint\t%s\n' "$runtime_footprint"
  printf 'durability\t%s\n' "$durability"
  printf 'memory_max\t%s\n' "$memory_max"
  printf 'memory_high\t%s\n' "$memory_high"
  printf 'swap_max\t%s\n' "$swap_max"
  printf 'resource_detail\tfull\n'
  printf 'resource_interval\t%s\n' "$resource_interval"
  printf 'eviction\tper-file-posix-fadvise-dontneed\n'
  printf 'residency_proof\tmincore-zero-pages\n'
  printf 'global_drop_caches\tforbidden\n'
  printf 'require_zero_write_aot\t1\n'
  printf 'required_snapshot_mode\tdirect-immutable-inode\n'
  printf 'carrier_closure_identity\t%s\n' "$frozen_carrier_identity"
  printf 'immutable_receipt_path\t%s\n' "$immutable_carrier_receipt"
  printf 'immutable_receipt_sha256\t%s\n' "$immutable_receipt_sha256"
  printf 'immutable_receipt_dev\t%s\n' "$immutable_receipt_dev"
  printf 'immutable_receipt_ino\t%s\n' "$immutable_receipt_ino"
  printf 'core_profile\t%s\n' "$frozen_core_profile"
  printf 'guest_build_recipe_sha256\t%s\n' "$frozen_guest_build_recipe_sha256"
  printf 'immutable_verification_scope\tcampaign-boundary-full-fast-samples\n'
  printf 'max_p95_ms\t%s\n' "${max_p95_ms:-report-only}"
} >"$plan"
plan_identity="$(fresh_wasmer_bin_hash "$plan")"
printf 'block\tpolicy_receipt\tpolicy_sha256\taudit_receipt\taudit_sha256\tvalidation_receipt\tvalidation_sha256\tstatus\n' \
  >"$sealed_loader_verification"

assert_immutable_inputs() {
  local stage="$1" receipt_stat observed_dev observed_ino
  "$FRESH_ROOT/bin/verify-immutable-sealed-carrier.sh" \
    --sealed-carrier "$sealed_carrier" \
    --receipt "$immutable_carrier_receipt" --fast || {
      printf 'sealed carrier identity changed at %s\n' "$stage" >&2
      return 125
    }
  receipt_stat="$(stat -c '%d %i' -- "$immutable_carrier_receipt")" || return
  read -r observed_dev observed_ino <<<"$receipt_stat"
  [ "$observed_dev" = "$immutable_receipt_dev" ] &&
    [ "$observed_ino" = "$immutable_receipt_ino" ] || {
    printf 'immutable deployment receipt inode changed at %s\n' "$stage" >&2
    return 125
  }
  [ "$(fresh_wasmer_bin_hash "$plan")" = "$plan_identity" ] || {
    printf 'cold ownership plan changed at %s\n' "$stage" >&2
    return 125
  }
}

sample_inputs=()
for ((block = 1; block <= blocks; block++)); do
  assert_immutable_inputs "block-$block:before"
  block_root="$qualification_root/blocks/$block"
  block_runs="$qualification_runs/blocks/$block"
  block_label="cold-$block"
  mkdir -p "$block_root" "$block_runs"
  bench_args=(
    --target wasix
    --sealed-carrier "$sealed_carrier"
    --require-zero-write-aot
    --immutable-carrier-receipt "$immutable_carrier_receipt"
    --immutable-carrier-verification-scope campaign-fast
    --cold-ownership
    --connections 1
    --iterations 1
    --rows 1
    --resource-detail full
    --resource-interval "$resource_interval"
    --cgroup-memory-max "$memory_max"
    --cgroup-memory-high "$memory_high"
    --cgroup-swap-max "$swap_max"
    --runtime-footprint "$runtime_footprint"
    --durability "$durability"
    --timeout "$timeout_seconds"
    --start-port "$start_port"
    --label "$block_label"
  )
  [ "$skip_build" -eq 0 ] || bench_args+=(--skip-build)
  [ "$discard_pgdata" -eq 0 ] || bench_args+=(--discard-pgdata)
  env -u WASIX_PERF_WAIT_DUMP_INTERVAL_MS \
    -u WASIX_PERF_WAIT_DUMP_FILE \
    -u WASIX_PERF_WAIT_DUMP_MAX_PER_WAIT \
    -u WASIX_PERF_WAIT_DUMP_VERBOSE \
    -u WASIX_WAIT_DUMP_INTERVAL_MS \
    -u WASIX_WAIT_DUMP_FILE \
    -u WASIX_WAIT_DUMP_MAX_PER_WAIT \
    -u WASIX_WAIT_DUMP_VERBOSE \
    -u WASIX_WAIT_DUMP_FENCE_REQUEST_FILE \
    -u WASIX_WAIT_DUMP_FENCE_ACK_FILE \
    -u OLIPHAUNT_WASIX_REQUIRE_ZERO_WRITE_AOT \
    -u OLIPHAUNT_WASIX_SEALED_LOADER_AUDIT_FILE \
    REPORT_DIR="$block_root" RUN_DIR="$block_runs" \
    "$FRESH_ROOT/bin/bench-wasix-concurrent-query-suite.sh" "${bench_args[@]}"
  sample="$block_root/concurrent-query-suite/$block_label/wasix/cold-ownership-sample.tsv"
  [ -s "$sample" ] || { printf 'cold block produced no sample: %s\n' "$sample" >&2; exit 1; }
  block_report="$block_root/concurrent-query-suite/$block_label"
  loader_policy="$block_report/sealed-loader-policy.tsv"
  loader_audit="$block_report/wasix/sealed-loader-audit.jsonl"
  loader_validation="$block_report/wasix/sealed-loader-audit-validation.tsv"
  if [ ! -f "$loader_policy" ] || [ -L "$loader_policy" ] ||
    [ ! -f "$loader_audit" ] || [ -L "$loader_audit" ] ||
    [ ! -f "$loader_validation" ] || [ -L "$loader_validation" ] ||
    ! awk -F '\t' -v receipt_path="$immutable_carrier_receipt" \
      -v receipt_sha="$immutable_receipt_sha256" \
      -v receipt_dev="$immutable_receipt_dev" \
      -v receipt_ino="$immutable_receipt_ino" \
      -v carrier_identity="$frozen_carrier_identity" \
      'NR == 2 && $1 == "oliphaunt.wasix-postmaster.sealed-loader-policy.v2" && $3 == 1 && $4 == "campaign-fast" && $5 == "direct-immutable-only" && $9 == "direct-immutable-inode" && $15 == receipt_path && $16 == receipt_sha && $17 == receipt_dev && $18 == receipt_ino && $19 == carrier_identity { ok = 1 } END { exit !(NR == 2 && ok) }' \
      "$loader_policy" ||
    ! awk -F '\t' 'NR == 2 && $1 == "oliphaunt.wasix-postmaster.sealed-loader-audit-validation.v3" && $2 == "passed" && $6 == 1 && $7 == 1 && $10 == "direct-immutable-inode" { ok = 1 } END { exit !(NR == 2 && ok) }' \
      "$loader_validation"; then
    printf 'cold block lacks exact direct immutable loader proof: %s\n' "$block" >&2
    exit 1
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\tpassed\n' \
    "$block" "$loader_policy" "$(fresh_wasmer_bin_hash "$loader_policy")" \
    "$loader_audit" "$(fresh_wasmer_bin_hash "$loader_audit")" \
    "$loader_validation" "$(fresh_wasmer_bin_hash "$loader_validation")" \
    >>"$sealed_loader_verification"
  assert_immutable_inputs "block-$block:after"
  sample_inputs+=(--input "$sample")
done

fresh_capture_qualification_carrier_identity "$sealed_carrier" &&
  [ "$FRESH_QUALIFICATION_CARRIER_CLOSURE_IDENTITY" = "$frozen_carrier_identity" ] || {
  echo 'sealed carrier failed the campaign-end full verification' >&2
  exit 125
}

summary="$qualification_root/summary.tsv"
receipt="$qualification_root/qualification-receipt.json"
summary_args=(
  "${sample_inputs[@]}"
  --expected-blocks "$blocks"
  --output "$summary"
  --receipt "$receipt"
)
[ -z "$max_p95_ms" ] || summary_args+=(--max-p95-ms "$max_p95_ms")
python3 "$FRESH_ROOT/bin/summarize-wasix-cold-ownership.py" "${summary_args[@]}"
chmod 0444 "$plan" "$sealed_loader_verification"
printf 'schema_version\tstatus\tcarrier_closure_identity\timmutable_receipt_sha256\timmutable_receipt_dev\timmutable_receipt_ino\tqualification_plan_sha256\tsealed_loader_verification_sha256\tsummary_sha256\tqualification_receipt_sha256\tcore_profile\tguest_build_recipe_sha256\timmutable_verification_scope\n' \
  >"$qualification_result"
printf 'oliphaunt.wasix-postmaster.cold-ownership-result.v2\tpassed\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\tcampaign-boundary-full-fast-samples\n' \
  "$frozen_carrier_identity" "$immutable_receipt_sha256" \
  "$immutable_receipt_dev" "$immutable_receipt_ino" "$plan_identity" \
  "$(fresh_wasmer_bin_hash "$sealed_loader_verification")" \
  "$(fresh_wasmer_bin_hash "$summary")" "$(fresh_wasmer_bin_hash "$receipt")" \
  "$frozen_core_profile" "$frozen_guest_build_recipe_sha256" \
  >>"$qualification_result"
chmod 0444 "$qualification_result"
printf 'cold ownership qualification: %s\n' "$summary"
