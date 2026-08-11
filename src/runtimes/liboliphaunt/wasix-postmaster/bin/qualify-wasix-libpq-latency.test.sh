#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="$(mktemp -d)"
if [ "${KEEP_TEST_ROOT:-0}" = 1 ]; then
  printf 'retaining latency qualifier test root: %s\n' "$TEST_ROOT" >&2
else
  trap 'rm -rf -- "$TEST_ROOT"' EXIT HUP INT TERM
fi
FAKE_PROJECT="$TEST_ROOT/project"
FAKE_REPORTS="$TEST_ROOT/reports"
FAKE_RUNS="$TEST_ROOT/runs"
FAKE_NATIVE="$TEST_ROOT/native"
FAKE_CARRIER="$TEST_ROOT/carrier"
FAKE_IMMUTABLE_RECEIPT="$TEST_ROOT/immutable-carrier.receipt.json"
mkdir -p "$FAKE_PROJECT/bin" "$FAKE_PROJECT/lib" "$FAKE_PROJECT/probes" \
  "$FAKE_PROJECT/profiles" \
  "$FAKE_REPORTS" "$FAKE_RUNS" "$FAKE_NATIVE/bin" "$FAKE_NATIVE/lib" "$FAKE_CARRIER/bin"

cp "$PROJECT_ROOT/bin/qualify-wasix-libpq-latency.sh" "$FAKE_PROJECT/bin/"
cp "$PROJECT_ROOT/bin/compare-libpq-latency.py" "$FAKE_PROJECT/bin/"
cp "$PROJECT_ROOT/bin/compare-postgres-settings.py" "$FAKE_PROJECT/bin/"
cp "$PROJECT_ROOT/lib/qualification-identities.sh" "$FAKE_PROJECT/lib/"
cp "$PROJECT_ROOT/lib/durable_publication.py" "$FAKE_PROJECT/lib/"
cp "$PROJECT_ROOT/probes/libpq_latency_probe.c" "$FAKE_PROJECT/probes/"

