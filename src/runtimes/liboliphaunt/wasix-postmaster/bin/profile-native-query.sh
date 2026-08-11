#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"

workload="unlogged-constant-insert"
setup_workload="${NATIVE_PROFILE_SETUP_WORKLOAD:-}"
profile_rows="${NATIVE_PROFILE_ROWS:-1000000}"
transaction_rows="${NATIVE_PROFILE_TRANSACTION_ROWS:-$profile_rows}"
transaction_rows_explicit=0
if [ "${NATIVE_PROFILE_TRANSACTION_ROWS+x}" = x ]; then
  transaction_rows_explicit=1
fi
sample_seconds="${NATIVE_PROFILE_SAMPLE_SECONDS:-10}"
sample_delay="${NATIVE_PROFILE_SAMPLE_DELAY:-0.2}"
start_port="${PGPORT:-59600}"
skip_build=0
run_label="${NATIVE_PROFILE_LABEL:-}"
postgres_gucs=()

usage() {
  cat <<EOF
Usage: $0 [options]

Options:
  --workload NAME|PATH          SQL workload. Default: $workload
  --setup-workload NAME|PATH    SQL workload to run before sampling. Default: none.
  --rows N                      perf_rows value. Default: $profile_rows
  --transaction-rows N          transaction_rows value. Default: rows.
  --sample-seconds SECONDS      sample(1) duration. Default: $sample_seconds
  --sample-delay SECONDS        Delay before sampling the backend. Default: $sample_delay
  --start-port PORT             PostgreSQL port. Default: $start_port
  --skip-build                  Reuse installed native oracle.
  --label LABEL                 Report label. Default: timestamped.
  --postgres-guc name=value     Extra postgres -c setting.

This starts one native PostgreSQL instance, runs one SQL workload, finds the
workload backend through pg_stat_activity, and samples that backend process.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
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
    --skip-build)
      skip_build=1
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
stop_pid() {
  local pid="${1:-}"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
}

if [ -z "$run_label" ]; then
  run_label="$(date -u +%Y%m%dT%H%M%SZ)-native-$(workload_name_for "$workload")"
fi
case "$run_label" in
  ""|[!A-Za-z0-9]*|*[!A-Za-z0-9._-]*)
    echo "label must start with a letter or number and contain only letters, numbers, '.', '_', and '-'" >&2
    exit 2
    ;;
esac

run_root="$FRESH_WORK_ROOT/run/query-profiles/$run_label"
report_root="$FRESH_WORK_ROOT/reports/query-profiles/$run_label"
pgdata="$run_root/pgdata"
fresh_require_managed_generated_path "$run_root" "native profile run root"
fresh_require_managed_generated_path "$report_root" "native profile report root"
fresh_require_managed_generated_path "$pgdata" "native profile PGDATA"
sql_path="$(workload_path_for "$workload")"
workload_name="$(workload_name_for "$workload")"
setup_sql_path=""
setup_workload_name=""
if [ -n "$setup_workload" ]; then
  setup_sql_path="$(workload_path_for "$setup_workload")"
  setup_workload_name="$(workload_name_for "$setup_workload")"
fi
app_name="native-profile-$run_label"

mkdir -p "$run_root" "$report_root"
rm -rf "$pgdata"

if [ ! -f "$sql_path" ]; then
  printf 'missing workload SQL: %s\n' "$sql_path" >&2
  exit 2
fi
if [ -n "$setup_sql_path" ] && [ ! -f "$setup_sql_path" ]; then
  printf 'missing setup workload SQL: %s\n' "$setup_sql_path" >&2
  exit 2
fi

if [ "$skip_build" -ne 1 ]; then
  "$FRESH_ROOT/bin/build-native-oracle.sh" >"$report_root/build.log" 2>&1
elif [ ! -x "$NATIVE_INSTALL_DIR/bin/postgres" ]; then
  printf 'missing %s/bin/postgres with --skip-build\n' "$NATIVE_INSTALL_DIR" >&2
  exit 2
fi

summary="$report_root/summary.md"
initdb_log="$report_root/initdb.log"
server_log="$report_root/server.log"
wait_log="$report_root/wait.log"
psql_log="$report_root/$workload_name.log"
setup_log="$report_root/${setup_workload_name:-setup}.setup.log"
backend_pid_log="$report_root/backend-pid.log"
sample_log="$report_root/sample.txt"
sample_stderr="$report_root/sample.stderr.log"

