#!/usr/bin/env bash

set -euo pipefail

# Dynamic product-root sourcing is intentional.
# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"
source "$FRESH_ROOT/lib/sealed-carrier.sh"
source "$FRESH_ROOT/lib/postgres-profiles.sh"
source "$FRESH_ROOT/lib/process-supervision.sh"
source "$FRESH_ROOT/lib/server-lifecycle.sh"
source "$FRESH_ROOT/lib/qualification-identities.sh"

usage() {
  cat <<'USAGE'
Usage: qualify-wasix-immediate-recovery.sh --sealed-carrier DIR [options]

Prove PostgreSQL crash recovery through the compiler-free WASIX postmaster
carrier. The qualifier creates one cluster with the embedded-concurrent and
safe profiles, checkpoints a baseline, records acknowledged post-checkpoint
transactions, delivers host SIGQUIT to the identity-checked Wasmer leader,
and restarts the exact same carrier, PGDATA, and /dev/shm mount.

Options:
  --sealed-carrier DIR       Compiler-free sealed carrier. Required.
  --mode MODE                qualification or diagnostic. Default:
                             qualification. Qualification mode requires the
                             immutable/zero-write and finite cgroup controls
                             below; diagnostic preserves the compatibility
                             execution path but is non-release.
  --require-zero-write-aot   Require direct activation from immutable AOT and
                             executable memory-image inodes, then validate the
                             complete loader audit after the final restart.
  --immutable-carrier-receipt FILE
                             External receipt created by
                             deploy-immutable-sealed-carrier.sh. Required with
                             --require-zero-write-aot and forbidden otherwise.
  --cgroup-memory-max SIZE   Finite MemoryMax for each postmaster server tree.
  --cgroup-memory-high SIZE  Finite MemoryHigh for each postmaster server tree.
  --cgroup-swap-max SIZE     Finite MemorySwapMax for each postmaster server
                             tree; use 0 to forbid swap. The three cgroup
                             controls are an all-or-none set.
  --port PORT                TCP port. Default: 55940.
  --timeout SECONDS          Per operation and lifecycle deadline. Default: 180.
  --transactions N           Acknowledged post-checkpoint commits. Default: 16.
  --rows-per-transaction N   Rows inserted by each commit. Default: 128.
  --label NAME               Evidence label. Default: timestamped.
  --keep-pgdata              Retain successful PGDATA and /dev/shm evidence.
  -h, --help                 Show this help.

Success requires all of the following:
  * the sealed carrier and named-profile inputs remain byte-identical;
  * every commit is observed with WAL flushed under the safe profile;
  * no checkpoint occurs after the controlled baseline;
  * SIGQUIT reaches PostgreSQL as an immediate shutdown without escalation;
  * the Wasmer process group, listener, and shared-object directory drain;
  * restart performs WAL redo and reproduces the exact table checksum;
  * a bridged SIGTERM performs smart shutdown; and
  * a final reopen is clean and reproduces the checksum again.

Qualification mode additionally requires full immutable-carrier verification
at both campaign boundaries, receipt-bound fast checks before every execution,
an exact population of one outer initdb and three outer postgres executor
invocations, direct-immutable evidence for every module activation (including
initdb's bootstrap postgres and dynamic modules), and proven
MemoryMax/MemoryHigh/MemorySwapMax membership for every server tree.
USAGE
}

sealed_carrier=""
sealed_carrier_explicit=0
mode="${WASIX_RECOVERY_MODE:-qualification}"
mode_explicit=0
require_zero_write_aot=0
immutable_carrier_receipt=""
cgroup_memory_max="${WASIX_RECOVERY_CGROUP_MEMORY_MAX:-}"
cgroup_memory_high="${WASIX_RECOVERY_CGROUP_MEMORY_HIGH:-}"
cgroup_swap_max="${WASIX_RECOVERY_CGROUP_SWAP_MAX:-}"
cgroup_memory_max_explicit=0
cgroup_memory_high_explicit=0
cgroup_swap_max_explicit=0
port="${WASIX_RECOVERY_PORT:-55940}"
timeout_seconds="${WASIX_RECOVERY_TIMEOUT:-180}"
transaction_count="${WASIX_RECOVERY_TRANSACTIONS:-16}"
rows_per_transaction="${WASIX_RECOVERY_ROWS_PER_TRANSACTION:-128}"
run_label="${WASIX_RECOVERY_LABEL:-$(date -u +%Y%m%dT%H%M%SZ)}"
keep_pgdata=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --sealed-carrier)
      shift
      [ "$#" -gt 0 ] || { echo "--sealed-carrier requires a directory" >&2; exit 2; }
      [ "$sealed_carrier_explicit" -eq 0 ] || {
        echo "--sealed-carrier may only be specified once" >&2
        exit 2
      }
      sealed_carrier="$1"
      sealed_carrier_explicit=1
      ;;
    --mode)
      shift
      [ "$#" -gt 0 ] || { echo "--mode requires qualification or diagnostic" >&2; exit 2; }
      [ "$mode_explicit" -eq 0 ] || {
        echo "--mode may only be specified once" >&2
        exit 2
      }
      mode="$1"
      mode_explicit=1
      ;;
    --require-zero-write-aot)
      [ "$require_zero_write_aot" -eq 0 ] || {
        echo "--require-zero-write-aot may only be specified once" >&2
        exit 2
      }
      require_zero_write_aot=1
      ;;
    --immutable-carrier-receipt)
      shift
      [ "$#" -gt 0 ] || { echo "--immutable-carrier-receipt requires a file" >&2; exit 2; }
      [ -z "$immutable_carrier_receipt" ] || {
        echo "--immutable-carrier-receipt may only be specified once" >&2
        exit 2
      }
      immutable_carrier_receipt="$1"
      ;;
    --cgroup-memory-max)
      shift
      [ "$#" -gt 0 ] || { echo "--cgroup-memory-max requires a size" >&2; exit 2; }
      [ "$cgroup_memory_max_explicit" -eq 0 ] || {
        echo "--cgroup-memory-max may only be specified once" >&2
        exit 2
      }
      cgroup_memory_max="$1"
      cgroup_memory_max_explicit=1
      ;;
    --cgroup-memory-high)
      shift
      [ "$#" -gt 0 ] || { echo "--cgroup-memory-high requires a size" >&2; exit 2; }
      [ "$cgroup_memory_high_explicit" -eq 0 ] || {
        echo "--cgroup-memory-high may only be specified once" >&2
        exit 2
      }
      cgroup_memory_high="$1"
      cgroup_memory_high_explicit=1
      ;;
    --cgroup-swap-max)
      shift
      [ "$#" -gt 0 ] || { echo "--cgroup-swap-max requires a size" >&2; exit 2; }
      [ "$cgroup_swap_max_explicit" -eq 0 ] || {
        echo "--cgroup-swap-max may only be specified once" >&2
        exit 2
      }
      cgroup_swap_max="$1"
      cgroup_swap_max_explicit=1
      ;;
    --port)
      shift
      [ "$#" -gt 0 ] || { echo "--port requires a value" >&2; exit 2; }
      port="$1"
      ;;
    --timeout)
      shift
      [ "$#" -gt 0 ] || { echo "--timeout requires a value" >&2; exit 2; }
      timeout_seconds="$1"
      ;;
    --transactions)
      shift
      [ "$#" -gt 0 ] || { echo "--transactions requires a value" >&2; exit 2; }
      transaction_count="$1"
      ;;
    --rows-per-transaction)
      shift
      [ "$#" -gt 0 ] || { echo "--rows-per-transaction requires a value" >&2; exit 2; }
      rows_per_transaction="$1"
      ;;
    --label)
      shift
      [ "$#" -gt 0 ] || { echo "--label requires a value" >&2; exit 2; }
      run_label="$1"
      ;;
    --keep-pgdata)
      keep_pgdata=1
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
case "$mode" in
  qualification|diagnostic) ;;
  *) echo "--mode requires qualification or diagnostic" >&2; exit 2 ;;
esac
if [ "$mode" = qualification ]; then
  classification=product-qualification
else
  classification=diagnostic-non-release
