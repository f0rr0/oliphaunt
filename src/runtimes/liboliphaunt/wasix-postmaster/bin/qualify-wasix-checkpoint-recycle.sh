#!/usr/bin/env bash

set -euo pipefail

# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"
source "$FRESH_ROOT/lib/sealed-carrier.sh"
source "$FRESH_ROOT/lib/postgres-profiles.sh"
source "$FRESH_ROOT/lib/process-supervision.sh"
source "$FRESH_ROOT/lib/server-lifecycle.sh"
source "$FRESH_ROOT/lib/qualification-identities.sh"

usage() {
  cat <<'USAGE'
Usage: qualify-wasix-checkpoint-recycle.sh --sealed-carrier DIR --immutable-carrier-receipt FILE [options]

Run fixed-offer periodic-checkpoint, WAL recycle, clean postmaster recycle, and
standalone embedded-memory evidence. This lane is research-only and does not
define a release or embedded-default claim.

  --sealed-carrier DIR       Exact compiler-free carrier. Required.
  --immutable-carrier-receipt FILE
                             External Linux immutable-deployment receipt.
                             Required for every executable qualification.
  --mode MODE                smoke, diagnostic, qualification. Default: smoke.
  --blocks N                 Balanced ABBA/BAAB blocks. Defaults: 1/3/10.
  --duration-seconds N       Per-sample steady epoch. Defaults: 40/240/240.
  --connections N            Persistent clients. Default: 4.
  --tps-per-client N         Fixed offers/client/second. Default: 15.
  --stagger-us N             Per-client start stagger. Default: 12500.
  --start-port PORT          Default: 55980.
  --timeout SECONDS          Per-operation deadline. Default: 240.
  --cgroup-memory-max SIZE   Standalone WASIX MemoryMax. Default: 256M.
  --cgroup-memory-high SIZE  Standalone WASIX MemoryHigh. Default: 224M.
  --cgroup-swap-max SIZE     Standalone WASIX MemorySwapMax. Default: 0.
  --skip-memory-sample       Skip standalone WASIX memory/recycle evidence;
                             aggregate status then fails closed.
  --keep-pgdata              Retain successful sample PGDATA.
  --label NAME               Evidence label.
  --print-plan               Print the bounded resolved plan and exit.
  -h, --help                 Show help.

Smoke enforces structural/correctness gates and observes latency gates.
Diagnostic and qualification modes enforce absolute and paired latency gates.
Qualification mode requires at least ten balanced blocks. Every mode remains
research-only and non-release.
USAGE
}

sealed_carrier=""
immutable_carrier_receipt=""
mode="${WASIX_CHECKPOINT_MODE:-smoke}"
blocks="${WASIX_CHECKPOINT_BLOCKS:-}"
duration_seconds="${WASIX_CHECKPOINT_DURATION_SECONDS:-}"
blocks_explicit=0
duration_explicit=0
connections="${WASIX_CHECKPOINT_CONNECTIONS:-4}"
tps_per_client="${WASIX_CHECKPOINT_TPS_PER_CLIENT:-15}"
stagger_us="${WASIX_CHECKPOINT_STAGGER_US:-12500}"
start_port="${WASIX_CHECKPOINT_PORT:-55980}"
timeout_seconds="${WASIX_CHECKPOINT_TIMEOUT:-240}"
cgroup_memory_max="${WASIX_CHECKPOINT_CGROUP_MEMORY_MAX:-256M}"
cgroup_memory_high="${WASIX_CHECKPOINT_CGROUP_MEMORY_HIGH:-224M}"
cgroup_swap_max="${WASIX_CHECKPOINT_CGROUP_SWAP_MAX:-0}"
run_label="${WASIX_CHECKPOINT_LABEL:-$(date -u +%Y%m%dT%H%M%SZ)}"
skip_memory_sample=0
keep_pgdata=0
print_plan=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --sealed-carrier) shift; [ "$#" -gt 0 ] || exit 2; sealed_carrier="$1" ;;
    --immutable-carrier-receipt) shift; [ "$#" -gt 0 ] || exit 2; [ -z "$immutable_carrier_receipt" ] || { echo '--immutable-carrier-receipt may only be specified once' >&2; exit 2; }; immutable_carrier_receipt="$1" ;;
    --mode) shift; [ "$#" -gt 0 ] || exit 2; mode="$1" ;;
    --blocks) shift; [ "$#" -gt 0 ] || exit 2; blocks="$1"; blocks_explicit=1 ;;
    --duration-seconds) shift; [ "$#" -gt 0 ] || exit 2; duration_seconds="$1"; duration_explicit=1 ;;
    --connections) shift; [ "$#" -gt 0 ] || exit 2; connections="$1" ;;
    --tps-per-client) shift; [ "$#" -gt 0 ] || exit 2; tps_per_client="$1" ;;
    --stagger-us) shift; [ "$#" -gt 0 ] || exit 2; stagger_us="$1" ;;
    --start-port) shift; [ "$#" -gt 0 ] || exit 2; start_port="$1" ;;
    --timeout) shift; [ "$#" -gt 0 ] || exit 2; timeout_seconds="$1" ;;
    --cgroup-memory-max) shift; [ "$#" -gt 0 ] || exit 2; cgroup_memory_max="$1" ;;
    --cgroup-memory-high) shift; [ "$#" -gt 0 ] || exit 2; cgroup_memory_high="$1" ;;
    --cgroup-swap-max) shift; [ "$#" -gt 0 ] || exit 2; cgroup_swap_max="$1" ;;
    --skip-memory-sample) skip_memory_sample=1 ;;
    --keep-pgdata) keep_pgdata=1 ;;
    --label) shift; [ "$#" -gt 0 ] || exit 2; run_label="$1" ;;
    --print-plan) print_plan=1 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

is_positive_integer() { [[ "$1" =~ ^[1-9][0-9]*$ ]]; }
is_nonnegative_integer() { [[ "$1" =~ ^[0-9]+$ ]]; }
validate_cgroup_size() { [[ "$1" =~ ^[0-9]+([KMGTPE]([i]?B)?)?$ ]]; }
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

case "$mode" in
  smoke)
    [ "$blocks_explicit" -eq 1 ] || blocks=1
    [ "$duration_explicit" -eq 1 ] || duration_seconds=40
    min_wal_bytes=33554432
    min_checkpoints=1
    min_overlap_samples=10
    post_recycle_quiescence_seconds=5
    performance_enforced=0
    ;;
  diagnostic)
    [ "$blocks_explicit" -eq 1 ] || blocks=3
    [ "$duration_explicit" -eq 1 ] || duration_seconds=240
    min_wal_bytes=536870912
    min_checkpoints=6
    min_overlap_samples=100
    post_recycle_quiescence_seconds=60
    performance_enforced=1
    ;;
  qualification)
    [ "$blocks_explicit" -eq 1 ] || blocks=10
    [ "$duration_explicit" -eq 1 ] || duration_seconds=240
    min_wal_bytes=536870912
    min_checkpoints=6
    min_overlap_samples=100
    post_recycle_quiescence_seconds=60
    performance_enforced=1
    ;;
  *) echo "--mode requires smoke, diagnostic, or qualification" >&2; exit 2 ;;
esac

for value in "$blocks" "$duration_seconds" "$connections" "$tps_per_client" "$start_port" "$timeout_seconds"; do
  is_positive_integer "$value" || { echo "positive integer option required" >&2; exit 2; }
done
is_nonnegative_integer "$stagger_us" || { echo "--stagger-us requires a nonnegative integer" >&2; exit 2; }
[ "$stagger_us" -le 1000000 ] || { echo "--stagger-us exceeds the probe limit" >&2; exit 2; }
[ "$connections" -le 4 ] || { echo "at most four clients fit the embedded profile control headroom" >&2; exit 2; }
[ "$tps_per_client" -le 10000 ] && [ "$duration_seconds" -le 86400 ] || { echo "probe load exceeds bounded limits" >&2; exit 2; }
[ "$start_port" -le 65535 ] || { echo "--start-port exceeds 65535" >&2; exit 2; }
for cgroup_size in "$cgroup_memory_max" "$cgroup_memory_high" "$cgroup_swap_max"; do
  validate_cgroup_size "$cgroup_size" || {
    printf 'invalid cgroup size: %s\n' "$cgroup_size" >&2
    exit 2
  }
done
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
[ "$cgroup_memory_max_bytes" -gt 0 ] &&
  [ "$cgroup_memory_high_bytes" -gt 0 ] || {
  echo "MemoryMax and MemoryHigh must be finite positive sizes" >&2
  exit 2
}
[ "$cgroup_memory_high_bytes" -le "$cgroup_memory_max_bytes" ] || {
  echo "MemoryHigh may not exceed MemoryMax" >&2
  exit 2
}
if [ "$mode" = qualification ] && [ "$blocks" -lt 10 ]; then
  echo "qualification mode requires at least 10 balanced blocks" >&2
  exit 2
fi
case "$run_label" in
  ""|[!A-Za-z0-9]*|*[!A-Za-z0-9._-]*)
    echo "--label must start with a letter or number and contain only letters, numbers, '.', '_', and '-'" >&2
    exit 2
    ;;
esac
min_achieved_tps="$(
  awk -v clients="$connections" -v tps="$tps_per_client" \
    'BEGIN { printf "%.6f", clients * tps * 0.99 }'
)"

if [ "$print_plan" -eq 1 ]; then
  printf 'mode\t%s\nblocks\t%s\nduration_seconds\t%s\nconnections\t%s\n' "$mode" "$blocks" "$duration_seconds" "$connections"
  printf 'tps_per_client\t%s\nmin_wal_bytes\t%s\nmin_checkpoints\t%s\n' "$tps_per_client" "$min_wal_bytes" "$min_checkpoints"
  printf 'min_achieved_tps\t%s\n' "$min_achieved_tps"
  printf 'cgroup_memory_max\t%s\ncgroup_memory_max_bytes\t%s\n' \
    "$cgroup_memory_max" "$cgroup_memory_max_bytes"
  printf 'cgroup_memory_high\t%s\ncgroup_memory_high_bytes\t%s\n' \
    "$cgroup_memory_high" "$cgroup_memory_high_bytes"
  printf 'cgroup_swap_max\t%s\ncgroup_swap_max_bytes\t%s\n' \
    "$cgroup_swap_max" "$cgroup_swap_max_bytes"
  printf 'memory_sample\t%s\nclassification\tresearch-only-non-release\n' "$([ "$skip_memory_sample" -eq 0 ] && printf enabled || printf disabled)"
  printf 'require_zero_write_aot\t1\nrequired_snapshot_mode\tdirect-immutable-inode\n'
  printf 'immutable_carrier_receipt\t%s\n' "${immutable_carrier_receipt:-required-at-execution}"
  exit 0