cat >"$FAKE_PROJECT/lib/common.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
export FRESH_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export REPORT_DIR="${REPORT_DIR:?}"
export RUN_DIR="${RUN_DIR:?}"
export NATIVE_INSTALL_DIR="${NATIVE_INSTALL_DIR:?}"
fresh_sha256_stream() { sha256sum | awk '{ print $1 }'; }
fresh_wasmer_bin_hash() { sha256sum "$1" | awk '{ print $1 }'; }
fresh_claim_generated_directories() {
  local -a claimed=()
  local path
  local index

  [ "$#" -gt 0 ] || return 2
  for path in "$@"; do
    mkdir -p "$(dirname "$path")"
    if ! mkdir -- "$path"; then
      for ((index = ${#claimed[@]} - 1; index >= 0; index--)); do
        rmdir -- "${claimed[$index]}" 2>/dev/null || true
      done
      return 2
    fi
    claimed+=("$path")
  done
}
EOF

cat >"$FAKE_PROJECT/bin/verify-immutable-sealed-carrier.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
{ [ "$#" -eq 4 ] || { [ "$#" -eq 5 ] && [ "$5" = --fast ]; }; } &&
  [ "$1" = --sealed-carrier ] && [ -d "$2" ] &&
  [ "$3" = --receipt ] && [ -f "$4" ] && [ ! -L "$4" ]
EOF

cat >"$FAKE_PROJECT/lib/sealed-carrier.sh" <<'EOF'
#!/usr/bin/env bash
fresh_verify_sealed_headless_carrier() {
  [ -f "$1/manifest.json" ] && [ -f "$1/wasmer-build.receipt" ] &&
    [ -f "$1/payload.files" ] && [ -x "$1/bin/wasmer-headless" ]
}
EOF

cat >"$FAKE_PROJECT/lib/postgres-profiles.sh" <<'EOF'
#!/usr/bin/env bash
fresh_resolve_postgres_profiles() {
  [ "$1" = embedded-concurrent ] && [ "$2" = safe ] || return 2
  profile_path="$FRESH_ROOT/profiles/fake-profile"
  profile_sha="$(fresh_wasmer_bin_hash "$profile_path")"
  FRESH_POSTGRES_PROFILE_RESOLUTION_IDENTITY="$(
    {
      printf 'schema\toliphaunt.wasix-postmaster.postgres-profile-resolution.v1\n'
      printf 'input\truntime-footprint\tembedded-concurrent\t%s\n' "$profile_sha"
      printf 'setting\tshared_buffers\t4096\truntime-footprint\tembedded-concurrent\t%s\t1\n' "$profile_sha"
    } | fresh_sha256_stream
  )"
  FRESH_POSTGRES_RUNTIME_FOOTPRINT_ID="$1"
  FRESH_POSTGRES_DURABILITY_ID="$2"
  FRESH_POSTGRES_RUNTIME_FOOTPRINT_SHA256="$profile_sha"
  FRESH_POSTGRES_DURABILITY_SHA256="$(fresh_wasmer_bin_hash "$FRESH_ROOT/profiles/fake-durability")"
}
fresh_assert_postgres_profile_inputs() { return 0; }
fresh_write_postgres_profile_evidence() {
  profile_path="$FRESH_ROOT/profiles/fake-profile"
  profile_sha="$(fresh_wasmer_bin_hash "$profile_path")"
  printf 'kind\tid\tpath\tsha256\nruntime-footprint\tembedded-concurrent\t%s\t%s\n' \
    "$profile_path" "$profile_sha" >"$1"
  printf 'name\tvalue\tsource\tprofile_id\tprofile_path\tprofile_sha256\tprecedence\nshared_buffers\t4096\truntime-footprint\tembedded-concurrent\t%s\t%s\t1\n' \
    "$profile_path" "$profile_sha" >"$2"
  chmod 0444 "$1" "$2"
}
EOF

cat >"$FAKE_PROJECT/bin/bench-wasix-concurrent-query-suite.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
source "$FRESH_ROOT/lib/common.sh"
source "$FRESH_ROOT/lib/sealed-carrier.sh"
source "$FRESH_ROOT/lib/postgres-profiles.sh"
source "$FRESH_ROOT/lib/qualification-identities.sh"
target=""
label=""
warmup=""
samples=""
resource=""
runtime=""
durability=""
latency_only=0
sealed=0
sealed_carrier=""
require_zero_write_aot=0
immutable_carrier_receipt=""
immutable_verification_scope=full
cgroup_memory_max=""
cgroup_memory_high=""
cgroup_swap_max=""
original=("$@")
while [ "$#" -gt 0 ]; do
  case "$1" in
    --target|--label|--libpq-latency-warmup|--libpq-latency-samples|--resource-detail|--runtime-footprint|--durability|--cgroup-memory-max|--cgroup-memory-high|--cgroup-swap-max)
      option="$1"; shift
      case "$option" in
        --target) target="$1" ;;
        --label) label="$1" ;;
        --libpq-latency-warmup) warmup="$1" ;;
        --libpq-latency-samples) samples="$1" ;;
        --resource-detail) resource="$1" ;;
        --runtime-footprint) runtime="$1" ;;
        --durability) durability="$1" ;;
        --cgroup-memory-max) cgroup_memory_max="$1" ;;
        --cgroup-memory-high) cgroup_memory_high="$1" ;;
        --cgroup-swap-max) cgroup_swap_max="$1" ;;
      esac
      ;;
    --libpq-latency-only) latency_only=1 ;;
    --require-zero-write-aot) require_zero_write_aot=1 ;;
    --immutable-carrier-receipt) shift; immutable_carrier_receipt="$1" ;;
    --immutable-carrier-verification-scope) shift; immutable_verification_scope="$1" ;;
    --sealed-carrier) shift; sealed=1; sealed_carrier="$1" ;;
    --skip-build|--discard-pgdata) ;;
    --timeout|--start-port|--checkpoint-policy) shift ;;
    *) printf 'unexpected fake harness argument: %s\n' "$1" >&2; exit 64 ;;
  esac
  shift
done
if [ "$require_zero_write_aot" -eq 1 ]; then
  [ -f "$immutable_carrier_receipt" ]
fi
[ "$resource" = off ] && [ "$latency_only" -eq 1 ] &&
  [ "$runtime" = embedded-concurrent ] && [ "$durability" = safe ]
if [ "$target" = native ]; then
  [ "$sealed" -eq 0 ]
else
  [ "$target" = wasix ] && [ "$sealed" -eq 1 ]
fi
[ "${WASIX_PERF_STATS:-}" = 0 ] && [ "${WASIX_LIBPQ_LATENCY_HOST_FD_ALLOWANCE:-}" = 0 ]
for wait_dump_name in \
  WASIX_PERF_WAIT_DUMP_INTERVAL_MS \
  WASIX_PERF_WAIT_DUMP_FILE \
  WASIX_PERF_WAIT_DUMP_MAX_PER_WAIT \
  WASIX_PERF_WAIT_DUMP_VERBOSE \
  WASIX_WAIT_DUMP_INTERVAL_MS \
  WASIX_WAIT_DUMP_FILE \
  WASIX_WAIT_DUMP_MAX_PER_WAIT \
  WASIX_WAIT_DUMP_VERBOSE \
  WASIX_WAIT_DUMP_FENCE_REQUEST_FILE \
  WASIX_WAIT_DUMP_FENCE_ACK_FILE
