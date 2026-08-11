#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"
source "$FRESH_ROOT/lib/sealed-carrier.sh"
source "$FRESH_ROOT/lib/postgres-profiles.sh"
source "$FRESH_ROOT/lib/qualification-identities.sh"

usage() {
  cat <<'USAGE'
Usage: qualify-wasix-single-backend.sh --sealed-carrier DIR [options]

Run isolated native/WASIX PostgreSQL 18 comparisons in balanced ABBA/BAAB
order. Every target/workload sample gets a fresh cluster; successful generated
PGDATA is discarded by default, while failed samples remain available.

Options:
  --sealed-carrier DIR  Compiler-free carrier to qualify. Required.
  --require-zero-write-aot
                        Require and validate direct immutable AOT and memory
                        activation; reflink/streamed modes are forbidden.
  --immutable-carrier-receipt FILE
                        Exact external Linux immutable-deployment receipt.
                        Required with --require-zero-write-aot.
  --blocks N            Balanced four-position blocks. Default: 5. At least
                        10 may qualify this throughput lane statistically,
                        but never composes a release claim.
  --connections N       Concurrent clients. Default: 1.
  --iterations N        Operations per client. Default: 100000.
  --rows N              Seed rows. Default: 100000.
  --workload NAME       Workload to run. May repeat. Defaults to all four.
  --workloads LIST      Space-separated workload names.
  --postgres-guc GUC    Extra postmaster name=value setting. May repeat and
                        is applied identically to native and WASIX samples.
  --runtime-footprint ID
                        Named runtime-footprint profile. Supported:
                        embedded-concurrent.
  --durability ID       Named durability profile. Supported: safe.
  --shared-memory-provider ID
                        WASIX host backing mounted at guest /dev/shm. Supported:
                        portable-file-v1 and Linux-only linux-tmpfs-v1.
                        Default: portable-file-v1. Native samples receive no
                        provider option.
  --cgroup-memory-max SIZE
                        Bind every measured postmaster to a dedicated systemd
                        user scope with MemoryMax=SIZE.
  --cgroup-memory-high SIZE
                        Bind the same scope with MemoryHigh=SIZE.
  --cgroup-swap-max SIZE
                        Bind the same scope with MemorySwapMax=SIZE. All three
                        cgroup limits must be configured together. Defaults are
                        inherited from WASIX_CGROUP_MEMORY_MAX,
                        WASIX_CGROUP_MEMORY_HIGH, and WASIX_CGROUP_SWAP_MAX;
                        an entirely unset triple disables the dedicated scope.
  --adaptive-cache-evidence-policy POLICY
                        Adaptive cache evidence accepted from each WASIX
                        sample. Default: `portable-correctness-v1` (exact
                        active or observe-only fallback). Opt-in
                        `constrained-linux-wal-action-v1` requires the finite
                        Linux cgroup triple and proves adaptive-active class-6
                        offers, advice calls/bytes, and zero errors.
  --timeout SECONDS     Per harness operation timeout. Default: 180.
  --start-port PORT     Reused after each verified shutdown. Default: 55820.
  --label NAME          Qualification label. Default: timestamped.
  --min-ratio R         Minimum median paired WASIX/native ratio. Defaults to
                        0.70 for c1 and 0.75 for c4.
  --min-lcb R           Minimum one-sided bootstrap 95% lower bound. Defaults
                        to 0.65 for c1 and 0.70 for c4.
  --max-batch-wall-p95 R
                        Maximum paired WASIX/native bulk-batch wall-time p95
                        ratio. Default: 1.50.
  --max-batch-wall-p99 R
                        Maximum paired WASIX/native bulk-batch wall-time p99
                        ratio. Default: 2.00.
  --max-batch-residual-delta-p95-ms N
                        Maximum p95 WASIX-minus-native bulk-batch residual
                        delta. Default: 15 ms.
  --max-batch-residual-delta-p99-ms N
                        Maximum p99 WASIX-minus-native bulk-batch residual
                        delta. Default: 25 ms.
  --keep-pgdata         Retain successful generated PGDATA.
  -h, --help            Show this help.

The timed lane disables background resource sampling and uses the controlled
checkpoint policy. Its wall and psql timing fields describe one complete bulk
client batch. The residual is batch wall time minus summed psql-timed statement
time; it is not per-query latency or isolated backend-launch time. Run the
underlying concurrent suite separately with --resource-detail full for
PSS/private/page-table qualification.
This runner is throughput-only and non-release: it neither runs nor binds
the independent lifecycle plateau and memory-budget evidence required for an
embedded viability or release decision.
USAGE
}

sealed_carrier=""
blocks="${WASIX_QUALIFICATION_BLOCKS:-5}"
connections="${WASIX_QUALIFICATION_CONNECTIONS:-1}"
iterations="${WASIX_QUALIFICATION_ITERATIONS:-100000}"
row_count="${WASIX_QUALIFICATION_ROWS:-100000}"
timeout_seconds="${WASIX_QUALIFICATION_TIMEOUT:-180}"
start_port="${WASIX_QUALIFICATION_PORT:-55820}"
run_label="${WASIX_QUALIFICATION_LABEL:-$(date -u +%Y%m%dT%H%M%SZ)}"
min_ratio="${WASIX_QUALIFICATION_MIN_RATIO:-}"
min_lcb="${WASIX_QUALIFICATION_MIN_LCB:-}"
max_batch_wall_p95="${WASIX_QUALIFICATION_MAX_BATCH_WALL_P95:-1.50}"
max_batch_wall_p99="${WASIX_QUALIFICATION_MAX_BATCH_WALL_P99:-2.00}"
max_batch_residual_delta_p95_ms="${WASIX_QUALIFICATION_MAX_BATCH_RESIDUAL_DELTA_P95_MS:-15}"
max_batch_residual_delta_p99_ms="${WASIX_QUALIFICATION_MAX_BATCH_RESIDUAL_DELTA_P99_MS:-25}"
discard_pgdata=1
workloads=()
postgres_gucs=()
runtime_footprint="${WASIX_RUNTIME_FOOTPRINT:-}"
durability_profile="${WASIX_DURABILITY_PROFILE:-}"
shared_memory_provider=portable-file-v1
shared_memory_provider_explicit=0
require_zero_write_aot=0
immutable_carrier_receipt=""
cgroup_memory_max="${WASIX_CGROUP_MEMORY_MAX:-}"
cgroup_memory_high="${WASIX_CGROUP_MEMORY_HIGH:-}"
cgroup_swap_max="${WASIX_CGROUP_SWAP_MAX:-}"
adaptive_cache_evidence_policy=portable-correctness-v1
adaptive_cache_evidence_policy_explicit=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --sealed-carrier)
      shift
      [ "$#" -gt 0 ] || { echo "--sealed-carrier requires a directory" >&2; exit 2; }
      sealed_carrier="$1"
      ;;
    --require-zero-write-aot)
      [ "$require_zero_write_aot" -eq 0 ] || {
        echo '--require-zero-write-aot may only be specified once' >&2
        exit 2
      }
      require_zero_write_aot=1
      ;;
    --immutable-carrier-receipt)
      shift
      [ "$#" -gt 0 ] || { echo '--immutable-carrier-receipt requires a file' >&2; exit 2; }
      [ -z "$immutable_carrier_receipt" ] || {
        echo '--immutable-carrier-receipt may only be specified once' >&2
        exit 2
      }
      immutable_carrier_receipt="$1"
      ;;
    --blocks)
      shift
      [ "$#" -gt 0 ] || { echo "--blocks requires a value" >&2; exit 2; }
      blocks="$1"
      ;;
    --connections)
      shift
      [ "$#" -gt 0 ] || { echo "--connections requires a value" >&2; exit 2; }
      connections="$1"
      ;;
    --iterations)
      shift
      [ "$#" -gt 0 ] || { echo "--iterations requires a value" >&2; exit 2; }
      iterations="$1"
      ;;
    --rows)
      shift
      [ "$#" -gt 0 ] || { echo "--rows requires a value" >&2; exit 2; }
      row_count="$1"
      ;;
    --workload)
      shift
      [ "$#" -gt 0 ] || { echo "--workload requires a value" >&2; exit 2; }
      workloads+=("$1")
      ;;
    --workloads)
      shift
      [ "$#" -gt 0 ] || { echo "--workloads requires a value" >&2; exit 2; }
      for workload in $1; do
        workloads+=("$workload")
      done
      ;;
    --postgres-guc)
      shift
      [ "$#" -gt 0 ] || { echo "--postgres-guc requires name=value" >&2; exit 2; }
      postgres_gucs+=("$1")
      ;;
    --runtime-footprint)
      shift
      [ "$#" -gt 0 ] || { echo "--runtime-footprint requires an ID" >&2; exit 2; }
      runtime_footprint="$1"
      ;;
    --durability)
      shift
      [ "$#" -gt 0 ] || { echo "--durability requires an ID" >&2; exit 2; }
      durability_profile="$1"
      ;;
    --shared-memory-provider)
      shift
      [ "$#" -gt 0 ] || { echo "--shared-memory-provider requires an ID" >&2; exit 2; }
      [ "$shared_memory_provider_explicit" -eq 0 ] || {
        echo '--shared-memory-provider may only be specified once' >&2
        exit 2
      }
      shared_memory_provider="$1"
      shared_memory_provider_explicit=1
      ;;
    --cgroup-memory-max)
      shift
      [ "$#" -gt 0 ] || { echo "--cgroup-memory-max requires a size" >&2; exit 2; }
      cgroup_memory_max="$1"
      ;;
    --cgroup-memory-high)
      shift
      [ "$#" -gt 0 ] || { echo "--cgroup-memory-high requires a size" >&2; exit 2; }
      cgroup_memory_high="$1"
      ;;
    --cgroup-swap-max)
      shift
      [ "$#" -gt 0 ] || { echo "--cgroup-swap-max requires a size" >&2; exit 2; }
      cgroup_swap_max="$1"
      ;;
    --adaptive-cache-evidence-policy)
      shift
      [ "$#" -gt 0 ] || {
        echo '--adaptive-cache-evidence-policy requires a policy ID' >&2
        exit 2
      }
      [ "$adaptive_cache_evidence_policy_explicit" -eq 0 ] || {
        echo '--adaptive-cache-evidence-policy may only be specified once' >&2
        exit 2
      }
      adaptive_cache_evidence_policy="$1"
      adaptive_cache_evidence_policy_explicit=1
      ;;
    --timeout)
      shift
      [ "$#" -gt 0 ] || { echo "--timeout requires a value" >&2; exit 2; }
      timeout_seconds="$1"
      ;;
    --start-port)
      shift
      [ "$#" -gt 0 ] || { echo "--start-port requires a value" >&2; exit 2; }
      start_port="$1"
      ;;
    --label)
      shift
      [ "$#" -gt 0 ] || { echo "--label requires a value" >&2; exit 2; }
      run_label="$1"
      ;;
    --min-ratio)
      shift
      [ "$#" -gt 0 ] || { echo "--min-ratio requires a value" >&2; exit 2; }
      min_ratio="$1"
      ;;
    --min-lcb)
      shift
      [ "$#" -gt 0 ] || { echo "--min-lcb requires a value" >&2; exit 2; }
      min_lcb="$1"
      ;;
    --max-batch-wall-p95)
      shift
      [ "$#" -gt 0 ] || { echo "--max-batch-wall-p95 requires a value" >&2; exit 2; }
      max_batch_wall_p95="$1"
      ;;
    --max-batch-wall-p99)
      shift
      [ "$#" -gt 0 ] || { echo "--max-batch-wall-p99 requires a value" >&2; exit 2; }
      max_batch_wall_p99="$1"
      ;;
    --max-batch-residual-delta-p95-ms)
      shift
      [ "$#" -gt 0 ] || { echo "--max-batch-residual-delta-p95-ms requires a value" >&2; exit 2; }
      max_batch_residual_delta_p95_ms="$1"
      ;;
    --max-batch-residual-delta-p99-ms)
      shift
      [ "$#" -gt 0 ] || { echo "--max-batch-residual-delta-p99-ms requires a value" >&2; exit 2; }
      max_batch_residual_delta_p99_ms="$1"
      ;;
    --keep-pgdata)
      discard_pgdata=0
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
  shift
done

is_positive_integer() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

is_ratio() {
  [[ "$1" =~ ^([0-9]+([.][0-9]*)?|[.][0-9]+)$ ]] &&
    awk -v value="$1" 'BEGIN { exit !(value >= 0 && value <= 1) }'
}

is_nonnegative_number() {
  [[ "$1" =~ ^([0-9]+([.][0-9]*)?|[.][0-9]+)$ ]]
}

validate_cgroup_size() {
  [[ "$1" =~ ^[0-9]+([KMGTPE]([i]?B)?)?$ ]]
}
cgroup_size_to_bytes() {
  python3 - "$1" <<'PY'
import re
import sys

match = re.fullmatch(r"([0-9]+)([KMGTPE])?(?:i?B)?", sys.argv[1])
if match is None:
    raise SystemExit(2)
value = int(match.group(1))
suffix = match.group(2)
if suffix is not None:
    value *= 1024 ** ("KMGTPE".index(suffix) + 1)
if value > 2**63 - 1:
    raise SystemExit(2)
print(value)
PY
}

[ -n "$sealed_carrier" ] || { echo "--sealed-carrier is required" >&2; exit 2; }
[ -d "$sealed_carrier" ] || { printf 'missing sealed carrier: %s\n' "$sealed_carrier" >&2; exit 2; }
sealed_carrier="$(cd "$sealed_carrier" && pwd -P)"
if [ "$require_zero_write_aot" -eq 1 ]; then
  [ -n "$immutable_carrier_receipt" ] || {
    echo '--require-zero-write-aot requires --immutable-carrier-receipt' >&2
    exit 2
  }
elif [ -n "$immutable_carrier_receipt" ]; then
  echo '--immutable-carrier-receipt requires --require-zero-write-aot' >&2
  exit 2
fi
is_positive_integer "$blocks" || { echo "--blocks requires a positive integer" >&2; exit 2; }
is_positive_integer "$connections" || { echo "--connections requires a positive integer" >&2; exit 2; }
is_positive_integer "$iterations" || { echo "--iterations requires a positive integer" >&2; exit 2; }
is_positive_integer "$row_count" || { echo "--rows requires a positive integer" >&2; exit 2; }
is_positive_integer "$timeout_seconds" || { echo "--timeout requires a positive integer" >&2; exit 2; }
if ! is_positive_integer "$start_port" || [ "$start_port" -gt 65535 ]; then
  echo "--start-port requires a port number from 1 through 65535" >&2
  exit 2
