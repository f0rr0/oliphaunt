#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"

profile="$WASIX_CORE_PROFILE"
initdb_profile=""
workload="unlogged-constant-insert"
setup_workload="${WASIX_PROFILE_SETUP_WORKLOAD:-}"
profile_rows="${WASIX_PROFILE_ROWS:-1000000}"
transaction_rows="${WASIX_PROFILE_TRANSACTION_ROWS:-$profile_rows}"
transaction_rows_explicit=0
if [ "${WASIX_PROFILE_TRANSACTION_ROWS+x}" = x ]; then
  transaction_rows_explicit=1
fi
sql_timeout="${WASIX_PROFILE_SQL_TIMEOUT:-0}"
sample_seconds="${WASIX_PROFILE_SAMPLE_SECONDS:-10}"
sample_delay="${WASIX_PROFILE_SAMPLE_DELAY:-0.2}"
start_port="${PGPORT:-59500}"
precompile_scope="${WASIX_PRECOMPILE_SCOPE:-minimal}"
skip_build=0
skip_precompile=0
run_label="${WASIX_PROFILE_LABEL:-}"
postgres_gucs=()
wasmer_extra_args=()

usage() {
  cat <<EOF
Usage: $0 [options]

Options:
  --profile PROFILE             WASIX_CORE_PROFILE. Default: $profile
  --initdb-profile PROFILE      Profile used only for initdb. Default: --profile.
  --workload NAME|PATH          SQL workload. Default: $workload
  --setup-workload NAME|PATH    SQL workload to run before sampling. Default: none.
  --rows N                      perf_rows value. Default: $profile_rows
  --transaction-rows N          transaction_rows value. Default: rows.
  --sql-timeout SECONDS         0 disables timeout. Default: $sql_timeout
  --sample-seconds SECONDS      sample(1) duration. Default: $sample_seconds
  --sample-delay SECONDS        Delay after starting psql before sampling. Default: $sample_delay
  --start-port PORT             PostgreSQL port. Default: $start_port
  --precompile-scope SCOPE      minimal, runtime, or all. Default: $precompile_scope
  --skip-build                  Reuse installed profile.
  --skip-precompile             Reuse current Wasmer cache.
  --label LABEL                 Report label. Default: timestamped.
  --postgres-guc name=value     Extra postgres -c setting.
  --wasmer-arg VALUE            Extra wasmer run argument.

This starts one WASIX postgres instance, runs one SQL workload, samples the
host Wasmer process, and copies /tmp/perf-<pid>.map when available.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --profile)
      shift
      [ "$#" -gt 0 ] || { echo "--profile requires a value" >&2; exit 2; }
      profile="$(fresh_normalize_wasix_core_profile "$1")"
      ;;
    --initdb-profile)
      shift
      [ "$#" -gt 0 ] || { echo "--initdb-profile requires a value" >&2; exit 2; }
      initdb_profile="$(fresh_normalize_wasix_core_profile "$1")"
      ;;
    --workload)
      shift
      [ "$#" -gt 0 ] || { echo "--workload requires a value" >&2; exit 2; }
      workload="$1"
      ;;
    --setup-workload)
      shift
      [ "$#" -gt 0 ] || { echo "--setup-workload requires a value" >&2; exit 2; }
      setup_workload="$1"
      ;;
    --rows)
      shift
      [ "$#" -gt 0 ] || { echo "--rows requires a value" >&2; exit 2; }
      profile_rows="$1"
      if [ "$transaction_rows_explicit" -eq 0 ]; then
        transaction_rows="$profile_rows"
      fi
      ;;
    --transaction-rows)
      shift
      [ "$#" -gt 0 ] || { echo "--transaction-rows requires a value" >&2; exit 2; }
      transaction_rows="$1"
      transaction_rows_explicit=1
      ;;
    --sql-timeout)
      shift
      [ "$#" -gt 0 ] || { echo "--sql-timeout requires a value" >&2; exit 2; }
      sql_timeout="$1"
      ;;
    --sample-seconds)
      shift
      [ "$#" -gt 0 ] || { echo "--sample-seconds requires a value" >&2; exit 2; }
      sample_seconds="$1"
      ;;
    --sample-delay)
      shift
      [ "$#" -gt 0 ] || { echo "--sample-delay requires a value" >&2; exit 2; }
      sample_delay="$1"
      ;;
    --start-port)
      shift
      [ "$#" -gt 0 ] || { echo "--start-port requires a value" >&2; exit 2; }
      start_port="$1"
      ;;
    --precompile-scope)
      shift
      [ "$#" -gt 0 ] || { echo "--precompile-scope requires a value" >&2; exit 2; }
      precompile_scope="$1"
      ;;
    --skip-build)
      skip_build=1
      ;;
    --skip-precompile)
      skip_precompile=1
      ;;
    --label)
      shift
      [ "$#" -gt 0 ] || { echo "--label requires a value" >&2; exit 2; }
      case "$1" in
        ""|[!A-Za-z0-9]*|*[!A-Za-z0-9._-]*)
          echo "--label must start with a letter or number and contain only letters, numbers, '.', '_', and '-'" >&2
          exit 2
          ;;
      esac
      run_label="$1"
      ;;
    --postgres-guc)
      shift
      [ "$#" -gt 0 ] || { echo "--postgres-guc requires a name=value setting" >&2; exit 2; }
      postgres_gucs+=("$1")
      ;;
    --wasmer-arg)
      shift
      [ "$#" -gt 0 ] || { echo "--wasmer-arg requires one wasmer argument" >&2; exit 2; }
      wasmer_extra_args+=("$1")
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