do
  if [[ -v $wait_dump_name ]]; then
    printf 'timed qualifier leaked ambient instrumentation: %s\n' "$wait_dump_name" >&2
    exit 65
  fi
done
[ ! -v OLIPHAUNT_WASIX_REQUIRE_ZERO_WRITE_AOT ]
[ ! -v OLIPHAUNT_WASIX_SEALED_LOADER_AUDIT_FILE ]
[ ! -v WASIX_CGROUP_MEMORY_MAX ]
[ ! -v WASIX_CGROUP_MEMORY_HIGH ]
[ ! -v WASIX_CGROUP_SWAP_MAX ]
if [ -n "${FAKE_EXPECT_CGROUP_BINDING:-}" ]; then
  IFS=: read -r expected_max expected_high expected_swap \
    <<<"$FAKE_EXPECT_CGROUP_BINDING"
  [ "$cgroup_memory_max" = "$expected_max" ] &&
    [ "$cgroup_memory_high" = "$expected_high" ] &&
    [ "$cgroup_swap_max" = "$expected_swap" ]
else
  [ -z "$cgroup_memory_max$cgroup_memory_high$cgroup_swap_max" ]
fi
printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$target" "$resource" "$label" \
  "${cgroup_memory_max:-none}" "${cgroup_memory_high:-none}" \
  "${cgroup_swap_max:-none}" >>"${FAKE_HARNESS_CALLS:?}"
plan="$REPORT_DIR/libpq-latency-qualification/${FAKE_QUAL_LABEL:?}/qualification-plan.tsv"
[ -f "$plan" ] && grep -Fq $'\tABBA/BAAB\tembedded-concurrent\tsafe\tcontrolled\toff\t0\tWASIX_PERF_WAIT_DUMP_INTERVAL_MS,WASIX_PERF_WAIT_DUMP_FILE,WASIX_PERF_WAIT_DUMP_MAX_PER_WAIT,WASIX_PERF_WAIT_DUMP_VERBOSE,WASIX_WAIT_DUMP_INTERVAL_MS,WASIX_WAIT_DUMP_FILE,WASIX_WAIT_DUMP_MAX_PER_WAIT,WASIX_WAIT_DUMP_VERBOSE,WASIX_WAIT_DUMP_FENCE_REQUEST_FILE,WASIX_WAIT_DUMP_FENCE_ACK_FILE\t2.0\t2.5\t3.5\t4.5\t0.25\t0.40\t20\t30' "$plan"

report="$REPORT_DIR/concurrent-query-suite/$label"
target_report="$report/$target"
latency_dir="$target_report/libpq-latency"
mkdir -p "$latency_dir"
fake_carrier_closure=none
if [ -n "$sealed_carrier" ]; then
  fresh_capture_qualification_carrier_identity "$sealed_carrier"
  fake_carrier_closure="$FRESH_QUALIFICATION_CARRIER_CLOSURE_IDENTITY"
fi
immutable_receipt_sha="$(fresh_wasmer_bin_hash "$immutable_carrier_receipt" 2>/dev/null || printf none)"
read -r immutable_receipt_dev immutable_receipt_ino < <(
  stat -c '%d %i' -- "$immutable_carrier_receipt" 2>/dev/null || printf 'none none\n'
)
printf 'schema_version\truntime_mode\trequire_zero_write_aot\tverification_scope\tactivation_policy\truntime_environment\taudit_environment\tenvironment_inheritance\tallowed_snapshot_modes\tmax_source_bytes_written\tmax_snapshot_bytes_written\tmax_sync_calls\tvalidator\tvalidator_sha256\timmutable_receipt_path\timmutable_receipt_sha256\timmutable_receipt_dev\timmutable_receipt_ino\tcarrier_closure_identity\tcore_profile\tguest_build_recipe_sha256\n' >"$report/sealed-loader-policy.tsv"
printf 'oliphaunt.wasix-postmaster.sealed-loader-policy.v2\tsealed-headless\t%s\t%s\t%s\t%s\t%s\tsanitized-then-explicit\t%s\t0\t0\t0\tfake-validator\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
  "$require_zero_write_aot" "$immutable_verification_scope" \
  "$([ "$require_zero_write_aot" -eq 1 ] && printf direct-immutable-only || printf compatibility)" \
  "$([ "$require_zero_write_aot" -eq 1 ] && printf OLIPHAUNT_WASIX_REQUIRE_ZERO_WRITE_AOT=1 || printf unset)" \
  "$([ "$require_zero_write_aot" -eq 1 ] && printf owned-per-target-jsonl || printf disabled)" \
  "$([ "$require_zero_write_aot" -eq 1 ] && printf direct-immutable-inode || printf unrestricted)" \
  "$(printf fake-validator | sha256sum | awk '{ print $1 }')" \
  "${immutable_carrier_receipt:-none}" "$immutable_receipt_sha" \
  "$immutable_receipt_dev" "$immutable_receipt_ino" \
  "$([ "$require_zero_write_aot" -eq 1 ] && printf '%s' "$fake_carrier_closure" || printf none)" \
  "$([ "$require_zero_write_aot" -eq 1 ] && printf '%s' "$FRESH_QUALIFICATION_CORE_PROFILE" || printf none)" \
  "$([ "$require_zero_write_aot" -eq 1 ] && printf '%s' "$FRESH_QUALIFICATION_GUEST_BUILD_RECIPE_SHA256" || printf none)" \
  >>"$report/sealed-loader-policy.tsv"
