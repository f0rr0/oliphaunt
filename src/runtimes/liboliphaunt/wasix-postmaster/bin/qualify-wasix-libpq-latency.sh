#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"
source "$FRESH_ROOT/lib/sealed-carrier.sh"
source "$FRESH_ROOT/lib/postgres-profiles.sh"
source "$FRESH_ROOT/lib/qualification-identities.sh"

usage() {
  cat <<'USAGE'
Usage: qualify-wasix-libpq-latency.sh --sealed-carrier DIR [options]

Run true-libpq persistent-query and reconnect latency on fresh native and WASIX
servers in alternating ABBA/BAAB blocks.  The comparator re-opens every raw
CLOCK_MONOTONIC sample stream, verifies exact carrier/native/libpq/probe/profile
identities, and gates the p95 of server-pair and server-run tail distributions.

Options:
  --sealed-carrier DIR              Compiler-free carrier. Required.
  --require-zero-write-aot          Require direct immutable AOT/memory
                                    activation and validated loader audit.
  --immutable-carrier-receipt FILE  Exact external Linux immutable-deployment
                                    receipt. Required with the option above.
  --blocks N                        Even count of four-server blocks. Default: 10.
  --samples N                       Measured calls per mode/server. Default: 1000.
  --warmup N                        Warmup calls per mode/server. Default: 100.
  --timeout SECONDS                 Per benchmark operation. Default: 300.
  --start-port PORT                 Reused after verified shutdown. Default: 55920.
  --label NAME                      Default: UTC timestamp.
  --runtime-footprint ID            Default: embedded-concurrent.
  --durability ID                   Default: safe.
  --cgroup-memory-max SIZE          Bind every measured postmaster to a
                                    dedicated systemd user scope with
                                    MemoryMax=SIZE.
  --cgroup-memory-high SIZE         Bind that scope with MemoryHigh=SIZE.
  --cgroup-swap-max SIZE            Bind that scope with MemorySwapMax=SIZE.
                                    All three limits must be configured
                                    together. Defaults are inherited from the
                                    matching WASIX_CGROUP_* variables; an
                                    entirely unset triple disables the scope.
  --max-persistent-p95-ratio R      Default: 2.0.
  --max-persistent-p99-ratio R      Default: 2.5.
  --max-reconnect-p95-ratio R       Default: 3.5.
  --max-reconnect-p99-ratio R       Default: 4.5.
  --max-wasix-persistent-p95-ms N   Default: 0.25 ms.
  --max-wasix-persistent-p99-ms N   Default: 0.40 ms.
  --max-wasix-reconnect-p95-ms N    Default: 20 ms.
  --max-wasix-reconnect-p99-ms N    Default: 30 ms.
  --keep-pgdata                     Retain successful generated clusters.
  -h, --help                        Show this help.

Bounded qualification requires at least 10 blocks, 100 warmups, and 1000 measured
samples per mode/server. Smaller runs remain useful but are classified as
diagnostic. Resource-detail sampling and WASIX perf statistics are always off
in this timed lane; qualify memory independently.
USAGE
}

sealed_carrier=""
blocks="${WASIX_LIBPQ_QUALIFICATION_BLOCKS:-10}"
samples="${WASIX_LIBPQ_QUALIFICATION_SAMPLES:-1000}"
warmup="${WASIX_LIBPQ_QUALIFICATION_WARMUP:-100}"
timeout_seconds="${WASIX_LIBPQ_QUALIFICATION_TIMEOUT:-300}"
start_port="${WASIX_LIBPQ_QUALIFICATION_PORT:-55920}"
run_label="${WASIX_LIBPQ_QUALIFICATION_LABEL:-$(date -u +%Y%m%dT%H%M%SZ)}"
runtime_footprint="${WASIX_RUNTIME_FOOTPRINT:-embedded-concurrent}"
durability_profile="${WASIX_DURABILITY_PROFILE:-safe}"
max_persistent_p95_ratio="${WASIX_LIBPQ_MAX_PERSISTENT_P95_RATIO:-2.0}"
max_persistent_p99_ratio="${WASIX_LIBPQ_MAX_PERSISTENT_P99_RATIO:-2.5}"
max_reconnect_p95_ratio="${WASIX_LIBPQ_MAX_RECONNECT_P95_RATIO:-3.5}"
max_reconnect_p99_ratio="${WASIX_LIBPQ_MAX_RECONNECT_P99_RATIO:-4.5}"
max_wasix_persistent_p95_ms="${WASIX_LIBPQ_MAX_WASIX_PERSISTENT_P95_MS:-0.25}"
max_wasix_persistent_p99_ms="${WASIX_LIBPQ_MAX_WASIX_PERSISTENT_P99_MS:-0.40}"
max_wasix_reconnect_p95_ms="${WASIX_LIBPQ_MAX_WASIX_RECONNECT_P95_MS:-20}"
max_wasix_reconnect_p99_ms="${WASIX_LIBPQ_MAX_WASIX_RECONNECT_P99_MS:-30}"
discard_pgdata=1
require_zero_write_aot=0
immutable_carrier_receipt=""
cgroup_memory_max="${WASIX_CGROUP_MEMORY_MAX:-}"
cgroup_memory_high="${WASIX_CGROUP_MEMORY_HIGH:-}"
cgroup_swap_max="${WASIX_CGROUP_SWAP_MAX:-}"
wait_dump_environment_names=(
  WASIX_PERF_WAIT_DUMP_INTERVAL_MS
  WASIX_PERF_WAIT_DUMP_FILE
  WASIX_PERF_WAIT_DUMP_MAX_PER_WAIT
  WASIX_PERF_WAIT_DUMP_VERBOSE
  WASIX_WAIT_DUMP_INTERVAL_MS
  WASIX_WAIT_DUMP_FILE
  WASIX_WAIT_DUMP_MAX_PER_WAIT
  WASIX_WAIT_DUMP_VERBOSE
  WASIX_WAIT_DUMP_FENCE_REQUEST_FILE
  WASIX_WAIT_DUMP_FENCE_ACK_FILE
)
wait_dump_unset_args=()
for wait_dump_name in "${wait_dump_environment_names[@]}"; do
  wait_dump_unset_args+=(-u "$wait_dump_name")