fi
if [ "$require_zero_write_aot" -eq 1 ]; then
  boundary_verification_scope=full-cryptographic-plus-immutable-receipt
else
  boundary_verification_scope=full-cryptographic-carrier-only
fi
if ! is_positive_integer "$port" || [ "$port" -gt 65535 ]; then
  echo "--port requires a port number from 1 through 65535" >&2
  exit 2
fi
is_positive_integer "$timeout_seconds" || { echo "--timeout requires a positive integer" >&2; exit 2; }
is_positive_integer "$transaction_count" || { echo "--transactions requires a positive integer" >&2; exit 2; }
is_positive_integer "$rows_per_transaction" || { echo "--rows-per-transaction requires a positive integer" >&2; exit 2; }
for cgroup_size in "$cgroup_memory_max" "$cgroup_memory_high" "$cgroup_swap_max"; do
  if [ -n "$cgroup_size" ] && ! validate_cgroup_size "$cgroup_size"; then
    printf 'invalid cgroup size: %s\n' "$cgroup_size" >&2
    exit 2
  fi
done
cgroup_enabled=0
if [ -n "$cgroup_memory_max$cgroup_memory_high$cgroup_swap_max" ]; then
  if [ -z "$cgroup_memory_max" ] || [ -z "$cgroup_memory_high" ] ||
    [ -z "$cgroup_swap_max" ]; then
    echo "cgroup MemoryMax, MemoryHigh, and MemorySwapMax are an all-or-none set" >&2
    exit 2
  fi
  cgroup_enabled=1
fi
if [ "$mode" = qualification ]; then
  [ "$require_zero_write_aot" -eq 1 ] || {
    echo "qualification mode requires --require-zero-write-aot" >&2
    exit 2
  }
  [ "$cgroup_enabled" -eq 1 ] || {
    echo "qualification mode requires finite --cgroup-memory-max, --cgroup-memory-high, and --cgroup-swap-max" >&2
    exit 2
  }
fi
if [ "$require_zero_write_aot" -eq 1 ]; then
  [ -n "$immutable_carrier_receipt" ] || {
    echo "--require-zero-write-aot requires --immutable-carrier-receipt" >&2
    exit 2
  }
elif [ -n "$immutable_carrier_receipt" ]; then
  echo "--immutable-carrier-receipt requires --require-zero-write-aot" >&2
  exit 2
fi
fresh_require_command python3
if [ "$cgroup_enabled" -eq 1 ]; then
  cgroup_memory_max_bytes="$(cgroup_size_to_bytes "$cgroup_memory_max")" || {
    echo "--cgroup-memory-max exceeds the supported finite range" >&2
    exit 2
  }
  cgroup_memory_high_bytes="$(cgroup_size_to_bytes "$cgroup_memory_high")" || {
    echo "--cgroup-memory-high exceeds the supported finite range" >&2
    exit 2
  }
  cgroup_swap_max_bytes="$(cgroup_size_to_bytes "$cgroup_swap_max")" || {
    echo "--cgroup-swap-max exceeds the supported finite range" >&2
    exit 2
  }
  if [ "$cgroup_memory_max_bytes" -le 0 ] ||
    [ "$cgroup_memory_high_bytes" -le 0 ]; then
    echo "MemoryMax and MemoryHigh must be finite positive sizes" >&2
    exit 2
  fi
  [ "$cgroup_memory_high_bytes" -le "$cgroup_memory_max_bytes" ] || {
    echo "MemoryHigh may not exceed MemoryMax" >&2
    exit 2
  }
else
  cgroup_memory_max_bytes=none
  cgroup_memory_high_bytes=none
  cgroup_swap_max_bytes=none
fi
case "$run_label" in
  ""|[!A-Za-z0-9]*|*[!A-Za-z0-9._-]*)
    echo "--label must start with a letter or number and contain only letters, numbers, '.', '_', and '-'" >&2
    exit 2
    ;;
esac
[ "$(uname -s)" = Linux ] || {
  echo "immediate-recovery qualification currently requires Linux process birth identities" >&2
  exit 2
}

fresh_require_command perl
fresh_require_command stat
if [ "$cgroup_enabled" -eq 1 ]; then
  fresh_require_command systemd-run
  [ -r /sys/fs/cgroup/cgroup.controllers ] || {
    echo "server cgroup controls require a cgroup-v2 host" >&2
    exit 2
  }
fi
[ -x "$NATIVE_INSTALL_DIR/bin/psql" ] || {
  printf 'missing native PostgreSQL 18 psql client: %s\n' "$NATIVE_INSTALL_DIR/bin/psql" >&2
  printf 'Build it with %s/bin/build-native-oracle.sh first.\n' "$FRESH_ROOT" >&2
  exit 2
}