if [ "$require_zero_write_aot" -eq 1 ]; then
  [ "$target" = wasix ]
  printf '{"fake":"direct-immutable"}\n' >"$target_report/sealed-loader-audit.jsonl"
  loader_validation_status=passed
  case "$label" in
    loader-gate-failure-*-p2-wasix) loader_validation_status=failed ;;
  esac
  printf 'schema_version\tstatus\trecords\taot_records\tmemory_records\tinitdb_executions\tpostgres_executions\tinitdb_pids\tpostgres_pids\trequired_snapshot_mode\n%s\t%s\t4\t2\t2\t1\t1\t101\t202\tdirect-immutable-inode\n' \
    oliphaunt.wasix-postmaster.sealed-loader-audit-validation.v3 \
    "$loader_validation_status" \
    >"$target_report/sealed-loader-audit-validation.tsv"
fi
if [ "$target" = wasix ]; then
  fresh_resolve_postgres_profiles "$runtime" "$durability"
  fresh_capture_qualification_carrier_identity "$sealed_carrier"
  module_sha="$(fresh_wasmer_bin_hash "$FRESH_ROOT/fake-postgres.wasm")"
  printf 'schema_version\tpostgres_major\truntime_mode\tcarrier_closure_identity\tcarrier_manifest_sha256\tcarrier_receipt_sha256\tcarrier_payload_inventory_sha256\tcarrier_headless_sha256\twasmer_bin_sha256\tpostgres_module_sha256\truntime_footprint\truntime_footprint_sha256\tdurability_profile\tdurability_profile_sha256\tpostgres_profile_resolution_identity\n' >"$report/execution-identity.tsv"
  printf 'oliphaunt.wasix-postmaster.execution-identity.v1\t18\tsealed-headless\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$FRESH_QUALIFICATION_CARRIER_CLOSURE_IDENTITY" \
    "$FRESH_QUALIFICATION_CARRIER_MANIFEST_SHA256" \
    "$FRESH_QUALIFICATION_CARRIER_RECEIPT_SHA256" \
    "$FRESH_QUALIFICATION_CARRIER_PAYLOAD_SHA256" \
    "$FRESH_QUALIFICATION_CARRIER_HEADLESS_SHA256" \
    "$FRESH_QUALIFICATION_CARRIER_HEADLESS_SHA256" "$module_sha" \
    "$runtime" "$FRESH_POSTGRES_RUNTIME_FOOTPRINT_SHA256" \
    "$durability" "$FRESH_POSTGRES_DURABILITY_SHA256" \
    "$FRESH_POSTGRES_PROFILE_RESOLUTION_IDENTITY" \
    >>"$report/execution-identity.tsv"
fi
profile_path="$FRESH_ROOT/profiles/fake-profile"
profile_sha="$(sha256sum "$profile_path" | awk '{ print $1 }')"
printf 'kind\tid\tpath\tsha256\nruntime-footprint\tembedded-concurrent\t%s\t%s\n' \
  "$profile_path" "$profile_sha" >"$report/postgres-profile-inputs.tsv"
printf 'name\tvalue\tsource\tprofile_id\tprofile_path\tprofile_sha256\tprecedence\nshared_buffers\t4096\truntime-footprint\tembedded-concurrent\t%s\t%s\t1\n' \
  "$profile_path" "$profile_sha" >"$report/postgres-profile-resolution.tsv"
settings="$target_report/effective-postgres-settings.tsv"
printf 'name\tsetting\tunit\tsource\n' >"$settings"
for name in autovacuum_worker_slots backend_flush_after bgwriter_flush_after checkpoint_flush_after checkpoint_timeout fsync full_page_writes io_method max_connections max_wal_senders max_worker_processes max_wal_size min_wal_size shared_buffers synchronous_commit wal_segment_size; do
  printf '%s\tvalue\t\tcommand line\n' "$name" >>"$settings"
done