fi

[ "$(uname -s)" = Linux ] || { echo "qualification currently requires Linux cgroup v2" >&2; exit 2; }
[ -n "$sealed_carrier" ] || { echo "--sealed-carrier is required" >&2; exit 2; }
[ -n "$immutable_carrier_receipt" ] || { echo "--immutable-carrier-receipt is required" >&2; exit 2; }
[ -d "$sealed_carrier" ] || { printf 'missing sealed carrier: %s\n' "$sealed_carrier" >&2; exit 2; }
sealed_carrier="$(cd "$sealed_carrier" && pwd -P)"
receipt_parent="$(dirname "$immutable_carrier_receipt")"
[ -d "$receipt_parent" ] && [ ! -L "$receipt_parent" ] || {
  printf 'immutable carrier receipt parent must be a non-symlink directory: %s\n' \
    "$receipt_parent" >&2
  exit 2
}
immutable_carrier_receipt="$(cd "$receipt_parent" && pwd -P)/$(basename "$immutable_carrier_receipt")"
[ "$(id -u)" -ne 0 ] || {
  echo 'checkpoint qualification must run unprivileged after deployment' >&2
  exit 2
}
cap_eff="$(awk '$1 == "CapEff:" { print $2 }' /proc/self/status)"
[[ "$cap_eff" =~ ^[0-9a-fA-F]+$ ]] || {
  echo 'could not read exact CapEff for checkpoint immutable qualification' >&2
  exit 2
}
if (( (16#$cap_eff & (1 << 9)) != 0 )); then
  echo 'checkpoint qualification refuses effective CAP_LINUX_IMMUTABLE' >&2
  exit 2
fi
for command in cc ldd perl python3 systemd-run stat; do fresh_require_command "$command"; done
for binary in pg_config initdb postgres psql pg_checksums; do
  [ -x "$NATIVE_INSTALL_DIR/bin/$binary" ] || { printf 'missing native oracle: %s\n' "$NATIVE_INSTALL_DIR/bin/$binary" >&2; exit 2; }
done

fresh_ensure_dirs
fresh_capture_qualification_carrier_identity "$sealed_carrier"
carrier_identity="$FRESH_QUALIFICATION_CARRIER_CLOSURE_IDENTITY"
core_profile="$FRESH_QUALIFICATION_CORE_PROFILE"
guest_build_recipe_sha256="$FRESH_QUALIFICATION_GUEST_BUILD_RECIPE_SHA256"
"$FRESH_ROOT/bin/verify-immutable-sealed-carrier.sh" \
  --sealed-carrier "$sealed_carrier" \
  --receipt "$immutable_carrier_receipt" --fast
immutable_receipt_sha256="$(fresh_wasmer_bin_hash "$immutable_carrier_receipt")"
read -r immutable_receipt_dev immutable_receipt_ino < <(
  stat -c '%d %i' -- "$immutable_carrier_receipt"
)
loader_validator="$FRESH_ROOT/bin/validate-sealed-loader-audit.py"
loader_validator_sha256="$(fresh_wasmer_bin_hash "$loader_validator")"
cache_observe_validator="$FRESH_ROOT/bin/validate-file-cache-telemetry.py"
cache_observe_validator_sha256="$(fresh_wasmer_bin_hash "$cache_observe_validator")"
cache_adaptive_validator="$FRESH_ROOT/bin/validate-adaptive-file-cache-telemetry.py"
cache_adaptive_validator_sha256="$(fresh_wasmer_bin_hash "$cache_adaptive_validator")"
expected_initdb_executions=$((blocks * 2))
expected_postgres_executions=$((blocks * 2))
expected_cache_observe_validations=$((blocks * 4))
expected_cache_adaptive_validations=$((blocks * 2))
if [ "$skip_memory_sample" -eq 0 ]; then
  expected_initdb_executions=$((expected_initdb_executions + 1))
  expected_postgres_executions=$((expected_postgres_executions + 2))
  expected_cache_observe_validations=$((expected_cache_observe_validations + 3))
  expected_cache_adaptive_validations=$((expected_cache_adaptive_validations + 2))
fi
fresh_capture_native_oracle_identity "$NATIVE_INSTALL_DIR"
native_identity="$FRESH_QUALIFICATION_NATIVE_ORACLE_IDENTITY"
pg_checksums_bin="$NATIVE_INSTALL_DIR/bin/pg_checksums"
pg_checksums_sha256="$(fresh_wasmer_bin_hash "$pg_checksums_bin")"

checkpoint_gucs="$FRESH_ROOT/profiles/checkpoint-policies/embedded-steady-v1.gucs"
checkpoint_policy="$FRESH_ROOT/profiles/checkpoint-policies/embedded-steady-v1.tsv"
workload_setup_sql="$FRESH_ROOT/bench/sql/checkpoint-workload-setup.sql"
workload_volume_sql="$FRESH_ROOT/bench/sql/checkpoint-volume.sql"
workload_state_sql="$FRESH_ROOT/bench/sql/checkpoint-database-state.sql"
[ -f "$checkpoint_gucs" ] && [ ! -L "$checkpoint_gucs" ] &&
  [ -f "$checkpoint_policy" ] && [ ! -L "$checkpoint_policy" ] || {
    echo "checkpoint policy inputs must be regular non-symlink files" >&2
    exit 2
  }
for sql_input in "$workload_setup_sql" "$workload_volume_sql" "$workload_state_sql"; do
  [ -f "$sql_input" ] && [ ! -L "$sql_input" ] || {
    printf 'workload SQL input must be regular and non-symlink: %s\n' \
      "$sql_input" >&2
    exit 2
  }
done
checkpoint_gucs_sha256="$(fresh_wasmer_bin_hash "$checkpoint_gucs")"
checkpoint_policy_sha256="$(fresh_wasmer_bin_hash "$checkpoint_policy")"
workload_setup_sha256="$(fresh_wasmer_bin_hash "$workload_setup_sql")"
workload_volume_sha256="$(fresh_wasmer_bin_hash "$workload_volume_sql")"
workload_state_sha256="$(fresh_wasmer_bin_hash "$workload_state_sql")"
workload_sql_identity="$(
  printf '%s\n%s\n%s\n' \
    "$workload_setup_sha256" "$workload_volume_sha256" \
    "$workload_state_sha256" | fresh_sha256_stream
)"
mapfile -t checkpoint_guc_values <"$checkpoint_gucs"
fresh_resolve_postgres_profiles embedded-concurrent safe "${checkpoint_guc_values[@]}"
[ "${#FRESH_POSTGRES_PROFILE_OVERLAPPING_EXPLICIT[@]}" -eq 0 ] || exit 2
effective_gucs=("${FRESH_POSTGRES_PROFILE_GUCS[@]}")

run_root="$FRESH_WORK_ROOT/run/checkpoint-recycle-$run_label"
report_root="$FRESH_WORK_ROOT/reports/checkpoint-recycle-$run_label"
fresh_require_managed_generated_path "$run_root" "checkpoint run root"
fresh_require_managed_generated_path "$report_root" "checkpoint report root"
fresh_claim_generated_directories "$run_root" "$report_root" || {
  printf 'checkpoint qualification label is already claimed: %s\n' "$run_label" >&2
  exit 2
}
mkdir -p "$report_root/samples" "$report_root/provenance"
sealed_loader_audit="$report_root/sealed-loader-audit.jsonl"
sealed_loader_validation="$report_root/sealed-loader-audit-validation.tsv"
sealed_loader_envelope="$report_root/qualification-evidence-envelope.tsv"
[ ! -e "$sealed_loader_audit" ] && [ ! -L "$sealed_loader_audit" ] || {
  echo 'sealed loader audit path exists before checkpoint qualification' >&2
  exit 2
}

cp -p "$checkpoint_gucs" "$report_root/provenance/checkpoint-policy.gucs"
cp -p "$checkpoint_policy" "$report_root/provenance/checkpoint-policy.tsv"
cp -p "$workload_setup_sql" "$report_root/provenance/checkpoint-workload-setup.sql"
cp -p "$workload_volume_sql" "$report_root/provenance/checkpoint-volume.sql"
cp -p "$workload_state_sql" "$report_root/provenance/checkpoint-database-state.sql"
fresh_write_native_oracle_manifest "$NATIVE_INSTALL_DIR" "$report_root/provenance/native-oracle-identity.tsv"
cp -p "$sealed_carrier/manifest.json" "$report_root/provenance/manifest.json"
cp -p "$sealed_carrier/wasmer-build.receipt" "$report_root/provenance/wasmer-build.receipt"
cp -p "$sealed_carrier/payload.files" "$report_root/provenance/payload.files"
fresh_write_postgres_profile_evidence "$report_root/provenance/postgres-profile-inputs.tsv" "$report_root/provenance/postgres-profile-resolution.tsv"
cache_telemetry_policy="$report_root/provenance/cache-telemetry-policy.tsv"
printf 'schema_version\tactivation_source\toutput_environment\tadaptive_path_derivation\tobserve_validator_sha256\tadaptive_validator_sha256\texpected_observe_validations\texpected_adaptive_validations\n' \
  >"$cache_telemetry_policy"
printf 'oliphaunt.wasix-postmaster.cache-telemetry-policy.v1\tsealed-manifest-only\tOLIPHAUNT_WASIX_CACHE_OFFER_TELEMETRY_FILE\tPath::with_extension("adaptive.json")\t%s\t%s\t%s\t%s\n' \
  "$cache_observe_validator_sha256" "$cache_adaptive_validator_sha256" \
  "$expected_cache_observe_validations" "$expected_cache_adaptive_validations" \
  >>"$cache_telemetry_policy"
cache_telemetry_policy_sha256="$(fresh_wasmer_bin_hash "$cache_telemetry_policy")"
standalone_cgroup_policy="$report_root/provenance/standalone-cgroup-policy.tsv"
printf 'schema_version\tenabled\tmemory_max\tmemory_max_bytes\tmemory_high\tmemory_high_bytes\tmemory_swap_max\tmemory_swap_max_bytes\n' \
  >"$standalone_cgroup_policy"
printf 'oliphaunt.wasix-postmaster.standalone-cgroup-policy.v1\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
  "$([ "$skip_memory_sample" -eq 0 ] && printf true || printf false)" \
  "$cgroup_memory_max" "$cgroup_memory_max_bytes" \
  "$cgroup_memory_high" "$cgroup_memory_high_bytes" \
  "$cgroup_swap_max" "$cgroup_swap_max_bytes" \
  >>"$standalone_cgroup_policy"
standalone_cgroup_policy_sha256="$(fresh_wasmer_bin_hash "$standalone_cgroup_policy")"
printf 'schema_version\tpath\tsha256\n' \
  >"$report_root/provenance/checksum-tool.tsv"
printf 'oliphaunt.wasix-postmaster.checksum-tool.v1\t%s\t%s\n' \
  "$pg_checksums_bin" "$pg_checksums_sha256" \
  >>"$report_root/provenance/checksum-tool.tsv"

policy_receipt="$report_root/qualification-policy.tsv"
printf 'schema_version\tstatus\tmode\tblocks\tduration_seconds\tconnections\ttps_per_client\tmin_achieved_tps\tstagger_us\tmin_wal_bytes\tmin_checkpoints\tmin_overlap_samples\tperformance_enforced\tcheckpoint_gucs_sha256\tcheckpoint_policy_sha256\tworkload_sql_identity\tpg_checksums_sha256\tpostgres_profile_identity\tcarrier_identity\tnative_identity\trequire_zero_write_aot\trequired_snapshot_mode\timmutable_receipt_path\timmutable_receipt_sha256\timmutable_receipt_dev\timmutable_receipt_ino\tloader_validator_sha256\texpected_initdb_executions\texpected_postgres_executions\tcore_profile\tguest_build_recipe_sha256\timmutable_verification_scope\n' >"$policy_receipt"
printf 'oliphaunt.wasix-postmaster.checkpoint-qualification-policy.v3\tresearch-only\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t1\tdirect-immutable-inode\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\tcampaign-boundary-full-fast-samples\n' \
  "$mode" "$blocks" "$duration_seconds" "$connections" "$tps_per_client" "$min_achieved_tps" "$stagger_us" "$min_wal_bytes" "$min_checkpoints" "$min_overlap_samples" \
  "$performance_enforced" "$checkpoint_gucs_sha256" "$checkpoint_policy_sha256" "$workload_sql_identity" "$pg_checksums_sha256" "$FRESH_POSTGRES_PROFILE_RESOLUTION_IDENTITY" "$carrier_identity" "$native_identity" \
  "$immutable_carrier_receipt" "$immutable_receipt_sha256" \
  "$immutable_receipt_dev" "$immutable_receipt_ino" \
  "$loader_validator_sha256" "$expected_initdb_executions" \
  "$expected_postgres_executions" "$core_profile" \
  "$guest_build_recipe_sha256" >>"$policy_receipt"
policy_identity="$(fresh_wasmer_bin_hash "$policy_receipt")"
chmod 0444 "$policy_receipt" "$report_root"/provenance/*

assert_frozen_inputs() {
  local receipt_stat observed_receipt_dev observed_receipt_ino
  receipt_stat="$(stat -c '%d %i' -- "$immutable_carrier_receipt")" || return
  read -r observed_receipt_dev observed_receipt_ino <<<"$receipt_stat"
  [ "$(fresh_wasmer_bin_hash "$policy_receipt")" = "$policy_identity" ] &&
    [ "$(fresh_wasmer_bin_hash "$cache_telemetry_policy")" = "$cache_telemetry_policy_sha256" ] &&
    [ "$(fresh_wasmer_bin_hash "$standalone_cgroup_policy")" = "$standalone_cgroup_policy_sha256" ] &&
    [ "$(fresh_wasmer_bin_hash "$checkpoint_gucs")" = "$checkpoint_gucs_sha256" ] &&
    [ "$(fresh_wasmer_bin_hash "$checkpoint_policy")" = "$checkpoint_policy_sha256" ] &&
    [ "$(fresh_wasmer_bin_hash "$workload_setup_sql")" = "$workload_setup_sha256" ] &&
    [ "$(fresh_wasmer_bin_hash "$workload_volume_sql")" = "$workload_volume_sha256" ] &&
    [ "$(fresh_wasmer_bin_hash "$workload_state_sql")" = "$workload_state_sha256" ] &&
    [ "$(fresh_wasmer_bin_hash "$pg_checksums_bin")" = "$pg_checksums_sha256" ] &&
    [ "$(fresh_wasmer_bin_hash "$probe_source")" = "$probe_source_sha256" ] &&
    [ "$(fresh_wasmer_bin_hash "$probe_bin")" = "$probe_sha256" ] &&
    [ "$(fresh_wasmer_bin_hash "$loader_validator")" = "$loader_validator_sha256" ] &&
    [ "$(fresh_wasmer_bin_hash "$cache_observe_validator")" = "$cache_observe_validator_sha256" ] &&
    [ "$(fresh_wasmer_bin_hash "$cache_adaptive_validator")" = "$cache_adaptive_validator_sha256" ] &&
    [ "$observed_receipt_dev" = "$immutable_receipt_dev" ] &&
    [ "$observed_receipt_ino" = "$immutable_receipt_ino" ] &&
    fresh_assert_postgres_profile_inputs &&
    "$FRESH_ROOT/bin/verify-immutable-sealed-carrier.sh" \
      --sealed-carrier "$sealed_carrier" \
      --receipt "$immutable_carrier_receipt" --fast &&
    fresh_capture_native_oracle_identity "$NATIVE_INSTALL_DIR" &&
    [ "$FRESH_QUALIFICATION_NATIVE_ORACLE_IDENTITY" = "$native_identity" ]
}

probe_source="$FRESH_ROOT/probes/libpq_checkpoint_probe.c"
probe_bin="$report_root/provenance/libpq-checkpoint-probe"
pg_config="$NATIVE_INSTALL_DIR/bin/pg_config"
include_dir="$($pg_config --includedir)"
lib_dir="$($pg_config --libdir)"
probe_pending="$(mktemp "$report_root/provenance/.checkpoint-probe.XXXXXX")"
cc -std=c11 -O2 -g0 -Wall -Wextra -Werror -Wpedantic -Wconversion -Wshadow -pthread \
  -I"$include_dir" "$probe_source" -L"$lib_dir" "-Wl,-rpath,$lib_dir" -lpq -o "$probe_pending"
chmod 0555 "$probe_pending"
mv "$probe_pending" "$probe_bin"
probe_sha256="$(fresh_wasmer_bin_hash "$probe_bin")"
probe_source_sha256="$(fresh_wasmer_bin_hash "$probe_source")"
linked_libpq="$(env -u LD_LIBRARY_PATH -u LD_PRELOAD -u LD_AUDIT ldd "$probe_bin" | awk '$1 ~ /^libpq[.]so/ && $2 == "=>" { print $3 }')"
[ -n "$linked_libpq" ] && [ "$(realpath "$linked_libpq")" = "$(realpath "$lib_dir/libpq.so")" ] || {
  echo "checkpoint probe did not resolve exact native-oracle libpq" >&2
  exit 2
}
printf 'schema_version\tprobe_sha256\tprobe_source_sha256\tlibpq_path\tlibpq_sha256\tcompiler\n' >"$report_root/provenance/probe-build.tsv"
printf 'oliphaunt.wasix-postmaster.checkpoint-probe-build.v1\t%s\t%s\t%s\t%s\t%s\n' \
  "$probe_sha256" "$probe_source_sha256" "$(realpath "$linked_libpq")" "$(fresh_wasmer_bin_hash "$(realpath "$linked_libpq")")" \
  "$(cc --version | awk 'NR==1{print}')" >>"$report_root/provenance/probe-build.tsv"
chmod 0444 "$report_root/provenance/probe-build.tsv"

wasmer_bin="$sealed_carrier/bin/wasmer-headless"
wasix_initdb="$sealed_carrier/bin/initdb"
wasix_postgres="$sealed_carrier/bin/postgres"
wasix_lib="$sealed_carrier/lib"
wasmer_stack_size="${WASMER_STACK_SIZE:-33554432}"
wasmer_args=(
  run --quiet --disable-cache
  --sealed-module-manifest "$sealed_carrier/manifest.json"
  --stack-size "$wasmer_stack_size"
  --enable-exceptions --enable-threads --net
  --volume "$REPO_ROOT:$REPO_ROOT"
  --volume "$wasix_lib:/lib"
)
case "$FRESH_WORK_ROOT/" in
  "$REPO_ROOT/"*) ;;
  *) wasmer_args+=(--volume "$FRESH_WORK_ROOT:$FRESH_WORK_ROOT") ;;
esac
case "$sealed_carrier/" in
  "$REPO_ROOT/"*|"$FRESH_WORK_ROOT/"*) ;;
  *) wasmer_args+=(--volume "$sealed_carrier:$sealed_carrier") ;;
esac

active_pid=""
active_pgid=""
active_identity=""
active_port=""
active_cgroup_dir=""
active_cgroup_identity=""
active_dev_shm=""
active_log=""
active_target=""
active_epoch_origin_ns=""
memory_sampler_pid=""
memory_stop_file=""
qualification_status=failed
current_stage=setup

cleanup() {
  local status="$?"
  trap - EXIT HUP INT TERM
  if [ -n "$memory_sampler_pid" ]; then
    [ -n "$memory_stop_file" ] && touch "$memory_stop_file"
    wait "$memory_sampler_pid" 2>/dev/null || true
  fi
  if [ -n "$active_pid" ] && fresh_supervision_pid_running "$active_pid"; then
    fresh_terminate_owned_process_group \
      "$active_pgid" "$active_pid" "$active_identity" 1000 3000 || true
  fi
  {
    printf 'status\t%s\n' "$qualification_status"
    printf 'exit_code\t%s\n' "$status"
    printf 'last_stage\t%s\n' "$current_stage"
    printf 'report_root\t%s\n' "$report_root"
  } >"$report_root/run-result.tsv"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

now_ns() {
  perl -MTime::HiRes=clock_gettime,CLOCK_MONOTONIC \
    -e 'printf "%.0f\n", clock_gettime(CLOCK_MONOTONIC) * 1000000000'
}
run_timed() {
  local log="$1"
  shift
  fresh_run_process_group_timeout "$timeout_seconds" -- "$@" >"$log" 2>&1
}
launch_with_nofile() {
  ulimit -S -n 1024
  exec "$@"
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
    --manifest "$sealed_carrier/manifest.json" \
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
    --manifest "$sealed_carrier/manifest.json" \
    --output "$validation"
  chmod 0444 "$adaptive"
}

server_prefix=()
server_cgroup_unit=""
configure_cgroup() {
  local sample_label="$1"
  local epoch="$2"
  local enable="$3"
  server_prefix=()
  server_cgroup_unit=""
  [ "$enable" -eq 1 ] || return 0
  server_cgroup_unit="oliphaunt-cp-$$-$sample_label-e$epoch"
  server_prefix=(
    systemd-run --user --scope --quiet --collect
    "--unit=$server_cgroup_unit"
    --property=MemoryAccounting=yes
    "--property=MemoryMax=$cgroup_memory_max"
    "--property=MemoryHigh=$cgroup_memory_high"
    "--property=MemorySwapMax=$cgroup_swap_max"
  )
}

capture_cgroup() {
  local pid="$1"
  local unit="$2"
  local deadline relative="" directory observed_max observed_high observed_swap
  active_cgroup_dir=""
  active_cgroup_identity=""
  [ -n "$unit" ] || return 0
  deadline=$(( $(fresh_supervision_now_ms) + 5000 ))
  while [ "$(fresh_supervision_now_ms)" -lt "$deadline" ]; do
    relative="$(awk -F: '$1=="0"{print $3;exit}' \
      "/proc/$pid/cgroup" 2>/dev/null || true)"
    if [ "$(basename "$relative" 2>/dev/null || true)" = "$unit.scope" ]; then
      break
    fi
    sleep 0.05
  done
  case "$relative" in /*) ;; *) return 125 ;; esac
  [ "$(basename "$relative")" = "$unit.scope" ] || return 125
  directory="/sys/fs/cgroup$relative"
  [ -r "$directory/cgroup.procs" ] &&
    [ -r "$directory/memory.peak" ] &&
    [ -r "$directory/memory.max" ] &&
    [ -r "$directory/memory.high" ] &&
    [ -r "$directory/memory.swap.max" ] || return 125
  observed_max="$(<"$directory/memory.max")"
  observed_high="$(<"$directory/memory.high")"
  observed_swap="$(<"$directory/memory.swap.max")"
  [ "$observed_max" = "$cgroup_memory_max_bytes" ] &&
    [ "$observed_high" = "$cgroup_memory_high_bytes" ] &&
    [ "$observed_swap" = "$cgroup_swap_max_bytes" ] || {
    printf 'standalone cgroup controls differ: max=%s/%s high=%s/%s swap=%s/%s\n' \
      "$observed_max" "$cgroup_memory_max_bytes" \
      "$observed_high" "$cgroup_memory_high_bytes" \
      "$observed_swap" "$cgroup_swap_max_bytes" >&2
    return 125
  }
  active_cgroup_dir="$directory"
  active_cgroup_identity="$(fresh_path_identity "$directory")"
}

start_server() {
  local target="$1"
  local pgdata="$2"
  local dev_shm="$3"
  local port="$4"
  local server_log="$5"
  local initialize="$6"
  local sample_label="$7"
  local epoch="$8"
  local measured="$9"
  local initdb_log="${server_log%.log}.initdb.log"
  local initdb_cache_telemetry
  local postgres_cache_telemetry
  local postgres_args=(
    -D "$pgdata" -h 127.0.0.1 -p "$port"
    -c unix_socket_directories=
  )
  local guc
  [ -z "$active_pid" ] || return 125
  ! fresh_tcp_port_open 127.0.0.1 "$port" || return 125
  [ -z "$(find "$dev_shm" -mindepth 1 -print -quit)" ] || return 1
  assert_frozen_inputs
  if [ "$initialize" -eq 1 ]; then
    if [ "$target" = native ]; then
      run_timed "$initdb_log" "$NATIVE_INSTALL_DIR/bin/initdb" \
        -D "$pgdata" -A trust --no-locale --encoding=UTF8 \
        --data-checksums --no-instructions
    else
      local init_args=("${wasmer_args[@]}" --volume "$dev_shm:/dev/shm")
      initdb_cache_telemetry="$(cache_telemetry_path_for_log "$initdb_log")" || return
      run_timed "$initdb_log" env -u WASMER_DIR -u WASMER_CACHE_DIR \
        -u OLIPHAUNT_WASIX_REQUIRE_ZERO_WRITE_AOT \
        -u OLIPHAUNT_WASIX_SEALED_LOADER_AUDIT_FILE \
        -u OLIPHAUNT_WASIX_CACHE_OFFER_TELEMETRY_FILE \
        OLIPHAUNT_WASIX_REQUIRE_ZERO_WRITE_AOT=1 \
        "OLIPHAUNT_WASIX_SEALED_LOADER_AUDIT_FILE=$sealed_loader_audit" \
        "OLIPHAUNT_WASIX_CACHE_OFFER_TELEMETRY_FILE=$initdb_cache_telemetry" \
        "$wasmer_bin" "${init_args[@]}" "$wasix_initdb" -- \
        -D "$pgdata" -A trust --no-locale --encoding=UTF8 \
        --data-checksums --no-instructions
      validate_observe_cache_telemetry "$initdb_log" runtime:initdb
    fi
  fi
  for guc in "${effective_gucs[@]}"; do postgres_args+=(-c "$guc"); done
  configure_cgroup "$sample_label" "$epoch" "$measured"
  active_epoch_origin_ns="$(now_ns)"
  if [ "$target" = native ]; then
    fresh_spawn_process_group -- launch_with_nofile \
      "${server_prefix[@]}" "$NATIVE_INSTALL_DIR/bin/postgres" \
      "${postgres_args[@]}" >"$server_log" 2>&1
  else
    local run_args=("${wasmer_args[@]}" --volume "$dev_shm:/dev/shm")
    postgres_cache_telemetry="$(cache_telemetry_path_for_log "$server_log")" || return
    fresh_spawn_process_group -- launch_with_nofile \
      "${server_prefix[@]}" env -u WASMER_DIR -u WASMER_CACHE_DIR \
      -u OLIPHAUNT_WASIX_REQUIRE_ZERO_WRITE_AOT \
      -u OLIPHAUNT_WASIX_SEALED_LOADER_AUDIT_FILE \
      -u OLIPHAUNT_WASIX_CACHE_OFFER_TELEMETRY_FILE \
      OLIPHAUNT_WASIX_REQUIRE_ZERO_WRITE_AOT=1 \
      "OLIPHAUNT_WASIX_SEALED_LOADER_AUDIT_FILE=$sealed_loader_audit" \
      "OLIPHAUNT_WASIX_CACHE_OFFER_TELEMETRY_FILE=$postgres_cache_telemetry" \
      "$wasmer_bin" "${run_args[@]}" "$wasix_postgres" -- \
      "${postgres_args[@]}" >"$server_log" 2>&1
  fi
  active_pid="$FRESH_PROCESS_GROUP_PID"
  active_pgid="$FRESH_PROCESS_GROUP_PGID"
  active_identity="$FRESH_PROCESS_GROUP_IDENTITY"
  active_port="$port"
  active_dev_shm="$dev_shm"
  active_log="$server_log"
  active_target="$target"
  [ "$active_pid" = "$active_pgid" ] && [ -n "$active_identity" ] ||
    return 125
  capture_cgroup "$active_pid" "$server_cgroup_unit"
}

connection_uri() {
  if [ "$1" = native ]; then
    printf 'postgresql://%s@127.0.0.1:%s/postgres\n' "$(id -un)" "$2"
  else
    printf 'postgresql://wasix@127.0.0.1:%s/postgres\n' "$2"
  fi
}

wait_ready() {
  local conn="$1"
  local log="$2"
  local deadline status
  : >"$log"
  deadline=$(( $(fresh_supervision_now_ms) + timeout_seconds * 1000 ))
  while [ "$(fresh_supervision_now_ms)" -lt "$deadline" ]; do
    set +e
    fresh_run_process_group_timeout_ms 1000 -- \
      env PGCONNECT_TIMEOUT=1 "$NATIVE_INSTALL_DIR/bin/psql" \
      "$conn" -XAtq -v ON_ERROR_STOP=1 -c 'select 1' >>"$log" 2>&1
    status=$?
    set -e
    [ "$status" -eq 0 ] && return 0
    [ "$status" -ne 125 ] || return 125
    fresh_supervision_pid_running "$active_pid" || return 1
    fresh_pid_matches_birth_identity "$active_pid" "$active_identity" ||
      return 125
    sleep 0.1
  done
  return 124
}

psql_file() {
  local conn="$1"
  local output="$2"
  local sql="$3"
  fresh_run_process_group_timeout "$timeout_seconds" -- \
    env PGCONNECT_TIMEOUT=5 "$NATIVE_INSTALL_DIR/bin/psql" \
    "$conn" -XAtq -F $'\t' -v ON_ERROR_STOP=1 -c "$sql" \
    >"$output" 2>"$output.stderr"
}

psql_script() {
  local conn="$1"
  local output="$2"
  local script="$3"
  shift 3
  fresh_run_process_group_timeout "$timeout_seconds" -- \
    env PGCONNECT_TIMEOUT=5 "$NATIVE_INSTALL_DIR/bin/psql" \
    "$conn" -XAtq -v ON_ERROR_STOP=1 "$@" -f "$script" \
    >"$output" 2>"$output.stderr"
}

stop_smart() {
  local evidence="$1"
  local deadline wait_status
  fresh_signal_owned_pid TERM "$active_pid" "$active_identity"
  deadline=$(( $(fresh_supervision_now_ms) + timeout_seconds * 1000 ))
  while fresh_supervision_pid_running "$active_pid"; do
    if ! fresh_pid_matches_birth_identity "$active_pid" "$active_identity"; then
      fresh_supervision_pid_running "$active_pid" && return 125
      break
    fi
    [ "$(fresh_supervision_now_ms)" -lt "$deadline" ] || return 124
    sleep 0.05
  done
  fresh_reap_process_group_leader "$active_pid"
  wait_status="$FRESH_PROCESS_GROUP_WAIT_STATUS"
  [ "$wait_status" -eq 0 ] || return 1
  ! fresh_process_group_exists "$active_pgid" || return 1
  fresh_wait_cgroup_empty \
    "$active_cgroup_dir" "$active_cgroup_identity" 5000 || return 1
  fresh_wait_tcp_port_closed 127.0.0.1 "$active_port" 5000 || return 1
  [ -z "$(find "$active_dev_shm" -mindepth 1 -print -quit)" ] || return 1
  grep -Fq 'received smart shutdown request' "$active_log" || return 1
  grep -Fq 'database system is shut down' "$active_log" || return 1
  {
    printf 'target\tpid\tpgid\tbirth_identity\twait_status\tprocess_group_empty\tcgroup_empty\tport_closed\tshared_objects_empty\tclean_shutdown\tescalation\n'
    printf '%s\t%s\t%s\t%s\t0\ttrue\ttrue\ttrue\ttrue\ttrue\tnone\n' \
      "$active_target" "$active_pid" "$active_pgid" "$active_identity"
  } >"$evidence"
  active_pid=""
  active_pgid=""
  active_identity=""
  active_port=""
  active_cgroup_dir=""
  active_cgroup_identity=""
  active_dev_shm=""
  active_log=""
  active_target=""
  active_epoch_origin_ns=""
}

capture_settings() {
  local conn="$1"
  local output="$2"
  psql_file "$conn" "$output" "
COPY (
  SELECT name, setting, COALESCE(unit, '') AS unit, source
  FROM pg_settings
  WHERE source = 'command line'
    AND name NOT IN (
      'config_file', 'data_directory', 'external_pid_file',
      'hba_file', 'ident_file'
    )
  ORDER BY name
) TO STDOUT WITH (FORMAT csv, HEADER true, DELIMITER E'\\t');
"
}

capture_checkpoint_state() {
  local conn="$1"
  local output="$2"
  psql_file "$conn" "$output" "
COPY (
  SELECT c.num_timed::bigint AS num_timed,
         c.num_requested::bigint AS num_requested,
         c.num_done::bigint AS num_done,
         w.wal_bytes::numeric::bigint AS wal_bytes
  FROM pg_stat_checkpointer AS c
  CROSS JOIN pg_stat_wal AS w
) TO STDOUT WITH (FORMAT csv, HEADER true, DELIMITER E'\\t');
"
}

verify_online_data_checksums() {
  local conn="$1"
  local output="$2"
  psql_file "$conn" "$output" "
COPY (
  SELECT current_setting('data_checksums') AS data_checksums
) TO STDOUT WITH (FORMAT csv, HEADER true, DELIMITER E'\\t');
"
  [ "$(awk -F '\t' 'NR == 2 { print $1 }' "$output")" = on ]
}

completed_time_checkpoints() {
  local server_log="$1"
  awk '
    /checkpoint starting:/ {
      active = 1
      timed = index($0, "checkpoint starting: time") > 0
      next
    }
    active && /checkpoint complete:/ {
      if (timed) count++
      active = 0
      timed = 0
    }
    END { print count + 0 }
  ' "$server_log"
}

wait_for_periodic_checkpoints() {
  local server_log="$1"
  local baseline="$2"
  local receipt="$3"
  local deadline observed
  deadline=$(( $(fresh_supervision_now_ms) + timeout_seconds * 1000 ))
  while :; do
    observed="$(completed_time_checkpoints "$server_log")"
    if [ $((observed - baseline)) -ge "$min_checkpoints" ]; then
      {
        printf 'completed_time_before\tcompleted_time_after\tdelta\n'
        printf '%s\t%s\t%s\n' \
          "$baseline" "$observed" "$((observed - baseline))"
      } >"$receipt"
      return 0
    fi
    fresh_supervision_pid_running "$active_pid" || return 1
    fresh_pid_matches_birth_identity "$active_pid" "$active_identity" ||
      return 125
    [ "$(fresh_supervision_now_ms)" -lt "$deadline" ] || return 124
    sleep 0.2
  done
}

capture_full_stats() {
  local conn="$1"
  local output="$2"
  psql_file "$conn" "$output" "
COPY (
  SELECT 'checkpointer'::text AS section, to_jsonb(c)::text AS payload
  FROM pg_stat_checkpointer AS c
  UNION ALL
  SELECT 'wal', to_jsonb(w)::text
  FROM pg_stat_wal AS w
  UNION ALL
  SELECT 'io', to_jsonb(i)::text
  FROM pg_stat_io AS i
) TO STDOUT WITH (FORMAT csv, HEADER true, DELIMITER E'\\t');
"
}

setup_workload() {
  local conn="$1"
  local output="$2"
  psql_script "$conn" "$output" "$workload_setup_sql" \
    -v "connections=$connections"
}

capture_database_state() {
  local conn="$1"
  local output="$2"
  psql_script "$conn" "$output" "$workload_state_sql"
}

run_probe() {
  local conn="$1"
  local directory="$2"
  local duration="$3"
  local sequence_offset="$4"
  mkdir -p "$directory"
  fresh_run_process_group_timeout "$((timeout_seconds + duration))" -- \
    "$probe_bin" \
      --conninfo "$conn" \
      --output "$directory/transactions.tsv" \
      --flush-output "$directory/flushes.tsv" \
      --clients "$connections" \
      --duration-seconds "$duration" \
      --tps-per-client "$tps_per_client" \
      --stagger-us "$stagger_us" \
      --sequence-offset "$sequence_offset" \
    >"$directory/probe.stdout" 2>"$directory/probe.stderr"
}

validate_periodic_probe() {
  local target="$1"
  local directory="$2"
  local server_log="$3"
  local duration="$4"
  local validation_args=(
    --transactions "$directory/transactions.tsv"
    --flushes "$directory/flushes.tsv"
    --checkpoint-before "$directory/checkpoint-before.tsv"
    --checkpoint-after "$directory/checkpoint-after.tsv"
    --server-log "$server_log"
    --output "$directory/checkpoint-summary.tsv"
    --gates-output "$directory/checkpoint-gates.tsv"
    --target "$target"
    --mode "$mode"
    --clients "$connections"
    --duration-seconds "$duration"
    --tps-per-client "$tps_per_client"
    --stagger-us "$stagger_us"
    --min-achieved-tps "$min_achieved_tps"
    --min-wal-bytes "$min_wal_bytes"
    --min-checkpoints "$min_checkpoints"
    --min-overlap-samples "$min_overlap_samples"
  )
  if [ "$performance_enforced" -eq 1 ]; then
    validation_args+=(--enforce-performance)
  fi
  python3 "$FRESH_ROOT/bin/validate-checkpoint-recycle.py" \
    "${validation_args[@]}"
}

collect_memory_sample() {
  local cgroup_dir="$1"
  local cgroup_identity="$2"
  local epoch="$3"
  local epoch_origin_ns="$4"
  local phase="$5"
  local output="$6"
  local actual_identity pids process_metrics
  local process_count pss_kib pss_anon_kib private_kib pagetables_kib
  local current peak swap anon file kernel cgroup_pagetables dirty writeback
  local event_metrics event_high event_max event_oom event_oom_kill
  local pressure_metrics psi_some psi_full monotonic

  [ -d "$cgroup_dir" ] || return 3
  actual_identity="$(fresh_path_identity "$cgroup_dir")" || return 125
  [ "$actual_identity" = "$cgroup_identity" ] || return 125
  pids="$(tr '\n' ' ' <"$cgroup_dir/cgroup.procs")"
  [ -n "${pids//[[:space:]]/}" ] || return 3
  process_metrics="$(
    {
      local pid
      for pid in $pids; do
        case "$pid" in ""|*[!0-9]*) return 125 ;; esac
        [ -r "/proc/$pid/smaps_rollup" ] &&
          [ -r "/proc/$pid/status" ] || continue
        awk '
          FNR == 1 { file_index++ }
          file_index == 1 && /^Pss:[[:space:]]/ {
            pss = $2
            saw_pss = 1
          }
          file_index == 1 && /^Pss_Anon:[[:space:]]/ { pss_anon = $2 }
          file_index == 1 && /^Private_Clean:[[:space:]]/ { private += $2 }
          file_index == 1 && /^Private_Dirty:[[:space:]]/ { private += $2 }
          file_index == 1 && /^Private_Hugetlb:[[:space:]]/ { private += $2 }
          file_index == 2 && /^VmPTE:[[:space:]]/ { pagetables = $2 }
          END {
            if (saw_pss) {
              printf "1\t%.0f\t%.0f\t%.0f\t%.0f\n",
                pss, pss_anon, private, pagetables
            }
          }
        ' "/proc/$pid/smaps_rollup" "/proc/$pid/status" 2>/dev/null || true
      done
    } | awk -F '\t' '
      {
        process_count += $1
        pss += $2
        pss_anon += $3
        private += $4
        pagetables += $5
      }
      END {
        printf "%d\t%.0f\t%.0f\t%.0f\t%.0f\n",
          process_count, pss, pss_anon, private, pagetables
      }
    '
  )"
  IFS=$'\t' read -r process_count pss_kib pss_anon_kib private_kib pagetables_kib \
    <<<"$process_metrics"
  [ "$process_count" -gt 0 ] || return 3

  current="$(<"$cgroup_dir/memory.current")"
  peak="$(<"$cgroup_dir/memory.peak")"
  swap="$(<"$cgroup_dir/memory.swap.current")"
  IFS=$'\t' read -r anon file kernel cgroup_pagetables dirty writeback < <(
    awk '
      $1 == "anon" { anon = $2; seen["anon"]++ }
      $1 == "file" { file = $2; seen["file"]++ }
      $1 == "kernel" { kernel = $2; seen["kernel"]++ }
      $1 == "pagetables" { pagetables = $2; seen["pagetables"]++ }
      $1 == "file_dirty" { dirty = $2; seen["file_dirty"]++ }
      $1 == "file_writeback" { writeback = $2; seen["file_writeback"]++ }
      END {
        if (seen["anon"] != 1 || seen["file"] != 1 ||
            seen["kernel"] != 1 || seen["pagetables"] != 1 ||
            seen["file_dirty"] != 1 || seen["file_writeback"] != 1 ||
            anon !~ /^[0-9]+$/ || file !~ /^[0-9]+$/ ||
            kernel !~ /^[0-9]+$/ || pagetables !~ /^[0-9]+$/ ||
            dirty !~ /^[0-9]+$/ || writeback !~ /^[0-9]+$/) {
          exit 1
        }
        printf "%s\t%s\t%s\t%s\t%s\t%s\n",
          anon, file, kernel, pagetables, dirty, writeback
      }
    ' "$cgroup_dir/memory.stat"
  )
  event_metrics="$(
    awk '
      $1 == "high" { high = $2; seen["high"]++ }
      $1 == "max" { max = $2; seen["max"]++ }
      $1 == "oom" { oom = $2; seen["oom"]++ }
      $1 == "oom_kill" { oom_kill = $2; seen["oom_kill"]++ }
      END {
        if (seen["high"] != 1 || seen["max"] != 1 ||
            seen["oom"] != 1 || seen["oom_kill"] != 1 ||
            high !~ /^[0-9]+$/ || max !~ /^[0-9]+$/ ||
            oom !~ /^[0-9]+$/ || oom_kill !~ /^[0-9]+$/) {
          exit 1
        }
        printf "%s\t%s\t%s\t%s\n", high, max, oom, oom_kill
      }
    ' "$cgroup_dir/memory.events"
  )" || return 125
  IFS=$'\t' read -r event_high event_max event_oom event_oom_kill \
    <<<"$event_metrics"
  pressure_metrics="$(
    awk '
      ($1 == "some" || $1 == "full") {
        kind = $1
        seen[kind]++
        for (index = 2; index <= NF; index++) {
          split($index, part, "=")
          if (part[1] == "total" && part[2] ~ /^[0-9]+$/) {
            total[kind] = part[2]
          }
        }
      }
      END {
        if (seen["some"] != 1 || seen["full"] != 1 ||
            total["some"] !~ /^[0-9]+$/ || total["full"] !~ /^[0-9]+$/) {
          exit 1
        }
        printf "%s\t%s\n", total["some"], total["full"]
      }
    ' "$cgroup_dir/memory.pressure"
  )" || return 125
  IFS=$'\t' read -r psi_some psi_full <<<"$pressure_metrics"
  for value in \
    "$current" "$peak" "$swap" "$anon" "$file" "$kernel" \
    "$cgroup_pagetables" "$dirty" "$writeback"
  do
    case "$value" in ""|*[!0-9]*) return 125 ;; esac
  done
  monotonic="$(now_ns)"
  printf '1\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$epoch" "$epoch_origin_ns" "$monotonic" "$phase" "$process_count" \
    "$pss_kib" "$pss_anon_kib" "$private_kib" "$pagetables_kib" \
    "$current" "$peak" "$swap" "$anon" "$file" "$kernel" \
    "$cgroup_pagetables" "$dirty" "$writeback" \
    "$event_high" "$event_max" "$event_oom" "$event_oom_kill" \
    "$psi_some" "$psi_full" >>"$output"
}

memory_sampler_loop() {
  local cgroup_dir="$1"
  local cgroup_identity="$2"
  local epoch="$3"
  local epoch_origin_ns="$4"
  local phase_file="$5"
  local stop_file="$6"
  local output="$7"
  local phase sample_status
  while [ ! -e "$stop_file" ]; do
    [ -d "$cgroup_dir" ] || return 0
    phase="$(<"$phase_file")"
    set +e
    collect_memory_sample \
      "$cgroup_dir" "$cgroup_identity" "$epoch" "$epoch_origin_ns" \
      "$phase" "$output"
    sample_status=$?
    set -e
    case "$sample_status" in
      0) ;;
      3) [ -d "$cgroup_dir" ] || return 0 ;;
      *) return "$sample_status" ;;
    esac
    sleep 0.1
  done
}

memory_phase_file=""
start_memory_sampler() {
  local epoch="$1"
  local phase="$2"
  local output="$3"
  [ -n "$active_cgroup_dir" ] && [ -n "$active_epoch_origin_ns" ] ||
    return 125
  if [ ! -e "$output" ]; then
    printf 'schema_version\tepoch\tepoch_origin_monotonic_ns\tmonotonic_ns\tphase\tprocess_count\tpss_kib\tpss_anon_kib\tprivate_kib\tpagetables_kib\tcgroup_current_bytes\tcgroup_peak_bytes\tcgroup_swap_bytes\tcgroup_anon_bytes\tcgroup_file_bytes\tcgroup_kernel_bytes\tcgroup_pagetables_bytes\tcgroup_file_dirty_bytes\tcgroup_file_writeback_bytes\tevent_high\tevent_max\tevent_oom\tevent_oom_kill\tpsi_some_total_usec\tpsi_full_total_usec\n' >"$output"
  fi
  memory_phase_file="$run_root/memory-phase-e$epoch"
  memory_stop_file="$run_root/memory-stop-e$epoch"
  [ ! -e "$memory_stop_file" ] || return 125
  printf '%s\n' "$phase" >"$memory_phase_file"
  memory_sampler_loop \
    "$active_cgroup_dir" "$active_cgroup_identity" "$epoch" \
    "$active_epoch_origin_ns" "$memory_phase_file" "$memory_stop_file" \
    "$output" &
  memory_sampler_pid="$!"
  sleep 0.3
  kill -0 "$memory_sampler_pid" 2>/dev/null
}

set_memory_phase() {
  local phase="$1"
  [ -n "$memory_sampler_pid" ] && [ -n "$memory_phase_file" ] || return 125
  printf '%s\n' "$phase" >"$memory_phase_file"
  sleep 0.3
}

stop_memory_sampler() {
  local status
  [ -n "$memory_sampler_pid" ] || return 0
  touch "$memory_stop_file"
  set +e
  wait "$memory_sampler_pid"
  status=$?
  set -e
  memory_sampler_pid=""
  memory_stop_file=""
  memory_phase_file=""
  [ "$status" -eq 0 ]
}

snapshot_wal() {
  local pgdata="$1"
  local label="$2"
  local output="$3"
  local name path ordinal=0 metrics size device inode
  case "$label" in
    before-steady|after-steady|after-volume|plateau-1|plateau-2|plateau-3) ;;
    *) return 125 ;;
  esac
  if [ ! -e "$output" ]; then
    printf 'schema_version\tsnapshot\tordinal\tname\tsize\tdevice\tinode\n' \
      >"$output"
  fi
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    path="$pgdata/pg_wal/$name"
    [ -f "$path" ] && [ ! -L "$path" ] || return 125
    metrics="$(stat -c '%s %d %i' "$path")"
    read -r size device inode <<<"$metrics"
    ordinal=$((ordinal + 1))
    printf '1\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$label" "$ordinal" "$name" "$size" "$device" "$inode" >>"$output"
  done < <(
    find "$pgdata/pg_wal" -maxdepth 1 -type f -printf '%f\n' |
      awk 'length($0) == 24 && $0 ~ /^[0-9A-F]+$/ { print }' |
      LC_ALL=C sort
  )
  [ "$ordinal" -gt 0 ]
}

wal_checkpoint_completed() {
  local server_log="$1"
  local first_line="$2"
  awk -v first_line="$first_line" '
    NR < first_line { next }
    /checkpoint starting: wal/ { pending = 1 }
    pending && /checkpoint complete:/ {
      completed = 1
      pending = 0
    }
    END { exit !completed }
  ' "$server_log"
}

run_volume_checkpoint() {
  local conn="$1"
  local output="$2"
  local server_log="$3"
  local deadline first_line
  first_line=$(( $(wc -l <"$server_log") + 1 ))
  psql_script "$conn" "$output" "$workload_volume_sql"
  deadline=$(( $(fresh_supervision_now_ms) + timeout_seconds * 1000 ))
  while ! wal_checkpoint_completed "$server_log" "$first_line"; do
    [ "$(fresh_supervision_now_ms)" -lt "$deadline" ] || return 124
    sleep 0.1
  done
}

run_plateau_checkpoints() {
  local conn="$1"
  local pgdata="$2"
  local snapshots="$3"
  local report_dir="$4"
  local index
  for index in 1 2 3; do
    psql_file "$conn" "$report_dir/plateau-$index.checkpoint.tsv" "CHECKPOINT;"
    snapshot_wal "$pgdata" "plateau-$index" "$snapshots"
  done
}

run_periodic_sample() {
  local target="$1"
  local block="$2"
  local pair="$3"
  local position="$4"
  local sample_label="$5"
  local port="$6"
  local sample_run="$run_root/$sample_label"
  local sample_report="$report_root/samples/$sample_label"
  local pgdata="$sample_run/pgdata"
  local dev_shm="$sample_run/dev-shm"
  local server_log="$sample_report/server.log"
  local conn settings_sha sample_status p95_ns p99_ns summary_fields
  local time_checkpoint_baseline
  local sequence_offset

  current_stage="paired:$sample_label:setup"
  assert_frozen_inputs
  mkdir -p "$sample_run" "$sample_report" "$dev_shm"
  start_server \
    "$target" "$pgdata" "$dev_shm" "$port" "$server_log" \
    1 "$sample_label" 0 0
  conn="$(connection_uri "$target" "$port")"
  wait_ready "$conn" "$sample_report/readiness.log"
  verify_online_data_checksums \
    "$conn" "$sample_report/data-checksums-online.tsv"
  setup_workload "$conn" "$sample_report/workload-setup.tsv"
  capture_settings "$conn" "$sample_report/effective-settings.tsv"
  fresh_validate_postgres_profile_settings \
    "$sample_report/effective-settings.tsv" \
    "$sample_report/postgres-profile-validation.tsv"
  capture_full_stats "$conn" "$sample_report/full-stats-before.tsv"
  capture_checkpoint_state "$conn" "$sample_report/checkpoint-before.tsv"
  time_checkpoint_baseline="$(completed_time_checkpoints "$server_log")"

  current_stage="paired:$sample_label:open-loop"
  sequence_offset=$((block * 1000000000 + position * 10000000))
  run_probe "$conn" "$sample_report" "$duration_seconds" "$sequence_offset"
  wait_for_periodic_checkpoints \
    "$server_log" "$time_checkpoint_baseline" \
    "$sample_report/time-checkpoint-log-delta.tsv"
  capture_checkpoint_state "$conn" "$sample_report/checkpoint-after.tsv"
  capture_full_stats "$conn" "$sample_report/full-stats-after.tsv"
  validate_periodic_probe "$target" "$sample_report" "$server_log" \
    "$duration_seconds"

  current_stage="paired:$sample_label:smart-shutdown"
  stop_smart "$sample_report/smart-shutdown.tsv"
  if [ "$target" = wasix ]; then
    validate_postgres_cache_telemetry "$server_log"
  fi
  summary_fields="$(
    python3 "$FRESH_ROOT/bin/extract-checkpoint-summary.py" \
      "$sample_report/checkpoint-summary.tsv"
  )"
  IFS=$'\t' read -r sample_status p95_ns p99_ns <<<"$summary_fields"
  settings_sha="$(fresh_wasmer_bin_hash "$sample_report/effective-settings.tsv")"
  printf '%s\t%s\t%s\t%s\t%s\t0\t%s\t%s\t%s\t%s\t%s\n' \
    "$block" "$pair" "$position" "$target" "$sample_label" \
    "$sample_status" "$p95_ns" "$p99_ns" "$sample_report" "$settings_sha" \
    >>"$report_root/samples.tsv"
  assert_frozen_inputs
  if [ "$keep_pgdata" -eq 0 ]; then
    fresh_require_managed_generated_path "$sample_run" \
      "checkpoint paired sample run root"
    rm -rf -- "$sample_run"
  fi
}

record_cgroup_epoch() {
  local epoch="$1"
  local output="$2"
  local memory_max memory_high swap_max
  memory_max="$(<"$active_cgroup_dir/memory.max")"
  memory_high="$(<"$active_cgroup_dir/memory.high")"
  swap_max="$(<"$active_cgroup_dir/memory.swap.max")"
  if [ ! -e "$output" ]; then
    printf 'schema_version\tepoch\tepoch_origin_monotonic_ns\tcgroup_path\tcgroup_identity\tmemory_max_bytes\tmemory_high_bytes\tmemory_swap_max_bytes\n' \
      >"$output"
  fi
  printf '1\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$epoch" "$active_epoch_origin_ns" "$active_cgroup_dir" \
    "$active_cgroup_identity" "$memory_max" "$memory_high" "$swap_max" \
    >>"$output"
}

run_standalone_wasix() {
  local sample_label="$run_label-standalone-wasix"
  local sample_run="$run_root/$sample_label"
  local sample_report="$report_root/standalone-wasix"
  local pgdata="$sample_run/pgdata"
  local dev_shm="$sample_run/dev-shm"
  local server_log="$sample_report/server-epoch-1.log"
  local restart_log="$sample_report/server-epoch-2.log"
  local conn snapshots memory_samples epoch_receipt
  local old_pid old_identity old_cgroup_dir old_cgroup_identity
  local old_epoch_origin old_state_sha new_state_sha time_checkpoint_baseline
  local checksum_status checksum_result checksum_log_sha256
  local sequence_offset=7000000000

  mkdir -p "$sample_run" "$sample_report/second-steady" "$dev_shm"
  snapshots="$sample_report/wal-snapshots.tsv"
  memory_samples="$sample_report/memory-samples.tsv"
  epoch_receipt="$sample_report/cgroup-epochs.tsv"

  current_stage="standalone:epoch-1-start"
  start_server \
    wasix "$pgdata" "$dev_shm" "$start_port" "$server_log" \
    1 "$sample_label" 1 1
  conn="$(connection_uri wasix "$start_port")"
  wait_ready "$conn" "$sample_report/readiness-epoch-1.log"
  verify_online_data_checksums \
    "$conn" "$sample_report/data-checksums-online-epoch-1.tsv"
  record_cgroup_epoch 1 "$epoch_receipt"
  setup_workload "$conn" "$sample_report/workload-setup.tsv"
  capture_settings "$conn" "$sample_report/effective-settings.tsv"
  fresh_validate_postgres_profile_settings \
    "$sample_report/effective-settings.tsv" \
    "$sample_report/postgres-profile-validation.tsv"
  snapshot_wal "$pgdata" before-steady "$snapshots"

  current_stage="standalone:initial-quiescence"
  start_memory_sampler 1 initial-quiescent "$memory_samples"
  sleep 2

  current_stage="standalone:steady"
  set_memory_phase steady
  capture_full_stats "$conn" "$sample_report/full-stats-before-steady.tsv"
  capture_checkpoint_state "$conn" "$sample_report/checkpoint-before.tsv"
  time_checkpoint_baseline="$(completed_time_checkpoints "$server_log")"
  run_probe "$conn" "$sample_report" "$duration_seconds" "$sequence_offset"
  wait_for_periodic_checkpoints \
    "$server_log" "$time_checkpoint_baseline" \
    "$sample_report/time-checkpoint-log-delta.tsv"
  capture_checkpoint_state "$conn" "$sample_report/checkpoint-after.tsv"
  capture_full_stats "$conn" "$sample_report/full-stats-after-steady.tsv"
  validate_periodic_probe wasix "$sample_report" "$server_log" \
    "$duration_seconds"
  snapshot_wal "$pgdata" after-steady "$snapshots"

  current_stage="standalone:volume-checkpoint"
  set_memory_phase volume-checkpoint
  capture_full_stats "$conn" "$sample_report/full-stats-before-volume.tsv"
  run_volume_checkpoint \
    "$conn" "$sample_report/volume-transaction.tsv" "$server_log"
  snapshot_wal "$pgdata" after-volume "$snapshots"
  run_plateau_checkpoints "$conn" "$pgdata" "$snapshots" "$sample_report"
  capture_full_stats "$conn" "$sample_report/full-stats-after-volume.tsv"
  capture_database_state "$conn" "$sample_report/database-state-before.tsv"
  old_state_sha="$(fresh_wasmer_bin_hash "$sample_report/database-state-before.tsv")"

  current_stage="standalone:smart-recycle-shutdown"
  old_pid="$active_pid"
  old_identity="$active_identity"
  old_cgroup_dir="$active_cgroup_dir"
  old_cgroup_identity="$active_cgroup_identity"
  old_epoch_origin="$active_epoch_origin_ns"
  set_memory_phase recycle-shutdown
  stop_smart "$sample_report/smart-shutdown-epoch-1.tsv"
  stop_memory_sampler
  validate_postgres_cache_telemetry "$server_log"

  current_stage="standalone:recycle-startup"
  start_server \
    wasix "$pgdata" "$dev_shm" "$start_port" "$restart_log" \
    0 "$sample_label" 2 1
  conn="$(connection_uri wasix "$start_port")"
  wait_ready "$conn" "$sample_report/readiness-epoch-2.log"
  verify_online_data_checksums \
    "$conn" "$sample_report/data-checksums-online-epoch-2.tsv"
  record_cgroup_epoch 2 "$epoch_receipt"
  [ "$active_identity" != "$old_identity" ] &&
    [ "$active_cgroup_dir" != "$old_cgroup_dir" ] &&
    [ "$active_cgroup_identity" != "$old_cgroup_identity" ] ||
    return 125
  grep -Fq 'database system was shut down at' "$restart_log"
  if grep -Eq \
    'database system was interrupted|redo starts at|redo done at|automatic recovery' \
    "$restart_log"; then
    return 1
  fi
  start_memory_sampler 2 recycle-startup "$memory_samples"
  capture_database_state "$conn" "$sample_report/database-state-after.tsv"
  new_state_sha="$(fresh_wasmer_bin_hash "$sample_report/database-state-after.tsv")"
  [ "$new_state_sha" = "$old_state_sha" ] &&
    cmp -s \
      "$sample_report/database-state-before.tsv" \
      "$sample_report/database-state-after.tsv"
  {
    printf 'schema_version\told_pid\told_birth_identity\tnew_pid\tnew_birth_identity\told_cgroup_path\told_cgroup_identity\tnew_cgroup_path\tnew_cgroup_identity\told_epoch_origin_monotonic_ns\tnew_epoch_origin_monotonic_ns\tdatabase_state_sha256\tclean_shutdown\tcrash_recovery\tstate_exact\n'
    printf 'oliphaunt.wasix-postmaster.clean-recycle.v1\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\ttrue\tfalse\ttrue\n' \
      "$old_pid" "$old_identity" "$active_pid" "$active_identity" \
      "$old_cgroup_dir" "$old_cgroup_identity" \
      "$active_cgroup_dir" "$active_cgroup_identity" \
      "$old_epoch_origin" "$active_epoch_origin_ns" "$new_state_sha"
  } >"$sample_report/clean-recycle.tsv"

  current_stage="standalone:second-steady"
  set_memory_phase second-steady
  capture_checkpoint_state \
    "$conn" "$sample_report/second-steady/checkpoint-before.tsv"
  time_checkpoint_baseline="$(completed_time_checkpoints "$restart_log")"
  run_probe \
    "$conn" "$sample_report/second-steady" "$duration_seconds" \
    "$((sequence_offset + 1000000000))"
  wait_for_periodic_checkpoints \
    "$restart_log" "$time_checkpoint_baseline" \
    "$sample_report/second-steady/time-checkpoint-log-delta.tsv"
  capture_checkpoint_state \
    "$conn" "$sample_report/second-steady/checkpoint-after.tsv"
  validate_periodic_probe \
    wasix "$sample_report/second-steady" "$restart_log" "$duration_seconds"

  current_stage="standalone:post-recycle-quiescence"
  set_memory_phase post-recycle-quiescent
  sleep "$post_recycle_quiescence_seconds"
  stop_smart "$sample_report/smart-shutdown-epoch-2.tsv"
  stop_memory_sampler
  validate_postgres_cache_telemetry "$restart_log"

  current_stage="standalone:offline-checksums"
  set +e
  run_timed "$sample_report/pg-checksums.log" \
    "$pg_checksums_bin" --check -D "$pgdata"
  checksum_status=$?
  set -e
  checksum_result=failed
  if [ "$checksum_status" -eq 0 ]; then
    checksum_result=passed
  fi
  checksum_log_sha256="$(fresh_wasmer_bin_hash "$sample_report/pg-checksums.log")"
  {
    printf 'schema_version\tstatus\texit_status\ttool_path\ttool_sha256\tpgdata\tlog\tlog_sha256\n'
    printf 'oliphaunt.wasix-postmaster.offline-checksums.v1\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$checksum_result" "$checksum_status" \
      "$pg_checksums_bin" "$pg_checksums_sha256" \
      "$pgdata" "$sample_report/pg-checksums.log" "$checksum_log_sha256"
  } >"$sample_report/pg-checksums.tsv"
  [ "$checksum_status" -eq 0 ]
  grep -Fq 'Checksum operation completed' "$sample_report/pg-checksums.log"

  current_stage="standalone:validate-memory-wal"
  python3 "$FRESH_ROOT/bin/validate-checkpoint-memory.py" \
    --samples "$memory_samples" \
    --epochs "$epoch_receipt" \
    --output "$sample_report/memory-summary.tsv" \
    --gates-output "$sample_report/memory-gates.tsv"
  python3 "$FRESH_ROOT/bin/validate-wal-recycle.py" \
    --snapshots "$snapshots" \
    --server-log "$server_log" \
    --output "$sample_report/wal-summary.tsv" \
    --gates-output "$sample_report/wal-gates.tsv"
  memory_status=passed
}

# Every paired row is a fresh postmaster. Positions form two adjacent
# native/WASIX pairs; block parity reverses the order to balance drift.
printf 'block\tpair\tposition\ttarget\tlabel\tharness_status\tsample_status\tp95_ns\tp99_ns\treport_dir\tsettings_sha256\n' \
  >"$report_root/samples.tsv"
for ((block = 1; block <= blocks; block++)); do
  if [ $((block % 2)) -eq 1 ]; then
    order=ABBA
    target_order=(native wasix wasix native)
  else
    order=BAAB
    target_order=(wasix native native wasix)
  fi
  for position_index in "${!target_order[@]}"; do
    position=$((position_index + 1))
    pair=$(((position_index / 2) + 1))
    target="${target_order[$position_index]}"
    sample_label="$(printf '%s-b%02d-%s-p%d-%s' \
      "$run_label" "$block" "$order" "$position" "$target")"
    printf 'checkpoint block=%s order=%s pair=%s position=%s target=%s\n' \
      "$block" "$order" "$pair" "$position" "$target"
    run_periodic_sample \
      "$target" "$block" "$pair" "$position" "$sample_label" "$start_port"
  done
done

memory_status=not-run
if [ "$skip_memory_sample" -eq 0 ]; then
  run_standalone_wasix
fi
assert_frozen_inputs

fresh_capture_qualification_carrier_identity "$sealed_carrier" &&
  [ "$FRESH_QUALIFICATION_CARRIER_CLOSURE_IDENTITY" = "$carrier_identity" ] &&
  [ "$FRESH_QUALIFICATION_CORE_PROFILE" = "$core_profile" ] &&
  [ "$FRESH_QUALIFICATION_GUEST_BUILD_RECIPE_SHA256" = \
    "$guest_build_recipe_sha256" ] || {
  echo 'sealed carrier failed the campaign-end full verification' >&2
  exit 125
}

current_stage=sealed-loader-validation
python3 "$loader_validator" \
  --audit "$sealed_loader_audit" \
  --manifest "$sealed_carrier/manifest.json" \
  --output "$sealed_loader_validation" \
  --required-snapshot-mode direct-immutable-inode \
  --expected-initdb-executions "$expected_initdb_executions" \
  --expected-postgres-executions "$expected_postgres_executions"
chmod 0444 "$sealed_loader_audit" "$sealed_loader_validation"
assert_frozen_inputs

current_stage=cache-telemetry-validation
observed_cache_observe_validations="$(
  find "$report_root" -type f -name '*.cache-offers-validation.tsv' -print | wc -l
)"
observed_cache_adaptive_validations="$(
  find "$report_root" -type f -name '*.cache-offers-adaptive-validation.tsv' -print | wc -l
)"
[ "$observed_cache_observe_validations" -eq \
  "$expected_cache_observe_validations" ] &&
  [ "$observed_cache_adaptive_validations" -eq \
  "$expected_cache_adaptive_validations" ] || {
  printf 'cache telemetry validation population differs: observe=%s/%s adaptive=%s/%s\n' \
    "$observed_cache_observe_validations" \
    "$expected_cache_observe_validations" \
    "$observed_cache_adaptive_validations" \
    "$expected_cache_adaptive_validations" >&2
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
  find "$report_root" -type f \
    -name '*.cache-offers-adaptive-validation.tsv' -print | LC_ALL=C sort
)
[ $((cache_adaptive_active_count + cache_adaptive_fallback_count)) -eq \
  "$observed_cache_adaptive_validations" ] || {
  echo 'adaptive cache admission outcomes do not cover the validation population' >&2
  exit 1
}
cache_validation_identity="$(
  find "$report_root" -type f \
    \( -name '*.cache-offers-validation.tsv' -o \
       -name '*.cache-offers-adaptive-validation.tsv' \) -print |
    LC_ALL=C sort |
    while IFS= read -r validation_file; do
      fresh_wasmer_bin_hash "$validation_file"
    done |
    fresh_sha256_stream
)"

current_stage=aggregate
set +e
python3 "$FRESH_ROOT/bin/summarize-checkpoint-qualification.py" \
  --samples "$report_root/samples.tsv" \
  --output "$report_root/paired-summary.tsv" \
  --result "$report_root/qualification-result.tsv" \
  --mode "$mode" \
  --blocks "$blocks" \
  --policy-sha256 "$policy_identity" \
  --carrier-identity "$carrier_identity" \
  --native-identity "$native_identity" \
  --memory-status "$memory_status"
summary_status=$?
set -e

{
  printf '# WASIX checkpoint/recycle qualification\n\n'
  printf -- '- Status: `%s`\n' \
    "$([ "$summary_status" -eq 0 ] && printf passed || printf failed)"
  printf -- '- Classification: `research-only-%s-non-release`\n' "$mode"
  printf -- '- Fresh-server order: alternating `ABBA` / `BAAB`\n'
  printf -- '- Fixed offers: `%s clients x %s TPS/client x %s seconds`\n' \
    "$connections" "$tps_per_client" "$duration_seconds"
  printf -- '- Checkpoint policy: `%s` (`%s`)\n' \
    "$checkpoint_policy" "$checkpoint_policy_sha256"
  printf -- '- Pair receipts: `%s`\n' "$report_root/samples.tsv"
  printf -- '- Pair summary: `%s`\n' "$report_root/paired-summary.tsv"
  printf -- '- Standalone recycle evidence: `%s`\n' \
    "$report_root/standalone-wasix"
  printf -- '- Immutable deployment receipt: `%s` (`%s`, dev `%s`, ino `%s`)\n' \
    "$immutable_carrier_receipt" "$immutable_receipt_sha256" \
    "$immutable_receipt_dev" "$immutable_receipt_ino"
  printf -- '- Direct immutable loader audit / validation: `%s` / `%s`\n' \
    "$sealed_loader_audit" "$sealed_loader_validation"
  printf -- '- Cache telemetry policy / validation identity: `%s` / `%s`\n' \
    "$cache_telemetry_policy" "$cache_validation_identity"
  printf -- '- Adaptive admission outcomes: `%s active / %s observe-only fallback`\n' \
    "$cache_adaptive_active_count" "$cache_adaptive_fallback_count"
  printf -- '- Standalone cgroup policy: `%s` (`%s`)\n' \
    "$standalone_cgroup_policy" "$standalone_cgroup_policy_sha256"
  printf -- '- Bound evidence envelope: `%s`\n' "$sealed_loader_envelope"
  printf -- '- Claim boundary: research-only; no release or embedded-default claim\n'
} >"$report_root/summary.md"

printf 'schema_version\tstatus\tcarrier_closure_identity\timmutable_receipt_sha256\timmutable_receipt_dev\timmutable_receipt_ino\tqualification_policy_sha256\tsealed_loader_audit_sha256\tsealed_loader_validation_sha256\tcache_telemetry_policy_sha256\tcache_validation_identity\tcache_observe_validation_count\tcache_adaptive_validation_count\tcache_adaptive_active_count\tcache_adaptive_fallback_count\tstandalone_cgroup_policy_sha256\tqualification_result_sha256\tcore_profile\tguest_build_recipe_sha256\timmutable_verification_scope\n' \
  >"$sealed_loader_envelope"
printf 'oliphaunt.wasix-postmaster.checkpoint-evidence-envelope.v3\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
  "$([ "$summary_status" -eq 0 ] && printf passed || printf failed)" \
  "$carrier_identity" "$immutable_receipt_sha256" \
  "$immutable_receipt_dev" "$immutable_receipt_ino" "$policy_identity" \
  "$(fresh_wasmer_bin_hash "$sealed_loader_audit")" \
  "$(fresh_wasmer_bin_hash "$sealed_loader_validation")" \
  "$cache_telemetry_policy_sha256" "$cache_validation_identity" \
  "$observed_cache_observe_validations" \
  "$observed_cache_adaptive_validations" \
  "$cache_adaptive_active_count" "$cache_adaptive_fallback_count" \
  "$standalone_cgroup_policy_sha256" \
  "$(fresh_wasmer_bin_hash "$report_root/qualification-result.tsv")" \
  "$core_profile" "$guest_build_recipe_sha256" \
  campaign-boundary-full-fast-samples \
  >>"$sealed_loader_envelope"
chmod 0444 "$sealed_loader_envelope"

if [ "$summary_status" -eq 0 ]; then
  qualification_status=passed
  current_stage=complete
  if [ "$keep_pgdata" -eq 0 ]; then
    fresh_require_managed_generated_path "$run_root" "checkpoint run root"
    rm -rf -- "$run_root"
  fi
  printf 'passed: checkpoint/recycle qualification; see %s\n' \
    "$report_root/summary.md"
else
  current_stage=aggregate-failed
  printf 'failed: checkpoint/recycle qualification; see %s\n' \
    "$report_root/summary.md" >&2
  exit "$summary_status"
fi