done
wait_dump_unset_args+=(
  -u OLIPHAUNT_WASIX_REQUIRE_ZERO_WRITE_AOT
  -u OLIPHAUNT_WASIX_SEALED_LOADER_AUDIT_FILE
  -u WASIX_CGROUP_MEMORY_MAX
  -u WASIX_CGROUP_MEMORY_HIGH
  -u WASIX_CGROUP_SWAP_MAX
)
wait_dump_sanitized_environment="$(
  IFS=,
  printf '%s' "${wait_dump_environment_names[*]}"
)"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --sealed-carrier|--immutable-carrier-receipt|--blocks|--samples|--warmup|--timeout|--start-port|--label|--runtime-footprint|--durability|--cgroup-memory-max|--cgroup-memory-high|--cgroup-swap-max|--max-persistent-p95-ratio|--max-persistent-p99-ratio|--max-reconnect-p95-ratio|--max-reconnect-p99-ratio|--max-wasix-persistent-p95-ms|--max-wasix-persistent-p99-ms|--max-wasix-reconnect-p95-ms|--max-wasix-reconnect-p99-ms)
      option="$1"
      shift
      [ "$#" -gt 0 ] || { printf '%s requires a value\n' "$option" >&2; exit 2; }
      case "$option" in
        --sealed-carrier) sealed_carrier="$1" ;;
        --immutable-carrier-receipt)
          [ -z "$immutable_carrier_receipt" ] || {
            echo '--immutable-carrier-receipt may only be specified once' >&2
            exit 2
          }
          immutable_carrier_receipt="$1"
          ;;
        --blocks) blocks="$1" ;;
        --samples) samples="$1" ;;
        --warmup) warmup="$1" ;;
        --timeout) timeout_seconds="$1" ;;
        --start-port) start_port="$1" ;;
        --label) run_label="$1" ;;
        --runtime-footprint) runtime_footprint="$1" ;;
        --durability) durability_profile="$1" ;;
        --cgroup-memory-max) cgroup_memory_max="$1" ;;
        --cgroup-memory-high) cgroup_memory_high="$1" ;;
        --cgroup-swap-max) cgroup_swap_max="$1" ;;
        --max-persistent-p95-ratio) max_persistent_p95_ratio="$1" ;;
        --max-persistent-p99-ratio) max_persistent_p99_ratio="$1" ;;
        --max-reconnect-p95-ratio) max_reconnect_p95_ratio="$1" ;;
        --max-reconnect-p99-ratio) max_reconnect_p99_ratio="$1" ;;
        --max-wasix-persistent-p95-ms) max_wasix_persistent_p95_ms="$1" ;;
        --max-wasix-persistent-p99-ms) max_wasix_persistent_p99_ms="$1" ;;
        --max-wasix-reconnect-p95-ms) max_wasix_reconnect_p95_ms="$1" ;;
        --max-wasix-reconnect-p99-ms) max_wasix_reconnect_p99_ms="$1" ;;
      esac
      ;;
    --keep-pgdata) discard_pgdata=0 ;;
    --require-zero-write-aot)
      [ "$require_zero_write_aot" -eq 0 ] || {
        echo '--require-zero-write-aot may only be specified once' >&2
        exit 2
      }
      require_zero_write_aot=1
      ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

is_positive_integer() { [[ "$1" =~ ^[1-9][0-9]*$ ]]; }
is_nonnegative_integer() { [[ "$1" =~ ^(0|[1-9][0-9]*)$ ]]; }
is_positive_number() {
  [[ "$1" =~ ^([0-9]+([.][0-9]*)?|[.][0-9]+)$ ]] &&
    awk -v value="$1" 'BEGIN { exit !(value > 0) }'
}
validate_cgroup_size() {
  [[ "$1" =~ ^[0-9]+([KMGTPE]([i]?B)?)?$ ]]
}

classify_latency_result() {
  local status="$1"
  local block_count="$2"
  local warmup_count="$3"
  local sample_count="$4"

  if [ "$block_count" -ge 10 ] && [ "$warmup_count" -ge 100 ] &&
    [ "$sample_count" -ge 1000 ]; then
    if [ "$status" -eq 0 ]; then
      printf 'latency-qualified-non-release'
    else
      printf 'failed-latency-qualification-non-release'
    fi
  else
    printf 'latency-diagnostic-non-release'
  fi
}

[ "$(uname -s)" = Linux ] || {
  echo 'true-libpq qualification requires Linux host-FD evidence' >&2
  exit 2
}
[ -n "$sealed_carrier" ] || { echo '--sealed-carrier is required' >&2; exit 2; }
[ -d "$sealed_carrier" ] || { printf 'missing sealed carrier: %s\n' "$sealed_carrier" >&2; exit 2; }
sealed_carrier="$(cd "$sealed_carrier" && pwd -P)"
fresh_capture_qualification_carrier_identity "$sealed_carrier" || {
  printf 'sealed carrier verification failed before qualification: %s\n' "$sealed_carrier" >&2
  exit 1
}
frozen_carrier_identity="$FRESH_QUALIFICATION_CARRIER_CLOSURE_IDENTITY"
frozen_core_profile="$FRESH_QUALIFICATION_CORE_PROFILE"
frozen_guest_build_recipe_sha256="$FRESH_QUALIFICATION_GUEST_BUILD_RECIPE_SHA256"
frozen_carrier_manifest_sha="$FRESH_QUALIFICATION_CARRIER_MANIFEST_SHA256"
frozen_carrier_receipt_sha="$FRESH_QUALIFICATION_CARRIER_RECEIPT_SHA256"
frozen_carrier_payload_sha="$FRESH_QUALIFICATION_CARRIER_PAYLOAD_SHA256"
frozen_carrier_headless_sha="$FRESH_QUALIFICATION_CARRIER_HEADLESS_SHA256"