libpq="$NATIVE_INSTALL_DIR/lib/libpq.so.5"
libpq_sha="$(sha256sum "$libpq" | awk '{ print $1 }')"
call_count="$(wc -l <"$FAKE_HARNESS_CALLS" | tr -d '[:space:]')"
probe_path="$RUN_DIR/concurrent-query-suite/$label/libpq-latency-probe"
mkdir -p "$(dirname "$probe_path")"
if [ "${FAKE_HARNESS_MUTATE_PROBE_AT:-0}" = "$call_count" ]; then
  printf 'mutated fake probe\n' >"$probe_path"
else
  printf 'exact fake probe\n' >"$probe_path"
fi
probe_sha="$(sha256sum "$probe_path" | awk '{ print $1 }')"
printf 'schema_version\ttarget\tmode\tstatus\tclock\twarmup_count\tsample_count\tp50_ns\tp95_ns\tp99_ns\tp50_ms\tp95_ms\tp99_ms\traw_tsv\tlibpq_path\tlibpq_sha256\tprobe_sha256\n' >"$report/libpq-latency-summary.tsv"
for mode in persistent reconnect; do
  if [ "$mode" = persistent ]; then
    [ "$target" = native ] && value=100000 || value=150000
  else
    [ "$target" = native ] && value=5000000 || value=12000000
  fi
  raw="$latency_dir/$mode.raw.tsv"
  printf 'schema_version\tmode\tphase\tsample_index\tduration_ns\tstatus\n' >"$raw"
  for ((sample = 1; sample <= warmup; sample++)); do
    printf '1\t%s\twarmup\t%s\t%s\tok\n' "$mode" "$sample" "$value" >>"$raw"
  done
  for ((sample = 1; sample <= samples; sample++)); do
    printf '1\t%s\tmeasure\t%s\t%s\tok\n' "$mode" "$sample" "$value" >>"$raw"
  done
  milliseconds="$(awk -v value="$value" 'BEGIN { printf "%.6f", value / 1000000 }')"
  printf '1\t%s\t%s\tok\tCLOCK_MONOTONIC\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$target" "$mode" "$warmup" "$samples" "$value" "$value" "$value" \
    "$milliseconds" "$milliseconds" "$milliseconds" "$raw" "$libpq" \
    "$libpq_sha" "$probe_sha" >>"$report/libpq-latency-summary.tsv"
done
printf 'target\tmode\tbefore_open_fds\tafter_open_fds\tquiescent_open_fds\tquiescent_growth\tallowance\tstatus\n' >"$report/host-fd-churn-summary.tsv"
printf '%s\tpersistent\t10\t10\t10\t0\t0\tpassed\n%s\treconnect\t10\t10\t10\t0\t0\tpassed\n' "$target" "$target" >>"$report/host-fd-churn-summary.tsv"
printf 'target\trequested_soft_nofile\tpre_soft_nofile\tpre_hard_nofile\tactual_soft_nofile\tactual_hard_nofile\tstatus\tlaunch_record\n%s\t1024\t4096\t4096\t1024\t4096\tpassed\t%s/launch.tsv\n' "$target" "$report" >"$report/server-limits.tsv"
printf 'target\tserver_pid\tserver_pgid\tserver_birth_identity\tcgroup_path\tcgroup_identity\torderly_int\tforced\twait_status\tclean_shutdown_marker\tprocess_group_residue\tcgroup_residue\tport_residue\tstatus\treport\n%s\t100\t100\tbirth\t\t\t1\tnone\t0\t1\t0\t0\t0\tpassed\t%s/shutdown.tsv\n' "$target" "$report" >"$report/server-lifecycle.tsv"
printf 'schema_version\tlane\twasix_perf_stats\twait_dump_policy\twait_dump_interval_ms\twait_dump_max_per_wait\twait_dump_verbose\tfence_protocol\tsanitized_environment\noliphaunt.wasix-postmaster.instrumentation.v1\tbenchmark\t0\tprohibited\t0\t0\t0\tnone\tWASIX_PERF_WAIT_DUMP_INTERVAL_MS WASIX_PERF_WAIT_DUMP_FILE WASIX_PERF_WAIT_DUMP_MAX_PER_WAIT WASIX_PERF_WAIT_DUMP_VERBOSE WASIX_WAIT_DUMP_INTERVAL_MS WASIX_WAIT_DUMP_FILE WASIX_WAIT_DUMP_MAX_PER_WAIT WASIX_WAIT_DUMP_VERBOSE WASIX_WAIT_DUMP_FENCE_REQUEST_FILE WASIX_WAIT_DUMP_FENCE_ACK_FILE\n' >"$report/instrumentation-policy.tsv"
case "$label" in
  receipt-mutation-*-p2-wasix)
    printf 'mutated\n' >>"$immutable_carrier_receipt"
    ;;
esac
EOF