fi
case "$run_label" in
  ""|[!A-Za-z0-9]*|*[!A-Za-z0-9._-]*)
    echo "--label must start with a letter or number and contain only letters, numbers, '.', '_', and '-'" >&2
    exit 2
    ;;
esac
case "$shared_memory_provider" in
  portable-file-v1) ;;
  linux-tmpfs-v1)
    [ "$(uname -s)" = Linux ] || {
      echo 'linux-tmpfs-v1 requires Linux' >&2
      exit 2
    }
    ;;
  *)
    echo '--shared-memory-provider requires portable-file-v1 or linux-tmpfs-v1' >&2
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
    [ "$(uname -s)" = Linux ] || {
      echo 'cgroup memory controls require Linux' >&2
      exit 2
    }
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
case "$adaptive_cache_evidence_policy" in
  portable-correctness-v1) ;;
  constrained-linux-wal-action-v1)
    [ "$cgroup_limit_count" -eq 3 ] || {
      echo 'constrained-linux-wal-action-v1 requires finite cgroup MemoryMax, MemoryHigh, and MemorySwapMax' >&2
      exit 2
    }
    if [[ "$cgroup_memory_max" =~ ^0+([KMGTPE]([i]?B)?)?$ ]] ||
      [[ "$cgroup_memory_high" =~ ^0+([KMGTPE]([i]?B)?)?$ ]]; then
      echo 'constrained-linux-wal-action-v1 requires positive finite MemoryMax and MemoryHigh' >&2
      exit 2
    fi
    ;;
  *)
    echo '--adaptive-cache-evidence-policy requires portable-correctness-v1 or constrained-linux-wal-action-v1' >&2
    exit 2
    ;;
esac
cgroup_memory_max_bytes=none
cgroup_memory_high_bytes=none
cgroup_swap_max_bytes=none
if [ "$cgroup_limit_count" -eq 3 ]; then
  cgroup_memory_max_bytes="$(cgroup_size_to_bytes "$cgroup_memory_max")" || exit 2
  cgroup_memory_high_bytes="$(cgroup_size_to_bytes "$cgroup_memory_high")" || exit 2
  cgroup_swap_max_bytes="$(cgroup_size_to_bytes "$cgroup_swap_max")" || exit 2
fi

if [ -z "$min_ratio" ]; then
  if [ "$connections" -eq 1 ]; then min_ratio="0.70"; else min_ratio="0.75"; fi
fi
if [ -z "$min_lcb" ]; then
  if [ "$connections" -eq 1 ]; then min_lcb="0.65"; else min_lcb="0.70"; fi
fi
is_ratio "$min_ratio" || { echo "--min-ratio requires a number from 0 through 1" >&2; exit 2; }
is_ratio "$min_lcb" || { echo "--min-lcb requires a number from 0 through 1" >&2; exit 2; }
is_nonnegative_number "$max_batch_wall_p95" || { echo "--max-batch-wall-p95 requires a nonnegative number" >&2; exit 2; }
is_nonnegative_number "$max_batch_wall_p99" || { echo "--max-batch-wall-p99 requires a nonnegative number" >&2; exit 2; }
is_nonnegative_number "$max_batch_residual_delta_p95_ms" || { echo "--max-batch-residual-delta-p95-ms requires a nonnegative number" >&2; exit 2; }
is_nonnegative_number "$max_batch_residual_delta_p99_ms" || { echo "--max-batch-residual-delta-p99-ms requires a nonnegative number" >&2; exit 2; }
awk -v p95="$max_batch_wall_p95" -v p99="$max_batch_wall_p99" 'BEGIN { exit !(p99 >= p95) }' || {
  echo "--max-batch-wall-p99 must be greater than or equal to --max-batch-wall-p95" >&2
  exit 2
}
awk -v p95="$max_batch_residual_delta_p95_ms" -v p99="$max_batch_residual_delta_p99_ms" 'BEGIN { exit !(p99 >= p95) }' || {
  echo "--max-batch-residual-delta-p99-ms must be greater than or equal to --max-batch-residual-delta-p95-ms" >&2
  exit 2
}

fresh_postgres_explicit_rows "${postgres_gucs[@]}" >/dev/null || exit

profile_resolution_active=0
if [ -n "$runtime_footprint$durability_profile" ]; then
  profile_resolution_active=1
  fresh_resolve_postgres_profiles "$runtime_footprint" "$durability_profile" \
    "${postgres_gucs[@]}" || exit
  if [ "${#FRESH_POSTGRES_PROFILE_OVERLAPPING_EXPLICIT[@]}" -gt 0 ]; then
    printf 'named-profile qualification forbids explicit overrides of: %s\n' \
      "${FRESH_POSTGRES_PROFILE_OVERLAPPING_EXPLICIT[*]}" >&2
    exit 2
  fi
fi
for guc in "${postgres_gucs[@]}"; do
  case "$guc" in
    *=*) ;;
    *) printf -- '--postgres-guc requires name=value, got: %s\n' "$guc" >&2; exit 2 ;;
  esac
  guc_name="$(printf '%s' "${guc%%=*}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  case "$guc_name" in
    checkpoint_timeout|max_wal_size|min_wal_size|fsync|synchronous_commit|full_page_writes)
      printf 'controlled checkpoint policy owns PostgreSQL setting %s; remove the conflicting --postgres-guc\n' \
        "$guc_name" >&2
      exit 2
      ;;
  esac
done

normalize_workload() {
  case "$1" in
    read|indexed-read|iread) echo indexed-read ;;
    mwrite|mixed-write|multi-write) echo mixed-write ;;
    iupdate|indexed-update) echo indexed-update ;;
    indexed|indexed-insert|iinsert) echo indexed-insert ;;
    *) printf 'unknown workload: %s\n' "$1" >&2; return 2 ;;
  esac
}

if [ "${#workloads[@]}" -eq 0 ]; then
  workloads=(indexed-read mixed-write indexed-update indexed-insert)
fi
normalized_workloads=()
seen_values=""
for workload in "${workloads[@]}"; do
  workload="$(normalize_workload "$workload")"
  case " $seen_values " in
    *" $workload "*) printf 'duplicate workload: %s\n' "$workload" >&2; exit 2 ;;
  esac
  seen_values="$seen_values $workload"
  normalized_workloads+=("$workload")
done
workloads=("${normalized_workloads[@]}")

captured_carrier_closure_identity=""
captured_carrier_manifest_sha256=""
captured_carrier_receipt_sha256=""
captured_carrier_payload_sha256=""
captured_carrier_headless_sha256=""
captured_core_profile=""
captured_guest_build_recipe_sha256=""
captured_native_oracle_identity=""
immutable_carrier_receipt_sha256=none
immutable_carrier_receipt_dev=none
immutable_carrier_receipt_ino=none
immutable_carrier_closure_identity=none

capture_verified_carrier_identity() {
  fresh_capture_qualification_carrier_identity "$sealed_carrier" || return
  captured_carrier_closure_identity="$FRESH_QUALIFICATION_CARRIER_CLOSURE_IDENTITY"
  captured_carrier_manifest_sha256="$FRESH_QUALIFICATION_CARRIER_MANIFEST_SHA256"
  captured_carrier_receipt_sha256="$FRESH_QUALIFICATION_CARRIER_RECEIPT_SHA256"
  captured_carrier_payload_sha256="$FRESH_QUALIFICATION_CARRIER_PAYLOAD_SHA256"
  captured_carrier_headless_sha256="$FRESH_QUALIFICATION_CARRIER_HEADLESS_SHA256"
  captured_core_profile="$FRESH_QUALIFICATION_CORE_PROFILE"
  captured_guest_build_recipe_sha256="$FRESH_QUALIFICATION_GUEST_BUILD_RECIPE_SHA256"
}

frozen_carrier_closure_identity=""
assert_frozen_carrier() {
  local stage="$1"
  local verification="${2:-fast}"
  local observed status=passed

  if [ "$require_zero_write_aot" -eq 1 ] && [ "$verification" = fast ]; then
    # The paired immutable assertion performs the receipt/inode/+i syscall
    # check. Its root +i proof makes this frozen closure identity constant.
    observed="$frozen_carrier_closure_identity"
  elif capture_verified_carrier_identity; then
    observed="$captured_carrier_closure_identity"
  else
    observed=""
    status=verification-failed
  fi
  if [ "$status" = passed ] && [ "$observed" != "$frozen_carrier_closure_identity" ]; then
    status=identity-changed
  fi
  printf '%s\t%s\t%s\t%s\n' "$stage" "$frozen_carrier_closure_identity" \
    "$observed" "$status" >>"$carrier_verification_tsv"
  if [ "$status" != passed ]; then
    printf 'sealed carrier failed frozen-identity check at %s: %s\n' "$stage" "$status" >&2
    return 1
  fi
}

preflight_immutable_carrier() {
  local receipt_parent

  [ "$require_zero_write_aot" -eq 1 ] || return 0
  receipt_parent="$(dirname "$immutable_carrier_receipt")"
  [ -d "$receipt_parent" ] && [ ! -L "$receipt_parent" ] || {
    printf 'immutable carrier receipt parent must be a non-symlink directory: %s\n' \
      "$receipt_parent" >&2
    return 2
  }
  immutable_carrier_receipt="$(cd "$receipt_parent" && pwd -P)/$(basename "$immutable_carrier_receipt")"
  "$FRESH_ROOT/bin/verify-immutable-sealed-carrier.sh" \
    --sealed-carrier "$sealed_carrier" \
    --receipt "$immutable_carrier_receipt" --fast || return
  immutable_carrier_closure_identity="$captured_carrier_closure_identity"
  fresh_capture_stable_regular_file_identity "$immutable_carrier_receipt" || return
  immutable_carrier_receipt_sha256="$FRESH_QUALIFICATION_REGULAR_FILE_SHA256"
  immutable_carrier_receipt_dev="$FRESH_QUALIFICATION_REGULAR_FILE_DEVICE"
  immutable_carrier_receipt_ino="$FRESH_QUALIFICATION_REGULAR_FILE_INODE"
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
      [ "$observed_ino" != "$immutable_carrier_receipt_ino" ] ||
      [ "$frozen_carrier_closure_identity" != "$immutable_carrier_closure_identity" ];
  }; then
    status=identity-changed
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$stage" "$immutable_carrier_receipt_sha256" "$observed_sha" \
    "$immutable_carrier_receipt_dev" "$observed_dev" \
    "$immutable_carrier_receipt_ino" "$observed_ino" "$status" \
    >>"$immutable_carrier_verification_tsv"
  [ "$status" = passed ] || {
    printf 'immutable carrier deployment failed frozen-identity check at %s: %s\n' \
      "$stage" "$status" >&2
    return 1
  }
}