if [ "$require_zero_write_aot" -eq 1 ]; then
  [ -n "$immutable_carrier_receipt" ] || {
    echo '--require-zero-write-aot requires --immutable-carrier-receipt' >&2
    exit 2
  }
elif [ -n "$immutable_carrier_receipt" ]; then
  echo '--immutable-carrier-receipt requires --require-zero-write-aot' >&2
  exit 2
fi
is_positive_integer "$blocks" && [ $((blocks % 2)) -eq 0 ] || {
  echo '--blocks requires a positive even integer for equal ABBA/BAAB representation' >&2
  exit 2
}
is_positive_integer "$samples" || { echo '--samples requires a positive integer' >&2; exit 2; }
is_nonnegative_integer "$warmup" || { echo '--warmup requires a nonnegative integer' >&2; exit 2; }
is_positive_integer "$timeout_seconds" || { echo '--timeout requires a positive integer' >&2; exit 2; }
if ! is_positive_integer "$start_port" || [ "$start_port" -gt 65535 ]; then
  echo '--start-port requires a port from 1 through 65535' >&2
  exit 2
fi
case "$run_label" in
  ""|[!A-Za-z0-9]*|*[!A-Za-z0-9._-]*)
    echo "--label must start with a letter or number and contain only letters, numbers, '.', '_', and '-'" >&2
    exit 2
    ;;
esac
cgroup_limit_count=0
for cgroup_size in "$cgroup_memory_max" "$cgroup_memory_high" "$cgroup_swap_max"; do
  if [ -n "$cgroup_size" ]; then
    cgroup_limit_count=$((cgroup_limit_count + 1))
    validate_cgroup_size "$cgroup_size" || {
      printf 'invalid cgroup size: %s\n' "$cgroup_size" >&2
      exit 2
    }
  fi
done
case "$cgroup_limit_count" in
  0)
    cgroup_binding=disabled
    cgroup_environment_action=ambient-sanitized-disabled
    ;;
  3)
    command -v systemd-run >/dev/null 2>&1 || {
      echo 'cgroup memory controls require systemd-run' >&2
      exit 127
    }
    cgroup_binding=dedicated-systemd-user-scope
    cgroup_environment_action=ambient-sanitized-explicit-argv
    ;;
  *)
    echo '--cgroup-memory-max, --cgroup-memory-high, and --cgroup-swap-max must be configured together' >&2
    exit 2
    ;;
esac
for threshold in \
  "$max_persistent_p95_ratio" "$max_persistent_p99_ratio" \
  "$max_reconnect_p95_ratio" "$max_reconnect_p99_ratio" \
  "$max_wasix_persistent_p95_ms" "$max_wasix_persistent_p99_ms" \
  "$max_wasix_reconnect_p95_ms" "$max_wasix_reconnect_p99_ms"
do
  is_positive_number "$threshold" || {
    printf 'all latency gates require finite positive decimal values, got: %s\n' "$threshold" >&2
    exit 2
  }
done
awk -v p95="$max_persistent_p95_ratio" -v p99="$max_persistent_p99_ratio" \
  'BEGIN { exit !(p99 >= p95) }' || { echo 'persistent p99 ratio gate must be >= p95 ratio gate' >&2; exit 2; }
awk -v p95="$max_reconnect_p95_ratio" -v p99="$max_reconnect_p99_ratio" \
  'BEGIN { exit !(p99 >= p95) }' || { echo 'reconnect p99 ratio gate must be >= p95 ratio gate' >&2; exit 2; }
awk -v p95="$max_wasix_persistent_p95_ms" -v p99="$max_wasix_persistent_p99_ms" \
  'BEGIN { exit !(p99 >= p95) }' || { echo 'persistent p99 absolute gate must be >= p95 gate' >&2; exit 2; }
awk -v p95="$max_wasix_reconnect_p95_ms" -v p99="$max_wasix_reconnect_p99_ms" \
  'BEGIN { exit !(p99 >= p95) }' || { echo 'reconnect p99 absolute gate must be >= p95 gate' >&2; exit 2; }

fresh_resolve_postgres_profiles "$runtime_footprint" "$durability_profile" || exit
[ -n "$FRESH_POSTGRES_PROFILE_RESOLUTION_IDENTITY" ] || {
  echo 'latency qualification requires named PostgreSQL profiles' >&2
  exit 2
}

qualification_root="$REPORT_DIR/libpq-latency-qualification/$run_label"
runs_tsv="$qualification_root/runs.tsv"
profile_comparisons_tsv="$qualification_root/profile-comparisons.tsv"
profile_inputs_tsv="$qualification_root/postgres-profile-inputs.tsv"
profile_resolution_tsv="$qualification_root/postgres-profile-resolution.tsv"
plan_tsv="$qualification_root/qualification-plan.tsv"
native_oracle_tsv="$qualification_root/native-oracle-identity.tsv"
carrier_identity_tsv="$qualification_root/carrier-identity.tsv"
carrier_verification_tsv="$qualification_root/carrier-verification.tsv"
native_verification_tsv="$qualification_root/native-oracle-verification.tsv"
samples_tsv="$qualification_root/samples.tsv"
pairs_tsv="$qualification_root/paired-samples.tsv"
paired_summary_tsv="$qualification_root/paired-summary.tsv"
identity_tsv="$qualification_root/sample-identity.tsv"
result_tsv="$qualification_root/qualification-result.tsv"
sealed_loader_verification_tsv="$qualification_root/sealed-loader-verification.tsv"
immutable_carrier_verification_tsv="$qualification_root/immutable-carrier-verification.tsv"
wasix_execution_identity_tsv="$qualification_root/wasix-execution-identity.tsv"
wasix_execution_identity_sha256=none
wasix_postgres_module_sha256=none
summary_md="$qualification_root/summary.md"
harness="$FRESH_ROOT/bin/bench-wasix-concurrent-query-suite.sh"
comparator="$FRESH_ROOT/bin/compare-libpq-latency.py"
probe_source="$FRESH_ROOT/probes/libpq_latency_probe.c"
immutable_carrier_receipt_sha256=none
immutable_carrier_receipt_dev=none
immutable_carrier_receipt_ino=none
immutable_carrier_closure_identity=none