chmod +x "$FAKE_PROJECT/bin/"*.sh "$FAKE_PROJECT/bin/"*.py \
  "$FAKE_PROJECT/lib/"*.sh
printf 'shared_buffers=32MB\n' >"$FAKE_PROJECT/profiles/fake-profile"
printf 'fsync=on\n' >"$FAKE_PROJECT/profiles/fake-durability"
printf 'fake PostgreSQL guest module\n' >"$FAKE_PROJECT/fake-postgres.wasm"
printf '{"core-profile":"release-o3","guest-build-recipe-sha256":"%064d","schema":"fake"}\n' 0 >"$FAKE_CARRIER/manifest.json"
printf 'receipt\n' >"$FAKE_CARRIER/wasmer-build.receipt"
printf 'payload\n' >"$FAKE_CARRIER/payload.files"
printf '#!/usr/bin/env bash\nexit 0\n' >"$FAKE_CARRIER/bin/wasmer-headless"
chmod +x "$FAKE_CARRIER/bin/wasmer-headless"
for binary in postgres initdb psql; do
  printf '#!/usr/bin/env bash\nexit 0\n' >"$FAKE_NATIVE/bin/$binary"
  chmod +x "$FAKE_NATIVE/bin/$binary"
done
printf 'fake libpq\n' >"$FAKE_NATIVE/lib/libpq.so.5"
printf '{"schema":"fake-immutable"}\n' >"$FAKE_IMMUTABLE_RECEIPT"

awk '
  /^classify_latency_result\(\) \{$/ { capture = 1 }
  capture { print }
  capture && /^}$/ { exit }
' "$PROJECT_ROOT/bin/qualify-wasix-libpq-latency.sh" \
  >"$TEST_ROOT/classify-latency-result.sh"
# shellcheck source=/dev/null
source "$TEST_ROOT/classify-latency-result.sh"
[ "$(classify_latency_result 0 10 100 1000)" = \
  latency-qualified-non-release ]
[ "$(classify_latency_result 1 10 100 1000)" = \
  failed-latency-qualification-non-release ]
[ "$(classify_latency_result 1 2 1 5)" = \
  latency-diagnostic-non-release ]

calls="$TEST_ROOT/odd-block.calls"
: >"$calls"
if REPORT_DIR="$FAKE_REPORTS" RUN_DIR="$FAKE_RUNS" NATIVE_INSTALL_DIR="$FAKE_NATIVE" \
  FAKE_HARNESS_CALLS="$calls" FAKE_QUAL_LABEL=odd-block \
    "$FAKE_PROJECT/bin/qualify-wasix-libpq-latency.sh" \
      --sealed-carrier "$FAKE_CARRIER" --blocks 1 --warmup 1 --samples 5 \
      --label odd-block >/dev/null 2>&1
then
  echo 'odd ABBA/BAAB block count unexpectedly passed' >&2
  exit 1
fi
[ ! -s "$calls" ]
[ ! -e "$FAKE_REPORTS/libpq-latency-qualification/odd-block" ]

calls="$TEST_ROOT/success.calls"
: >"$calls"
REPORT_DIR="$FAKE_REPORTS" RUN_DIR="$FAKE_RUNS" NATIVE_INSTALL_DIR="$FAKE_NATIVE" \
FAKE_HARNESS_CALLS="$calls" FAKE_QUAL_LABEL=success \
WASIX_PERF_WAIT_DUMP_INTERVAL_MS=999 \
WASIX_PERF_WAIT_DUMP_FILE=/ambient/perf.log \
WASIX_PERF_WAIT_DUMP_MAX_PER_WAIT=999 \
WASIX_PERF_WAIT_DUMP_VERBOSE=1 \
WASIX_WAIT_DUMP_INTERVAL_MS=999 \
WASIX_WAIT_DUMP_FILE=/ambient/wait.log \
WASIX_WAIT_DUMP_MAX_PER_WAIT=999 \
WASIX_WAIT_DUMP_VERBOSE=1 \
WASIX_WAIT_DUMP_FENCE_REQUEST_FILE=/ambient/fence.request \
WASIX_WAIT_DUMP_FENCE_ACK_FILE=/ambient/fence.ack \
WASIX_CGROUP_MEMORY_MAX=ambient-max \
WASIX_CGROUP_MEMORY_HIGH=ambient-high \
WASIX_CGROUP_SWAP_MAX=ambient-swap \
FAKE_EXPECT_CGROUP_BINDING=256M:224M:0 \
  "$FAKE_PROJECT/bin/qualify-wasix-libpq-latency.sh" \
    --sealed-carrier "$FAKE_CARRIER" --blocks 2 --warmup 1 --samples 5 \
    --cgroup-memory-max 256M --cgroup-memory-high 224M --cgroup-swap-max 0 \
    --label success >/dev/null