write_native_oracle_manifest() {
  local output="$1"
  local relative path bytes digest link_target resolved
  local libpq_files=0

  [ -d "$NATIVE_INSTALL_DIR" ] && [ ! -L "$NATIVE_INSTALL_DIR" ] || {
    printf 'native install is missing or is a symlink: %s\n' "$NATIVE_INSTALL_DIR" >&2
    return 1
  }
  {
    printf 'schema\tkind\tpath\tbytes\tsha256_or_target\n'
    for relative in bin/postgres bin/initdb bin/psql; do
      path="$NATIVE_INSTALL_DIR/$relative"
      [ -f "$path" ] && [ ! -L "$path" ] && [ -x "$path" ] || {
        printf 'native oracle requires an executable regular file: %s\n' "$path" >&2
        return 1
      }
      bytes="$(wc -c <"$path" | tr -d '[:space:]')"
      digest="$(fresh_wasmer_bin_hash "$path")"
      printf 'oliphaunt.wasix-postmaster.native-oracle.v1\tfile\t%s\t%s\t%s\n' \
        "$relative" "$bytes" "$digest"
    done
    while IFS= read -r path; do
      [ -n "$path" ] || continue
      relative="${path#"$NATIVE_INSTALL_DIR"/}"
      case "$relative" in
        *$'\t'*|*$'\r'*|*$'\n'*)
          printf 'unsafe native libpq path: %s\n' "$relative" >&2
          return 1
          ;;
      esac
      bytes="$(wc -c <"$path" | tr -d '[:space:]')"
      digest="$(fresh_wasmer_bin_hash "$path")"
      printf 'oliphaunt.wasix-postmaster.native-oracle.v1\tfile\t%s\t%s\t%s\n' \
        "$relative" "$bytes" "$digest"
      libpq_files=$((libpq_files + 1))
    done < <(find "$NATIVE_INSTALL_DIR/lib" -maxdepth 1 -type f \
      \( -name 'libpq.a' -o -name 'libpq.*' \) -print | LC_ALL=C sort)
    while IFS= read -r path; do
      [ -n "$path" ] || continue
      relative="${path#"$NATIVE_INSTALL_DIR"/}"
      link_target="$(readlink "$path")" || return
      case "$relative:$link_target" in
        *$'\t'*|*$'\r'*|*$'\n'*|*:/*|*:*../*)
          printf 'unsafe native libpq symlink: %s -> %s\n' "$relative" "$link_target" >&2
          return 1
          ;;
      esac
      resolved="$(realpath "$path")" || return
      case "$resolved" in
        "$NATIVE_INSTALL_DIR"/lib/*) ;;
        *) printf 'native libpq symlink escapes install root: %s\n' "$path" >&2; return 1 ;;
      esac
      [ -f "$resolved" ] && [ ! -L "$resolved" ] || {
        printf 'native libpq symlink target is not a regular file: %s\n' "$path" >&2
        return 1
      }
      printf 'oliphaunt.wasix-postmaster.native-oracle.v1\tsymlink\t%s\t-\t%s\n' \
        "$relative" "$link_target"
    done < <(find "$NATIVE_INSTALL_DIR/lib" -maxdepth 1 -type l -name 'libpq*' \
      -print | LC_ALL=C sort)
  } >"$output"
  [ "$libpq_files" -gt 0 ] || {
    printf 'native oracle has no installed regular libpq artifact below %s/lib\n' \
      "$NATIVE_INSTALL_DIR" >&2
    return 1
  }
}

capture_native_oracle_identity() {
  local temporary_root first second
  temporary_root="$(mktemp -d)" || return
  if ! write_native_oracle_manifest "$temporary_root/first.tsv" ||
    ! write_native_oracle_manifest "$temporary_root/second.tsv" ||
    ! cmp -s "$temporary_root/first.tsv" "$temporary_root/second.tsv"; then
    printf 'native oracle changed while its verified identity was captured\n' >&2
    rm -rf -- "$temporary_root"
    return 1
  fi
  first="$(fresh_wasmer_bin_hash "$temporary_root/first.tsv")" || {
    rm -rf -- "$temporary_root"
    return 1
  }
  second="$(fresh_wasmer_bin_hash "$temporary_root/second.tsv")" || {
    rm -rf -- "$temporary_root"
    return 1
  }
  rm -rf -- "$temporary_root"
  [ "$first" = "$second" ] || return 1
  captured_native_oracle_identity="$second"
}

frozen_native_oracle_identity=""
assert_frozen_native_oracle() {
  local stage="$1"
  local observed status=passed

  if capture_native_oracle_identity; then
    observed="$captured_native_oracle_identity"
  else
    observed=""
    status=verification-failed
  fi
  if [ "$status" = passed ] && [ "$observed" != "$frozen_native_oracle_identity" ]; then
    status=identity-changed
  fi
  printf '%s\t%s\t%s\t%s\n' "$stage" "$frozen_native_oracle_identity" \
    "$observed" "$status" >>"$native_oracle_verification_tsv"
  if [ "$status" != passed ]; then
    printf 'native oracle failed frozen-identity check at %s: %s\n' "$stage" "$status" >&2
    return 1
  fi
}

qualification_root="$REPORT_DIR/single-backend-qualification/$run_label"
raw_tsv="$qualification_root/samples.tsv"
paired_tsv="$qualification_root/paired-summary.tsv"
bulk_batch_raw_tsv="$qualification_root/bulk-batch-samples.tsv"
bulk_batch_tsv="$qualification_root/bulk-batch-summary.tsv"
summary="$qualification_root/summary.md"
profile_tsv="$qualification_root/profile-summary.tsv"
carrier_identity_tsv="$qualification_root/carrier-identity.tsv"
carrier_verification_tsv="$qualification_root/carrier-verification.tsv"
native_oracle_identity_tsv="$qualification_root/native-oracle-identity.tsv"
native_oracle_verification_tsv="$qualification_root/native-oracle-verification.tsv"
instrumentation_policy_tsv="$qualification_root/instrumentation-policy.tsv"
instrumentation_verification_tsv="$qualification_root/instrumentation-verification.tsv"
adaptive_cache_verification_tsv="$qualification_root/adaptive-cache-verification.tsv"
sealed_loader_verification_tsv="$qualification_root/sealed-loader-verification.tsv"
immutable_carrier_verification_tsv="$qualification_root/immutable-carrier-verification.tsv"
qualification_policy_tsv="$qualification_root/qualification-policy.tsv"
qualification_result_tsv="$qualification_root/qualification-result.tsv"
wasix_execution_identity_tsv="$qualification_root/wasix-execution-identity.tsv"
wasix_execution_identity_sha256=none
wasix_postgres_module_sha256=none
qualification_postgres_profile_inputs="$qualification_root/postgres-profile-inputs.tsv"
qualification_postgres_profile_resolution="$qualification_root/postgres-profile-resolution.tsv"
harness="$FRESH_ROOT/bin/bench-wasix-concurrent-query-suite.sh"
adaptive_cache_validator="$FRESH_ROOT/bin/validate-adaptive-file-cache-telemetry.py"
adaptive_cache_validator_sha256="$(fresh_wasmer_bin_hash "$adaptive_cache_validator")"
adaptive_cache_sample_contract_schema=oliphaunt.wasix-postmaster.adaptive-cache-sample-contract.v1
IFS=$'\t' read -r adaptive_cache_validation_schema adaptive_cache_policy_id \
  adaptive_cache_config_id adaptive_cache_config_sha256 \
  adaptive_cache_warmup_samples < <(
    python3 - "$adaptive_cache_validator" <<'PY'
import runpy
import sys

constants = runpy.run_path(sys.argv[1])
print(
    constants["RESULT_SCHEMA"],
    constants["POLICY_ID"],
    constants["CONFIG_ID"],
    constants["CONFIG_SHA256"],
    constants["CONFIG"]["warmup-samples"],
    sep="\t",
)
PY
  )
case "$adaptive_cache_validation_schema:$adaptive_cache_policy_id:$adaptive_cache_config_id:$adaptive_cache_config_sha256:$adaptive_cache_warmup_samples" in
  *$'\t'*|*$'\r'*|*$'\n'*|*::*|*:|*[!A-Za-z0-9._:-]*)
    echo 'adaptive cache validator exported an invalid evidence contract' >&2
    exit 125
    ;;
esac
wait_dump_env_unsets=(
  -u WASIX_PERF_WAIT_DUMP_INTERVAL_MS
  -u WASIX_PERF_WAIT_DUMP_FILE
  -u WASIX_PERF_WAIT_DUMP_MAX_PER_WAIT
  -u WASIX_PERF_WAIT_DUMP_VERBOSE
  -u WASIX_WAIT_DUMP_INTERVAL_MS
  -u WASIX_WAIT_DUMP_FILE
  -u WASIX_WAIT_DUMP_MAX_PER_WAIT
  -u WASIX_WAIT_DUMP_VERBOSE
  -u WASIX_WAIT_DUMP_FENCE_REQUEST_FILE
  -u WASIX_WAIT_DUMP_FENCE_ACK_FILE
  -u OLIPHAUNT_WASIX_REQUIRE_ZERO_WRITE_AOT
  -u OLIPHAUNT_WASIX_SEALED_LOADER_AUDIT_FILE
  -u WASIX_CGROUP_MEMORY_MAX
  -u WASIX_CGROUP_MEMORY_HIGH
  -u WASIX_CGROUP_SWAP_MAX
)
if ! fresh_claim_generated_directories "$qualification_root"; then
  printf 'qualification label already exists: %s\n' "$qualification_root" >&2
  exit 2
fi
capture_verified_carrier_identity || {
  printf 'sealed carrier verification failed before qualification: %s\n' "$sealed_carrier" >&2
  exit 1
}
frozen_carrier_closure_identity="$captured_carrier_closure_identity"
adaptive_cache_runtime_abi_id="$(
  python3 - "$sealed_carrier/manifest.json" <<'PY'
import json
import re
import sys
from pathlib import Path

manifest = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
runtime_abi_id = manifest.get("runtime-abi-id")
if not isinstance(runtime_abi_id, str) or re.fullmatch(r"[0-9a-f]{64}", runtime_abi_id) is None:
    raise SystemExit(2)
print(runtime_abi_id)
PY
)" || {
  echo 'sealed carrier manifest has no exact adaptive runtime ABI identity' >&2
  exit 125
}
preflight_immutable_carrier || {
  printf 'immutable carrier deployment verification failed before qualification: %s\n' \
    "$sealed_carrier" >&2
  exit 1
}
[ "$require_zero_write_aot" -eq 0 ] ||
  [ "$frozen_carrier_closure_identity" = "$immutable_carrier_closure_identity" ] || {
    echo 'immutable deployment closure differs from frozen qualification carrier' >&2
    exit 1
  }
capture_native_oracle_identity || {
  printf 'native oracle verification failed before qualification: %s\n' "$NATIVE_INSTALL_DIR" >&2
  exit 1
}
frozen_native_oracle_identity="$captured_native_oracle_identity"
mkdir -p "$qualification_root/logs"
mkdir -p "$qualification_root/profile-comparisons" \
  "$qualification_root/carrier-provenance" "$qualification_root/effective-settings" \
  "$qualification_root/adaptive-cache-validations"
printf 'schema_version\tscope\tblocks\tconnections\titerations\trows\tworkloads\tmin_ratio\tmin_lcb\tmax_batch_wall_p95\tmax_batch_wall_p99\tmax_batch_residual_delta_p95_ms\tmax_batch_residual_delta_p99_ms\truntime_footprint\truntime_footprint_sha256\tdurability_profile\tdurability_profile_sha256\tpostgres_profile_resolution_identity\tcarrier_closure_identity\trequire_zero_write_aot\tactivation_policy\timmutable_receipt_path\timmutable_receipt_sha256\timmutable_receipt_dev\timmutable_receipt_ino\tcore_profile\tguest_build_recipe_sha256\timmutable_verification_scope\tcgroup_binding\tcgroup_memory_max\tcgroup_memory_high\tcgroup_swap_max\tcgroup_environment_action\tadaptive_cache_evidence_policy\tadaptive_cache_validator_sha256\tadaptive_cache_validation_schema\tadaptive_cache_policy_id\tadaptive_cache_config_id\tadaptive_cache_config_sha256\tadaptive_cache_warmup_samples\tadaptive_cache_runtime_abi_id\tadaptive_cache_sample_contract_schema\twasix_shared_memory_provider\n' \
  >"$qualification_policy_tsv"
printf 'oliphaunt.wasix-postmaster.throughput-policy.v7\tthroughput-only-non-release\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
  "$blocks" "$connections" "$iterations" "$row_count" \
  "$(IFS=,; printf '%s' "${workloads[*]}")" "$min_ratio" "$min_lcb" \
  "$max_batch_wall_p95" "$max_batch_wall_p99" \
  "$max_batch_residual_delta_p95_ms" "$max_batch_residual_delta_p99_ms" \
  "${runtime_footprint:-none}" \
  "${FRESH_POSTGRES_RUNTIME_FOOTPRINT_SHA256:-none}" \
  "${durability_profile:-none}" "${FRESH_POSTGRES_DURABILITY_SHA256:-none}" \
  "${FRESH_POSTGRES_PROFILE_RESOLUTION_IDENTITY:-none}" \
  "$frozen_carrier_closure_identity" "$require_zero_write_aot" \
  "$([ "$require_zero_write_aot" -eq 1 ] && printf direct-immutable-only || printf compatibility)" \
  "${immutable_carrier_receipt:-none}" "$immutable_carrier_receipt_sha256" \
  "$immutable_carrier_receipt_dev" "$immutable_carrier_receipt_ino" \
  "$captured_core_profile" "$captured_guest_build_recipe_sha256" \
  "$([ "$require_zero_write_aot" -eq 1 ] && printf campaign-boundary-full-fast-samples || printf full-per-check)" \
  "$cgroup_binding" "${cgroup_memory_max:-none}" \
  "${cgroup_memory_high:-none}" "${cgroup_swap_max:-none}" \
  "$cgroup_environment_action" "$adaptive_cache_evidence_policy" \
  "$adaptive_cache_validator_sha256" \
  "$adaptive_cache_validation_schema" "$adaptive_cache_policy_id" \
  "$adaptive_cache_config_id" "$adaptive_cache_config_sha256" \
  "$adaptive_cache_warmup_samples" "$adaptive_cache_runtime_abi_id" \
  "$adaptive_cache_sample_contract_schema" "$shared_memory_provider" \
  >>"$qualification_policy_tsv"
qualification_policy_identity="$(fresh_wasmer_bin_hash "$qualification_policy_tsv")"
chmod 0444 "$qualification_policy_tsv"
assert_frozen_qualification_policy() {
  [ "$(fresh_wasmer_bin_hash "$qualification_policy_tsv")" = \
    "$qualification_policy_identity" ] || {
    echo 'pre-run throughput qualification policy changed during execution' >&2
    return 125
  }
  [ "$(fresh_wasmer_bin_hash "$adaptive_cache_validator")" = \
    "$adaptive_cache_validator_sha256" ] || {
    echo 'adaptive cache evidence validator changed during qualification' >&2
    return 125
  }
}
printf 'schema_version\tlane\twait_dump_policy\twait_dump_interval_ms\twait_dump_max_per_wait\twait_dump_verbose\tfence_protocol\tenvironment_action\tadaptive_cache_evidence_policy\twasix_sample_rule\tnative_sample_rule\n' \
  >"$instrumentation_policy_tsv"
printf 'oliphaunt.wasix-postmaster.qualification-instrumentation.v2\tbulk-throughput\tprohibited\t0\t0\t0\tnone\tunset-before-every-harness-launch\t%s\tselected-policy\tportable-correctness-v1\n' \
  "$adaptive_cache_evidence_policy" \
  >>"$instrumentation_policy_tsv"
chmod 0444 "$instrumentation_policy_tsv"
printf 'sample\treceipt\tsha256\tstatus\n' >"$instrumentation_verification_tsv"
printf 'sample\ttarget\tacceptance_policy\tpolicy_receipt\tpolicy_sha256\tsample_contract_receipt\tsample_contract_sha256\tserver_lifecycle_receipt\tserver_lifecycle_sha256\traw_telemetry\traw_telemetry_sha256\tinner_validation_receipt\tinner_validation_sha256\tqualification_validation_receipt\tqualification_validation_sha256\toutcome\tpolicy_id\tconfig_id\tconfig_sha256\truntime_abi_id\tcgroup_identity\tcgroup_initial_memory_max_bytes\tcgroup_initial_memory_high_bytes\tcgroup_initial_swap_max_bytes\tcgroup_final_memory_max_bytes\tcgroup_final_memory_high_bytes\tcgroup_final_swap_max_bytes\tsample_window_start_monotonic_ns\tsample_window_end_monotonic_ns\tmembership_leaf_identity\tpressure_source_identity\tlast_sample_monotonic_ns\tlast_sample_effective_limit_bytes\tclass6_offers\tclass6_advice_calls\tclass6_advised_bytes\tsample_errors\tclock_errors\tadvice_errors\tstatus\n' \
  >"$adaptive_cache_verification_tsv"
printf 'sample\ttarget\tpolicy_receipt\tpolicy_sha256\taudit_receipt\taudit_sha256\tvalidation_receipt\tvalidation_sha256\tstatus\n' \
  >"$sealed_loader_verification_tsv"
printf 'stage\texpected_receipt_sha256\tobserved_receipt_sha256\texpected_receipt_dev\tobserved_receipt_dev\texpected_receipt_ino\tobserved_receipt_ino\tstatus\n' \
  >"$immutable_carrier_verification_tsv"
if [ "$profile_resolution_active" -eq 1 ]; then
  fresh_write_postgres_profile_evidence \
    "$qualification_postgres_profile_inputs" \
    "$qualification_postgres_profile_resolution"
fi
printf 'stage\texpected_closure_identity\tobserved_closure_identity\tstatus\n' >"$carrier_verification_tsv"
printf 'initial\t%s\t%s\tpassed\n' "$frozen_carrier_closure_identity" \
  "$frozen_carrier_closure_identity" >>"$carrier_verification_tsv"
printf 'stage\texpected_native_oracle_identity\tobserved_native_oracle_identity\tstatus\n' \
  >"$native_oracle_verification_tsv"
printf 'initial\t%s\t%s\tpassed\n' "$frozen_native_oracle_identity" \
  "$frozen_native_oracle_identity" >>"$native_oracle_verification_tsv"
assert_frozen_carrier provenance-copy:before || exit 1
assert_frozen_immutable_carrier provenance-copy:before || exit 1
assert_frozen_native_oracle provenance-copy:before || exit 1
cp -p "$sealed_carrier/manifest.json" "$qualification_root/carrier-provenance/manifest.json"
cp -p "$sealed_carrier/wasmer-build.receipt" "$qualification_root/carrier-provenance/wasmer-build.receipt"
cp -p "$sealed_carrier/payload.files" "$qualification_root/carrier-provenance/payload.files"
chmod 0444 "$qualification_root/carrier-provenance/manifest.json" \
  "$qualification_root/carrier-provenance/wasmer-build.receipt" \
  "$qualification_root/carrier-provenance/payload.files"
[ "$(fresh_wasmer_bin_hash "$qualification_root/carrier-provenance/manifest.json")" = "$captured_carrier_manifest_sha256" ] &&
  [ "$(fresh_wasmer_bin_hash "$qualification_root/carrier-provenance/wasmer-build.receipt")" = "$captured_carrier_receipt_sha256" ] &&
  [ "$(fresh_wasmer_bin_hash "$qualification_root/carrier-provenance/payload.files")" = "$captured_carrier_payload_sha256" ] || {
    echo 'copied carrier provenance does not match the frozen carrier identity' >&2
    exit 1
  }
assert_frozen_carrier provenance-copy:after || exit 1
assert_frozen_immutable_carrier provenance-copy:after || exit 1
write_native_oracle_manifest "$native_oracle_identity_tsv"
[ "$(fresh_wasmer_bin_hash "$native_oracle_identity_tsv")" = \
  "$frozen_native_oracle_identity" ] || {
  echo 'captured native oracle manifest does not match its frozen identity' >&2
  exit 1
}
chmod 0444 "$native_oracle_identity_tsv"
assert_frozen_native_oracle provenance-copy:after || exit 1
printf 'closure_identity\tmanifest_sha256\treceipt_sha256\tpayload_inventory_sha256\theadless_sha256\tcarrier_root\tcore_profile\tguest_build_recipe_sha256\n' >"$carrier_identity_tsv"
printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$frozen_carrier_closure_identity" \
  "$captured_carrier_manifest_sha256" "$captured_carrier_receipt_sha256" \
  "$captured_carrier_payload_sha256" "$captured_carrier_headless_sha256" \
  "$sealed_carrier" "$captured_core_profile" \
  "$captured_guest_build_recipe_sha256" >>"$carrier_identity_tsv"
chmod 0444 "$carrier_identity_tsv"
printf 'block\tworkload\tpair\tfirst_target\tsecond_target\tnative_settings\twasix_settings\tcomparison\tstatus\n' >"$profile_tsv"
printf 'block\tworkload\tpair\tposition\ttarget\trun_label\tworkload_status\tharness_status\teffective_status\tderived_metrics_valid\tthroughput_ops_per_sec\tfanout_wall_ms\toperation_count\treport_dir\teffective_settings\teffective_settings_sha256\tcarrier_closure_identity\tpostgres_profile_resolution_identity\tnative_oracle_identity\n' >"$raw_tsv"
printf 'block\tworkload\tpair\tposition\ttarget\tclient\tclient_status\tworkload_status\tharness_status\teffective_status\tderived_metrics_valid\tbulk_batch_wall_ms\tbulk_batch_psql_time_sum_ms\tbulk_batch_psql_time_count\tbulk_batch_residual_ms\treport_dir\teffective_settings_sha256\tcarrier_closure_identity\tpostgres_profile_resolution_identity\tnative_oracle_identity\n' >"$bulk_batch_raw_tsv"

overall_status=0
expected_sample_summary_header=$'target\tworkload\tstatus\tconnections\titerations\toperation_count\tverified_count\texpected_verify_count\tfanout_wall_ms\tthroughput_ops_per_sec\tok_clients\tfailed_clients\ttimed_out\tepoll_intr_count\tserver_log\treport_dir'
expected_client_summary_header=$'target\tworkload\tclient\tstatus\tbulk_batch_wall_ms\tbulk_batch_psql_time_sum_ms\tbulk_batch_psql_time_count\tlog'
for ((block = 1; block <= blocks; block++)); do
  if [ $((block % 2)) -eq 1 ]; then
    target_order=(native wasix wasix native)
  else
    target_order=(wasix native native wasix)
  fi
  workload_count="${#workloads[@]}"
  workload_rotation=$(((block - 1) % workload_count))
  for ((workload_offset = 0; workload_offset < workload_count; workload_offset++)); do
    workload_index=$(((workload_rotation + workload_offset) % workload_count))
    workload="${workloads[$workload_index]}"
    pair_first_target=""
    pair_first_settings=""
    for position_index in "${!target_order[@]}"; do
      position=$((position_index + 1))
      pair=$(((position_index / 2) + 1))
      target="${target_order[$position_index]}"
      sample_label="$(printf '%s-b%02d-%s-p%d-%s' "$run_label" "$block" "$workload" "$position" "$target")"
      sample_log="$qualification_root/logs/$sample_label.log"
      args=(
        --skip-build
        --target "$target"
        --workload "$workload"
        --connections "$connections"
        --iterations "$iterations"
        --rows "$row_count"
        --timeout "$timeout_seconds"
        --start-port "$start_port"
        --checkpoint-policy controlled
        --resource-detail off
        --label "$sample_label"
      )
      sample_adaptive_cache_evidence_policy=portable-correctness-v1
      if [ "$target" = wasix ]; then
        sample_adaptive_cache_evidence_policy="$adaptive_cache_evidence_policy"
      fi
      args+=(
        --adaptive-cache-evidence-policy \
        "$sample_adaptive_cache_evidence_policy"
      )
      if [ "$cgroup_binding" != disabled ]; then
        args+=(
          --cgroup-memory-max "$cgroup_memory_max"
          --cgroup-memory-high "$cgroup_memory_high"
          --cgroup-swap-max "$cgroup_swap_max"
        )
      fi
      if [ "$discard_pgdata" -eq 1 ]; then
        args+=(--discard-pgdata)
      fi
      if [ "$target" = "wasix" ]; then
        args+=(
          --sealed-carrier "$sealed_carrier"
          --shared-memory-provider "$shared_memory_provider"
        )
        if [ "$require_zero_write_aot" -eq 1 ]; then
          args+=(
            --require-zero-write-aot
            --immutable-carrier-receipt "$immutable_carrier_receipt"
            --immutable-carrier-verification-scope campaign-fast
          )
        fi
      fi
      for guc in "${postgres_gucs[@]}"; do
        args+=(--postgres-guc "$guc")
      done
      if [ -n "$runtime_footprint" ]; then
        args+=(--runtime-footprint "$runtime_footprint")
      fi
      if [ -n "$durability_profile" ]; then
        args+=(--durability "$durability_profile")
      fi
      printf 'block=%s workload=%s position=%s target=%s\n' \
        "$block" "$workload" "$position" "$target"
      assert_frozen_qualification_policy || exit 1
      assert_frozen_carrier "$sample_label:before" || exit 1
      assert_frozen_immutable_carrier "$sample_label:before" || exit 1
      assert_frozen_native_oracle "$sample_label:before" || exit 1
      if [ "$profile_resolution_active" -eq 1 ]; then
        fresh_assert_postgres_profile_inputs || exit 1
      fi
      set +e
      env "${wait_dump_env_unsets[@]}" WASIX_PERF_STATS=0 \
        "$harness" "${args[@]}" >"$sample_log" 2>&1
      harness_status=$?
      set -e
      assert_frozen_carrier "$sample_label:after" || exit 1
      assert_frozen_immutable_carrier "$sample_label:after" || exit 1
      assert_frozen_native_oracle "$sample_label:after" || exit 1
      if [ "$profile_resolution_active" -eq 1 ]; then
        fresh_assert_postgres_profile_inputs || exit 1
      fi
      sample_report="$REPORT_DIR/concurrent-query-suite/$sample_label"
      sample_summary="$sample_report/summary.tsv"
      sample_clients="$sample_report/client-summary.tsv"
      sample_instrumentation="$sample_report/instrumentation-policy.tsv"
      sample_adaptive_policy="$sample_report/adaptive-cache-evidence-policy.tsv"
      sample_adaptive_contract="$sample_report/$target/adaptive-cache-sample-contract.tsv"
      sample_server_lifecycle="$sample_report/server-lifecycle.tsv"
      sample_adaptive_telemetry="$sample_report/$target/cache-offers-postgres.adaptive.json"
      sample_adaptive_inner_validation="$sample_report/$target/cache-offers-postgres-adaptive-validation.tsv"
      sample_adaptive_validation="$qualification_root/adaptive-cache-validations/$sample_label.tsv"
      sample_loader_policy="$sample_report/sealed-loader-policy.tsv"
      sample_loader_audit="$sample_report/$target/sealed-loader-audit.jsonl"
      sample_loader_validation="$sample_report/$target/sealed-loader-audit-validation.tsv"
      sample_profile_inputs="$sample_report/postgres-profile-inputs.tsv"
      sample_profile_resolution="$sample_report/postgres-profile-resolution.tsv"
      sample_profile_evidence_status=0
      sample_instrumentation_status=1
      sample_instrumentation_sha256=""
      sample_adaptive_status=1
      sample_adaptive_policy_sha256=""
      sample_adaptive_contract_sha256=""
      sample_server_lifecycle_sha256=""
      sample_adaptive_telemetry_sha256=""
      sample_adaptive_inner_validation_sha256=""
      sample_adaptive_validation_sha256=""
      sample_adaptive_outcome=not-applicable
      sample_adaptive_policy_id=none
      sample_adaptive_config_id=none
      sample_adaptive_config_sha256=none
      sample_adaptive_runtime_abi_id=none
      sample_adaptive_server_pid=none
      sample_adaptive_server_birth_identity=none
      sample_adaptive_cgroup_unit=none
      sample_adaptive_cgroup_identity=none
      sample_adaptive_memory_max_bytes=none
      sample_adaptive_memory_high_bytes=none
      sample_adaptive_effective_limit_bytes=none
      sample_adaptive_swap_max_bytes=none
      sample_adaptive_final_memory_max_bytes=none
      sample_adaptive_final_memory_high_bytes=none
      sample_adaptive_final_swap_max_bytes=none
      sample_adaptive_window_start_ns=none
      sample_adaptive_window_end_ns=none
      sample_adaptive_membership_identity=none
      sample_adaptive_pressure_identity=none
      sample_adaptive_last_sample_ns=none
      sample_adaptive_last_sample_limit_bytes=none
      sample_adaptive_class6_offers=0
      sample_adaptive_class6_advice_calls=0
      sample_adaptive_class6_advised_bytes=0
      sample_adaptive_sample_errors=0
      sample_adaptive_clock_errors=0
      sample_adaptive_advice_errors=0
      sample_loader_status=0
      sample_loader_policy_sha256=""
      sample_loader_audit_sha256=""
      sample_loader_validation_sha256=""
      if [ "$require_zero_write_aot" -eq 1 ] && [ "$target" = wasix ]; then
        sample_loader_status=1
        if [ -f "$sample_loader_policy" ] && [ ! -L "$sample_loader_policy" ] &&
          [ -f "$sample_loader_audit" ] && [ ! -L "$sample_loader_audit" ] &&
          [ -f "$sample_loader_validation" ] && [ ! -L "$sample_loader_validation" ] &&
          awk -F '\t' '
            NR == 1 { next }
            NR == 2 && $1 == "oliphaunt.wasix-postmaster.sealed-loader-policy.v2" &&
              $3 == 1 && $4 == "campaign-fast" &&
              $5 == "direct-immutable-only" &&
              $6 == "OLIPHAUNT_WASIX_REQUIRE_ZERO_WRITE_AOT=1" &&
              $8 == "sanitized-then-explicit" &&
              $9 == "direct-immutable-inode" &&
              $10 == 0 && $11 == 0 && $12 == 0 &&
              $15 == receipt_path && $16 == receipt_sha &&
              $17 == receipt_dev && $18 == receipt_ino &&
              $19 == carrier_identity && $20 == core_profile &&
              $21 == guest_recipe {
              valid = 1
            }
            END { exit !(NR == 2 && valid) }
          ' receipt_path="$immutable_carrier_receipt" \
            receipt_sha="$immutable_carrier_receipt_sha256" \
            receipt_dev="$immutable_carrier_receipt_dev" \
            receipt_ino="$immutable_carrier_receipt_ino" \
            carrier_identity="$immutable_carrier_closure_identity" \
            core_profile="$captured_core_profile" \
            guest_recipe="$captured_guest_build_recipe_sha256" \
            "$sample_loader_policy" &&
          awk -F '\t' '
            NR == 1 { next }
            NR == 2 && $1 == "oliphaunt.wasix-postmaster.sealed-loader-audit-validation.v3" &&
              $2 == "passed" && $6 == 1 && $7 == 1 &&
              $10 == "direct-immutable-inode" { valid = 1 }
            END { exit !(NR == 2 && valid) }
          ' "$sample_loader_validation"
        then
          sample_loader_status=0
          sample_loader_policy_sha256="$(fresh_wasmer_bin_hash "$sample_loader_policy")"
          sample_loader_audit_sha256="$(fresh_wasmer_bin_hash "$sample_loader_audit")"
          sample_loader_validation_sha256="$(fresh_wasmer_bin_hash "$sample_loader_validation")"
        fi
      fi
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$sample_label" "$target" "$sample_loader_policy" \
        "$sample_loader_policy_sha256" "$sample_loader_audit" \
        "$sample_loader_audit_sha256" "$sample_loader_validation" \
        "$sample_loader_validation_sha256" \
        "$([ "$sample_loader_status" -eq 0 ] && printf passed || printf failed)" \
        >>"$sealed_loader_verification_tsv"

      sample_adaptive_required_host=any
      sample_adaptive_expected_claim_scope=portable-correctness
      sample_adaptive_required_runtime=any
      sample_adaptive_expected_runtime=compiler
      sample_adaptive_expected_manifest=none
      sample_adaptive_expected_outcome=adaptive-active-or-observe-only-fallback
      sample_adaptive_expected_class=none
      sample_adaptive_min_offers=0
      sample_adaptive_min_calls=0
      sample_adaptive_min_bytes=0
      sample_adaptive_max_sample_errors=unbounded
      sample_adaptive_max_clock_errors=unbounded
      sample_adaptive_max_advice_errors=unbounded
      sample_adaptive_max_psi_breaker_trips=unbounded
      sample_adaptive_max_refault_breaker_trips=unbounded
      sample_adaptive_max_deferred_wal_pin_errors=unbounded
      sample_adaptive_max_contended_wal_pin_failures=unbounded
      sample_adaptive_terminal_receipt=active-finalized-or-admission-fallback
      sample_adaptive_scope_contract=not-required
      sample_adaptive_required_cgroup_binding=none
      sample_adaptive_required_limit_binding=none
      sample_adaptive_required_monotonic_window=none
      if [ "$target" = wasix ]; then
        sample_adaptive_expected_runtime=sealed-headless
        sample_adaptive_expected_manifest="$captured_carrier_manifest_sha256"
      fi
      if [ "$sample_adaptive_cache_evidence_policy" = \
        constrained-linux-wal-action-v1 ]; then
        sample_adaptive_required_host=Linux
        sample_adaptive_expected_claim_scope=constrained-linux-performance
        sample_adaptive_required_runtime=sealed-headless
        sample_adaptive_expected_outcome=adaptive-active
        sample_adaptive_expected_class=6
        sample_adaptive_min_offers=1
        sample_adaptive_min_calls=1
        sample_adaptive_min_bytes=1
        sample_adaptive_max_sample_errors=0
        sample_adaptive_max_clock_errors=0
        sample_adaptive_max_advice_errors=0
        sample_adaptive_max_psi_breaker_trips=0
        sample_adaptive_max_refault_breaker_trips=0
        sample_adaptive_max_deferred_wal_pin_errors=0
        sample_adaptive_max_contended_wal_pin_failures=0
        sample_adaptive_terminal_receipt=active-finalized
        sample_adaptive_scope_contract=required
        sample_adaptive_required_cgroup_binding=per-target-device-inode
        sample_adaptive_required_limit_binding=requested-equals-leaf-and-effective-min
        sample_adaptive_required_monotonic_window=launch-before-through-post-shutdown
      fi
      if [ -f "$sample_adaptive_policy" ] &&
        [ ! -L "$sample_adaptive_policy" ] &&
        awk -F '\t' \
          -v policy="$sample_adaptive_cache_evidence_policy" \
          -v claim_scope="$sample_adaptive_expected_claim_scope" \
          -v required_host="$sample_adaptive_required_host" \
          -v selected_host="$(uname -s)" \
          -v required_runtime="$sample_adaptive_required_runtime" \
          -v selected_runtime="$sample_adaptive_expected_runtime" \
          -v memory_max="${cgroup_memory_max:-none}" \
          -v memory_high="${cgroup_memory_high:-none}" \
          -v swap_max="${cgroup_swap_max:-none}" \
          -v required_outcome="$sample_adaptive_expected_outcome" \
          -v required_class="$sample_adaptive_expected_class" \
          -v min_offers="$sample_adaptive_min_offers" \
          -v min_calls="$sample_adaptive_min_calls" \
          -v min_bytes="$sample_adaptive_min_bytes" \
          -v max_sample_errors="$sample_adaptive_max_sample_errors" \
          -v max_clock_errors="$sample_adaptive_max_clock_errors" \
          -v max_advice_errors="$sample_adaptive_max_advice_errors" \
          -v max_psi_breakers="$sample_adaptive_max_psi_breaker_trips" \
          -v max_refault_breakers="$sample_adaptive_max_refault_breaker_trips" \
          -v max_deferred_pin_errors="$sample_adaptive_max_deferred_wal_pin_errors" \
          -v max_contended_pin_failures="$sample_adaptive_max_contended_wal_pin_failures" \
          -v terminal_receipt="$sample_adaptive_terminal_receipt" \
          -v validator_sha="$adaptive_cache_validator_sha256" \
          -v manifest_sha="$sample_adaptive_expected_manifest" \
          -v scope_contract="$sample_adaptive_scope_contract" \
          -v cgroup_binding="$sample_adaptive_required_cgroup_binding" \
          -v limit_binding="$sample_adaptive_required_limit_binding" \
          -v monotonic_window="$sample_adaptive_required_monotonic_window" '
          NR == 1 {
            expected = "schema_version acceptance_policy claim_scope required_host selected_host required_runtime_mode selected_runtime_mode selected_memory_max selected_memory_high selected_swap_max required_outcome required_class min_class_offers min_class_advice_calls min_class_advised_bytes max_sample_errors max_clock_errors max_advice_errors max_psi_breaker_trips max_refault_breaker_trips max_deferred_wal_pin_errors max_contended_wal_pin_failures terminal_receipt validator_sha256 sealed_manifest_sha256 sample_scope_contract required_cgroup_binding required_limit_binding required_monotonic_window"
            split(expected, names, " ")
            if (NF != 29) exit 1
            for (field_index = 1; field_index <= NF; field_index++) {
              if ($field_index != names[field_index]) exit 1
            }
            next
          }
          NR == 2 {
            if (NF != 29 ||
                $1 != "oliphaunt.wasix-postmaster.adaptive-cache-evidence-policy.v3" ||
                $2 != policy || $3 != claim_scope ||
                $4 != required_host || $5 != selected_host ||
                $6 != required_runtime || $7 != selected_runtime ||
                $8 != memory_max || $9 != memory_high || $10 != swap_max ||
                $11 != required_outcome || $12 != required_class ||
                $13 != min_offers || $14 != min_calls || $15 != min_bytes ||
                $16 != max_sample_errors || $17 != max_clock_errors ||
                $18 != max_advice_errors || $19 != max_psi_breakers ||
                $20 != max_refault_breakers || $21 != max_deferred_pin_errors ||
                $22 != max_contended_pin_failures || $23 != terminal_receipt ||
                $24 != validator_sha || $25 != manifest_sha ||
                $26 != scope_contract || $27 != cgroup_binding ||
                $28 != limit_binding || $29 != monotonic_window) exit 1
            valid = 1
          }
          END { exit !(NR == 2 && valid) }
        ' "$sample_adaptive_policy"
      then
        sample_adaptive_policy_sha256="$(
          fresh_wasmer_bin_hash "$sample_adaptive_policy"
        )"
        if [ "$target" = native ]; then
          [ ! -e "$sample_adaptive_contract" ] &&
            [ ! -e "$sample_adaptive_telemetry" ] &&
            [ ! -e "$sample_adaptive_inner_validation" ] &&
            [ ! -e "$sample_adaptive_validation" ] &&
            sample_adaptive_status=0
        elif [ -f "$sample_adaptive_contract" ] &&
          [ ! -L "$sample_adaptive_contract" ] &&
          [ -f "$sample_server_lifecycle" ] &&
          [ ! -L "$sample_server_lifecycle" ] &&
          [ -f "$sample_adaptive_telemetry" ] &&
          [ ! -L "$sample_adaptive_telemetry" ] &&
          [ -f "$sample_adaptive_inner_validation" ] &&
          [ ! -L "$sample_adaptive_inner_validation" ]
        then
          sample_adaptive_contract_result="$(
            awk -F '\t' -v OFS='\t' \
              -v sample_label="$sample_label" -v target="$target" \
              -v acceptance="$sample_adaptive_cache_evidence_policy" \
              -v base_policy_sha="$sample_adaptive_policy_sha256" \
              -v validator_sha="$adaptive_cache_validator_sha256" \
              -v manifest_sha="$captured_carrier_manifest_sha256" \
              -v requested_max="$cgroup_memory_max" \
              -v requested_high="$cgroup_memory_high" \
              -v requested_swap="$cgroup_swap_max" \
              -v requested_max_bytes="$cgroup_memory_max_bytes" \
              -v requested_high_bytes="$cgroup_memory_high_bytes" \
              -v requested_swap_bytes="$cgroup_swap_max_bytes" '
              NR == 1 {
                expected = "schema_version measurement_id target acceptance_policy contract_mode base_policy_sha256 validator_sha256 manifest_sha256 cgroup_path cgroup_identity server_pid server_birth_identity cgroup_unit requested_memory_max requested_memory_high requested_swap_max requested_memory_max_bytes requested_memory_high_bytes requested_swap_max_bytes observed_initial_memory_max_bytes observed_initial_memory_high_bytes observed_initial_swap_max_bytes observed_final_memory_max_bytes observed_final_memory_high_bytes observed_final_swap_max_bytes sample_window_start_monotonic_ns sample_window_end_monotonic_ns status"
                split(expected, names, " ")
                if (NF != 28) exit 1
                for (field_index = 1; field_index <= NF; field_index++) {
                  if ($field_index != names[field_index]) exit 1
                }
                next
              }
              NR == 2 {
                if (NF != 28 ||
                    $1 != "oliphaunt.wasix-postmaster.adaptive-cache-sample-contract.v1" ||
                    $2 != sample_label || $3 != target || $4 != acceptance ||
                    $6 != base_policy_sha || $7 != validator_sha ||
                    $8 != manifest_sha || $28 != "passed" ||
                    $11 !~ /^[1-9][0-9]*$/ || $12 == "" ||
                    $12 ~ /[\t\r\n]/) exit 1
                if (acceptance == "constrained-linux-wal-action-v1") {
                  if ($5 != "constrained-exact-cgroup-time" ||
                      $9 !~ /^\// ||
                      $10 !~ /^[1-9][0-9]*:[1-9][0-9]*$/ ||
                      $13 !~ /^[A-Za-z0-9_.-]+$/ ||
                      substr($9, length($9) - length($13) - 6) != "/" $13 ".scope" ||
                      $14 != requested_max || $15 != requested_high ||
                      $16 != requested_swap || $17 != requested_max_bytes ||
                      $18 != requested_high_bytes || $19 != requested_swap_bytes ||
                      $20 != $17 || $21 != $18 || $22 != $19 ||
                      $23 != $17 || $24 != $18 || $25 != $19 ||
                      $26 !~ /^[0-9]+$/ || $27 !~ /^[0-9]+$/ ||
                      ($26 + 0) >= ($27 + 0)) exit 1
                } else {
                  if ($5 != "portable-not-required" ||
                      $9 != "none" || $10 != "none" ||
                      $14 != (requested_max == "" ? "none" : requested_max) ||
                      $15 != (requested_high == "" ? "none" : requested_high) ||
                      $16 != (requested_swap == "" ? "none" : requested_swap) ||
                      $17 != "none" || $18 != "none" || $19 != "none" ||
                      $20 != "none" || $21 != "none" || $22 != "none" ||
                      $23 != "none" || $24 != "none" || $25 != "none" ||
                      $26 != "none" || $27 != "none") exit 1
                }
                print $9, $10, $11, $12, $13, $17, $18, $19, $20, $21,
                  $22, $23, $24, $25, $26, $27
                valid = 1
              }
              END { exit !(NR == 2 && valid) }
            ' "$sample_adaptive_contract"
          )" || sample_adaptive_contract_result=""
          if [ -n "$sample_adaptive_contract_result" ]; then
            IFS=$'\t' read -r sample_adaptive_cgroup_path \
              sample_adaptive_cgroup_identity sample_adaptive_server_pid \
              sample_adaptive_server_birth_identity sample_adaptive_cgroup_unit \
              sample_requested_memory_max_bytes \
              sample_requested_memory_high_bytes sample_requested_swap_max_bytes \
              sample_adaptive_memory_max_bytes sample_adaptive_memory_high_bytes \
              sample_adaptive_swap_max_bytes sample_adaptive_final_memory_max_bytes \
              sample_adaptive_final_memory_high_bytes \
              sample_adaptive_final_swap_max_bytes sample_adaptive_window_start_ns \
              sample_adaptive_window_end_ns <<<"$sample_adaptive_contract_result"
            if [ "$sample_adaptive_cache_evidence_policy" = \
              constrained-linux-wal-action-v1 ]; then
              if [ "$sample_adaptive_memory_max_bytes" -le \
                "$sample_adaptive_memory_high_bytes" ]; then
                sample_adaptive_effective_limit_bytes="$sample_adaptive_memory_max_bytes"
              else
                sample_adaptive_effective_limit_bytes="$sample_adaptive_memory_high_bytes"
              fi
            fi
            sample_adaptive_contract_sha256="$(
              fresh_wasmer_bin_hash "$sample_adaptive_contract"
            )"
            sample_server_lifecycle_sha256="$(
              fresh_wasmer_bin_hash "$sample_server_lifecycle"
            )"
            sample_adaptive_telemetry_sha256="$(
              fresh_wasmer_bin_hash "$sample_adaptive_telemetry"
            )"
            sample_adaptive_inner_validation_sha256="$(
              fresh_wasmer_bin_hash "$sample_adaptive_inner_validation"
            )"
            lifecycle_bound=0
            if [ "$sample_adaptive_cache_evidence_policy" = constrained-linux-wal-action-v1 ]; then
              if awk -F '\t' \
                -v target="$target" -v path="$sample_adaptive_cgroup_path" \
                -v identity="$sample_adaptive_cgroup_identity" \
                -v server_pid="$sample_adaptive_server_pid" \
                -v birth_identity="$sample_adaptive_server_birth_identity" '
                NR == 1 {
                  expected = "target server_pid server_pgid server_birth_identity cgroup_path cgroup_identity orderly_int forced wait_status clean_shutdown_marker process_group_residue cgroup_residue port_residue status report"
                  split(expected, names, " ")
                  if (NF != 15) exit 1
                  for (field_index = 1; field_index <= NF; field_index++) {
                    if ($field_index != names[field_index]) exit 1
                  }
                  next
                }
                NR == 2 && NF == 15 && $1 == target && $2 == server_pid &&
                  $4 == birth_identity && $5 == path && $6 == identity &&
                  $14 == "passed" { valid = 1 }
                END { exit !(NR == 2 && valid) }
              ' "$sample_server_lifecycle"; then
                lifecycle_bound=1
              fi
            else
              lifecycle_bound=1
            fi
            inner_validation_bound=0
            if awk -F '\t' \
              -v validation_schema="$adaptive_cache_validation_schema" \
              -v acceptance="$sample_adaptive_cache_evidence_policy" \
              -v policy_id="$adaptive_cache_policy_id" \
              -v config_id="$adaptive_cache_config_id" \
              -v config_sha="$adaptive_cache_config_sha256" \
              -v runtime_abi="$adaptive_cache_runtime_abi_id" \
              -v telemetry_sha="$sample_adaptive_telemetry_sha256" \
              -v manifest_sha="$captured_carrier_manifest_sha256" \
              -v validator_sha="$adaptive_cache_validator_sha256" \
              -v cgroup_identity="$sample_adaptive_cgroup_identity" \
              -v memory_max="$sample_adaptive_memory_max_bytes" \
              -v memory_high="$sample_adaptive_memory_high_bytes" \
              -v effective_limit="$sample_adaptive_effective_limit_bytes" \
              -v swap_max="$sample_adaptive_swap_max_bytes" \
              -v window_start="$sample_adaptive_window_start_ns" \
              -v window_end="$sample_adaptive_window_end_ns" \
              -v sample_label="$sample_label" -v target="$target" '
              NR == 1 {
                expected = "schema_version status outcome reason workload_id policy_id config_id config_sha256 acceptance_policy runtime_abi_id state sample_count valid_offers advice_calls advised_bytes class6_offers class6_advice_calls class6_advised_bytes class6_advice_errors sample_errors clock_errors advice_errors wal_dirty_veto_bypasses wal_dirty_veto_bypass_bytes telemetry_sha256 manifest_sha256 validator_sha256 cgroup_identity cgroup_memory_max_bytes cgroup_memory_high_bytes cgroup_swap_max_bytes sample_window_start_monotonic_ns sample_window_end_monotonic_ns membership_leaf_identity pressure_source_identity last_sample_monotonic_ns last_sample_effective_limit_bytes measurement_id target"
                split(expected, names, " ")
                if (NF != 39) exit 1
                for (field_index = 1; field_index <= NF; field_index++) {
                  if ($field_index != names[field_index]) exit 1
                }
                next
              }
              NR == 2 {
                if (NF != 39 || $1 != validation_schema || $2 != "passed" ||
                    $5 != "runtime:postgres" || $6 != policy_id ||
                    $7 != config_id || $8 != config_sha || $9 != acceptance ||
                    $10 != runtime_abi || $25 != telemetry_sha ||
                    $26 != manifest_sha || $27 != validator_sha ||
                    $38 != sample_label || $39 != target) exit 1
                if (acceptance == "constrained-linux-wal-action-v1" &&
                    ($28 != cgroup_identity || $29 != memory_max ||
                     $30 != memory_high || $31 != swap_max ||
                     $32 != window_start || $33 != window_end ||
                     $34 != cgroup_identity || $35 != cgroup_identity ||
                     $37 != effective_limit ||
                     $38 != sample_label || $39 != target)) exit 1
                valid = 1
              }
              END { exit !(NR == 2 && valid) }
            ' "$sample_adaptive_inner_validation"; then
              inner_validation_bound=1
            fi
            adaptive_validator_args=(
              --telemetry "$sample_adaptive_telemetry"
              --manifest "$sealed_carrier/manifest.json"
              --output "$sample_adaptive_validation"
              --acceptance-policy "$sample_adaptive_cache_evidence_policy"
              --measurement-id "$sample_label"
              --target "$target"
            )
            if [ "$sample_adaptive_cache_evidence_policy" = constrained-linux-wal-action-v1 ]; then
              adaptive_validator_args+=(
                --cgroup-identity "$sample_adaptive_cgroup_identity"
                --cgroup-memory-max-bytes "$sample_adaptive_memory_max_bytes"
                --cgroup-memory-high-bytes "$sample_adaptive_memory_high_bytes"
                --cgroup-swap-max-bytes "$sample_adaptive_swap_max_bytes"
                --sample-window-start-monotonic-ns "$sample_adaptive_window_start_ns"
                --sample-window-end-monotonic-ns "$sample_adaptive_window_end_ns"
              )
            fi
            if [ "$lifecycle_bound" -eq 1 ] &&
              [ "$inner_validation_bound" -eq 1 ] &&
              assert_frozen_qualification_policy &&
              assert_frozen_carrier "$sample_label:adaptive-revalidation-before" &&
              python3 "$adaptive_cache_validator" "${adaptive_validator_args[@]}" &&
              assert_frozen_carrier "$sample_label:adaptive-revalidation-after"
            then
              adaptive_result="$(
                awk -F '\t' -v OFS='\t' \
                  -v sample_label="$sample_label" -v target="$target" \
                  -v validation_schema="$adaptive_cache_validation_schema" \
                  -v acceptance="$sample_adaptive_cache_evidence_policy" \
                  -v policy_id="$adaptive_cache_policy_id" \
                  -v config_id="$adaptive_cache_config_id" \
                  -v config_sha="$adaptive_cache_config_sha256" \
                  -v runtime_abi="$adaptive_cache_runtime_abi_id" \
                  -v warmup="$adaptive_cache_warmup_samples" \
                  -v telemetry_sha="$sample_adaptive_telemetry_sha256" \
                  -v manifest_sha="$captured_carrier_manifest_sha256" \
                  -v validator_sha="$adaptive_cache_validator_sha256" \
                  -v cgroup_identity="$sample_adaptive_cgroup_identity" \
                  -v memory_max="$sample_adaptive_memory_max_bytes" \
                  -v memory_high="$sample_adaptive_memory_high_bytes" \
                  -v effective_limit="$sample_adaptive_effective_limit_bytes" \
                  -v swap_max="$sample_adaptive_swap_max_bytes" \
                  -v window_start="$sample_adaptive_window_start_ns" \
                  -v window_end="$sample_adaptive_window_end_ns" '
            NR == 1 {
              expected = "schema_version status outcome reason workload_id policy_id config_id config_sha256 acceptance_policy runtime_abi_id state sample_count valid_offers advice_calls advised_bytes class6_offers class6_advice_calls class6_advised_bytes class6_advice_errors sample_errors clock_errors advice_errors wal_dirty_veto_bypasses wal_dirty_veto_bypass_bytes telemetry_sha256 manifest_sha256 validator_sha256 cgroup_identity cgroup_memory_max_bytes cgroup_memory_high_bytes cgroup_swap_max_bytes sample_window_start_monotonic_ns sample_window_end_monotonic_ns membership_leaf_identity pressure_source_identity last_sample_monotonic_ns last_sample_effective_limit_bytes measurement_id target"
              split(expected, names, " ")
              if (NF != 39) exit 1
              for (field_index = 1; field_index <= NF; field_index++) {
                if ($field_index != names[field_index]) exit 1
              }
              next
            }
            NR == 2 {
              if (NF != 39 || $1 != validation_schema ||
                  $2 != "passed" || $5 != "runtime:postgres" ||
                  $6 != policy_id || $7 != config_id || $8 != config_sha ||
                  $9 != acceptance || $10 != runtime_abi ||
                  $25 != telemetry_sha ||
                  $26 != manifest_sha || $27 != validator_sha ||
                  $38 != sample_label || $39 != target) exit 1
              if (acceptance == "constrained-linux-wal-action-v1") {
                if ($3 != "adaptive-active" || $16 !~ /^[1-9][0-9]*$/ ||
                    $17 !~ /^[1-9][0-9]*$/ || $18 !~ /^[1-9][0-9]*$/ ||
                    $12 !~ /^[0-9]+$/ || ($12 + 0) < (warmup + 0) ||
                    $19 != 0 || $20 != 0 || $21 != 0 || $22 != 0 ||
                    $28 != cgroup_identity || $29 != memory_max ||
                    $30 != memory_high || $31 != swap_max ||
                    $32 != window_start || $33 != window_end ||
                    $34 != cgroup_identity || $35 != cgroup_identity ||
                    $36 !~ /^[0-9]+$/ || ($36 + 0) < (window_start + 0) ||
                    ($36 + 0) > (window_end + 0) ||
                    $37 != effective_limit) exit 1
              } else if ($3 != "adaptive-active" &&
                         $3 != "observe-only-fallback") {
                exit 1
              }
              print $3, $6, $7, $8, $10, $28, $29, $30, $31, $32,
                $33, $34, $35, $36, $37, $16, $17, $18, $20, $21, $22
              valid = 1
            }
            END { exit !(NR == 2 && valid) }
                ' "$sample_adaptive_validation"
              )" || adaptive_result=""
              if [ -n "$adaptive_result" ] &&
                [ "$(fresh_wasmer_bin_hash "$sample_adaptive_telemetry")" = \
                  "$sample_adaptive_telemetry_sha256" ]; then
                IFS=$'\t' read -r sample_adaptive_outcome \
                  sample_adaptive_policy_id sample_adaptive_config_id \
                  sample_adaptive_config_sha256 sample_adaptive_runtime_abi_id \
                  sample_adaptive_cgroup_identity sample_adaptive_memory_max_bytes \
                  sample_adaptive_memory_high_bytes sample_adaptive_swap_max_bytes \
                  sample_adaptive_window_start_ns sample_adaptive_window_end_ns \
                  sample_adaptive_membership_identity \
                  sample_adaptive_pressure_identity sample_adaptive_last_sample_ns \
                  sample_adaptive_last_sample_limit_bytes \
                  sample_adaptive_class6_offers \
                  sample_adaptive_class6_advice_calls \
                  sample_adaptive_class6_advised_bytes \
                  sample_adaptive_sample_errors sample_adaptive_clock_errors \
                  sample_adaptive_advice_errors <<<"$adaptive_result"
                sample_adaptive_validation_sha256="$(
                  fresh_wasmer_bin_hash "$sample_adaptive_validation"
                )"
                sample_adaptive_status=0
              fi
            fi
          fi
        fi
      fi
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$sample_label" "$target" "$sample_adaptive_cache_evidence_policy" \
        "$sample_adaptive_policy" "$sample_adaptive_policy_sha256" \
        "$sample_adaptive_contract" "$sample_adaptive_contract_sha256" \
        "$sample_server_lifecycle" "$sample_server_lifecycle_sha256" \
        "$sample_adaptive_telemetry" "$sample_adaptive_telemetry_sha256" \
        "$sample_adaptive_inner_validation" \
        "$sample_adaptive_inner_validation_sha256" \
        "$sample_adaptive_validation" "$sample_adaptive_validation_sha256" \
        "$sample_adaptive_outcome" "$sample_adaptive_policy_id" \
        "$sample_adaptive_config_id" "$sample_adaptive_config_sha256" \
        "$sample_adaptive_runtime_abi_id" "$sample_adaptive_cgroup_identity" \
        "$sample_adaptive_memory_max_bytes" \
        "$sample_adaptive_memory_high_bytes" "$sample_adaptive_swap_max_bytes" \
        "$sample_adaptive_final_memory_max_bytes" \
        "$sample_adaptive_final_memory_high_bytes" \
        "$sample_adaptive_final_swap_max_bytes" \
        "$sample_adaptive_window_start_ns" "$sample_adaptive_window_end_ns" \
        "$sample_adaptive_membership_identity" \
        "$sample_adaptive_pressure_identity" "$sample_adaptive_last_sample_ns" \
        "$sample_adaptive_last_sample_limit_bytes" \
        "$sample_adaptive_class6_offers" \
        "$sample_adaptive_class6_advice_calls" \
        "$sample_adaptive_class6_advised_bytes" \
        "$sample_adaptive_sample_errors" "$sample_adaptive_clock_errors" \
        "$sample_adaptive_advice_errors" \
        "$([ "$sample_adaptive_status" -eq 0 ] && printf passed || printf failed)" \
        >>"$adaptive_cache_verification_tsv"
      if [ -f "$sample_instrumentation" ] && [ ! -L "$sample_instrumentation" ] &&
        awk -F '\t' '
          NR == 1 {
            if ($1 != "schema_version" || $2 != "lane" ||
                $3 != "wasix_perf_stats" || $4 != "wait_dump_policy" ||
                $5 != "wait_dump_interval_ms" ||
                $6 != "wait_dump_max_per_wait" || $7 != "wait_dump_verbose" ||
                $8 != "fence_protocol" || $9 != "sanitized_environment") exit 1
          }
          NR == 2 {
            if ($1 != "oliphaunt.wasix-postmaster.instrumentation.v1" ||
                $2 != "benchmark" || $3 != 0 || $4 != "prohibited" ||
                $5 != 0 || $6 != 0 || $7 != 0 || $8 != "none") exit 1
            valid = 1
          }
          END { exit !(NR == 2 && valid) }
        ' "$sample_instrumentation"
      then
        sample_instrumentation_status=0
        sample_instrumentation_sha256="$(fresh_wasmer_bin_hash "$sample_instrumentation")"
      fi
      printf '%s\t%s\t%s\t%s\n' "$sample_label" "$sample_instrumentation" \
        "$sample_instrumentation_sha256" \
        "$([ "$sample_instrumentation_status" -eq 0 ] && printf passed || printf failed)" \
        >>"$instrumentation_verification_tsv"
      if [ "$profile_resolution_active" -eq 1 ]; then
        if [ ! -f "$sample_profile_inputs" ] || [ -L "$sample_profile_inputs" ] ||
          [ ! -f "$sample_profile_resolution" ] || [ -L "$sample_profile_resolution" ] ||
          ! cmp -s "$qualification_postgres_profile_inputs" "$sample_profile_inputs" ||
          ! cmp -s "$qualification_postgres_profile_resolution" "$sample_profile_resolution"; then
          printf 'sample PostgreSQL profile evidence does not match qualification inputs: %s\n' \
            "$sample_report" >&2
          sample_profile_evidence_status=1
        fi
      fi
      settings_source="$sample_report/$target/effective-postgres-settings.tsv"
      settings_path="$qualification_root/effective-settings/$sample_label.tsv"
      settings_sha256=""
      if [ -f "$settings_source" ] && [ ! -L "$settings_source" ]; then
        settings_source_sha256="$(fresh_wasmer_bin_hash "$settings_source")"
        cp -p "$settings_source" "$settings_path"
        settings_sha256="$(fresh_wasmer_bin_hash "$settings_path")"
        if [ "$settings_source_sha256" != "$settings_sha256" ] ||
          [ "$(fresh_wasmer_bin_hash "$settings_source")" != "$settings_sha256" ]; then
          printf 'effective PostgreSQL settings changed while captured: %s\n' \
            "$settings_source" >&2
          settings_sha256=""
          rm -f "$settings_path"
        else
          chmod 0444 "$settings_path"
        fi
      fi
      sample_profile_settings_status=0
      if [ "$profile_resolution_active" -eq 1 ]; then
        profile_validation_path="$qualification_root/effective-settings/$sample_label.profile-validation.tsv"
        if [ -z "$settings_sha256" ]; then
          sample_profile_settings_status=1
        elif fresh_validate_postgres_profile_settings \
          "$settings_path" "$profile_validation_path"; then
          sample_profile_settings_status=0
        else
          sample_profile_settings_status=$?
        fi
      fi
      row=""
      if [ -s "$sample_summary" ] && [ ! -L "$sample_summary" ] &&
        [ "$(sed -n '1p' "$sample_summary")" = "$expected_sample_summary_header" ]; then
        row="$(awk -F '\t' 'NR == 2 { print $3 "\t" $10 "\t" $9 "\t" $6 }' "$sample_summary")"
      fi
      if [ -n "$row" ]; then
        IFS=$'\t' read -r workload_status throughput wall_ms operation_count <<<"$row"
      else
        workload_status=1
        throughput=""
        wall_ms=""
        operation_count=""
      fi

      client_rows=0
      client_evidence_status=1
      if [ -s "$sample_clients" ] && [ ! -L "$sample_clients" ] &&
        [ "$(sed -n '1p' "$sample_clients")" = "$expected_client_summary_header" ]; then
        read -r client_rows client_evidence_status < <(
          awk -F '\t' '
            NR > 1 {
              rows += 1
              if ($4 != "0") invalid = 1
            }
            END { printf "%d %d\n", rows, (rows > 0 && !invalid) ? 0 : 1 }
          ' "$sample_clients"
        )
      fi
      if [ "$client_rows" -ne "$connections" ]; then
        client_evidence_status=1
      fi

      effective_status=0
      if [ "$harness_status" -ne 0 ]; then
        effective_status="$harness_status"
      elif [ "$workload_status" != "0" ] || [ "$client_evidence_status" -ne 0 ]; then
        effective_status=1
      elif [ -z "$settings_sha256" ]; then
        effective_status=1
      elif [ "$sample_profile_evidence_status" -ne 0 ] ||
        [ "$sample_profile_settings_status" -ne 0 ]; then
        effective_status=1
      elif [ "$sample_instrumentation_status" -ne 0 ]; then
        effective_status=1
      elif [ "$sample_adaptive_status" -ne 0 ]; then
        effective_status=1
      elif [ "$sample_loader_status" -ne 0 ]; then
        effective_status=1
      fi
      derived_metrics_valid=1
      if [ "$effective_status" -ne 0 ] || [ -z "$throughput" ] ||
        [ -z "$wall_ms" ] || [ -z "$operation_count" ]; then
        derived_metrics_valid=0
        throughput=""
        wall_ms=""
      fi
      if [ "$derived_metrics_valid" -ne 1 ]; then
        overall_status=1
      fi
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$block" "$workload" "$pair" "$position" "$target" "$sample_label" \
        "$workload_status" "$harness_status" "$effective_status" \
        "$derived_metrics_valid" "$throughput" "$wall_ms" "$operation_count" \
        "$sample_report" "$settings_path" "$settings_sha256" \
        "$frozen_carrier_closure_identity" \
        "${FRESH_POSTGRES_PROFILE_RESOLUTION_IDENTITY:-}" \
        "$frozen_native_oracle_identity" >>"$raw_tsv"
      if [ "$client_rows" -gt 0 ]; then
        awk -F '\t' -v OFS='\t' \
          -v block="$block" -v workload="$workload" -v pair="$pair" \
          -v position="$position" -v target="$target" -v report="$sample_report" \
          -v workload_status="$workload_status" -v harness_status="$harness_status" \
          -v effective_status="$effective_status" \
          -v derived_metrics_valid="$derived_metrics_valid" \
          -v settings_sha256="$settings_sha256" \
          -v carrier_identity="$frozen_carrier_closure_identity" \
          -v profile_identity="${FRESH_POSTGRES_PROFILE_RESOLUTION_IDENTITY:-}" \
          -v native_oracle_identity="$frozen_native_oracle_identity" '
          NR > 1 {
            residual = ""
            if ($6 != "" && $7 > 0) {
              residual = sprintf("%.3f", $5 - $6)
            }
            print block, workload, pair, position, target, $3, $4,
              workload_status, harness_status, effective_status,
              derived_metrics_valid, $5, $6, $7, residual, report,
              settings_sha256, carrier_identity, profile_identity,
              native_oracle_identity
          }
        ' "$sample_clients" >>"$bulk_batch_raw_tsv"
      else
        printf '%s\t%s\t%s\t%s\t%s\t\t1\t%s\t%s\t%s\t0\t\t\t0\t\t%s\t%s\t%s\t%s\t%s\n' \
          "$block" "$workload" "$pair" "$position" "$target" \
          "$workload_status" "$harness_status" "$effective_status" \
          "$sample_report" "$settings_sha256" \
          "$frozen_carrier_closure_identity" \
          "${FRESH_POSTGRES_PROFILE_RESOLUTION_IDENTITY:-}" \
          "$frozen_native_oracle_identity" \
          >>"$bulk_batch_raw_tsv"
        overall_status=1
      fi
      if [ $((position % 2)) -eq 1 ]; then
        pair_first_target="$target"
        pair_first_settings="$settings_path"
      else
        comparison="$qualification_root/profile-comparisons/$(printf 'b%02d-%s-pair%s.tsv' "$block" "$workload" "$pair")"
        native_settings=""
        wasix_settings=""
        if [ "$pair_first_target" = native ]; then
          native_settings="$pair_first_settings"
          wasix_settings="$settings_path"
        else
          native_settings="$settings_path"
          wasix_settings="$pair_first_settings"
        fi
        profile_status=failed
        if [ -f "$native_settings" ] && [ ! -L "$native_settings" ] &&
          [ -f "$wasix_settings" ] && [ ! -L "$wasix_settings" ]; then
          set +e
          "$FRESH_ROOT/bin/compare-postgres-settings.py" \
            "$native_settings" "$wasix_settings" "$comparison"
          compare_status=$?
          set -e
          [ "$compare_status" -eq 0 ] && profile_status=passed
        fi
        printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
          "$block" "$workload" "$pair" "$pair_first_target" "$target" \
          "$native_settings" "$wasix_settings" "$comparison" "$profile_status" \
          >>"$profile_tsv"
        if [ "$profile_status" != passed ]; then
          overall_status=1
        fi
        pair_first_target=""
        pair_first_settings=""
      fi
    done
  done
done

if [ "$adaptive_cache_evidence_policy" = constrained-linux-wal-action-v1 ] &&
  ! awk -F '\t' '
  NR == 1 {
    if (NF != 40 || $1 != "sample" || $2 != "target" ||
        $3 != "acceptance_policy" || $40 != "status") exit 1
    next
  }
  $2 == "wasix" && $3 == "constrained-linux-wal-action-v1" {
    if ($40 != "passed" || $7 !~ /^[0-9a-f]{64}$/ ||
        $11 !~ /^[0-9a-f]{64}$/ ||
        $21 !~ /^[1-9][0-9]*:[1-9][0-9]*$/ ||
        $28 !~ /^[0-9]+$/ || $29 !~ /^[0-9]+$/ ||
        contract[$7]++ || telemetry[$11]++ || cgroup[$21]++ ||
        window[$28 ":" $29]++) exit 1
    constrained++
  }
  END { exit constrained == 0 }
' "$adaptive_cache_verification_tsv"
then
  echo 'constrained adaptive evidence is missing or reuses a sample identity' >&2
  overall_status=1
fi

if ! assert_frozen_carrier final full; then
  overall_status=1
fi
if ! assert_frozen_immutable_carrier final; then
  overall_status=1
fi
if ! assert_frozen_qualification_policy; then
  overall_status=1
fi
if ! assert_frozen_native_oracle final; then
  overall_status=1
fi
if [ "$profile_resolution_active" -eq 1 ] &&
  ! fresh_assert_postgres_profile_inputs; then
  overall_status=1
fi
wasix_execution_reports=()
while IFS= read -r sample_report; do
  [ -n "$sample_report" ] && wasix_execution_reports+=("$sample_report")
done < <(awk -F '\t' 'NR > 1 && $5 == "wasix" { print $14 }' "$raw_tsv" | LC_ALL=C sort -u)
if fresh_freeze_wasix_execution_identity \
  "$wasix_execution_identity_tsv" \
  "$frozen_carrier_closure_identity" \
  "$captured_carrier_manifest_sha256" \
  "$captured_carrier_receipt_sha256" \
  "$captured_carrier_payload_sha256" \
  "$captured_carrier_headless_sha256" \
  "${runtime_footprint:-none}" \
  "${FRESH_POSTGRES_RUNTIME_FOOTPRINT_SHA256:-none}" \
  "${durability_profile:-none}" \
  "${FRESH_POSTGRES_DURABILITY_SHA256:-none}" \
  "${FRESH_POSTGRES_PROFILE_RESOLUTION_IDENTITY:-none}" \
  "${wasix_execution_reports[@]}"; then
  wasix_execution_identity_sha256="$FRESH_QUALIFICATION_EXECUTION_IDENTITY_SHA256"
  wasix_postgres_module_sha256="$FRESH_QUALIFICATION_POSTGRES_MODULE_SHA256"
else
  overall_status=1
fi
chmod 0444 "$carrier_verification_tsv"
chmod 0444 "$native_oracle_verification_tsv"
chmod 0444 "$immutable_carrier_verification_tsv"
chmod 0444 "$sealed_loader_verification_tsv"
chmod 0444 "$adaptive_cache_verification_tsv"

set +e
perl - "$raw_tsv" "$blocks" "$min_ratio" "$min_lcb" >"$paired_tsv" <<'PERL'
use strict;
use warnings;

my ($input, $blocks, $min_ratio, $min_lcb) = @ARGV;
open my $fh, '<', $input or die "open $input: $!";
my $header = <$fh>;
my %pairs;
my %samples;
my %failed;
my %workloads;
while (my $line = <$fh>) {
    chomp $line;
    my ($block, $workload, $pair, $position, $target, $label,
        $workload_status, $harness_status, $effective_status, $valid, $rate) =
        split /\t/, $line, -1;
    $workloads{$workload} = 1;
    $failed{$workload} = 1
        if $workload_status ne '0' || $harness_status ne '0' ||
           $effective_status ne '0' || $valid ne '1' || $rate eq '';
    next if $valid ne '1' || $rate eq '';
    push @{$samples{$workload}{$target}}, 0 + $rate;
    $pairs{$workload}{"$block:$pair"}{$target} = 0 + $rate;
}

sub median {
    my @values = sort { $a <=> $b } @_;
    return 0 unless @values;
    my $middle = int(@values / 2);
    return @values % 2 ? $values[$middle] : ($values[$middle - 1] + $values[$middle]) / 2;
}

sub bootstrap_lcb {
    my ($values) = @_;
    return 0 unless @$values;
    srand(0x4f4c4950);
    my @medians;
    for (1 .. 20_000) {
        my @sample = map { $values->[int(rand(@$values))] } 1 .. @$values;
        push @medians, median(@sample);
    }
    @medians = sort { $a <=> $b } @medians;
    return $medians[int(0.05 * $#medians)];
}

print join("\t", qw(workload paired_samples native_samples wasix_samples
    native_median_ops_per_sec wasix_median_ops_per_sec ratio_of_medians
    paired_ratio_median paired_ratio_lcb95 paired_ratio_min status)), "\n";
my $exit = 0;
for my $workload (sort keys %workloads) {
    my @ratios;
    for my $pair_id (sort keys %{$pairs{$workload} // {}}) {
        my $pair = $pairs{$workload}{$pair_id};
        if (!defined $pair->{native} || !defined $pair->{wasix} || $pair->{native} <= 0) {
            $failed{$workload} = 1;
            next;
        }
        push @ratios, $pair->{wasix} / $pair->{native};
    }
    my @native = @{$samples{$workload}{native} // []};
    my @wasix = @{$samples{$workload}{wasix} // []};
    my $native_median = median(@native);
    my $wasix_median = median(@wasix);
    my $ratio_of_medians = $native_median > 0 ? $wasix_median / $native_median : 0;
    my $paired_median = median(@ratios);
    my $lcb = bootstrap_lcb(\@ratios);
    my $minimum = @ratios ? (sort { $a <=> $b } @ratios)[0] : 0;
    my $expected_pairs = 2 * $blocks;
    my $status = (!$failed{$workload} && @ratios == $expected_pairs &&
        $paired_median >= $min_ratio && $lcb >= $min_lcb) ? 'passed' : 'failed';
    $exit = 1 if $status ne 'passed';
    printf "%s\t%d\t%d\t%d\t%.3f\t%.3f\t%.6f\t%.6f\t%.6f\t%.6f\t%s\n",
        $workload, scalar(@ratios), scalar(@native), scalar(@wasix),
        $native_median, $wasix_median, $ratio_of_medians, $paired_median,
        $lcb, $minimum, $status;
}
exit $exit;
PERL
summary_status=$?
set -e
if [ "$summary_status" -ne 0 ]; then
  overall_status=1
fi

set +e
perl - "$bulk_batch_raw_tsv" "$blocks" "$connections" \
  "$max_batch_wall_p95" "$max_batch_wall_p99" \
  "$max_batch_residual_delta_p95_ms" \
  "$max_batch_residual_delta_p99_ms" >"$bulk_batch_tsv" <<'PERL'
use strict;
use warnings;

my ($input, $blocks, $connections, $max_wall_p95, $max_wall_p99,
    $max_residual_delta_p95, $max_residual_delta_p99) = @ARGV;
open my $fh, '<', $input or die "open $input: $!";
my $header = <$fh>;
my (%pairs, %failed, %workloads);
while (my $line = <$fh>) {
    chomp $line;
    my ($block, $workload, $pair, $position, $target, $client,
        $client_status, $workload_status, $harness_status, $effective_status,
        $valid, $wall, $query, $query_count, $residual) = split /\t/, $line, -1;
    $workloads{$workload} = 1;
    my $id = join ':', $block, $pair, $client;
    $failed{$workload} = 1
        if $client_status ne '0' || $workload_status ne '0' ||
           $harness_status ne '0' || $effective_status ne '0' || $valid ne '1' ||
           $wall eq '' || $query eq '' || $query_count !~ /^[1-9][0-9]*$/ ||
           $residual eq '';
    next if $client_status ne '0' || $workload_status ne '0' ||
            $harness_status ne '0' || $effective_status ne '0' || $valid ne '1' ||
            $wall eq '' || $query eq '' || $query_count !~ /^[1-9][0-9]*$/ ||
            $residual eq '';
    $pairs{$workload}{$id}{$target} = {
        wall => 0 + $wall,
        query => 0 + $query,
        residual => 0 + $residual,
    };
}

sub quantile {
    my ($values, $fraction) = @_;
    return 0 unless @$values;
    my @sorted = sort { $a <=> $b } @$values;
    my $rank = int($fraction * @sorted + 0.999999999) - 1;
    $rank = 0 if $rank < 0;
    $rank = $#sorted if $rank > $#sorted;
    return $sorted[$rank];
}

print join("\t", qw(workload paired_bulk_batch_samples
    native_bulk_batch_wall_p50_ms native_bulk_batch_wall_p95_ms native_bulk_batch_wall_p99_ms
    wasix_bulk_batch_wall_p50_ms wasix_bulk_batch_wall_p95_ms wasix_bulk_batch_wall_p99_ms
    paired_bulk_batch_wall_ratio_p50 paired_bulk_batch_wall_ratio_p95 paired_bulk_batch_wall_ratio_p99
    paired_bulk_batch_psql_time_sum_ratio_p50 paired_bulk_batch_psql_time_sum_ratio_p95 paired_bulk_batch_psql_time_sum_ratio_p99
    paired_bulk_batch_residual_delta_p50_ms paired_bulk_batch_residual_delta_p95_ms paired_bulk_batch_residual_delta_p99_ms
    status)), "\n";
my $exit = 0;
for my $workload (sort keys %workloads) {
    my (@native_wall, @wasix_wall, @wall_ratios, @query_ratios, @residual_deltas);
    for my $id (sort keys %{$pairs{$workload} // {}}) {
        my $pair = $pairs{$workload}{$id};
        if (!defined $pair->{native} || !defined $pair->{wasix} ||
            $pair->{native}{wall} <= 0 || $pair->{native}{query} <= 0) {
            $failed{$workload} = 1;
            next;
        }
        push @native_wall, $pair->{native}{wall};
        push @wasix_wall, $pair->{wasix}{wall};
        push @wall_ratios, $pair->{wasix}{wall} / $pair->{native}{wall};
        push @query_ratios, $pair->{wasix}{query} / $pair->{native}{query};
        push @residual_deltas,
            $pair->{wasix}{residual} - $pair->{native}{residual};
    }
    my $expected = 2 * $blocks * $connections;
    my $wall_ratio_p95 = quantile(\@wall_ratios, 0.95);
    my $wall_ratio_p99 = quantile(\@wall_ratios, 0.99);
    my $residual_delta_p95 = quantile(\@residual_deltas, 0.95);
    my $residual_delta_p99 = quantile(\@residual_deltas, 0.99);
    my $status = (!$failed{$workload} && @wall_ratios == $expected &&
        $wall_ratio_p95 <= $max_wall_p95 && $wall_ratio_p99 <= $max_wall_p99 &&
        $residual_delta_p95 <= $max_residual_delta_p95 &&
        $residual_delta_p99 <= $max_residual_delta_p99)
        ? 'passed' : 'failed';
    $exit = 1 if $status ne 'passed';
    printf "%s\t%d\t%.3f\t%.3f\t%.3f\t%.3f\t%.3f\t%.3f\t%.6f\t%.6f\t%.6f\t%.6f\t%.6f\t%.6f\t%.3f\t%.3f\t%.3f\t%s\n",
        $workload, scalar(@wall_ratios),
        quantile(\@native_wall, 0.50), quantile(\@native_wall, 0.95),
        quantile(\@native_wall, 0.99), quantile(\@wasix_wall, 0.50),
        quantile(\@wasix_wall, 0.95), quantile(\@wasix_wall, 0.99),
        quantile(\@wall_ratios, 0.50), $wall_ratio_p95, $wall_ratio_p99,
        quantile(\@query_ratios, 0.50), quantile(\@query_ratios, 0.95),
        quantile(\@query_ratios, 0.99), quantile(\@residual_deltas, 0.50),
        $residual_delta_p95, $residual_delta_p99, $status;
}
exit $exit;
PERL
bulk_batch_status=$?
set -e
if [ "$bulk_batch_status" -ne 0 ]; then
  overall_status=1
fi

classification="throughput-diagnostic-non-release"
if [ "$blocks" -ge 10 ] && [ "$overall_status" -eq 0 ]; then
  classification="throughput-qualified-non-release"
elif [ "$blocks" -ge 10 ]; then
  classification="failed-throughput-qualification-non-release"
fi
printf 'schema_version\tstatus\tclassification\tdetail\tcarrier_closure_identity\tnative_oracle_identity\tpostgres_profile_resolution_identity\truntime_footprint_sha256\tdurability_profile_sha256\tqualification_policy_sha256\tsamples_sha256\tpaired_summary_sha256\tbulk_batch_samples_sha256\tbulk_batch_summary_sha256\twasix_execution_identity_sha256\tpostgres_module_sha256\timmutable_carrier_verification_sha256\tsealed_loader_verification_sha256\tcore_profile\tguest_build_recipe_sha256\timmutable_verification_scope\tcgroup_binding\tcgroup_memory_max\tcgroup_memory_high\tcgroup_swap_max\tcgroup_environment_action\tadaptive_cache_evidence_policy\tadaptive_cache_validator_sha256\tadaptive_cache_verification_sha256\tadaptive_cache_validation_schema\tadaptive_cache_policy_id\tadaptive_cache_config_id\tadaptive_cache_config_sha256\tadaptive_cache_warmup_samples\tadaptive_cache_runtime_abi_id\tadaptive_cache_sample_contract_schema\twasix_shared_memory_provider\n' \
  >"$qualification_result_tsv"
printf 'oliphaunt.wasix-postmaster.throughput-result.v7\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
  "$([ "$overall_status" -eq 0 ] && printf passed || printf failed)" \
  "$classification" \
  "$([ "$overall_status" -eq 0 ] && printf all-declared-throughput-gates-passed || printf one-or-more-throughput-gates-failed)" \
  "$frozen_carrier_closure_identity" \
  "$frozen_native_oracle_identity" \
  "${FRESH_POSTGRES_PROFILE_RESOLUTION_IDENTITY:-none}" \
  "${FRESH_POSTGRES_RUNTIME_FOOTPRINT_SHA256:-none}" \
  "${FRESH_POSTGRES_DURABILITY_SHA256:-none}" \
  "$qualification_policy_identity" \
  "$(fresh_wasmer_bin_hash "$raw_tsv")" \
  "$(fresh_wasmer_bin_hash "$paired_tsv")" \
  "$(fresh_wasmer_bin_hash "$bulk_batch_raw_tsv")" \
  "$(fresh_wasmer_bin_hash "$bulk_batch_tsv")" \
  "$wasix_execution_identity_sha256" \
  "$wasix_postgres_module_sha256" \
  "$(fresh_wasmer_bin_hash "$immutable_carrier_verification_tsv")" \
  "$(fresh_wasmer_bin_hash "$sealed_loader_verification_tsv")" \
  "$captured_core_profile" "$captured_guest_build_recipe_sha256" \
  "$([ "$require_zero_write_aot" -eq 1 ] && printf campaign-boundary-full-fast-samples || printf full-per-check)" \
  "$cgroup_binding" "${cgroup_memory_max:-none}" \
  "${cgroup_memory_high:-none}" "${cgroup_swap_max:-none}" \
  "$cgroup_environment_action" "$adaptive_cache_evidence_policy" \
  "$adaptive_cache_validator_sha256" \
  "$(fresh_wasmer_bin_hash "$adaptive_cache_verification_tsv")" \
  "$adaptive_cache_validation_schema" "$adaptive_cache_policy_id" \
  "$adaptive_cache_config_id" "$adaptive_cache_config_sha256" \
  "$adaptive_cache_warmup_samples" "$adaptive_cache_runtime_abi_id" \
  "$adaptive_cache_sample_contract_schema" "$shared_memory_provider" \
  >>"$qualification_result_tsv"
chmod 0444 "$qualification_result_tsv"
fresh_write_report_header "$summary" "WASIX Single-Backend Qualification"
{
  printf -- '- Classification: `%s`\n' "$classification"
  printf -- '- Composition scope: `throughput-only; lifecycle and memory evidence are not consumed, so this result cannot assert embedded viability or release readiness`\n'
  printf -- '- Pre-run throughput policy: `%s` (`%s`)\n' \
    "$qualification_policy_tsv" "$qualification_policy_identity"
  printf -- '- Machine result receipt: `%s`\n' "$qualification_result_tsv"
  printf -- '- Balanced blocks: `%s`\n' "$blocks"
  printf -- '- Samples per target/workload: `%s`\n' "$((blocks * 2))"
  printf -- '- Connections: `%s`\n' "$connections"
  printf -- '- Iterations per client: `%s`\n' "$iterations"
  printf -- '- Rows: `%s`\n' "$row_count"
  printf -- '- WASIX shared-memory provider: `%s`\n' "$shared_memory_provider"
  printf -- '- Workloads: `%s`\n' "${workloads[*]}"
  printf -- '- Checkpoint policy: `controlled`\n'
  printf -- '- Background resource sampling: `off`\n'
  printf -- '- Server cgroup binding: `%s`\n' "$cgroup_binding"
  printf -- '- Server cgroup MemoryMax / MemoryHigh / MemorySwapMax: `%s / %s / %s`\n' \
    "${cgroup_memory_max:-unset}" "${cgroup_memory_high:-unset}" \
    "${cgroup_swap_max:-unset}"
  printf -- '- Adaptive cache evidence policy: `%s`\n' \
    "$adaptive_cache_evidence_policy"
  printf -- '- Per-sample adaptive cache verification: `%s`\n' \
    "$adaptive_cache_verification_tsv"
  printf -- '- Wait-dump instrumentation: `prohibited and removed from every harness environment`\n'
  printf -- '- Instrumentation policy: `%s`\n' "$instrumentation_policy_tsv"
  printf -- '- Per-sample instrumentation verification: `%s`\n' \
    "$instrumentation_verification_tsv"
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
  printf -- '- Extra PostgreSQL GUCs: `%s`\n' "${postgres_gucs[*]:-}"
  printf -- '- Runtime footprint: `%s`\n' "${FRESH_POSTGRES_RUNTIME_FOOTPRINT_ID:-}"
  printf -- '- Runtime-footprint SHA-256: `%s`\n' \
    "${FRESH_POSTGRES_RUNTIME_FOOTPRINT_SHA256:-}"
  printf -- '- Durability profile: `%s`\n' "${FRESH_POSTGRES_DURABILITY_ID:-}"
  printf -- '- Durability-profile SHA-256: `%s`\n' \
    "${FRESH_POSTGRES_DURABILITY_SHA256:-}"
  printf -- '- PostgreSQL profile resolution identity: `%s`\n' \
    "${FRESH_POSTGRES_PROFILE_RESOLUTION_IDENTITY:-}"
  if [ "$profile_resolution_active" -eq 1 ]; then
    printf -- '- PostgreSQL profile inputs: `%s`\n' \
      "$qualification_postgres_profile_inputs"
    printf -- '- PostgreSQL profile resolution: `%s`\n' \
      "$qualification_postgres_profile_resolution"
  fi
  printf -- '- Paired median gate: `%s`\n' "$min_ratio"
  printf -- '- One-sided bootstrap 95%% LCB gate: `%s`\n' "$min_lcb"
  printf -- '- Paired bulk-batch wall p95/p99 ratio gates: `%s` / `%s`\n' \
    "$max_batch_wall_p95" "$max_batch_wall_p99"
  printf -- '- Bulk-batch residual p95/p99 delta gates: `%s ms` / `%s ms`\n' \
    "$max_batch_residual_delta_p95_ms" \
    "$max_batch_residual_delta_p99_ms"
  printf -- '- Bulk-batch residual definition: `batch wall minus summed psql-timed statements; not per-query latency or isolated backend launch`\n'
  printf -- '- Successful PGDATA discarded: `%s`\n' "$discard_pgdata"
  printf -- '- Sealed carrier: `%s`\n' "$sealed_carrier"
  printf -- '- Frozen carrier closure identity: `%s`\n' "$frozen_carrier_closure_identity"
  printf -- '- Carrier identity evidence: `%s`\n' "$carrier_identity_tsv"
  printf -- '- Per-sample carrier verification: `%s`\n' "$carrier_verification_tsv"
  printf -- '- Frozen native oracle identity: `%s`\n' "$frozen_native_oracle_identity"
  printf -- '- Native oracle closure evidence: `%s`\n' "$native_oracle_identity_tsv"
  printf -- '- Per-sample native oracle verification: `%s`\n' \
    "$native_oracle_verification_tsv"
  printf -- '- Paired effective-settings comparison: `%s`\n' "$profile_tsv"
  printf -- '- Raw samples: `%s`\n' "$raw_tsv"
  printf -- '- Paired summary: `%s`\n' "$paired_tsv"
  printf -- '- Raw bulk-batch samples: `%s`\n' "$bulk_batch_raw_tsv"
  printf -- '- Bulk-batch summary: `%s`\n' "$bulk_batch_tsv"
  printf -- '- Exit code: `%s`\n' "$overall_status"
} >>"$summary"

if [ "$overall_status" -ne 0 ]; then
  printf 'failed: single-backend qualification; see %s\n' "$summary" >&2
else
  printf 'passed: throughput-only single-backend qualification (non-release); see %s\n' "$summary"
fi
exit "$overall_status"