if ! fresh_claim_generated_directories "$qualification_root"; then
  printf 'qualification label already exists: %s\n' "$qualification_root" >&2
  exit 2
fi

if [ "$require_zero_write_aot" -eq 1 ]; then
  receipt_parent="$(dirname "$immutable_carrier_receipt")"
  [ -d "$receipt_parent" ] && [ ! -L "$receipt_parent" ] || {
    printf 'immutable carrier receipt parent must be a non-symlink directory: %s\n' \
      "$receipt_parent" >&2
    exit 2
  }
  immutable_carrier_receipt="$(cd "$receipt_parent" && pwd -P)/$(basename "$immutable_carrier_receipt")"
  "$FRESH_ROOT/bin/verify-immutable-sealed-carrier.sh" \
    --sealed-carrier "$sealed_carrier" \
    --receipt "$immutable_carrier_receipt" --fast || {
      echo 'immutable carrier deployment verification failed before latency qualification' >&2
      exit 1
    }
  fresh_capture_stable_regular_file_identity "$immutable_carrier_receipt" || {
    echo 'immutable carrier receipt changed while its identity was captured' >&2
    exit 1
  }
  immutable_carrier_receipt_sha256="$FRESH_QUALIFICATION_REGULAR_FILE_SHA256"
  immutable_carrier_receipt_dev="$FRESH_QUALIFICATION_REGULAR_FILE_DEVICE"
  immutable_carrier_receipt_ino="$FRESH_QUALIFICATION_REGULAR_FILE_INODE"
fi

immutable_carrier_closure_identity="$([ "$require_zero_write_aot" -eq 1 ] && printf '%s' "$frozen_carrier_identity" || printf none)"
fresh_capture_native_oracle_identity "$NATIVE_INSTALL_DIR" || {
  printf 'native oracle verification failed before qualification: %s\n' "$NATIVE_INSTALL_DIR" >&2
  exit 1
}
frozen_native_identity="$FRESH_QUALIFICATION_NATIVE_ORACLE_IDENTITY"
frozen_profile_identity="$FRESH_POSTGRES_PROFILE_RESOLUTION_IDENTITY"
probe_source_sha="$(fresh_wasmer_bin_hash "$probe_source")"

mkdir -p "$qualification_root/logs" "$qualification_root/profile-comparisons" \
  "$qualification_root/carrier-provenance"
printf 'schema_version\tstatus\tclassification\tdetail\tcarrier_closure_identity\tnative_oracle_identity\tpostgres_profile_resolution_identity\truntime_footprint_sha256\tdurability_profile_sha256\tqualification_plan_sha256\tsamples_sha256\tpaired_samples_sha256\tpaired_summary_sha256\tsample_identity_sha256\twasix_execution_identity_sha256\tpostgres_module_sha256\timmutable_carrier_verification_sha256\tsealed_loader_verification_sha256\tcore_profile\tguest_build_recipe_sha256\timmutable_verification_scope\tcgroup_binding\tcgroup_memory_max\tcgroup_memory_high\tcgroup_swap_max\tcgroup_environment_action\n' >"$result_tsv"
result_written=0
result_hash_or_none() {
  if [ -f "$1" ] && [ ! -L "$1" ]; then
    fresh_wasmer_bin_hash "$1"
  else
    printf none
  fi
}
finish_result() {
  local status="$1" classification="$2" detail="$3"
  [ "$result_written" -eq 0 ] || return 0
  printf 'oliphaunt.wasix-postmaster.latency-result.v4\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$status" "$classification" "$detail" \
    "${frozen_carrier_identity:-none}" "${frozen_native_identity:-none}" \
    "${frozen_profile_identity:-none}" \
    "${FRESH_POSTGRES_RUNTIME_FOOTPRINT_SHA256:-none}" \
    "${FRESH_POSTGRES_DURABILITY_SHA256:-none}" \
    "${plan_identity:-none}" "$(result_hash_or_none "$samples_tsv")" \
    "$(result_hash_or_none "$pairs_tsv")" \
    "$(result_hash_or_none "$paired_summary_tsv")" \
    "$(result_hash_or_none "$identity_tsv")" \
    "$wasix_execution_identity_sha256" "$wasix_postgres_module_sha256" \
    "$(result_hash_or_none "$immutable_carrier_verification_tsv")" \
    "$(result_hash_or_none "$sealed_loader_verification_tsv")" \
    "${frozen_core_profile:-none}" \
    "${frozen_guest_build_recipe_sha256:-none}" \
    "$([ "${require_zero_write_aot:-0}" -eq 1 ] && printf campaign-boundary-full-fast-samples || printf full-per-check)" \
    "${cgroup_binding:-none}" "${cgroup_memory_max:-none}" \
    "${cgroup_memory_high:-none}" "${cgroup_swap_max:-none}" \
    "${cgroup_environment_action:-none}" \
    >>"$result_tsv"
  result_written=1
}
on_exit() {
  local status=$?
  if [ "$result_written" -eq 0 ]; then
    finish_result failed latency-incomplete-non-release "runner-exit-$status"
  fi
}
trap on_exit EXIT

fresh_write_postgres_profile_evidence "$profile_inputs_tsv" "$profile_resolution_tsv"
fresh_write_native_oracle_manifest "$NATIVE_INSTALL_DIR" "$native_oracle_tsv"
[ "$(fresh_wasmer_bin_hash "$native_oracle_tsv")" = "$frozen_native_identity" ] || {
  echo 'native oracle receipt does not match its frozen identity' >&2
  exit 1
}
cp -p "$sealed_carrier/manifest.json" "$qualification_root/carrier-provenance/manifest.json"
cp -p "$sealed_carrier/wasmer-build.receipt" "$qualification_root/carrier-provenance/wasmer-build.receipt"
cp -p "$sealed_carrier/payload.files" "$qualification_root/carrier-provenance/payload.files"
[ "$(fresh_wasmer_bin_hash "$qualification_root/carrier-provenance/manifest.json")" = \
    "$frozen_carrier_manifest_sha" ] &&
  [ "$(fresh_wasmer_bin_hash "$qualification_root/carrier-provenance/wasmer-build.receipt")" = \
    "$frozen_carrier_receipt_sha" ] &&
  [ "$(fresh_wasmer_bin_hash "$qualification_root/carrier-provenance/payload.files")" = \
    "$frozen_carrier_payload_sha" ] || {
    echo 'copied carrier provenance does not match the frozen closure' >&2
    exit 1
  }
