#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bench="$root/bin/bench-wasix-concurrent-query-suite.sh"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT

expect_policy_failure() {
  local label="$1"
  shift
  set +e
  "$@" >"$tmp/$label.log" 2>&1
  local status=$?
  set -e
  if [ "$status" -ne 2 ]; then
    printf '%s: expected policy exit 2, got %s\n' "$label" "$status" >&2
    sed -n '1,100p' "$tmp/$label.log" >&2
    exit 1
  fi
}

expect_policy_failure timed-option "$bench" --wasix-wait-dump-interval-ms 100
grep -Fq 'untimed lifecycle diagnostic only' "$tmp/timed-option.log"
expect_policy_failure timed-max-option "$bench" --wasix-wait-dump-max-per-wait 2
expect_policy_failure timed-verbose-option "$bench" --wasix-wait-dump-verbose
expect_policy_failure ambient-runtime-interval \
  env WASIX_WAIT_DUMP_INTERVAL_MS=100 "$bench"
expect_policy_failure ambient-wrapper-interval \
  env WASIX_PERF_WAIT_DUMP_INTERVAL_MS=100 "$bench"
expect_policy_failure ambient-runtime-file \
  env WASIX_WAIT_DUMP_FILE="$tmp/foreign.log" "$bench"
expect_policy_failure zero-write-without-sealed \
  "$bench" --target wasix --require-zero-write-aot --resource-detail off
grep -Fq -- '--require-zero-write-aot requires --sealed-carrier' \
  "$tmp/zero-write-without-sealed.log"
expect_policy_failure lifecycle-owned-path \
  env WASIX_WAIT_DUMP_FENCE_REQUEST_FILE="$tmp/foreign.request" \
    "$bench" --wasix-lifecycle-plateau --resource-detail off
grep -Fq 'owns its wait-dump log, fence-request, and committed-ACK paths' \
  "$tmp/lifecycle-owned-path.log"
expect_policy_failure lifecycle-owned-ack-path \
  env WASIX_WAIT_DUMP_FENCE_ACK_FILE="$tmp/foreign.ack" \
    "$bench" --wasix-lifecycle-plateau --resource-detail off
expect_policy_failure unknown-adaptive-cache-evidence-policy \
  "$bench" --adaptive-cache-evidence-policy almost-constrained
grep -Fq -- '--adaptive-cache-evidence-policy requires portable-correctness-v1 or constrained-linux-wal-action-v1' \
  "$tmp/unknown-adaptive-cache-evidence-policy.log"
expect_policy_failure duplicate-adaptive-cache-evidence-policy \
  "$bench" --adaptive-cache-evidence-policy portable-correctness-v1 \
    --adaptive-cache-evidence-policy portable-correctness-v1
expect_policy_failure unconstrained-adaptive-cache-evidence \
  "$bench" --adaptive-cache-evidence-policy constrained-linux-wal-action-v1
grep -Fq 'requires explicit finite cgroup MemoryMax, MemoryHigh, and MemorySwapMax' \
  "$tmp/unconstrained-adaptive-cache-evidence.log"
expect_policy_failure invalid-explicit-guc-name \
  "$bench" --postgres-guc Work_mem=4MB
grep -Fq 'invalid explicit PostgreSQL setting name: Work_mem' \
  "$tmp/invalid-explicit-guc-name.log"
expect_policy_failure empty-explicit-guc-value \
  "$bench" --postgres-guc work_mem=
grep -Fq 'invalid empty/edge-whitespace explicit PostgreSQL value: work_mem' \
  "$tmp/empty-explicit-guc-value.log"
expect_policy_failure duplicate-explicit-guc \
  "$bench" --postgres-guc work_mem=4MB --postgres-guc work_mem=8MB
grep -Fq 'duplicate explicit PostgreSQL setting: work_mem' \
  "$tmp/duplicate-explicit-guc.log"
for unsafe_label in . .. .hidden -leading _leading; do
  expect_policy_failure "unsafe-label-${unsafe_label//[^A-Za-z0-9]/_}" \
    "$bench" --label "$unsafe_label"