success_root="$FAKE_REPORTS/libpq-latency-qualification/success"
[ "$(cut -f1 "$calls" | paste -sd ' ' -)" = \
  'native wasix wasix native wasix native native wasix' ]
grep -Fq $'oliphaunt.wasix-postmaster.latency-result.v4\tpassed\tlatency-diagnostic-non-release\tall-declared-gates-passed' \
  "$success_root/qualification-result.tsv"
[ "$(cut -f4-6 "$calls" | sort -u)" = $'256M\t224M\t0' ]
for receipt in "$success_root/qualification-plan.tsv" \
  "$success_root/qualification-result.tsv"; do
  awk -F '\t' '
    NR == 1 {
      for (column = 1; column <= NF; column++) column_index[$column] = column
      next
    }
    NR == 2 {
      if ($(column_index["cgroup_binding"]) != "dedicated-systemd-user-scope" ||
          $(column_index["cgroup_memory_max"]) != "256M" ||
          $(column_index["cgroup_memory_high"]) != "224M" ||
          $(column_index["cgroup_swap_max"]) != "0" ||
          $(column_index["cgroup_environment_action"]) != "ambient-sanitized-explicit-argv" ||
          $(column_index["immutable_verification_scope"]) != "full-per-check") exit 1
      valid = 1
    }
    END { exit !valid }
  ' "$receipt"
done
grep -Fq 'Server cgroup MemoryMax / MemoryHigh / MemorySwapMax: `256M / 224M / 0`' \
  "$success_root/summary.md"
[ -s "$success_root/wasix-execution-identity.tsv" ]
[ "$(stat -c '%a' "$success_root/wasix-execution-identity.tsv")" = 444 ]
grep -Fq $'1\tpersistent\tpassed\t4\t4\t4' "$success_root/paired-summary.tsv"
[ "$(wc -l <"$success_root/samples.tsv" | tr -d '[:space:]')" -eq 17 ]
[ "$(wc -l <"$success_root/paired-samples.tsv" | tr -d '[:space:]')" -eq 9 ]

calls="$TEST_ROOT/zero-write.calls"
: >"$calls"
REPORT_DIR="$FAKE_REPORTS" RUN_DIR="$FAKE_RUNS" NATIVE_INSTALL_DIR="$FAKE_NATIVE" \
FAKE_HARNESS_CALLS="$calls" FAKE_QUAL_LABEL=zero-write \
OLIPHAUNT_WASIX_REQUIRE_ZERO_WRITE_AOT=ambient \
OLIPHAUNT_WASIX_SEALED_LOADER_AUDIT_FILE=/ambient/audit \
  "$FAKE_PROJECT/bin/qualify-wasix-libpq-latency.sh" \
    --sealed-carrier "$FAKE_CARRIER" --blocks 2 --warmup 1 --samples 5 \
    --require-zero-write-aot \
    --immutable-carrier-receipt "$FAKE_IMMUTABLE_RECEIPT" \
    --label zero-write >/dev/null
zero_write_root="$FAKE_REPORTS/libpq-latency-qualification/zero-write"
awk -F '\t' -v receipt="$FAKE_IMMUTABLE_RECEIPT" 'NR == 2 { if ($1 != "oliphaunt.wasix-postmaster.libpq-latency-plan.v4" || $22 != 1 || $23 != "direct-immutable-only" || $25 != receipt || $26 !~ /^[0-9a-f]{64}$/ || $27 !~ /^[0-9]+$/ || $28 !~ /^[0-9]+$/) exit 1; valid = 1 } END { exit !valid }' \
  "$zero_write_root/qualification-plan.tsv"
awk -F '\t' 'NR > 1 && $2 == "wasix" { if ($4 !~ /^[0-9a-f]{64}$/ || $6 !~ /^[0-9a-f]{64}$/ || $8 !~ /^[0-9a-f]{64}$/ || $9 != "passed") exit 1; wasix++ } END { exit wasix != 4 }' \
  "$zero_write_root/sealed-loader-verification.tsv"
awk -F '\t' '
  NR == 1 {
    if (NF != 8 || $7 != "observed_receipt_ino" || $8 != "status") exit 1
  }
  NR > 1 {
    if (NF != 8 || $2 != $3 || $4 != $5 || $6 != $7 || $8 != "passed") exit 1
    rows++
  }
  END { exit rows == 0 }
' "$zero_write_root/immutable-carrier-verification.tsv"