fresh_capture_qualification_carrier_identity "$sealed_carrier"
frozen_carrier_identity="$FRESH_QUALIFICATION_CARRIER_CLOSURE_IDENTITY"
frozen_manifest_sha256="$FRESH_QUALIFICATION_CARRIER_MANIFEST_SHA256"
frozen_wasmer_receipt_sha256="$FRESH_QUALIFICATION_CARRIER_RECEIPT_SHA256"
frozen_payload_sha256="$FRESH_QUALIFICATION_CARRIER_PAYLOAD_SHA256"
frozen_headless_sha256="$FRESH_QUALIFICATION_CARRIER_HEADLESS_SHA256"
frozen_core_profile="$FRESH_QUALIFICATION_CORE_PROFILE"
frozen_guest_build_recipe_sha256="$FRESH_QUALIFICATION_GUEST_BUILD_RECIPE_SHA256"
immutable_receipt_sha256=none
immutable_receipt_dev=none
immutable_receipt_ino=none
if [ "$require_zero_write_aot" -eq 1 ]; then
  [ "$(id -u)" -ne 0 ] || {
    echo "zero-write recovery qualification must run unprivileged" >&2
    exit 2
  }
  cap_eff="$(awk '$1 == "CapEff:" { print $2 }' /proc/self/status)"
  [[ "$cap_eff" =~ ^[0-9a-fA-F]+$ ]] || {
    echo "could not read exact CapEff for zero-write recovery qualification" >&2
    exit 2
  }
  if (( (16#$cap_eff & (1 << 9)) != 0 )); then
    echo "zero-write recovery qualification refuses effective CAP_LINUX_IMMUTABLE" >&2
    exit 2
  fi
  receipt_parent="$(dirname "$immutable_carrier_receipt")"
  if [ ! -d "$receipt_parent" ] || [ -L "$receipt_parent" ]; then
    printf 'immutable carrier receipt parent must be a non-symlink directory: %s\n' \
      "$receipt_parent" >&2
    exit 2
  fi
  immutable_carrier_receipt="$(cd "$receipt_parent" && pwd -P)/$(basename "$immutable_carrier_receipt")"
  if [ ! -f "$immutable_carrier_receipt" ] ||
    [ -L "$immutable_carrier_receipt" ]; then
    printf 'immutable carrier receipt must be a regular non-symlink file: %s\n' \
      "$immutable_carrier_receipt" >&2
    exit 2
  fi
  case "$immutable_carrier_receipt/" in
    "$sealed_carrier/"|"$sealed_carrier/"*)
      echo "immutable deployment receipt must remain outside the sealed carrier" >&2
      exit 2
      ;;
  esac
  "$FRESH_ROOT/bin/verify-immutable-sealed-carrier.sh" \
    --sealed-carrier "$sealed_carrier" \
    --receipt "$immutable_carrier_receipt"
  fresh_capture_stable_regular_file_identity "$immutable_carrier_receipt" || {
    echo "immutable carrier receipt changed while its identity was captured" >&2
    exit 1
  }
  immutable_receipt_sha256="$FRESH_QUALIFICATION_REGULAR_FILE_SHA256"
  immutable_receipt_dev="$FRESH_QUALIFICATION_REGULAR_FILE_DEVICE"
  immutable_receipt_ino="$FRESH_QUALIFICATION_REGULAR_FILE_INODE"
fi
fresh_resolve_postgres_profiles embedded-concurrent safe
[ "${#FRESH_POSTGRES_PROFILE_OVERLAPPING_EXPLICIT[@]}" -eq 0 ] || exit 2

run_root="$FRESH_WORK_ROOT/run/immediate-recovery-$run_label"
report_dir="$FRESH_WORK_ROOT/reports/immediate-recovery-$run_label"
pgdata="$run_root/pgdata"
dev_shm="$run_root/dev-shm"
fresh_require_managed_generated_path "$run_root" "immediate-recovery run directory"
fresh_require_managed_generated_path "$report_dir" "immediate-recovery report directory"
if ! fresh_claim_generated_directories "$run_root" "$report_dir"; then
  printf 'recovery qualification label is already claimed: %s\n' "$run_label" >&2
  exit 2
fi
mkdir -p "$pgdata" "$dev_shm"

profile_inputs="$report_dir/postgres-profile-inputs.tsv"
profile_resolution="$report_dir/postgres-profile-resolution.tsv"
fresh_write_postgres_profile_evidence "$profile_inputs" "$profile_resolution"
loader_validator="$FRESH_ROOT/bin/validate-sealed-loader-audit.py"
loader_validator_sha256="$(fresh_wasmer_bin_hash "$loader_validator")"
cache_observe_validator="$FRESH_ROOT/bin/validate-file-cache-telemetry.py"
cache_observe_validator_sha256="$(fresh_wasmer_bin_hash "$cache_observe_validator")"
cache_adaptive_validator="$FRESH_ROOT/bin/validate-adaptive-file-cache-telemetry.py"
cache_adaptive_validator_sha256="$(fresh_wasmer_bin_hash "$cache_adaptive_validator")"
sealed_loader_audit="$report_dir/sealed-loader-audit.jsonl"
sealed_loader_validation="$report_dir/sealed-loader-audit-validation.tsv"
immutable_verification="$report_dir/immutable-carrier-verification.tsv"
carrier_boundary_verification="$report_dir/carrier-boundary-verification.tsv"
qualification_policy="$report_dir/qualification-policy.tsv"
cache_telemetry_policy="$report_dir/cache-telemetry-policy.tsv"
evidence_envelope="$report_dir/qualification-evidence-envelope.tsv"
if [ -e "$sealed_loader_audit" ] || [ -L "$sealed_loader_audit" ]; then
  echo "sealed loader audit path exists before recovery qualification" >&2
  exit 2
fi
printf 'stage\texpected_receipt_sha256\tobserved_receipt_sha256\texpected_receipt_dev\tobserved_receipt_dev\texpected_receipt_ino\tobserved_receipt_ino\tstatus\n' \
  >"$immutable_verification"
printf 'stage\tverification_scope\texpected_closure_identity\tobserved_closure_identity\tstatus\n' \
  >"$carrier_boundary_verification"
printf 'campaign-start\t%s\t%s\t%s\tpassed\n' \
  "$boundary_verification_scope" "$frozen_carrier_identity" \
  "$frozen_carrier_identity" \
  >>"$carrier_boundary_verification"
printf 'schema_version\tmode\tclassification\trequire_zero_write_aot\trequired_snapshot_mode\texpected_outer_initdb_invocations\texpected_outer_postgres_invocations\tcarrier_closure_identity\tmanifest_sha256\twasmer_receipt_sha256\tpayload_sha256\theadless_sha256\tcore_profile\tguest_build_recipe_sha256\timmutable_receipt_path\timmutable_receipt_sha256\timmutable_receipt_dev\timmutable_receipt_ino\tloader_validator_sha256\tcgroup_enabled\tcgroup_memory_max\tcgroup_memory_max_bytes\tcgroup_memory_high\tcgroup_memory_high_bytes\tcgroup_swap_max\tcgroup_swap_max_bytes\tpostgres_profile_identity\n' \
  >"$qualification_policy"
printf 'oliphaunt.wasix-postmaster.immediate-recovery-policy.v3\t%s\t%s\t%s\t%s\t1\t3\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
  "$mode" "$classification" \
  "$require_zero_write_aot" \
  "$([ "$require_zero_write_aot" -eq 1 ] && printf direct-immutable-inode || printf compatibility)" \
  "$frozen_carrier_identity" "$frozen_manifest_sha256" \
  "$frozen_wasmer_receipt_sha256" "$frozen_payload_sha256" \
  "$frozen_headless_sha256" "$frozen_core_profile" \
  "$frozen_guest_build_recipe_sha256" \
  "${immutable_carrier_receipt:-none}" "$immutable_receipt_sha256" \
  "$immutable_receipt_dev" "$immutable_receipt_ino" \
  "$loader_validator_sha256" "$cgroup_enabled" \
  "${cgroup_memory_max:-none}" "$cgroup_memory_max_bytes" \
  "${cgroup_memory_high:-none}" "$cgroup_memory_high_bytes" \
  "${cgroup_swap_max:-none}" "$cgroup_swap_max_bytes" \
  "$FRESH_POSTGRES_PROFILE_RESOLUTION_IDENTITY" \
  >>"$qualification_policy"
printf 'schema_version\tactivation_source\toutput_environment\tadaptive_path_derivation\tobserve_validator_sha256\tadaptive_validator_sha256\texpected_observe_validations\texpected_adaptive_validations\n' \
  >"$cache_telemetry_policy"
printf 'oliphaunt.wasix-postmaster.cache-telemetry-policy.v1\tsealed-manifest-only\tOLIPHAUNT_WASIX_CACHE_OFFER_TELEMETRY_FILE\tPath::with_extension("adaptive.json")\t%s\t%s\t4\t3\n' \
  "$cache_observe_validator_sha256" "$cache_adaptive_validator_sha256" \
  >>"$cache_telemetry_policy"
cache_telemetry_policy_sha256="$(fresh_wasmer_bin_hash "$cache_telemetry_policy")"
qualification_policy_sha256="$(fresh_wasmer_bin_hash "$qualification_policy")"
chmod 0444 "$qualification_policy" "$cache_telemetry_policy"

wasmer_bin="$sealed_carrier/bin/wasmer-headless"
sealed_manifest="$sealed_carrier/manifest.json"
wasix_initdb="$sealed_carrier/bin/initdb"
wasix_postgres="$sealed_carrier/bin/postgres"
wasix_lib="$sealed_carrier/lib"
wasmer_stack_size="${WASMER_STACK_SIZE:-33554432}"
case "$wasmer_stack_size" in
  ""|0|*[!0-9]*) echo "WASMER_STACK_SIZE requires a positive integer" >&2; exit 2 ;;
esac

sealed_loader_unset_args=(
  -u OLIPHAUNT_WASIX_REQUIRE_ZERO_WRITE_AOT
  -u OLIPHAUNT_WASIX_SEALED_LOADER_AUDIT_FILE
  -u OLIPHAUNT_WASIX_CACHE_OFFER_TELEMETRY_FILE
)
sealed_loader_env=()
if [ "$require_zero_write_aot" -eq 1 ]; then
  sealed_loader_env=(
    OLIPHAUNT_WASIX_REQUIRE_ZERO_WRITE_AOT=1
    "OLIPHAUNT_WASIX_SEALED_LOADER_AUDIT_FILE=$sealed_loader_audit"
  )
fi

wasmer_args=(
  run
  --quiet
  --disable-cache
  --sealed-module-manifest "$sealed_manifest"
  --stack-size "$wasmer_stack_size"
  --enable-exceptions
  --enable-threads
  --net
  --volume "$REPO_ROOT:$REPO_ROOT"
  --volume "$wasix_lib:/lib"
  --volume "$dev_shm:/dev/shm"
)
case "$FRESH_WORK_ROOT/" in
  "$REPO_ROOT/"*) ;;
  *) wasmer_args+=(--volume "$FRESH_WORK_ROOT:$FRESH_WORK_ROOT") ;;
esac
case "$sealed_carrier/" in
  "$REPO_ROOT/"*|"$FRESH_WORK_ROOT/"*) ;;
  *) wasmer_args+=(--volume "$sealed_carrier:$sealed_carrier") ;;
esac

effective_gucs=("${FRESH_POSTGRES_PROFILE_GUCS[@]}")
effective_gucs+=(
  checkpoint_timeout=1h
  max_wal_size=8GB
  min_wal_size=1GB
)