printf 'closure_identity\tmanifest_sha256\treceipt_sha256\tpayload_inventory_sha256\theadless_sha256\tcarrier_root\tcore_profile\tguest_build_recipe_sha256\n' >"$carrier_identity_tsv"
printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$frozen_carrier_identity" \
  "$frozen_carrier_manifest_sha" "$frozen_carrier_receipt_sha" \
  "$frozen_carrier_payload_sha" "$frozen_carrier_headless_sha" \
  "$sealed_carrier" "$frozen_core_profile" \
  "$frozen_guest_build_recipe_sha256" >>"$carrier_identity_tsv"

# This receipt exists and is frozen before the first server starts.  Defaults
# therefore cannot silently drift after results are known.
printf 'schema_version\tblocks\twarmup\tsamples\ttimeout_seconds\tstart_port\torder\truntime_footprint\tdurability\tcheckpoint_policy\tresource_detail\thost_fd_allowance\tsanitized_environment\tmax_persistent_p95_ratio\tmax_persistent_p99_ratio\tmax_reconnect_p95_ratio\tmax_reconnect_p99_ratio\tmax_wasix_persistent_p95_ms\tmax_wasix_persistent_p99_ms\tmax_wasix_reconnect_p95_ms\tmax_wasix_reconnect_p99_ms\trequire_zero_write_aot\tactivation_policy\tcarrier_closure_identity\timmutable_receipt_path\timmutable_receipt_sha256\timmutable_receipt_dev\timmutable_receipt_ino\tcore_profile\tguest_build_recipe_sha256\timmutable_verification_scope\tcgroup_binding\tcgroup_memory_max\tcgroup_memory_high\tcgroup_swap_max\tcgroup_environment_action\n' >"$plan_tsv"
printf 'oliphaunt.wasix-postmaster.libpq-latency-plan.v4\t%s\t%s\t%s\t%s\t%s\tABBA/BAAB\t%s\t%s\tcontrolled\toff\t0\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
  "$blocks" "$warmup" "$samples" "$timeout_seconds" "$start_port" \
  "$runtime_footprint" "$durability_profile" "$wait_dump_sanitized_environment" \
  "$max_persistent_p95_ratio" "$max_persistent_p99_ratio" \
  "$max_reconnect_p95_ratio" "$max_reconnect_p99_ratio" \
  "$max_wasix_persistent_p95_ms" "$max_wasix_persistent_p99_ms" \
  "$max_wasix_reconnect_p95_ms" "$max_wasix_reconnect_p99_ms" \
  "$require_zero_write_aot" \
  "$([ "$require_zero_write_aot" -eq 1 ] && printf direct-immutable-only || printf compatibility)" \
  "$frozen_carrier_identity" "${immutable_carrier_receipt:-none}" \
  "$immutable_carrier_receipt_sha256" "$immutable_carrier_receipt_dev" \
  "$immutable_carrier_receipt_ino" \
  "$frozen_core_profile" "$frozen_guest_build_recipe_sha256" \
  "$([ "$require_zero_write_aot" -eq 1 ] && printf campaign-boundary-full-fast-samples || printf full-per-check)" \
  "$cgroup_binding" "${cgroup_memory_max:-none}" \
  "${cgroup_memory_high:-none}" "${cgroup_swap_max:-none}" \
  "$cgroup_environment_action" \
  >>"$plan_tsv"
plan_identity="$(fresh_wasmer_bin_hash "$plan_tsv")"
chmod 0444 "$plan_tsv" "$native_oracle_tsv" "$carrier_identity_tsv" \
  "$qualification_root/carrier-provenance/manifest.json" \
  "$qualification_root/carrier-provenance/wasmer-build.receipt" \
  "$qualification_root/carrier-provenance/payload.files"

printf 'stage\texpected_closure_identity\tobserved_closure_identity\tstatus\n' >"$carrier_verification_tsv"
printf 'initial\t%s\t%s\tpassed\n' "$frozen_carrier_identity" "$frozen_carrier_identity" >>"$carrier_verification_tsv"
printf 'stage\texpected_native_oracle_identity\tobserved_native_oracle_identity\tstatus\n' >"$native_verification_tsv"
printf 'initial\t%s\t%s\tpassed\n' "$frozen_native_identity" "$frozen_native_identity" >>"$native_verification_tsv"
printf 'stage\texpected_receipt_sha256\tobserved_receipt_sha256\texpected_receipt_dev\tobserved_receipt_dev\texpected_receipt_ino\tobserved_receipt_ino\tstatus\n' \
  >"$immutable_carrier_verification_tsv"

assert_frozen_carrier() {
  local stage="$1" verification="${2:-fast}" observed="" status=passed
  if [ "$require_zero_write_aot" -eq 1 ] && [ "$verification" = fast ]; then
    observed="$frozen_carrier_identity"
  elif fresh_capture_qualification_carrier_identity "$sealed_carrier"; then
    observed="$FRESH_QUALIFICATION_CARRIER_CLOSURE_IDENTITY"
  else
    status=verification-failed
  fi
  if [ "$status" = passed ] && [ "$observed" != "$frozen_carrier_identity" ]; then
    status=identity-changed
  fi
  printf '%s\t%s\t%s\t%s\n' "$stage" "$frozen_carrier_identity" "$observed" "$status" >>"$carrier_verification_tsv"
  [ "$status" = passed ] || {
    printf 'carrier identity failed at %s: %s\n' "$stage" "$status" >&2
    return 1
  }
}