if [ -n "${POSTGRES_GUCS:-}" ]; then
  for guc in $POSTGRES_GUCS; do
    postgres_gucs+=("$guc")
  done
fi
if [ -n "${WASMER_RUN_EXTRA_ARGS:-}" ]; then
  for arg in $WASMER_RUN_EXTRA_ARGS; do
    wasmer_extra_args+=("$arg")
  done
fi

fresh_ensure_dirs

workload_dir="$FRESH_ROOT/bench/sql/query-perf"
workload_path_for() {
  case "$1" in
    */*) printf '%s\n' "$1" ;;
    *.sql) printf '%s/%s\n' "$workload_dir" "$1" ;;
    *) printf '%s/%s.sql\n' "$workload_dir" "$1" ;;
  esac
}
workload_name_for() {
  basename "${1%.sql}"
}
now_ms() {
  if command -v perl >/dev/null 2>&1; then
    perl -MTime::HiRes=time -e 'printf "%.0f\n", time() * 1000'
  else
    printf '%s000\n' "$(date +%s)"
  fi
}
extract_psql_time_sum_ms() {
  awk '
    /^Time: [0-9.]+ ms/ {
      sum += $2
      count += 1
    }
    END {
      if (count == 0) {
        printf ""
      } else {
        printf "%.3f", sum
      }
    }
  ' "$1"
}

if [ -z "$run_label" ]; then
  run_label="$(date -u +%Y%m%dT%H%M%SZ)-$profile-$(workload_name_for "$workload")"
fi
case "$run_label" in
  ""|[!A-Za-z0-9]*|*[!A-Za-z0-9._-]*)
    echo "label must start with a letter or number and contain only letters, numbers, '.', '_', and '-'" >&2
    exit 2
    ;;
esac
if [ -z "$initdb_profile" ]; then
  initdb_profile="$profile"
fi

install_dir="$(fresh_wasix_core_install_dir_for "$profile")"
initdb_install_dir="$(fresh_wasix_core_install_dir_for "$initdb_profile")"
run_root="$FRESH_WORK_ROOT/run/query-profiles/$run_label"
report_root="$FRESH_WORK_ROOT/reports/query-profiles/$run_label"
pgdata="$run_root/pgdata"
dev_shm="$run_root/dev-shm"
fresh_require_managed_generated_path "$run_root" "WASIX profile run root"
fresh_require_managed_generated_path "$report_root" "WASIX profile report root"
fresh_require_managed_generated_path "$pgdata" "WASIX profile PGDATA"
fresh_require_managed_generated_path "$dev_shm" "WASIX profile shared-memory root"
sql_path="$(workload_path_for "$workload")"
workload_name="$(workload_name_for "$workload")"
setup_sql_path=""
setup_workload_name=""
if [ -n "$setup_workload" ]; then
  setup_sql_path="$(workload_path_for "$setup_workload")"
  setup_workload_name="$(workload_name_for "$setup_workload")"
fi

mkdir -p "$run_root" "$report_root"
rm -rf "$pgdata" "$dev_shm"
mkdir -p "$dev_shm"

if [ ! -f "$sql_path" ]; then
  printf 'missing workload SQL: %s\n' "$sql_path" >&2
  exit 2
fi
if [ -n "$setup_sql_path" ] && [ ! -f "$setup_sql_path" ]; then
  printf 'missing setup workload SQL: %s\n' "$setup_sql_path" >&2
  exit 2
fi

if [ "$skip_build" -ne 1 ]; then
  WASIX_CORE_PROFILE="$profile" \
    WASIX_BUILD_DIR="$(fresh_wasix_core_build_dir_for "$profile")" \
    WASIX_INSTALL_DIR="$install_dir" \
    REPORT_DIR="$(fresh_wasix_core_report_dir_for "$profile")" \
    RUN_DIR="$(fresh_wasix_core_run_dir_for "$profile")" \
    "$FRESH_ROOT/bin/build-wasix-core.sh" >"$report_root/build.log" 2>&1
  if [ "$initdb_profile" != "$profile" ]; then
    WASIX_CORE_PROFILE="$initdb_profile" \
      WASIX_BUILD_DIR="$(fresh_wasix_core_build_dir_for "$initdb_profile")" \
      WASIX_INSTALL_DIR="$initdb_install_dir" \
      REPORT_DIR="$(fresh_wasix_core_report_dir_for "$initdb_profile")" \
      RUN_DIR="$(fresh_wasix_core_run_dir_for "$initdb_profile")" \
      "$FRESH_ROOT/bin/build-wasix-core.sh" >"$report_root/initdb-build.log" 2>&1
  fi
elif [ ! -x "$install_dir/bin/postgres" ]; then
  printf 'missing %s/bin/postgres with --skip-build\n' "$install_dir" >&2
  exit 2
fi
if [ ! -x "$initdb_install_dir/bin/initdb" ]; then
  printf 'missing %s/bin/initdb\n' "$initdb_install_dir" >&2
  exit 2
fi

if [ "$skip_precompile" -ne 1 ]; then
  WASIX_CORE_PROFILE="$profile" \
    WASIX_BUILD_DIR="$(fresh_wasix_core_build_dir_for "$profile")" \
    WASIX_INSTALL_DIR="$install_dir" \
    REPORT_DIR="$(fresh_wasix_core_report_dir_for "$profile")" \
    RUN_DIR="$(fresh_wasix_core_run_dir_for "$profile")" \
    WASIX_PRECOMPILE_SCOPE="$precompile_scope" \
    "$FRESH_ROOT/bin/precompile-wasix-core.sh" >"$report_root/precompile.log" 2>&1
else
  printf 'precompile skipped\n' >"$report_root/precompile.log"
fi

wasmer_bin="$(fresh_wasmer_bin)"
wasmer_bin_hash="$(fresh_wasmer_bin_hash "$wasmer_bin")"
wasmer_cache_dir="$(fresh_wasmer_cache_dir "$wasmer_bin")"
wasmer_compiler="$(fresh_wasmer_compiler)"
wasmer_llvm_opt_level="${WASMER_LLVM_OPT_LEVEL:-aggressive}"
wasmer_stack_size="${WASMER_STACK_SIZE:-33554432}"
wasmer_compiler_threads="${WASMER_COMPILER_THREADS:-$(fresh_jobs)}"
fresh_require_wasmer_compiler_cli "$wasmer_bin" "$wasmer_compiler" run

wasmer_env=(
  "WASMER_DIR=$FRESH_WORK_ROOT/tools/wasmer-home"
  "WASMER_CACHE_DIR=$wasmer_cache_dir"
)
wasmer_args=(
  run
  --quiet
)
while IFS= read -r arg; do
  wasmer_args+=("$arg")
done < <(fresh_wasmer_compiler_args_for "$wasmer_bin" run "$wasmer_compiler" "$wasmer_llvm_opt_level" "$wasmer_compiler_threads")
wasmer_args+=(
  --profiler perfmap
  --stack-size "$wasmer_stack_size"
  --enable-exceptions
  --enable-threads
  --net
  --volume "$REPO_ROOT:$REPO_ROOT"
  --volume "$dev_shm:/dev/shm"
)
if [ "${#wasmer_extra_args[@]}" -gt 0 ]; then
  wasmer_args+=("${wasmer_extra_args[@]}")
fi

summary="$report_root/summary.md"
initdb_log="$report_root/initdb.log"
server_log="$report_root/server.log"
wait_log="$report_root/wait.log"
psql_log="$report_root/$workload_name.log"
setup_log="$report_root/${setup_workload_name:-setup}.setup.log"
sample_log="$report_root/sample.txt"
sample_stderr="$report_root/sample.stderr.log"
perfmap_copy="$report_root/perf.map"
symbolized_sample="$report_root/symbolized-sample.txt"
symbolized_top="$report_root/symbolized-sample.top.tsv"

{
  printf '# WASIX Query Profile\n\n'
  printf -- '- Generated: `%s`\n' "$(fresh_timestamp)"
  printf -- '- Profile: `%s`\n' "$profile"
  printf -- '- Initdb profile: `%s`\n' "$initdb_profile"
  printf -- '- Workload: `%s`\n' "$workload_name"
  printf -- '- Workload SQL: `%s`\n' "$sql_path"
  printf -- '- Setup workload: `%s`\n' "${setup_workload_name:-}"
  printf -- '- Setup workload SQL: `%s`\n' "${setup_sql_path:-}"
  printf -- '- Rows: `%s`\n' "$profile_rows"
  printf -- '- Transaction rows: `%s`\n' "$transaction_rows"
  printf -- '- Port: `%s`\n' "$start_port"
  printf -- '- Sample seconds: `%s`\n' "$sample_seconds"
  printf -- '- Sample delay: `%s`\n' "$sample_delay"
  printf -- '- Wasmer binary: `%s`\n' "$wasmer_bin"
  printf -- '- Wasmer binary hash: `%s`\n' "$wasmer_bin_hash"
  printf -- '- Wasmer compiler: `%s`\n' "$wasmer_compiler"
  printf -- '- Wasmer LLVM opt level: `%s`\n' "$wasmer_llvm_opt_level"
  printf -- '- WASMER_LLVM_NATIVE_CPU: `%s`\n' "${WASMER_LLVM_NATIVE_CPU:-0}"
  printf -- '- WASMER_LLVM_FULL_O3_PIPELINE: `%s`\n' "${WASMER_LLVM_FULL_O3_PIPELINE:-0}"
  printf -- '- WASMER_LLVM_INDIRECT_CALL_CACHE: `%s`\n' "${WASMER_LLVM_INDIRECT_CALL_CACHE:-0}"
  printf -- '- Wasmer cache dir: `%s`\n' "$wasmer_cache_dir"
  printf -- '- PostgreSQL GUCs: `%s`\n' "${postgres_gucs[*]:-}"
  printf -- '- Extra Wasmer args: `%s`\n\n' "${wasmer_extra_args[*]:-}"
} >"$summary"

env "${wasmer_env[@]}" \
  "$wasmer_bin" "${wasmer_args[@]}" \
    --volume "$initdb_install_dir/lib:/lib" \
    "$initdb_install_dir/bin/initdb" -- \
    -D "$pgdata" \
    -A trust \
    --no-locale \
    --encoding=UTF8 \
    --no-instructions \
    >"$initdb_log" 2>&1

postgres_args=(
  -D "$pgdata"
  -h 127.0.0.1
  -p "$start_port"
  -c unix_socket_directories=
)
if [ "${#postgres_gucs[@]}" -gt 0 ]; then
  for guc in "${postgres_gucs[@]}"; do
    postgres_args+=(-c "$guc")
  done
fi

set +e
env "${wasmer_env[@]}" \
  "$wasmer_bin" "${wasmer_args[@]}" \
    --volume "$install_dir/lib:/lib" \
    "$install_dir/bin/postgres" -- \
    "${postgres_args[@]}" >"$server_log" 2>&1 &
server_pid=$!
set -e

cleanup() {
  if kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

: >"$wait_log"
ready=0
conn="postgresql://wasix@127.0.0.1:$start_port/postgres"
for _ in $(seq 1 300); do
  if "$NATIVE_INSTALL_DIR/bin/psql" "$conn" -X -q -c 'select 1' >>"$wait_log" 2>&1; then
    ready=1
    break
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    echo "WASIX server exited before readiness" >>"$wait_log"
    break
  fi
  sleep 0.1
done
if [ "$ready" -ne 1 ]; then
  printf 'WASIX server did not become ready; see %s\n' "$wait_log" >&2
  exit 1
fi

if [ -n "$setup_sql_path" ]; then
  "$NATIVE_INSTALL_DIR/bin/psql" \
    "$conn" \
    -X -q \
    -v "perf_rows=$profile_rows" \
    -v "update_rows=$profile_rows" \
    -v "transaction_rows=$transaction_rows" \
    -f "$setup_sql_path" >"$setup_log" 2>&1
fi

started_ms="$(now_ms)"
set +e
"$NATIVE_INSTALL_DIR/bin/psql" \
  "$conn" \
  -X -q \
  -v "perf_rows=$profile_rows" \
  -v "update_rows=$profile_rows" \
  -v "transaction_rows=$transaction_rows" \
  -f "$sql_path" >"$psql_log" 2>&1 &
psql_pid=$!
set -e

sleep "$sample_delay"
sample_status=0
if command -v sample >/dev/null 2>&1 && kill -0 "$psql_pid" 2>/dev/null; then
  set +e
  sample "$server_pid" "$sample_seconds" -file "$sample_log" >"$sample_stderr" 2>&1
  sample_status=$?
  set -e
else
  sample_status=127
  printf 'sample command unavailable or workload finished before sampling\n' >"$sample_stderr"
fi

set +e
wait "$psql_pid"
psql_status=$?
set -e
ended_ms="$(now_ms)"
wall_ms=$((ended_ms - started_ms))
psql_time_ms="$(extract_psql_time_sum_ms "$psql_log")"

perfmap="/tmp/perf-$server_pid.map"
if [ -s "$perfmap" ]; then
  cp "$perfmap" "$perfmap_copy"
fi

if [ -s "$sample_log" ] && [ -s "$perfmap_copy" ]; then
  "$FRESH_ROOT/bin/symbolize-wasmer-sample.sh" \
    "$sample_log" \
    "$perfmap_copy" \
    "$report_root/symbolized-sample" \
    >"$report_root/symbolize.log" 2>&1 || true
fi

{
  printf '\n## Result\n\n'
  printf -- '- Server host PID: `%s`\n' "$server_pid"
  printf -- '- PSQL exit code: `%s`\n' "$psql_status"
  printf -- '- Sample exit code: `%s`\n' "$sample_status"
  printf -- '- Workload wall ms: `%s`\n' "$wall_ms"
  printf -- '- PSQL timed ms: `%s`\n' "$psql_time_ms"
  if [ -n "$setup_sql_path" ]; then
    printf -- '- Setup log: `%s`\n' "$setup_log"
  fi
  printf -- '- PSQL log: `%s`\n' "$psql_log"
  printf -- '- Sample log: `%s`\n' "$sample_log"
  printf -- '- Sample stderr: `%s`\n' "$sample_stderr"
  if [ -s "$perfmap_copy" ]; then
    printf -- '- Perf map: `%s`\n' "$perfmap_copy"
  else
    printf -- '- Perf map: `missing`\n'
  fi
  if [ -s "$symbolized_sample" ]; then
    printf -- '- Symbolized sample: `%s`\n' "$symbolized_sample"
    printf -- '- Symbolized top TSV: `%s`\n' "$symbolized_top"
  else
    printf -- '- Symbolized sample: `missing`\n'
  fi
} >>"$summary"

printf 'profile written to %s\n' "$summary"
exit "$psql_status"