calls="$TEST_ROOT/loader-gate-failure.calls"
: >"$calls"
set +e
REPORT_DIR="$FAKE_REPORTS" RUN_DIR="$FAKE_RUNS" NATIVE_INSTALL_DIR="$FAKE_NATIVE" \
FAKE_HARNESS_CALLS="$calls" FAKE_QUAL_LABEL=loader-gate-failure \
  "$FAKE_PROJECT/bin/qualify-wasix-libpq-latency.sh" \
    --sealed-carrier "$FAKE_CARRIER" --blocks 2 --warmup 1 --samples 5 \
    --require-zero-write-aot \
    --immutable-carrier-receipt "$FAKE_IMMUTABLE_RECEIPT" \
    --label loader-gate-failure >/dev/null 2>&1
loader_gate_status=$?
set -e
[ "$loader_gate_status" -ne 0 ]
loader_gate_root="$FAKE_REPORTS/libpq-latency-qualification/loader-gate-failure"
grep -Fq $'oliphaunt.wasix-postmaster.latency-result.v4\tfailed\tlatency-diagnostic-non-release\tone-or-more-declared-gates-failed' \
  "$loader_gate_root/qualification-result.tsv"
grep -Fq $'persistent\tpassed' "$loader_gate_root/paired-summary.tsv"

calls="$TEST_ROOT/receipt-mutation.calls"
: >"$calls"
set +e
REPORT_DIR="$FAKE_REPORTS" RUN_DIR="$FAKE_RUNS" NATIVE_INSTALL_DIR="$FAKE_NATIVE" \
FAKE_HARNESS_CALLS="$calls" FAKE_QUAL_LABEL=receipt-mutation \
  "$FAKE_PROJECT/bin/qualify-wasix-libpq-latency.sh" \
    --sealed-carrier "$FAKE_CARRIER" --blocks 2 --warmup 1 --samples 5 \
    --require-zero-write-aot \
    --immutable-carrier-receipt "$FAKE_IMMUTABLE_RECEIPT" \
    --label receipt-mutation >/dev/null 2>&1
receipt_mutation_status=$?
set -e
[ "$receipt_mutation_status" -ne 0 ]
receipt_mutation_root="$FAKE_REPORTS/libpq-latency-qualification/receipt-mutation"
awk -F '\t' '
  NR == 1 {
    if (NF != 8 || $7 != "observed_receipt_ino" || $8 != "status") exit 1
  }
  NR > 1 && $8 == "identity-changed" {
    if ($2 == $3 || $4 != $5 || $6 != $7) exit 1
    changed = 1
  }
  END { exit !changed }
' "$receipt_mutation_root/immutable-carrier-verification.tsv"
printf '{"schema":"fake-immutable"}\n' >"$FAKE_IMMUTABLE_RECEIPT"

calls="$TEST_ROOT/probe-failure.calls"
: >"$calls"
if REPORT_DIR="$FAKE_REPORTS" RUN_DIR="$FAKE_RUNS" NATIVE_INSTALL_DIR="$FAKE_NATIVE" \
  FAKE_HARNESS_CALLS="$calls" FAKE_QUAL_LABEL=probe-failure \
  FAKE_HARNESS_MUTATE_PROBE_AT=3 \
    "$FAKE_PROJECT/bin/qualify-wasix-libpq-latency.sh" \
      --sealed-carrier "$FAKE_CARRIER" --blocks 2 --warmup 1 --samples 5 \
      --label probe-failure >/dev/null 2>&1
then
  echo 'probe identity mutation unexpectedly passed' >&2
  exit 1
fi
failure_root="$FAKE_REPORTS/libpq-latency-qualification/probe-failure"
grep -Fq $'oliphaunt.wasix-postmaster.latency-result.v4\tfailed\tlatency-diagnostic-non-release\tone-or-more-declared-gates-failed' \
  "$failure_root/qualification-result.tsv"
[ ! -e "$failure_root/samples.tsv" ]

calls="$TEST_ROOT/partial-cgroup.calls"
: >"$calls"
if REPORT_DIR="$FAKE_REPORTS" RUN_DIR="$FAKE_RUNS" NATIVE_INSTALL_DIR="$FAKE_NATIVE" \
  FAKE_HARNESS_CALLS="$calls" FAKE_QUAL_LABEL=partial-cgroup \
  WASIX_CGROUP_MEMORY_MAX=256M \
    "$FAKE_PROJECT/bin/qualify-wasix-libpq-latency.sh" \
      --sealed-carrier "$FAKE_CARRIER" --blocks 2 --warmup 1 --samples 5 \
      --label partial-cgroup >"$TEST_ROOT/partial-cgroup.log" 2>&1
then
  echo 'partial cgroup binding unexpectedly passed' >&2
  exit 1
fi
[ ! -s "$calls" ]
[ ! -e "$FAKE_REPORTS/libpq-latency-qualification/partial-cgroup" ]
grep -q 'must be configured together' "$TEST_ROOT/partial-cgroup.log"

printf 'true-libpq latency qualifier tests passed\n'