assert_frozen_native_oracle() {
  local stage="$1" observed="" status=passed
  if fresh_capture_native_oracle_identity "$NATIVE_INSTALL_DIR"; then
    observed="$FRESH_QUALIFICATION_NATIVE_ORACLE_IDENTITY"
  else
    status=verification-failed
  fi
  if [ "$status" = passed ] && [ "$observed" != "$frozen_native_identity" ]; then
    status=identity-changed
  fi
  printf '%s\t%s\t%s\t%s\n' "$stage" "$frozen_native_identity" "$observed" "$status" >>"$native_verification_tsv"
  [ "$status" = passed ] || {
    printf 'native oracle identity failed at %s: %s\n' "$stage" "$status" >&2
    return 1
  }
}

assert_frozen_immutable_carrier() {
  local stage="$1" observed_sha=none observed_dev=none observed_ino=none
  local status=passed
  [ "$require_zero_write_aot" -eq 1 ] || return 0
  if ! "$FRESH_ROOT/bin/verify-immutable-sealed-carrier.sh" \
    --sealed-carrier "$sealed_carrier" \
    --receipt "$immutable_carrier_receipt" --fast; then
    status=unreadable
  fi
  if fresh_capture_stable_regular_file_identity "$immutable_carrier_receipt"; then
    observed_sha="$FRESH_QUALIFICATION_REGULAR_FILE_SHA256"
    observed_dev="$FRESH_QUALIFICATION_REGULAR_FILE_DEVICE"
    observed_ino="$FRESH_QUALIFICATION_REGULAR_FILE_INODE"
  else
    status=unreadable
  fi
  if [ "$status" = passed ] && {
    [ "$observed_sha" != "$immutable_carrier_receipt_sha256" ] ||
      [ "$observed_dev" != "$immutable_carrier_receipt_dev" ] ||
      [ "$observed_ino" != "$immutable_carrier_receipt_ino" ];
  }; then
    status=identity-changed
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$stage" "$immutable_carrier_receipt_sha256" "$observed_sha" \
    "$immutable_carrier_receipt_dev" "$observed_dev" \
    "$immutable_carrier_receipt_ino" "$observed_ino" "$status" \
    >>"$immutable_carrier_verification_tsv"
  [ "$status" = passed ] || {
    printf 'immutable carrier deployment identity failed at %s: %s\n' \
      "$stage" "$status" >&2
    return 1
  }
}

assert_frozen_inputs() {
  local stage="$1"
  [ "$(fresh_wasmer_bin_hash "$plan_tsv")" = "$plan_identity" ] || {
    printf 'qualification plan changed at %s\n' "$stage" >&2
    return 1
  }
  [ "$(fresh_wasmer_bin_hash "$probe_source")" = "$probe_source_sha" ] || {
    printf 'libpq probe source changed at %s\n' "$stage" >&2
    return 1
  }
  [ "$FRESH_POSTGRES_PROFILE_RESOLUTION_IDENTITY" = "$frozen_profile_identity" ] || {
    printf 'PostgreSQL profile resolution changed at %s\n' "$stage" >&2
    return 1
  }
  fresh_assert_postgres_profile_inputs
}

printf 'schema_version\tblock\torder\tpair\tposition\ttarget\trun_label\tharness_status\treport_dir\teffective_settings\teffective_settings_sha256\tcarrier_closure_identity\tnative_oracle_identity\tpostgres_profile_resolution_identity\tqualification_plan_identity\n' >"$runs_tsv"
printf 'schema_version\tblock\torder\tpair\tnative_settings\twasix_settings\tcomparison\tcomparison_sha256\tstatus\n' >"$profile_comparisons_tsv"
printf 'sample\ttarget\tpolicy_receipt\tpolicy_sha256\taudit_receipt\taudit_sha256\tvalidation_receipt\tvalidation_sha256\tstatus\n' \
  >"$sealed_loader_verification_tsv"