done
grep -Fq -- '--label must start with a letter or number' \
  "$tmp/unsafe-label-_.log"
grep -Fq 'fresh_claim_generated_directories "$suite_root" "$report_dir"' "$bench"
if grep -Fq -- '--replace-existing' "$bench"; then
  echo 'benchmark retained a destructive label-replacement surface' >&2
  exit 1
fi
expect_policy_failure sealed-perfmap-sampling \
  "$bench" --target wasix --sealed-carrier "$tmp/not-a-carrier" \
    --sample-seconds 1
grep -Fq 'sealed-headless execution does not expose the perfmap profiler' \
  "$tmp/sealed-perfmap-sampling.log"

sed -n '/^build_wasmer_args()/,/^start_wasix_server()/p' "$bench" |
  sed '$d' >"$tmp/build-wasmer-args.sh"
# shellcheck source=/dev/null
source "$tmp/build-wasmer-args.sh"
is_positive_number() {
  [[ "$1" =~ ^([0-9]+([.][0-9]*)?|[.][0-9]+)$ ]] &&
    awk -v value="$1" 'BEGIN { exit !((value + 0) > 0) }'
}
fresh_wasmer_compiler_args_for() { printf '%s\n' --llvm; }
wasix_runtime_mode=compiler
sample_seconds=1
FRESH_WORK_ROOT="$tmp/work"
REPO_ROOT="$tmp/repo"
wasix_runtime_lib_dir="$tmp/runtime-lib"
wasmer_cache_dir="$tmp/cache"
wasmer_bin=/bin/true
wasmer_compiler=llvm
wasmer_llvm_opt_level=aggressive
wasmer_compiler_threads=1
wasmer_stack_size=4096
wasmer_extra_args=()
build_wasmer_args "$tmp/dev-shm"
perfmap_pairs=0
for ((arg_index = 0; arg_index < ${#wasmer_args[@]}; arg_index++)); do
  if [ "${wasmer_args[$arg_index]}" = --profiler ] &&
    [ "${wasmer_args[$((arg_index + 1))]:-}" = perfmap ]; then
    perfmap_pairs=$((perfmap_pairs + 1))
  fi
done
[ "$perfmap_pairs" -eq 1 ] || {
  echo 'positive sampling did not enable exactly one perfmap profiler' >&2
  exit 1
}
sample_seconds=0
build_wasmer_args "$tmp/dev-shm"
if printf '%s\n' "${wasmer_args[@]}" | grep -Fxq -- --profiler; then
  echo 'disabled sampling unexpectedly enabled a Wasmer profiler' >&2
  exit 1
fi

sed -n '/^capture_checkpoint_settings()/,/^validate_controlled_checkpoint_settings()/p' \
  "$bench" | sed '$d' >"$tmp/capture-settings.sh"
# shellcheck source=/dev/null
source "$tmp/capture-settings.sh"
captured_settings_sql=""
fresh_run_process_group_timeout() {
  local capture_next=0 arg
  shift
  [ "$1" = -- ] && shift
  for arg in "$@"; do
    if [ "$capture_next" -eq 1 ]; then
      captured_settings_sql="$arg"
      capture_next=0
    elif [ "$arg" = -c ]; then
      capture_next=1
    fi
  done
}
timeout_seconds=1
NATIVE_INSTALL_DIR="$tmp/native"
explicit_postgres_guc_names=(work_mem shared_buffers)
capture_checkpoint_settings postgres://example "$tmp/settings.tsv"
grep -Fxq $'name\tsetting\tunit\tsource' "$tmp/settings.tsv"
case "$captured_settings_sql" in
  *"'work_mem'"*) ;;
  *) echo 'effective-settings query omitted explicit work_mem' >&2; exit 1 ;;
esac
[ "$(printf '%s' "$captured_settings_sql" | grep -o "'shared_buffers'" | wc -l)" -eq 1 ] || {
  echo 'effective-settings query did not form a set union with baseline names' >&2
  exit 1
}

sed -n '/^configure_wasmer_env_command()/,/^prepare_wasix_runtime()/p' "$bench" |
  sed '$d' >"$tmp/configure-env.sh"
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
sealed_loader_environment_names=(
  OLIPHAUNT_WASIX_REQUIRE_ZERO_WRITE_AOT
  OLIPHAUNT_WASIX_SEALED_LOADER_AUDIT_FILE
)
# shellcheck source=/dev/null
source "$tmp/configure-env.sh"
for name in "${wait_dump_environment_names[@]}"; do
  export "$name=ambient-value"
done
for name in "${sealed_loader_environment_names[@]}"; do
  export "$name=ambient-value"
done
configure_wasmer_env_command
"${wasmer_env_command[@]}" >"$tmp/sanitized.env"
if grep -Eq '^WASIX_(PERF_)?WAIT_DUMP_' "$tmp/sanitized.env"; then
  echo 'Wasmer child environment retained wait-dump instrumentation variables' >&2
  exit 1
fi
if grep -Eq '^OLIPHAUNT_WASIX_(REQUIRE_ZERO_WRITE_AOT|SEALED_LOADER_AUDIT_FILE)=' \
  "$tmp/sanitized.env"; then
  echo 'Wasmer child environment retained sealed-loader policy variables' >&2
  exit 1
fi

nonce=0123456789abcdef0123456789abcdef
tab=$'\t'
sed -n '/^validate_walwriter_stabilization_state_file()/,/^write_lifecycle_fence_request()/p' "$bench" |
  sed '$d' >"$tmp/walwriter-stabilization.sh"
# shellcheck source=/dev/null
source "$tmp/walwriter-stabilization.sh"
walwriter_state="$tmp/walwriter-state.tsv"
printf '10\t81920\t1786320000000000\t200\t0/1008000\tt\n' >"$walwriter_state"
validate_walwriter_stabilization_state_file "$walwriter_state"
printf '10\t81920\t1786320000000000\t200\t0/1008000\n' >"$walwriter_state"
if validate_walwriter_stabilization_state_file "$walwriter_state"; then
  echo 'WAL-writer state accepted a missing flush-reached field' >&2
  exit 1
fi
printf '10\t81920\t1786320000000000\t0\t0/1008000\tt\n' >"$walwriter_state"
if validate_walwriter_stabilization_state_file "$walwriter_state"; then
  echo 'WAL-writer state accepted a zero wal_writer_delay' >&2
  exit 1
fi
stabilization_log="$tmp/stabilization.log"
append_walwriter_stabilization_record "$stabilization_log" "$nonce" \
  10 12 81920 147456 1786320000000000 1786320000000000 \
  0/1000000 0/1008000 200 25 35 passed 42
grep -Fxq "wasix-runtime-stabilization-v1${tab}nonce=$nonce${tab}method=pg_log_standby_snapshot${tab}before_writes=10${tab}after_writes=12${tab}before_write_bytes=81920${tab}after_write_bytes=147456${tab}before_stats_reset=1786320000000000${tab}after_stats_reset=1786320000000000${tab}target_lsn=0/1000000${tab}observed_flush_lsn=0/1008000${tab}wal_writer_delay_ms=200${tab}start_mono_ns=25${tab}end_mono_ns=35${tab}status=passed${tab}observer_pid=42" \
  "$stabilization_log"
grep -Fq "SELECT pg_log_standby_snapshot()" "$bench"
grep -Fq 'io.backend_type = '\''walwriter'\''' "$bench"
grep -Fq 'append_lifecycle_phase_marker "$wait_dump_log" "$nonce" cold-readiness' "$bench"
grep -Fq 'append_lifecycle_phase_marker "$wait_dump_log" "$nonce" maintenance-stabilization' "$bench"
grep -Fq 'checkpoint_policy=controlled' "$bench"
grep -Fq 'wasix-runtime-reconnect-churn-v1\tnonce=%s\trequested=%s\tcompleted=%s\tcommand_sha256=%s' "$bench"
grep -Fq 'run_lifecycle_reconnect_churn "$conn" "$reconnect_log" "$wait_dump_log"' "$bench"
grep -Fq 'cache_offer_postgres_adaptive_telemetry="${cache_offer_postgres_telemetry%.json}.adaptive.json"' \
  "$bench"
grep -Fq 'validate-adaptive-file-cache-telemetry.py' "$bench"
grep -Fq -- '--acceptance-policy "$adaptive_cache_evidence_policy"' "$bench"
grep -Fq 'adaptive-cache-evidence-policy.tsv' "$bench"
if grep -Fq 'OLIPHAUNT_WASIX_ADAPTIVE_CACHE_TELEMETRY_FILE' "$bench"; then
  echo 'adaptive cache telemetry gained an environment activation surface' >&2
  exit 1
fi
if grep -Eq 'WASIX_ADAPTIVE_CACHE_(EVIDENCE_)?POLICY' "$bench"; then
  echo 'adaptive cache evidence acceptance gained an ambient environment surface' >&2
  exit 1
fi

sed -n '/^write_lifecycle_fence_request()/,/^wait_for_lifecycle_fence_ack()/p' "$bench" |
  sed '$d' >"$tmp/fence-request.sh"
# shellcheck source=/dev/null
source "$tmp/fence-request.sh"
request="$tmp/fence.request"
write_lifecycle_fence_request "$request" "$nonce" 1 readiness 42
[ "$(cat "$request")" = \
  "wasix-runtime-fence-request-v1${tab}nonce=$nonce${tab}request_seq=1${tab}phase=readiness${tab}observer_pid=42" ] || {
  echo 'atomic lifecycle fence request did not use the exact schema' >&2
  exit 1
}
write_lifecycle_fence_request "$request" "$nonce" 2 post-quiescence 42
grep -Fxq "wasix-runtime-fence-request-v1${tab}nonce=$nonce${tab}request_seq=2${tab}phase=post-quiescence${tab}observer_pid=42" \
  "$request"
if find "$tmp" -maxdepth 1 -name 'fence.request.pending.*' -print -quit | grep -q .; then
  echo 'atomic lifecycle fence request left a pending file' >&2
  exit 1
fi

sed -n '/^wait_for_lifecycle_fence_ack()/,/^run_lifecycle_reconnect_churn()/p' "$bench" |
  sed '$d' >"$tmp/fence-ack.sh"
# shellcheck source=/dev/null
source "$tmp/fence-ack.sh"
ack="$tmp/fence.ack"
printf 'wasix-runtime-fence-commit-v1\tnonce=%s\tseq=11\tmono_ns=3200000000\tphase=post-quiescence\tobserver_pid=42\tobserver_tid=7\trequest_seq=2\tfence_end_offset=1234\n' \
  "$nonce" >"$ack"
timeout_seconds=1
now_ms() { date +%s%3N; }
wait_for_lifecycle_fence_ack "$ack" "$nonce" 2 post-quiescence 42 "$$"
printf 'extra\n' >>"$ack"
timeout_seconds=0
if wait_for_lifecycle_fence_ack "$ack" "$nonce" 2 post-quiescence 42 "$$" \
  >/dev/null 2>&1; then
  echo 'multi-line committed ACK unexpectedly passed exact validation' >&2
  exit 1
fi

printf 'stale\n' >"$ack"
wait_for_lifecycle_fence_ack() {
  [ ! -e "$1" ] && [ -s "$request" ]
}
request_lifecycle_fence "$request" "$ack" "$nonce" 2 post-quiescence 42 "$$"
[ ! -e "$ack" ] || {
  echo 'request publication retained a stale committed ACK' >&2
  exit 1
}

printf 'passed: instrumentation isolation, exact adaptive evidence policy, maintenance stabilization, bound reconnect churn, and committed fence protocol\n'