{
  printf '# Native Query Profile\n\n'
  printf -- '- Generated: `%s`\n' "$(fresh_timestamp)"
  printf -- '- Workload: `%s`\n' "$workload_name"
  printf -- '- Workload SQL: `%s`\n' "$sql_path"
  printf -- '- Setup workload: `%s`\n' "${setup_workload_name:-}"
  printf -- '- Setup workload SQL: `%s`\n' "${setup_sql_path:-}"
  printf -- '- Rows: `%s`\n' "$profile_rows"
  printf -- '- Transaction rows: `%s`\n' "$transaction_rows"
  printf -- '- Port: `%s`\n' "$start_port"
  printf -- '- Sample seconds: `%s`\n' "$sample_seconds"
  printf -- '- Sample delay: `%s`\n' "$sample_delay"
  printf -- '- PostgreSQL GUCs: `%s`\n\n' "${postgres_gucs[*]:-}"
} >"$summary"

"$NATIVE_INSTALL_DIR/bin/initdb" \
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
"$NATIVE_INSTALL_DIR/bin/postgres" "${postgres_args[@]}" >"$server_log" 2>&1 &
server_pid=$!
set -e

cleanup() {
  stop_pid "$server_pid"
}
trap cleanup EXIT

: >"$wait_log"
ready=0
conn="postgresql://$(id -un)@127.0.0.1:$start_port/postgres"
for _ in $(seq 1 300); do
  if "$NATIVE_INSTALL_DIR/bin/psql" "$conn" -X -q -c 'select 1' >>"$wait_log" 2>&1; then
    ready=1
    break
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    echo "native server exited before readiness" >>"$wait_log"
    break
  fi
  sleep 0.1
done
if [ "$ready" -ne 1 ]; then
  printf 'native server did not become ready; see %s\n' "$wait_log" >&2
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
PGAPPNAME="$app_name" \
"$NATIVE_INSTALL_DIR/bin/psql" \
  "$conn" \
  -X -q \
  -v "perf_rows=$profile_rows" \
  -v "update_rows=$profile_rows" \
  -v "transaction_rows=$transaction_rows" \
  -f "$sql_path" >"$psql_log" 2>&1 &
psql_pid=$!
set -e

backend_pid=""
: >"$backend_pid_log"
for _ in $(seq 1 200); do
  if ! kill -0 "$psql_pid" 2>/dev/null; then
    break
  fi
  backend_pid="$("$NATIVE_INSTALL_DIR/bin/psql" "$conn" -XAtq \
    -c "select pid from pg_stat_activity where application_name = '$app_name' order by backend_start desc limit 1" \
    2>>"$backend_pid_log" | head -n 1 | tr -d '[:space:]')"
  case "$backend_pid" in
    ''|*[!0-9]*)
      sleep 0.05
      ;;
    *)
      printf '%s\n' "$backend_pid" >"$backend_pid_log"
      break
      ;;
  esac
done

sleep "$sample_delay"
sample_status=0
if [ -n "$backend_pid" ] && command -v sample >/dev/null 2>&1 && kill -0 "$psql_pid" 2>/dev/null && kill -0 "$backend_pid" 2>/dev/null; then
  set +e
  sample "$backend_pid" "$sample_seconds" -file "$sample_log" >"$sample_stderr" 2>&1
  sample_status=$?
  set -e
else
  sample_status=127
  printf 'sample command unavailable, backend missing, or workload finished before sampling\n' >"$sample_stderr"
fi

set +e
wait "$psql_pid"
psql_status=$?
set -e
ended_ms="$(now_ms)"
wall_ms=$((ended_ms - started_ms))
psql_time_ms="$(extract_psql_time_sum_ms "$psql_log")"

{
  printf '\n## Result\n\n'
  printf -- '- Postmaster PID: `%s`\n' "$server_pid"
  printf -- '- Workload backend PID: `%s`\n' "${backend_pid:-missing}"
  printf -- '- PSQL exit code: `%s`\n' "$psql_status"
  printf -- '- Sample exit code: `%s`\n' "$sample_status"
  printf -- '- Workload wall ms: `%s`\n' "$wall_ms"
  printf -- '- PSQL timed ms: `%s`\n' "$psql_time_ms"
  if [ -n "$setup_sql_path" ]; then
    printf -- '- Setup log: `%s`\n' "$setup_log"
  fi
  printf -- '- PSQL log: `%s`\n' "$psql_log"
  printf -- '- Backend PID log: `%s`\n' "$backend_pid_log"
  printf -- '- Sample log: `%s`\n' "$sample_log"
  printf -- '- Sample stderr: `%s`\n' "$sample_stderr"
} >>"$summary"

printf 'native profile written to %s\n' "$summary"
exit "$psql_status"