overall_status=0
for ((block = 1; block <= blocks; block++)); do
  if [ $((block % 2)) -eq 1 ]; then
    order=ABBA
    target_order=(native wasix wasix native)
  else
    order=BAAB
    target_order=(wasix native native wasix)
  fi
  pair_first_target=""
  pair_first_settings=""
  for position_index in "${!target_order[@]}"; do
    position=$((position_index + 1))
    pair=$(((position_index / 2) + 1))
    target="${target_order[$position_index]}"
    sample_label="$(printf '%s-b%02d-p%d-%s' "$run_label" "$block" "$position" "$target")"
    sample_log="$qualification_root/logs/$sample_label.log"
    sample_report="$REPORT_DIR/concurrent-query-suite/$sample_label"
    settings="$sample_report/$target/effective-postgres-settings.tsv"
    args=(
      --skip-build
      --target "$target"
      --libpq-latency-only
      --libpq-latency-warmup "$warmup"
      --libpq-latency-samples "$samples"
      --timeout "$timeout_seconds"
      --start-port "$start_port"
      --checkpoint-policy controlled
      --resource-detail off
      --runtime-footprint "$runtime_footprint"
      --durability "$durability_profile"
      --label "$sample_label"
    )
    if [ "$cgroup_binding" != disabled ]; then
      args+=(
        --cgroup-memory-max "$cgroup_memory_max"
        --cgroup-memory-high "$cgroup_memory_high"
        --cgroup-swap-max "$cgroup_swap_max"
      )
    fi
    if [ "$discard_pgdata" -eq 1 ]; then args+=(--discard-pgdata); fi
    if [ "$target" = wasix ]; then
      args+=(--sealed-carrier "$sealed_carrier")
      if [ "$require_zero_write_aot" -eq 1 ]; then
        args+=(
          --require-zero-write-aot
          --immutable-carrier-receipt "$immutable_carrier_receipt"
          --immutable-carrier-verification-scope campaign-fast
        )
      fi
    fi

    printf 'latency block=%s order=%s pair=%s position=%s target=%s\n' \
      "$block" "$order" "$pair" "$position" "$target"
    assert_frozen_inputs "$sample_label:before" || exit 1
    assert_frozen_carrier "$sample_label:before" || exit 1
    assert_frozen_immutable_carrier "$sample_label:before" || exit 1
    assert_frozen_native_oracle "$sample_label:before" || exit 1
    set +e
    env \
      "${wait_dump_unset_args[@]}" \
      WASIX_PERF_STATS=0 \
      WASIX_LIBPQ_LATENCY_HOST_FD_ALLOWANCE=0 \
      "$harness" "${args[@]}" >"$sample_log" 2>&1
    harness_status=$?
    set -e
    sample_loader_status=0
    sample_loader_policy="$sample_report/sealed-loader-policy.tsv"
    sample_loader_audit="$sample_report/$target/sealed-loader-audit.jsonl"
    sample_loader_validation="$sample_report/$target/sealed-loader-audit-validation.tsv"
    sample_loader_policy_sha=""
    sample_loader_audit_sha=""
    sample_loader_validation_sha=""
    if [ "$require_zero_write_aot" -eq 1 ] && [ "$target" = wasix ]; then
      sample_loader_status=1
      if [ -f "$sample_loader_policy" ] && [ ! -L "$sample_loader_policy" ] &&
        [ -f "$sample_loader_audit" ] && [ ! -L "$sample_loader_audit" ] &&
        [ -f "$sample_loader_validation" ] && [ ! -L "$sample_loader_validation" ] &&
        awk -F '\t' -v receipt_path="$immutable_carrier_receipt" \
          -v receipt_sha="$immutable_carrier_receipt_sha256" \
          -v receipt_dev="$immutable_carrier_receipt_dev" \
          -v receipt_ino="$immutable_carrier_receipt_ino" \
          -v carrier_identity="$immutable_carrier_closure_identity" \
          -v core_profile="$frozen_core_profile" \
          -v guest_recipe="$frozen_guest_build_recipe_sha256" \
          'NR == 2 && $1 == "oliphaunt.wasix-postmaster.sealed-loader-policy.v2" && $3 == 1 && $4 == "campaign-fast" && $5 == "direct-immutable-only" && $6 == "OLIPHAUNT_WASIX_REQUIRE_ZERO_WRITE_AOT=1" && $8 == "sanitized-then-explicit" && $9 == "direct-immutable-inode" && $10 == 0 && $11 == 0 && $12 == 0 && $15 == receipt_path && $16 == receipt_sha && $17 == receipt_dev && $18 == receipt_ino && $19 == carrier_identity && $20 == core_profile && $21 == guest_recipe { valid = 1 } END { exit !(NR == 2 && valid) }' "$sample_loader_policy" &&
        awk -F '\t' 'NR == 2 && $1 == "oliphaunt.wasix-postmaster.sealed-loader-audit-validation.v3" && $2 == "passed" && $6 == 1 && $7 == 1 && $10 == "direct-immutable-inode" { valid = 1 } END { exit !(NR == 2 && valid) }' "$sample_loader_validation"
      then
        sample_loader_status=0
        sample_loader_policy_sha="$(fresh_wasmer_bin_hash "$sample_loader_policy")"
        sample_loader_audit_sha="$(fresh_wasmer_bin_hash "$sample_loader_audit")"
        sample_loader_validation_sha="$(fresh_wasmer_bin_hash "$sample_loader_validation")"
      fi
    fi
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$sample_label" "$target" "$sample_loader_policy" "$sample_loader_policy_sha" \
      "$sample_loader_audit" "$sample_loader_audit_sha" \
      "$sample_loader_validation" "$sample_loader_validation_sha" \
      "$([ "$sample_loader_status" -eq 0 ] && printf passed || printf failed)" \
      >>"$sealed_loader_verification_tsv"
    assert_frozen_inputs "$sample_label:after" || exit 1
    assert_frozen_carrier "$sample_label:after" || exit 1
    assert_frozen_immutable_carrier "$sample_label:after" || exit 1
    assert_frozen_native_oracle "$sample_label:after" || exit 1

    settings_sha=""
    if [ -f "$settings" ] && [ ! -L "$settings" ]; then
      settings_sha="$(fresh_wasmer_bin_hash "$settings")"
    else
      overall_status=1
    fi
    if [ "$harness_status" -ne 0 ] || [ "$sample_loader_status" -ne 0 ]; then
      overall_status=1
    fi
    printf '1\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$block" "$order" "$pair" "$position" "$target" "$sample_label" \
      "$harness_status" "$sample_report" "$settings" "$settings_sha" \
      "$frozen_carrier_identity" "$frozen_native_identity" \
      "$frozen_profile_identity" "$plan_identity" >>"$runs_tsv"

    if [ $((position % 2)) -eq 1 ]; then
      pair_first_target="$target"
      pair_first_settings="$settings"
    else
      if [ "$pair_first_target" = native ]; then
        native_settings="$pair_first_settings"
        wasix_settings="$settings"
      else
        native_settings="$settings"
        wasix_settings="$pair_first_settings"
      fi
      comparison="$qualification_root/profile-comparisons/$(printf 'b%02d-p%d.tsv' "$block" "$pair")"
      comparison_status=failed
      comparison_sha=""
      if [ -f "$native_settings" ] && [ ! -L "$native_settings" ] &&
        [ -f "$wasix_settings" ] && [ ! -L "$wasix_settings" ]; then
        set +e
        python3 "$FRESH_ROOT/bin/compare-postgres-settings.py" \
          "$native_settings" "$wasix_settings" "$comparison"
        compare_status=$?
        set -e
        if [ "$compare_status" -eq 0 ] && [ -f "$comparison" ] && [ ! -L "$comparison" ]; then
          comparison_status=passed
          comparison_sha="$(fresh_wasmer_bin_hash "$comparison")"
        fi
      fi
      if [ "$comparison_status" != passed ]; then overall_status=1; fi
      printf '1\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$block" "$order" "$pair" "$native_settings" "$wasix_settings" \
        "$comparison" "$comparison_sha" "$comparison_status" >>"$profile_comparisons_tsv"
    fi
  done