conn="postgresql://wasix@127.0.0.1:$port/postgres"
carrier_snapshots="$report_dir/carrier-snapshots.tsv"
printf 'phase\tmanifest_sha256\treceipt_sha256\tpayload_sha256\theadless_sha256\n' \
  >"$carrier_snapshots"
current_stage="setup"
qualification_status="failed"
cleanup_escalation=0
active_pid=""
active_pgid=""
active_identity=""
active_phase=""
active_cgroup_unit=""
active_cgroup_dir=""
active_cgroup_identity=""
server_command_prefix=()

assert_frozen_immutable_carrier() {
  local stage="$1"
  local observed_sha=none observed_dev=none observed_ino=none status=passed

  [ "$require_zero_write_aot" -eq 1 ] || return 0
  if ! "$FRESH_ROOT/bin/verify-immutable-sealed-carrier.sh" \
    --sealed-carrier "$sealed_carrier" \
    --receipt "$immutable_carrier_receipt" --fast; then
    status=verification-failed
  fi
  if fresh_capture_stable_regular_file_identity \
    "$immutable_carrier_receipt" 2>/dev/null; then
    observed_sha="$FRESH_QUALIFICATION_REGULAR_FILE_SHA256"
    observed_dev="$FRESH_QUALIFICATION_REGULAR_FILE_DEVICE"
    observed_ino="$FRESH_QUALIFICATION_REGULAR_FILE_INODE"
  else
    status=unreadable
  fi
  if [ "$status" = passed ] && {
    [ "$observed_sha" != "$immutable_receipt_sha256" ] ||
      [ "$observed_dev" != "$immutable_receipt_dev" ] ||
      [ "$observed_ino" != "$immutable_receipt_ino" ];
  }; then
    status=identity-changed
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$stage" "$immutable_receipt_sha256" "$observed_sha" \
    "$immutable_receipt_dev" "$observed_dev" \
    "$immutable_receipt_ino" "$observed_ino" "$status" \
    >>"$immutable_verification"
  [ "$status" = passed ] || {
    printf 'immutable carrier deployment identity failed at %s: %s\n' \
      "$stage" "$status" >&2
    return 125
  }
}

assert_frozen_policy() {
  [ "$(fresh_wasmer_bin_hash "$qualification_policy")" = \
    "$qualification_policy_sha256" ] &&
    [ "$(fresh_wasmer_bin_hash "$cache_telemetry_policy")" = \
      "$cache_telemetry_policy_sha256" ] &&
    [ "$(fresh_wasmer_bin_hash "$loader_validator")" = \
      "$loader_validator_sha256" ] &&
    [ "$(fresh_wasmer_bin_hash "$cache_observe_validator")" = \
      "$cache_observe_validator_sha256" ] &&
    [ "$(fresh_wasmer_bin_hash "$cache_adaptive_validator")" = \
      "$cache_adaptive_validator_sha256" ] &&
    fresh_assert_postgres_profile_inputs
}

snapshot_carrier() {
  local phase="$1"
  local manifest_sha receipt_sha payload_sha headless_sha

  assert_frozen_policy || return
  if [ "$require_zero_write_aot" -eq 1 ]; then
    assert_frozen_immutable_carrier "$phase" || return
    manifest_sha="$frozen_manifest_sha256"
    receipt_sha="$frozen_wasmer_receipt_sha256"
    payload_sha="$frozen_payload_sha256"
    headless_sha="$frozen_headless_sha256"
  else
    fresh_capture_qualification_carrier_identity "$sealed_carrier" || return
    [ "$FRESH_QUALIFICATION_CARRIER_CLOSURE_IDENTITY" = \
      "$frozen_carrier_identity" ] || {
      printf 'sealed carrier identity changed during recovery qualification\n' >&2
      return 1
    }
    manifest_sha="$FRESH_QUALIFICATION_CARRIER_MANIFEST_SHA256"
    receipt_sha="$FRESH_QUALIFICATION_CARRIER_RECEIPT_SHA256"
    payload_sha="$FRESH_QUALIFICATION_CARRIER_PAYLOAD_SHA256"
    headless_sha="$FRESH_QUALIFICATION_CARRIER_HEADLESS_SHA256"
  fi
  printf '%s\t%s\t%s\t%s\t%s\n' \
    "$phase" "$manifest_sha" "$receipt_sha" "$payload_sha" "$headless_sha" \
    >>"$carrier_snapshots"
}

cleanup_active_server() {
  local status=0

  [ -n "$active_pid" ] || return 0
  cleanup_escalation=1
  if [ -z "$active_pgid" ] || [ -z "$active_identity" ]; then
    printf 'cannot safely clean incomplete active server identity for phase %s\n' \
      "$active_phase" >&2
    return 125
  fi
  fresh_terminate_owned_process_group \
    "$active_pgid" "$active_pid" "$active_identity" 1000 3000 || status=$?
  if [ "$status" -eq 0 ] && [ -n "$active_cgroup_dir" ] &&
    [ -n "$active_cgroup_identity" ]; then
    fresh_wait_cgroup_empty "$active_cgroup_dir" "$active_cgroup_identity" \
      3000 || status=$?
  fi
  active_pid=""
  active_pgid=""
  active_identity=""
  active_phase=""
  active_cgroup_unit=""
  active_cgroup_dir=""
  active_cgroup_identity=""
  return "$status"
}

on_exit() {
  local status="$1"
  local cleanup_status=0

  trap - EXIT INT TERM HUP
  if [ -n "$active_pid" ]; then
    cleanup_active_server || cleanup_status=$?
  fi
  if [ "$status" -eq 0 ] && [ "$cleanup_status" -ne 0 ]; then
    status="$cleanup_status"
  fi
  {
    printf 'status\t%s\n' "$qualification_status"
    printf 'exit_code\t%s\n' "$status"
    printf 'last_stage\t%s\n' "$current_stage"
    printf 'cleanup_escalation\t%s\n' "$cleanup_escalation"
    printf 'mode\t%s\n' "$mode"
    printf 'require_zero_write_aot\t%s\n' "$require_zero_write_aot"
    printf 'cgroup_enabled\t%s\n' "$cgroup_enabled"
    printf 'run_root\t%s\n' "$run_root"
    printf 'report_dir\t%s\n' "$report_dir"
  } >"$report_dir/result.tsv"
  exit "$status"
}
trap 'on_exit $?' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

run_logged() {
  local log="$1"
  shift
  fresh_run_process_group_timeout "$timeout_seconds" -- "$@" >"$log" 2>&1
}

cache_telemetry_path_for_log() {
  local log="$1"
  case "$log" in
    /*.log) printf '%s.cache-offers.json\n' "${log%.log}" ;;
    *) printf 'cache telemetry requires an absolute .log path: %s\n' "$log" >&2; return 125 ;;
  esac
}

validate_observe_cache_telemetry() {
  local log="$1"
  local expected_workload="$2"
  local telemetry validation
  telemetry="$(cache_telemetry_path_for_log "$log")" || return
  validation="${telemetry%.json}-validation.tsv"
  python3 "$cache_observe_validator" \
    --telemetry "$telemetry" \
    --manifest "$sealed_manifest" \
    --output "$validation" \
    --expected-workload "$expected_workload"
  chmod 0444 "$telemetry"
}

validate_postgres_cache_telemetry() {
  local log="$1"
  local telemetry adaptive validation
  validate_observe_cache_telemetry "$log" runtime:postgres
  telemetry="$(cache_telemetry_path_for_log "$log")" || return
  # Exact sibling convention used by Rust Path::with_extension("adaptive.json").
  adaptive="${telemetry%.json}.adaptive.json"
  validation="${telemetry%.json}-adaptive-validation.tsv"
  python3 "$cache_adaptive_validator" \
    --telemetry "$adaptive" \
    --manifest "$sealed_manifest" \
    --output "$validation"
  chmod 0444 "$adaptive"
}

configure_server_cgroup() {
  local phase="$1"

  server_command_prefix=()
  active_cgroup_unit=""
  [ "$cgroup_enabled" -eq 1 ] || return 0
  active_cgroup_unit="oliphaunt-recovery-$$-$phase"
  server_command_prefix=(
    systemd-run
    --user
    --scope
    --quiet
    --collect
    "--unit=$active_cgroup_unit"
    --property=MemoryAccounting=yes
    "--property=MemoryMax=$cgroup_memory_max"
    "--property=MemoryHigh=$cgroup_memory_high"
    "--property=MemorySwapMax=$cgroup_swap_max"
  )
}

assert_active_server_cgroup() {
  local observation="$1"
  local deadline relative="" cgroup_dir observed_identity
  local observed_max observed_high observed_swap output

  [ "$cgroup_enabled" -eq 1 ] || return 0
  [ -n "$active_pid" ] && [ -n "$active_cgroup_unit" ] || return 125
  deadline=$(( $(fresh_supervision_now_ms) + 5000 ))
  while [ "$(fresh_supervision_now_ms)" -lt "$deadline" ]; do
    relative="$(awk -F: '$1 == "0" { print $3; exit }' \
      "/proc/$active_pid/cgroup" 2>/dev/null || true)"
    if [ "$(basename "$relative" 2>/dev/null || true)" = \
      "$active_cgroup_unit.scope" ]; then
      break
    fi
    sleep 0.05
  done
  case "$relative" in
    /*) ;;
    *) echo "server did not expose an absolute cgroup-v2 path" >&2; return 125 ;;
  esac
  [ "$(basename "$relative")" = "$active_cgroup_unit.scope" ] || {
    printf 'server did not enter its requested cgroup scope: pid=%s expected=%s observed=%s\n' \
      "$active_pid" "$active_cgroup_unit.scope" "$relative" >&2
    return 125
  }
  cgroup_dir="/sys/fs/cgroup$relative"
  for control in memory.max memory.high memory.swap.max memory.current memory.peak; do
    [ -r "$cgroup_dir/$control" ] || {
      printf 'server cgroup control is unreadable: %s/%s\n' \
        "$cgroup_dir" "$control" >&2
      return 125
    }
  done
  observed_identity="$(fresh_path_identity "$cgroup_dir")" || return
  if [ -n "$active_cgroup_identity" ]; then
    [ "$observed_identity" = "$active_cgroup_identity" ] || {
      echo "server cgroup identity changed during recovery phase" >&2
      return 125
    }
  else
    active_cgroup_dir="$cgroup_dir"
    active_cgroup_identity="$observed_identity"
  fi
  observed_max="$(<"$cgroup_dir/memory.max")"
  observed_high="$(<"$cgroup_dir/memory.high")"
  observed_swap="$(<"$cgroup_dir/memory.swap.max")"
  if [ "$observed_max" != "$cgroup_memory_max_bytes" ] ||
    [ "$observed_high" != "$cgroup_memory_high_bytes" ] ||
    [ "$observed_swap" != "$cgroup_swap_max_bytes" ]; then
    printf 'server cgroup controls differ: max=%s/%s high=%s/%s swap=%s/%s\n' \
      "$observed_max" "$cgroup_memory_max_bytes" \
      "$observed_high" "$cgroup_memory_high_bytes" \
      "$observed_swap" "$cgroup_swap_max_bytes" >&2
    return 125
  fi
  output="$report_dir/$active_phase.cgroup.tsv"
  if [ ! -e "$output" ]; then
    printf 'observation\tunit\tcgroup_path\tcgroup_identity\tmemory_max_bytes\tmemory_high_bytes\tmemory_swap_max_bytes\tmemory_current_bytes\tmemory_peak_bytes\n' \
      >"$output"
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$observation" "$active_cgroup_unit" "$relative" \
    "$active_cgroup_identity" "$observed_max" "$observed_high" \
    "$observed_swap" "$(<"$cgroup_dir/memory.current")" \
    "$(<"$cgroup_dir/memory.peak")" >>"$output"
}

launch_with_embedded_nofile() {
  local limits_file="$1"
  shift
  local pre_soft pre_hard actual_soft actual_hard

  pre_soft="$(ulimit -S -n)"
  pre_hard="$(ulimit -H -n)"
  case "$pre_hard" in
    unlimited) ;;
    ""|*[!0-9]*) return 125 ;;
    *) [ "$pre_hard" -ge 1024 ] || return 125 ;;
  esac
  ulimit -S -n 1024 || return 125
  actual_soft="$(ulimit -S -n)"
  actual_hard="$(ulimit -H -n)"
  {
    printf 'pre_soft_nofile=%s\n' "$pre_soft"
    printf 'pre_hard_nofile=%s\n' "$pre_hard"
    printf 'actual_soft_nofile=%s\n' "$actual_soft"
    printf 'actual_hard_nofile=%s\n' "$actual_hard"
  } >"$limits_file"
  [ "$actual_soft" = 1024 ] && [ "$actual_hard" = "$pre_hard" ] || return 125
  exec "$@"
}

start_server() {
  local phase="$1"
  local server_log="$2"
  local limits_file="$3"
  local postgres_args=(
    -D "$pgdata"
    -h 127.0.0.1
    -p "$port"
    -c unix_socket_directories=
  )
  local guc
  local cache_telemetry

  [ -z "$active_pid" ] || {
    echo "refusing to replace an active recovery server" >&2
    return 125
  }
  fresh_tcp_port_open 127.0.0.1 "$port" && {
    printf 'refusing occupied recovery port: 127.0.0.1:%s\n' "$port" >&2
    return 125
  }
  [ -z "$(find "$dev_shm" -mindepth 1 -print -quit)" ] || {
    printf 'shared-object directory is not empty before %s start: %s\n' \
      "$phase" "$dev_shm" >&2
    return 1
  }
  fresh_assert_postgres_profile_inputs || return
  for guc in "${effective_gucs[@]}"; do
    postgres_args+=(-c "$guc")
  done
  assert_frozen_policy || return
  assert_frozen_immutable_carrier "before-$phase-start" || return
  configure_server_cgroup "$phase"
  cache_telemetry="$(cache_telemetry_path_for_log "$server_log")" || return
  fresh_spawn_process_group -- launch_with_embedded_nofile "$limits_file" \
    "${server_command_prefix[@]}" \
    env -u WASMER_DIR -u WASMER_CACHE_DIR \
    "${sealed_loader_unset_args[@]}" \
    "${sealed_loader_env[@]}" \
    "OLIPHAUNT_WASIX_CACHE_OFFER_TELEMETRY_FILE=$cache_telemetry" \
    "$wasmer_bin" "${wasmer_args[@]}" "$wasix_postgres" -- \
    "${postgres_args[@]}" >"$server_log" 2>&1 || return
  active_pid="$FRESH_PROCESS_GROUP_PID"
  active_pgid="$FRESH_PROCESS_GROUP_PGID"
  active_identity="$FRESH_PROCESS_GROUP_IDENTITY"
  active_phase="$phase"
  if [ -z "$active_identity" ] || [ "$active_pid" != "$active_pgid" ]; then
    printf 'incomplete server identity: pid=%s pgid=%s identity=%s\n' \
      "$active_pid" "$active_pgid" "$active_identity" >&2
    return 125
  fi
  assert_active_server_cgroup launch
}

wait_for_ready() {
  local wait_log="$1"
  local attempt_log="$wait_log.attempt"
  local deadline status

  : >"$wait_log"
  deadline=$(( $(fresh_supervision_now_ms) + timeout_seconds * 1000 ))
  while [ "$(fresh_supervision_now_ms)" -lt "$deadline" ]; do
    set +e
    fresh_run_process_group_timeout_ms 1000 -- \
      env PGCONNECT_TIMEOUT=1 "$NATIVE_INSTALL_DIR/bin/psql" \
      "$conn" -XAtq -v ON_ERROR_STOP=1 -c 'select 1' >"$attempt_log" 2>&1
    status=$?
    set -e
    if [ -s "$attempt_log" ]; then cat "$attempt_log" >>"$wait_log"; fi
    if [ "$status" -eq 0 ]; then
      rm -f -- "$attempt_log"
      return 0
    fi
    if [ "$status" -eq 125 ]; then
      rm -f -- "$attempt_log"
      return 125
    fi
    if ! fresh_supervision_pid_running "$active_pid"; then
      echo "server exited before readiness" >>"$wait_log"
      rm -f -- "$attempt_log"
      return 1
    fi
    if ! fresh_pid_matches_birth_identity "$active_pid" "$active_identity"; then
      echo "server birth identity changed before readiness" >>"$wait_log"
      rm -f -- "$attempt_log"
      return 125
    fi
    sleep 0.1
  done
  echo "readiness timed out" >>"$wait_log"
  rm -f -- "$attempt_log"
  return 124
}

psql_to_file() {
  local output="$1"
  local sql="$2"
  fresh_run_process_group_timeout "$timeout_seconds" -- \
    env PGCONNECT_TIMEOUT=5 "$NATIVE_INSTALL_DIR/bin/psql" \
    "$conn" -XAtq -F $'\t' -v ON_ERROR_STOP=1 -c "$sql" \
    >"$output" 2>"$output.stderr"
}

capture_and_validate_settings() {
  local phase="$1"
  local settings="$report_dir/$phase.pg-settings.tsv"
  local validation="$report_dir/$phase.profile-validation.tsv"

  {
    printf 'name\tsetting\tunit\tsource\n'
    fresh_run_process_group_timeout "$timeout_seconds" -- \
      env PGCONNECT_TIMEOUT=5 "$NATIVE_INSTALL_DIR/bin/psql" \
      "$conn" -XAtq -F $'\t' -v ON_ERROR_STOP=1 -c "
        SELECT name, setting, coalesce(unit, ''), source
        FROM pg_settings
        WHERE name IN (
          'io_method', 'shared_buffers', 'max_connections',
          'fsync', 'full_page_writes', 'synchronous_commit'
        )
        ORDER BY name
      "
  } >"$settings" 2>"$settings.stderr"
  fresh_validate_postgres_profile_settings "$settings" "$validation"
  psql_to_file "$report_dir/$phase.checkpoint-policy.tsv" "
    SELECT
      current_setting('checkpoint_timeout')::interval = interval '1 hour',
      pg_size_bytes(current_setting('max_wal_size')) = 8589934592,
      pg_size_bytes(current_setting('min_wal_size')) = 1073741824,
      current_setting('fsync') = 'on',
      current_setting('synchronous_commit') = 'on',
      current_setting('full_page_writes') = 'on'
  "
  [ "$(tr -d '[:space:]' <"$report_dir/$phase.checkpoint-policy.tsv")" = tttttt ] || {
    printf 'controlled checkpoint/durability policy mismatch during %s\n' "$phase" >&2
    return 1
  }
}

capture_database_state() {
  local output="$1"
  {
    printf 'row_count\tpayload_sum\tcontent_md5\tcheckpoint_lsn\tredo_lsn\tinsert_lsn\tflush_lsn\tcheckpoints_timed\tcheckpoints_requested\tcheckpoints_done\n'
    fresh_run_process_group_timeout "$timeout_seconds" -- \
      env PGCONNECT_TIMEOUT=5 "$NATIVE_INSTALL_DIR/bin/psql" \
      "$conn" -XAtq -F $'\t' -v ON_ERROR_STOP=1 -c "
        SELECT
          count(*),
          coalesce(sum(payload), 0),
          md5(string_agg(id::text || ':' || payload::text, ',' ORDER BY id)),
          (pg_control_checkpoint()).checkpoint_lsn,
          (pg_control_checkpoint()).redo_lsn,
          pg_current_wal_insert_lsn(),
          pg_current_wal_flush_lsn(),
          s.num_timed,
          s.num_requested,
          s.num_done
        FROM recovery_probe, pg_stat_checkpointer s
        GROUP BY s.num_timed, s.num_requested, s.num_done
      "
  } >"$output" 2>"$output.stderr"
  [ "$(wc -l <"$output" | tr -d '[:space:]')" = 2 ] || {
    printf 'unexpected database-state row count: %s\n' "$output" >&2
    return 1
  }
}

state_field() {
  local file="$1"
  local field="$2"
  awk -F '\t' -v field="$field" 'NR == 1 { for (i = 1; i <= NF; i++) if ($i == field) column = i; next }
    NR == 2 && column { print $column }' "$file"
}

assert_same_contents() {
  local expected="$1"
  local observed="$2"
  local field expected_value observed_value

  for field in row_count payload_sum content_md5; do
    expected_value="$(state_field "$expected" "$field")"
    observed_value="$(state_field "$observed" "$field")"
    if [ -z "$expected_value" ] || [ "$observed_value" != "$expected_value" ]; then
      printf 'database content mismatch for %s: expected=%s observed=%s\n' \
        "$field" "$expected_value" "$observed_value" >&2
      return 1
    fi
  done
}

signal_active_server() {
  local signal="$1"
  local evidence="$2"

  [ -n "$active_pid" ] || return 125
  fresh_supervision_pid_running "$active_pid" || return 1
  fresh_pid_matches_birth_identity "$active_pid" "$active_identity" || return 125
  assert_active_server_cgroup "pre-$signal" || return
  printf 'phase\tpid\tpgid\tbirth_identity\tsignal\tsent_at\n' >"$evidence"
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$active_phase" "$active_pid" "$active_pgid" "$active_identity" \
    "$signal" "$(fresh_timestamp)" >>"$evidence"
  fresh_signal_owned_pid "$signal" "$active_pid" "$active_identity"
}

wait_for_unassisted_exit() {
  local exit_evidence="$1"
  local deadline wait_status group_deadline cgroup_empty=not-requested

  deadline=$(( $(fresh_supervision_now_ms) + timeout_seconds * 1000 ))
  while fresh_supervision_pid_running "$active_pid"; do
    if ! fresh_pid_matches_birth_identity "$active_pid" "$active_identity"; then
      # The leader can exit between the liveness check above and reading its
      # immutable birth identity.  Only classify an identity mismatch as PID
      # reuse when the numeric PID is still live after that failed read.
      fresh_supervision_pid_running "$active_pid" && return 125
      break
    fi
    [ "$(fresh_supervision_now_ms)" -lt "$deadline" ] || {
      printf 'server did not exit after bridged signal without escalation\n' >&2
      return 124
    }
    sleep 0.05
  done
  fresh_reap_process_group_leader "$active_pid"
  wait_status="$FRESH_PROCESS_GROUP_WAIT_STATUS"
  group_deadline=$(( $(fresh_supervision_now_ms) + timeout_seconds * 1000 ))
  while fresh_process_group_exists "$active_pgid"; do
    [ "$(fresh_supervision_now_ms)" -lt "$group_deadline" ] || {
      printf 'server process group remained after leader exit: %s\n' "$active_pgid" >&2
      return 124
    }
    sleep 0.05
  done
  if [ -n "$active_cgroup_dir" ] && [ -n "$active_cgroup_identity" ]; then
    fresh_wait_cgroup_empty "$active_cgroup_dir" "$active_cgroup_identity" \
      "$((timeout_seconds * 1000))"
    cgroup_empty=true
  fi
  fresh_wait_tcp_port_closed 127.0.0.1 "$port" "$((timeout_seconds * 1000))"
  [ -z "$(find "$dev_shm" -mindepth 1 -print -quit)" ] || {
    printf 'shared objects survived normal guest shutdown: %s\n' "$dev_shm" >&2
    return 1
  }
  [ "$wait_status" -eq 0 ] || {
    printf 'server leader exited nonzero after unassisted guest shutdown: phase=%s status=%s\n' \
      "$active_phase" "$wait_status" >&2
    return 1
  }
  {
    printf 'phase\twait_status\tprocess_group_empty\tcgroup_empty\tport_closed\tshared_objects_empty\tescalation_used\n'
    printf '%s\t%s\ttrue\t%s\ttrue\ttrue\tfalse\n' \
      "$active_phase" "$wait_status" "$cgroup_empty"
  } >"$exit_evidence"
  active_pid=""
  active_pgid=""
  active_identity=""
  active_phase=""
  active_cgroup_unit=""
  active_cgroup_dir=""
  active_cgroup_identity=""
}

snapshot_carrier before-initdb
current_stage="initdb"
assert_frozen_immutable_carrier before-initdb-execution
initdb_log="$report_dir/initdb.log"
initdb_cache_telemetry="$(cache_telemetry_path_for_log "$initdb_log")"
run_logged "$report_dir/initdb.log" \
  env -u WASMER_DIR -u WASMER_CACHE_DIR \
  "${sealed_loader_unset_args[@]}" \
  "${sealed_loader_env[@]}" \
  "OLIPHAUNT_WASIX_CACHE_OFFER_TELEMETRY_FILE=$initdb_cache_telemetry" \
  "$wasmer_bin" "${wasmer_args[@]}" "$wasix_initdb" -- \
  -D "$pgdata" -A trust --no-locale --encoding=UTF8 --no-instructions
validate_observe_cache_telemetry "$initdb_log" runtime:initdb
snapshot_carrier after-initdb

current_stage="baseline-start"
start_server baseline "$report_dir/baseline.server.log" "$report_dir/baseline.limits"
wait_for_ready "$report_dir/baseline.wait.log"
capture_and_validate_settings baseline
psql_to_file "$report_dir/baseline-create.tsv" "
  CREATE TABLE recovery_probe (
    id bigint PRIMARY KEY,
    payload bigint NOT NULL
  );
  INSERT INTO recovery_probe
  SELECT g, ((g::bigint * 1103515245 + 12345) % 2147483647)
  FROM generate_series(1, 4096) AS g;
  CHECKPOINT;
  SELECT count(*) FROM recovery_probe
"
capture_database_state "$report_dir/baseline-state.tsv"
baseline_checkpoint_lsn="$(state_field "$report_dir/baseline-state.tsv" checkpoint_lsn)"
baseline_flush_lsn="$(state_field "$report_dir/baseline-state.tsv" flush_lsn)"
[[ "$baseline_checkpoint_lsn" =~ ^[0-9A-F]+/[0-9A-F]+$ ]] || {
  printf 'invalid baseline checkpoint LSN: %s\n' "$baseline_checkpoint_lsn" >&2
  exit 1
}
[[ "$baseline_flush_lsn" =~ ^[0-9A-F]+/[0-9A-F]+$ ]] || {
  printf 'invalid baseline flush LSN: %s\n' "$baseline_flush_lsn" >&2
  exit 1
}

current_stage="acknowledged-transactions"
printf 'transaction\tinsert_lsn\tflush_lsn\tflush_covers_insert\n' \
  >"$report_dir/acknowledged-transactions.tsv"
for transaction in $(seq 1 "$transaction_count"); do
  first_id=$((4096 + (transaction - 1) * rows_per_transaction + 1))
  last_id=$((first_id + rows_per_transaction - 1))
  update_first=$((1 + ((transaction - 1) * rows_per_transaction) % 4096))
  update_last=$((update_first + rows_per_transaction - 1))
  if [ "$update_last" -gt 4096 ]; then update_last=4096; fi
  transaction_result="$report_dir/transaction-$transaction.tsv"
  psql_to_file "$transaction_result" "
    BEGIN;
    INSERT INTO recovery_probe
    SELECT g, ((g::bigint * 1103515245 + $transaction * 12345) % 2147483647)
    FROM generate_series($first_id, $last_id) AS g;
    UPDATE recovery_probe
    SET payload = payload + $transaction
    WHERE id BETWEEN $update_first AND $update_last;
    COMMIT;
    SELECT
      $transaction,
      pg_current_wal_insert_lsn(),
      pg_current_wal_flush_lsn(),
      pg_current_wal_flush_lsn() >= pg_current_wal_insert_lsn()
  "
  transaction_line="$(tr -d '\r' <"$transaction_result")"
  transaction_fields="$(awk -F '\t' '{ print NF }' <<<"$transaction_line")"
  if [ "$transaction_fields" != 4 ] || [ "${transaction_line##*$'\t'}" != t ]; then
      printf 'transaction %s was not proven flushed: %s\n' \
        "$transaction" "$transaction_line" >&2
      exit 1
  fi
  printf '%s\n' "$transaction_line" >>"$report_dir/acknowledged-transactions.tsv"
done

capture_database_state "$report_dir/pre-crash-state.tsv"
precrash_checkpoint_lsn="$(state_field "$report_dir/pre-crash-state.tsv" checkpoint_lsn)"
precrash_flush_lsn="$(state_field "$report_dir/pre-crash-state.tsv" flush_lsn)"
[ "$precrash_checkpoint_lsn" = "$baseline_checkpoint_lsn" ] || {
  printf 'checkpoint advanced after controlled baseline: baseline=%s precrash=%s\n' \
    "$baseline_checkpoint_lsn" "$precrash_checkpoint_lsn" >&2
  exit 1
}
[ "$precrash_flush_lsn" != "$baseline_flush_lsn" ] || {
  echo "post-checkpoint transactions did not advance the flushed WAL LSN" >&2
  exit 1
}
snapshot_carrier before-sigquit

current_stage="immediate-shutdown"
signal_active_server QUIT "$report_dir/sigquit.tsv"
wait_for_unassisted_exit "$report_dir/immediate-exit.tsv"
validate_postgres_cache_telemetry "$report_dir/baseline.server.log"
grep -Fq 'received immediate shutdown request' "$report_dir/baseline.server.log" || {
  echo "PostgreSQL did not log an immediate shutdown request after host SIGQUIT" >&2
  exit 1
}
snapshot_carrier after-sigquit

current_stage="recovery-start"
start_server recovery "$report_dir/recovery.server.log" "$report_dir/recovery.limits"
wait_for_ready "$report_dir/recovery.wait.log"
capture_and_validate_settings recovery
grep -Fq 'database system was not properly shut down; automatic recovery in progress' \
  "$report_dir/recovery.server.log" || {
  echo "restart did not enter PostgreSQL automatic recovery" >&2
  exit 1
}
grep -Fq 'redo starts at' "$report_dir/recovery.server.log" || {
  echo "restart did not report WAL redo" >&2
  exit 1
}
capture_database_state "$report_dir/recovered-state.tsv"
assert_same_contents "$report_dir/pre-crash-state.tsv" "$report_dir/recovered-state.tsv"
snapshot_carrier after-recovery

current_stage="smart-shutdown"
signal_active_server TERM "$report_dir/sigterm.tsv"
wait_for_unassisted_exit "$report_dir/smart-exit.tsv"
validate_postgres_cache_telemetry "$report_dir/recovery.server.log"
grep -Fq 'received smart shutdown request' "$report_dir/recovery.server.log" || {
  echo "PostgreSQL did not log a smart shutdown request after host SIGTERM" >&2
  exit 1
}
snapshot_carrier after-smart-shutdown

current_stage="clean-reopen"
start_server clean-reopen "$report_dir/clean-reopen.server.log" "$report_dir/clean-reopen.limits"
wait_for_ready "$report_dir/clean-reopen.wait.log"
capture_and_validate_settings clean-reopen
grep -Fq 'database system was shut down at' "$report_dir/clean-reopen.server.log" || {
  echo "final reopen did not observe a cleanly shut down cluster" >&2
  exit 1
}
if grep -Fq 'automatic recovery in progress' "$report_dir/clean-reopen.server.log"; then
  echo "final reopen unexpectedly entered crash recovery" >&2
  exit 1
fi
capture_database_state "$report_dir/clean-reopen-state.tsv"
assert_same_contents "$report_dir/pre-crash-state.tsv" "$report_dir/clean-reopen-state.tsv"

current_stage="final-smart-shutdown"
signal_active_server TERM "$report_dir/final-sigterm.tsv"
wait_for_unassisted_exit "$report_dir/final-smart-exit.tsv"
validate_postgres_cache_telemetry "$report_dir/clean-reopen.server.log"
grep -Fq 'received smart shutdown request' "$report_dir/clean-reopen.server.log" || {
  echo "final PostgreSQL process did not receive smart shutdown" >&2
  exit 1
}
snapshot_carrier final

current_stage="sealed-loader-validation"
if [ "$require_zero_write_aot" -eq 1 ]; then
  python3 "$loader_validator" \
    --audit "$sealed_loader_audit" \
    --manifest "$sealed_manifest" \
    --output "$sealed_loader_validation" \
    --required-snapshot-mode direct-immutable-inode \
    --expected-initdb-executions 1 \
    --expected-postgres-executions 3
  chmod 0444 "$sealed_loader_audit" "$sealed_loader_validation"
fi

current_stage="campaign-end-verification"
if [ "$require_zero_write_aot" -eq 1 ]; then
  "$FRESH_ROOT/bin/verify-immutable-sealed-carrier.sh" \
    --sealed-carrier "$sealed_carrier" \
    --receipt "$immutable_carrier_receipt"
fi
fresh_capture_qualification_carrier_identity "$sealed_carrier"
if [ "$FRESH_QUALIFICATION_CARRIER_CLOSURE_IDENTITY" != \
  "$frozen_carrier_identity" ] ||
  [ "$FRESH_QUALIFICATION_CORE_PROFILE" != "$frozen_core_profile" ] ||
  [ "$FRESH_QUALIFICATION_GUEST_BUILD_RECIPE_SHA256" != \
    "$frozen_guest_build_recipe_sha256" ]; then
  echo "sealed carrier failed the campaign-end full verification" >&2
  exit 125
fi
printf 'campaign-end\t%s\t%s\t%s\tpassed\n' \
  "$boundary_verification_scope" "$frozen_carrier_identity" \
  "$FRESH_QUALIFICATION_CARRIER_CLOSURE_IDENTITY" \
  >>"$carrier_boundary_verification"
assert_frozen_policy
assert_frozen_immutable_carrier campaign-end

if [ "$keep_pgdata" -eq 0 ]; then
  fresh_require_managed_generated_path "$pgdata" "successful recovery PGDATA"
  fresh_require_managed_generated_path "$dev_shm" "successful recovery shared-object directory"
  rm -rf -- "$pgdata" "$dev_shm"
  printf 'status\tdiscarded-after-success\npgdata\t%s\ndev_shm\t%s\n' \
    "$pgdata" "$dev_shm" >"$report_dir/run-retention.tsv"
else
  printf 'status\tretained\npgdata\t%s\ndev_shm\t%s\n' \
    "$pgdata" "$dev_shm" >"$report_dir/run-retention.tsv"
fi

sealed_loader_audit_sha256=none
sealed_loader_validation_sha256=none
if [ "$require_zero_write_aot" -eq 1 ]; then
  sealed_loader_audit_sha256="$(fresh_wasmer_bin_hash "$sealed_loader_audit")"
  sealed_loader_validation_sha256="$(fresh_wasmer_bin_hash "$sealed_loader_validation")"
fi
carrier_snapshots_sha256="$(fresh_wasmer_bin_hash "$carrier_snapshots")"
immutable_verification_sha256="$(fresh_wasmer_bin_hash "$immutable_verification")"
carrier_boundary_verification_sha256="$(
  fresh_wasmer_bin_hash "$carrier_boundary_verification"
)"
cgroup_evidence_identity=none
if [ "$cgroup_enabled" -eq 1 ]; then
  cgroup_evidence_identity="$(
    {
      fresh_wasmer_bin_hash "$report_dir/baseline.cgroup.tsv"
      fresh_wasmer_bin_hash "$report_dir/recovery.cgroup.tsv"
      fresh_wasmer_bin_hash "$report_dir/clean-reopen.cgroup.tsv"
    } | fresh_sha256_stream
  )"
fi
observed_cache_observe_validations="$(
  find "$report_dir" -type f -name '*.cache-offers-validation.tsv' -print | wc -l
)"
observed_cache_adaptive_validations="$(
  find "$report_dir" -type f -name '*.cache-offers-adaptive-validation.tsv' -print | wc -l
)"
[ "$observed_cache_observe_validations" -eq 4 ] &&
  [ "$observed_cache_adaptive_validations" -eq 3 ] || {
  printf 'recovery cache telemetry validation population differs: observe=%s/4 adaptive=%s/3\n' \
    "$observed_cache_observe_validations" \
    "$observed_cache_adaptive_validations" >&2
  exit 1
}
cache_adaptive_active_count=0
cache_adaptive_fallback_count=0
while IFS= read -r adaptive_validation_file; do
  adaptive_outcome="$(awk -F '\t' 'NR == 2 { print $3 }' \
    "$adaptive_validation_file")"
  case "$adaptive_outcome" in
    adaptive-active)
      cache_adaptive_active_count=$((cache_adaptive_active_count + 1))
      ;;
    observe-only-fallback)
      cache_adaptive_fallback_count=$((cache_adaptive_fallback_count + 1))
      ;;
    *)
      printf 'unknown adaptive validation outcome %s in %s\n' \
        "$adaptive_outcome" "$adaptive_validation_file" >&2
      exit 1
      ;;
  esac
done < <(
  find "$report_dir" -type f \
    -name '*.cache-offers-adaptive-validation.tsv' -print | LC_ALL=C sort
)
[ $((cache_adaptive_active_count + cache_adaptive_fallback_count)) -eq 3 ] || {
  echo 'recovery adaptive cache outcomes do not cover all postgres epochs' >&2
  exit 1
}
cache_validation_identity="$(
  find "$report_dir" -type f \
    \( -name '*.cache-offers-validation.tsv' -o \
       -name '*.cache-offers-adaptive-validation.tsv' \) -print |
    LC_ALL=C sort |
    while IFS= read -r validation_file; do
      fresh_wasmer_bin_hash "$validation_file"
    done |
    fresh_sha256_stream
)"
printf 'schema_version\tstatus\tmode\tclassification\tcarrier_closure_identity\tqualification_policy_sha256\tcache_telemetry_policy_sha256\tcache_validation_identity\tcache_observe_validation_count\tcache_adaptive_validation_count\tcache_adaptive_active_count\tcache_adaptive_fallback_count\timmutable_receipt_sha256\timmutable_receipt_dev\timmutable_receipt_ino\timmutable_verification_sha256\tcarrier_boundary_verification_sha256\tsealed_loader_audit_sha256\tsealed_loader_validation_sha256\tcarrier_snapshots_sha256\tcgroup_evidence_identity\tcgroup_memory_max_bytes\tcgroup_memory_high_bytes\tcgroup_swap_max_bytes\tcore_profile\tguest_build_recipe_sha256\n' \
  >"$evidence_envelope"
printf 'oliphaunt.wasix-postmaster.immediate-recovery-evidence.v3\tpassed\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
  "$mode" "$classification" "$frozen_carrier_identity" \
  "$qualification_policy_sha256" "$cache_telemetry_policy_sha256" \
  "$cache_validation_identity" "$observed_cache_observe_validations" \
  "$observed_cache_adaptive_validations" \
  "$cache_adaptive_active_count" "$cache_adaptive_fallback_count" \
  "$immutable_receipt_sha256" \
  "$immutable_receipt_dev" "$immutable_receipt_ino" \
  "$immutable_verification_sha256" \
  "$carrier_boundary_verification_sha256" \
  "$sealed_loader_audit_sha256" "$sealed_loader_validation_sha256" \
  "$carrier_snapshots_sha256" "$cgroup_evidence_identity" \
  "$cgroup_memory_max_bytes" \
  "$cgroup_memory_high_bytes" "$cgroup_swap_max_bytes" \
  "$frozen_core_profile" "$frozen_guest_build_recipe_sha256" \
  >>"$evidence_envelope"
chmod 0444 "$immutable_verification" "$carrier_snapshots" \
  "$carrier_boundary_verification" "$evidence_envelope" \
  "$report_dir/run-retention.tsv"
if [ "$cgroup_enabled" -eq 1 ]; then
  chmod 0444 "$report_dir/baseline.cgroup.tsv" \
    "$report_dir/recovery.cgroup.tsv" \
    "$report_dir/clean-reopen.cgroup.tsv"
fi

current_stage="complete"
qualification_status="passed"

printf 'WASIX immediate recovery %s passed: %s\n' \
  "$classification" "$report_dir"