done

assert_frozen_inputs final || exit 1
assert_frozen_carrier final full || exit 1
assert_frozen_immutable_carrier final || exit 1
assert_frozen_native_oracle final || exit 1
chmod 0444 "$immutable_carrier_verification_tsv" \
  "$sealed_loader_verification_tsv"

wasix_execution_reports=()
while IFS= read -r sample_report; do
  [ -n "$sample_report" ] && wasix_execution_reports+=("$sample_report")
done < <(awk -F '\t' 'NR > 1 && $6 == "wasix" { print $9 }' "$runs_tsv" | LC_ALL=C sort -u)
if fresh_freeze_wasix_execution_identity \
  "$wasix_execution_identity_tsv" \
  "$frozen_carrier_identity" "$frozen_carrier_manifest_sha" \
  "$frozen_carrier_receipt_sha" "$frozen_carrier_payload_sha" \
  "$frozen_carrier_headless_sha" "$runtime_footprint" \
  "$FRESH_POSTGRES_RUNTIME_FOOTPRINT_SHA256" "$durability_profile" \
  "$FRESH_POSTGRES_DURABILITY_SHA256" "$frozen_profile_identity" \
  "${wasix_execution_reports[@]}"; then
  wasix_execution_identity_sha256="$FRESH_QUALIFICATION_EXECUTION_IDENTITY_SHA256"
  wasix_postgres_module_sha256="$FRESH_QUALIFICATION_POSTGRES_MODULE_SHA256"
else
  overall_status=1
fi

set +e
python3 "$comparator" \
  --runs "$runs_tsv" \
  --profile-comparisons "$profile_comparisons_tsv" \
  --profile-inputs "$profile_inputs_tsv" \
  --profile-resolution "$profile_resolution_tsv" \
  --native-oracle-manifest "$native_oracle_tsv" \
  --native-install-dir "$NATIVE_INSTALL_DIR" \
  --benchmark-reports-root "$REPORT_DIR/concurrent-query-suite" \
  --benchmark-runs-root "$RUN_DIR/concurrent-query-suite" \
  --expected-blocks "$blocks" \
  --expected-warmup "$warmup" \
  --expected-samples "$samples" \
  --carrier-identity "$frozen_carrier_identity" \
  --native-oracle-identity "$frozen_native_identity" \
  --profile-identity "$frozen_profile_identity" \
  --probe-source-sha256 "$probe_source_sha" \
  --plan-identity "$plan_identity" \
  --max-persistent-p95-ratio "$max_persistent_p95_ratio" \
  --max-persistent-p99-ratio "$max_persistent_p99_ratio" \
  --max-reconnect-p95-ratio "$max_reconnect_p95_ratio" \
  --max-reconnect-p99-ratio "$max_reconnect_p99_ratio" \
  --max-wasix-persistent-p95-ms "$max_wasix_persistent_p95_ms" \
  --max-wasix-persistent-p99-ms "$max_wasix_persistent_p99_ms" \
  --max-wasix-reconnect-p95-ms "$max_wasix_reconnect_p95_ms" \
  --max-wasix-reconnect-p99-ms "$max_wasix_reconnect_p99_ms" \
  --receipt-output "$samples_tsv" \
  --pairs-output "$pairs_tsv" \
  --summary-output "$paired_summary_tsv" \
  --identity-output "$identity_tsv"
comparator_status=$?
set -e
if [ "$comparator_status" -ne 0 ]; then overall_status=1; fi

classification="$(classify_latency_result "$overall_status" "$blocks" "$warmup" "$samples")"
{
  printf '# WASIX true-libpq latency qualification\n\n'
  printf -- '- Status: `%s`\n' "$([ "$overall_status" -eq 0 ] && printf passed || printf failed)"
  printf -- '- Classification: `%s`\n' "$classification"
  printf -- '- Order: alternating `ABBA` / `BAAB`, one fresh server per position\n'
  printf -- '- Resource detail: `off` (dedicated timed lane)\n'
  printf -- '- Server cgroup binding: `%s`\n' "$cgroup_binding"
  printf -- '- Server cgroup MemoryMax / MemoryHigh / MemorySwapMax: `%s / %s / %s`\n' \
    "${cgroup_memory_max:-unset}" "${cgroup_memory_high:-unset}" \
    "${cgroup_swap_max:-unset}"
  printf -- '- Blocks / warmups / samples: `%s / %s / %s`\n' "$blocks" "$warmup" "$samples"
  printf -- '- Qualification plan: `%s` (`%s`)\n' "$plan_tsv" "$plan_identity"
  printf -- '- Direct immutable activation required: `%s`\n' "$require_zero_write_aot"
  printf -- '- Per-sample sealed-loader verification: `%s`\n' \
    "$sealed_loader_verification_tsv"
  if [ "$require_zero_write_aot" -eq 1 ]; then
    printf -- '- Immutable deployment receipt: `%s` (`%s`, dev `%s`, ino `%s`)\n' \
      "$immutable_carrier_receipt" "$immutable_carrier_receipt_sha256" \
      "$immutable_carrier_receipt_dev" "$immutable_carrier_receipt_ino"
    printf -- '- Immutable deployment identity verification: `%s`\n' \
      "$immutable_carrier_verification_tsv"
  fi
  printf -- '- Raw-sample receipts: `%s`\n' "$samples_tsv"
  printf -- '- Pair evidence: `%s`\n' "$pairs_tsv"
  printf -- '- Gate summary: `%s`\n' "$paired_summary_tsv"
  printf -- '- Exact identities: `%s`\n' "$identity_tsv"
} >"$summary_md"

if [ "$overall_status" -eq 0 ]; then
  finish_result passed "$classification" all-declared-gates-passed
  printf 'passed: true-libpq latency qualification (non-release); see %s\n' "$summary_md"
else
  finish_result failed "$classification" one-or-more-declared-gates-failed
  printf 'failed: true-libpq latency qualification; see %s\n' "$summary_md" >&2
  exit 1
fi
