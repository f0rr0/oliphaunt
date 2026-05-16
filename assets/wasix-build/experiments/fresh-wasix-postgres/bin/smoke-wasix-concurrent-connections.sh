#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"

usage() {
  cat <<'USAGE'
Usage: smoke-wasix-concurrent-connections.sh [options]

Start a WASIX PostgreSQL server and fan out native psql clients against it.
The smoke checks that concurrent client connections create distinct backends,
overlap in time, and can insert/update indexed rows without client failure.

Options:
  --connections N       Number of concurrent psql clients. Default: 2.
  --iterations N        Rows inserted and updated by each client. Default: 4.
  --hold-seconds N      Seconds each backend sleeps while connected. Default: 1.
  --timeout SECONDS     Wall timeout for the client fanout. Default: 60.
  --port PORT           TCP port. Default: PGPORT or 55445.
  --label NAME          Report/run label. Default: wasix-concurrent-connections.
  --skip-build          Require an existing WASIX install.
  --skip-precompile     Reuse the current Wasmer cache.
  --postgres-guc GUC    Extra postmaster -c name=value setting. May repeat.
  --wasmer-arg ARG      Extra wasmer run argument. May repeat.
  -h, --help            Show this help.
USAGE
}

connections="${WASIX_CONCURRENT_CONNECTIONS:-2}"
iterations="${WASIX_CONCURRENT_ITERATIONS:-4}"
hold_seconds="${WASIX_CONCURRENT_HOLD_SECONDS:-1}"
client_timeout="${WASIX_CONCURRENT_TIMEOUT:-60}"
verify_timeout="${WASIX_CONCURRENT_VERIFY_TIMEOUT:-20}"
port="${PGPORT:-55445}"
label="${WASIX_CONCURRENT_LABEL:-wasix-concurrent-connections}"
skip_build=0
skip_precompile="${WASIX_SKIP_PRECOMPILE:-0}"
postgres_gucs=()
wasmer_extra_args=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --connections)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--connections requires a positive integer" >&2
        exit 2
      fi
      connections="$1"
      ;;
    --iterations)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--iterations requires a positive integer" >&2
        exit 2
      fi
      iterations="$1"
      ;;
    --hold-seconds)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--hold-seconds requires a numeric value" >&2
        exit 2
      fi
      hold_seconds="$1"
      ;;
    --timeout)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--timeout requires a positive integer" >&2
        exit 2
      fi
      client_timeout="$1"
      ;;
    --port)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--port requires a port number" >&2
        exit 2
      fi
      port="$1"
      ;;
    --label)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--label requires a value" >&2
        exit 2
      fi
      label="$1"
      ;;
    --skip-build)
      skip_build=1
      ;;
    --skip-precompile)
      skip_precompile=1
      ;;
    --postgres-guc)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--postgres-guc requires name=value" >&2
        exit 2
      fi
      postgres_gucs+=("$1")
      ;;
    --wasmer-arg)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--wasmer-arg requires one wasmer run argument" >&2
        exit 2
      fi
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

case "$connections" in ''|*[!0-9]*|0) echo "--connections requires a positive integer" >&2; exit 2 ;; esac
case "$iterations" in ''|*[!0-9]*|0) echo "--iterations requires a positive integer" >&2; exit 2 ;; esac
case "$client_timeout" in ''|*[!0-9]*|0) echo "--timeout requires a positive integer" >&2; exit 2 ;; esac
case "$port" in ''|*[!0-9]*) echo "--port requires a port number" >&2; exit 2 ;; esac
case "$label" in ""|*[!A-Za-z0-9._-]*) echo "--label may only contain letters, numbers, '.', '_', and '-'" >&2; exit 2 ;; esac
case "$hold_seconds" in ''|*[!0-9.]*|*.*.*) echo "--hold-seconds requires a non-negative numeric value" >&2; exit 2 ;; esac

fresh_ensure_dirs

if [ ! -x "$NATIVE_INSTALL_DIR/bin/psql" ]; then
  "$FRESH_ROOT/bin/build-native-oracle.sh" >/dev/null
fi
if [ ! -x "$WASIX_INSTALL_DIR/bin/postgres" ] || [ ! -x "$WASIX_INSTALL_DIR/bin/initdb" ]; then
  if [ "$skip_build" -eq 1 ]; then
    printf 'missing WASIX install with --skip-build: %s\n' "$WASIX_INSTALL_DIR" >&2
    exit 2
  fi
  "$FRESH_ROOT/bin/build-wasix-core.sh" >/dev/null
fi

wasmer_bin="$(fresh_wasmer_bin)"
wasmer_bin_hash="$(fresh_wasmer_bin_hash "$wasmer_bin")"
wasmer_cache_dir="$(fresh_wasmer_cache_dir "$wasmer_bin")"
wasmer_compiler="$(fresh_wasmer_compiler)"
wasmer_llvm_opt_level="${WASMER_LLVM_OPT_LEVEL:-aggressive}"
wasmer_stack_size="${WASMER_STACK_SIZE:-33554432}"
wasmer_compiler_threads="${WASMER_COMPILER_THREADS:-$(fresh_jobs)}"
fresh_require_wasmer_compiler_cli "$wasmer_bin" "$wasmer_compiler" run

if [ "$skip_precompile" != "1" ]; then
  "$FRESH_ROOT/bin/precompile-wasix-core.sh" >/dev/null
fi

suite_root="$RUN_DIR/$label"
report_dir="$REPORT_DIR/$label"
pgdata="$suite_root/pgdata"
dev_shm="$suite_root/dev-shm"
client_sql="$suite_root/concurrent-client.sql"
initdb_log="$report_dir/initdb.log"
server_log="$report_dir/server.log"
wait_log="$report_dir/wait.log"
setup_log="$report_dir/setup.log"
verify_log="$report_dir/verify.log"
verify_sql="$suite_root/verify.sql"
summary="$report_dir/summary.md"
summary_tsv="$report_dir/summary.tsv"

rm -rf "$suite_root" "$report_dir"
mkdir -p "$pgdata" "$dev_shm" "$report_dir"

fresh_write_report_header "$summary" "WASIX Concurrent Connections Smoke"
{
  printf -- '- Connections: `%s`\n' "$connections"
  printf -- '- Iterations per connection: `%s`\n' "$iterations"
  printf -- '- Hold seconds: `%s`\n' "$hold_seconds"
  printf -- '- Client fanout timeout: `%s seconds`\n' "$client_timeout"
  printf -- '- Verification timeout: `%s seconds`\n' "$verify_timeout"
  printf -- '- Port: `%s`\n' "$port"
  printf -- '- PGDATA: `%s`\n' "$pgdata"
  printf -- '- Report dir: `%s`\n' "$report_dir"
  printf -- '- Wasmer binary: `%s`\n' "$wasmer_bin"
  printf -- '- Wasmer binary hash: `%s`\n' "$wasmer_bin_hash"
  printf -- '- Wasmer version: `%s`\n' "$("$wasmer_bin" --version 2>/dev/null || true)"
  printf -- '- Wasmer cache dir: `%s`\n' "$wasmer_cache_dir"
  printf -- '- WASIX core profile: `%s`\n' "$WASIX_CORE_PROFILE"
  printf -- '- WASIX install dir: `%s`\n' "$WASIX_INSTALL_DIR"
  printf -- '- Pinned runtime: `%s`\n' "${FRESH_PINNED_RUNTIME_NAME:-}"
  printf -- '- Wasmer compiler: `%s`\n' "$wasmer_compiler"
  printf -- '- Wasmer LLVM opt level: `%s`\n' "$wasmer_llvm_opt_level"
  printf -- '- WASMER_LLVM_NATIVE_CPU: `%s`\n' "${WASMER_LLVM_NATIVE_CPU:-0}"
  printf -- '- WASMER_LLVM_FULL_O3_PIPELINE: `%s`\n' "${WASMER_LLVM_FULL_O3_PIPELINE:-0}"
  printf -- '- WASMER_LLVM_INDIRECT_CALL_CACHE: `%s`\n' "${WASMER_LLVM_INDIRECT_CALL_CACHE:-0}"
  printf -- '- Wasmer stack size: `%s`\n' "$wasmer_stack_size"
  printf -- '- Wasmer compiler threads: `%s`\n' "$wasmer_compiler_threads"
  printf -- '- Skip precompile: `%s`\n\n' "$skip_precompile"
} >>"$summary"
printf 'client\tstatus\tlog\n' >"$summary_tsv"

run_logged_timeout() {
  local timeout_seconds="$1"
  shift
  local log="$1"
  shift
  local pid started elapsed status

  "$@" >"$log" 2>&1 &
  pid=$!
  started="$(date +%s)"
  while kill -0 "$pid" 2>/dev/null; do
    elapsed=$(( $(date +%s) - started ))
    if [ "$elapsed" -ge "$timeout_seconds" ]; then
      {
        printf '\ncommand timed out after %s seconds\n' "$timeout_seconds"
        printf 'command:'
        printf ' %q' "$@"
        printf '\n'
      } >>"$log"
      kill "$pid" 2>/dev/null || true
      sleep 0.5
      kill -9 "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      return 124
    fi
    sleep 0.1
  done
  if wait "$pid"; then
    return 0
  fi
  status=$?
  return "$status"
}

readiness_blocker_reason() {
  local log="$1"

  if [ -f "$log" ] && grep -q 'could not reattach to WASIX shared memory object' "$log"; then
    printf 'runtime-shared-memory-reattach'
    return 0
  fi
  if [ -f "$log" ] && grep -q 'failed to epoll during deep sleep - intr' "$log"; then
    printf 'runtime-epoll-interrupt'
    return 0
  fi
  if [ -n "$server_pid" ] && ! kill -0 "$server_pid" 2>/dev/null; then
    printf 'server-exited'
    return 0
  fi
  printf ''
}

cat >"$client_sql" <<'SQL'
\set ON_ERROR_STOP 1
\pset tuples_only on
\pset format unaligned
begin;
select pg_backend_pid() as backend_pid \gset
insert into wasix_concurrent_probe(client_id, iteration, backend_pid, started_at, payload)
select :client_id, g, :backend_pid, clock_timestamp(), md5((:client_id::text || ':' || g::text))
from generate_series(1, :iterations) as g;
select pg_sleep(:hold_seconds);
update wasix_concurrent_probe
set finished_at = clock_timestamp(),
    payload = md5(payload || ':done')
where client_id = :client_id
  and backend_pid = :backend_pid;
commit;
select :client_id || '|' || :backend_pid || '|' || count(*)
from wasix_concurrent_probe
where client_id = :client_id
  and backend_pid = :backend_pid;
SQL

cat >"$verify_sql" <<'SQL'
select
  count(*)::int as rows_written,
  count(distinct client_id)::int as clients_seen,
  count(distinct backend_pid)::int as backends_seen,
  count(finished_at)::int as rows_finished,
  coalesce((max(started_at) <= min(finished_at))::text, 'false') as all_clients_overlapped
from wasix_concurrent_probe;
SQL

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
  --stack-size "$wasmer_stack_size"
  --enable-exceptions
  --enable-threads
  --net
  --volume "$REPO_ROOT:$REPO_ROOT"
  --volume "$WASIX_INSTALL_DIR/lib:/lib"
  --volume "$dev_shm:/dev/shm"
)
if [ "${#wasmer_extra_args[@]}" -gt 0 ]; then
  wasmer_args+=("${wasmer_extra_args[@]}")
fi

env "${wasmer_env[@]}" \
  "$wasmer_bin" "${wasmer_args[@]}" "$WASIX_INSTALL_DIR/bin/initdb" -- \
    -D "$pgdata" \
    -A trust \
    --no-locale \
    --encoding=UTF8 \
    --no-instructions \
    >"$initdb_log" 2>&1

server_pid=""
cleanup() {
  if [ -n "$server_pid" ] && kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

postgres_args=(
  -D "$pgdata"
  -h 127.0.0.1
  -p "$port"
  -c unix_socket_directories=
  -c "max_connections=$((connections + 16))"
  -c log_connections=on
  -c log_disconnections=on
)
if [ "${#postgres_gucs[@]}" -gt 0 ]; then
  for guc in "${postgres_gucs[@]}"; do
    postgres_args+=(-c "$guc")
  done
fi

set +e
env "${wasmer_env[@]}" \
  "$wasmer_bin" "${wasmer_args[@]}" "$WASIX_INSTALL_DIR/bin/postgres" -- \
    "${postgres_args[@]}" >"$server_log" 2>&1 &
server_pid=$!
set -e

conn="postgresql://wasix@127.0.0.1:$port/postgres"
: >"$wait_log"
ready=0
readiness_reason=""
for _ in $(seq 1 300); do
  if "$NATIVE_INSTALL_DIR/bin/psql" "$conn" -X -q -c 'select 1' >>"$wait_log" 2>&1; then
    ready=1
    break
  fi
  readiness_reason="$(readiness_blocker_reason "$server_log")"
  if [ -n "$readiness_reason" ]; then
    printf 'WASIX server readiness blocker: %s\n' "$readiness_reason" >>"$wait_log"
    break
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    echo "WASIX server exited before readiness" >>"$wait_log"
    readiness_reason="server-exited"
    break
  fi
  sleep 0.1
done
if [ "$ready" -ne 1 ]; then
  {
    printf '\n## Result\n\n'
    printf -- '- Status: `blocked`\n'
    printf -- '- Gate: `readiness`\n'
    printf -- '- Reason: `%s`\n' "${readiness_reason:-timeout}"
    printf -- '- Server log: `%s`\n' "$server_log"
    printf -- '- Wait log: `%s`\n' "$wait_log"
  } >>"$summary"
  echo "WASIX concurrent smoke blocked at readiness; see $server_log and $wait_log" >&2
  exit 2
fi

"$NATIVE_INSTALL_DIR/bin/psql" "$conn" -X -q -v ON_ERROR_STOP=1 >"$setup_log" 2>&1 <<'SQL'
drop table if exists wasix_concurrent_probe;
create table wasix_concurrent_probe (
  client_id integer not null,
  iteration integer not null,
  backend_pid integer not null,
  started_at timestamptz not null,
  finished_at timestamptz,
  payload text not null,
  primary key (client_id, iteration)
);
create index wasix_concurrent_probe_backend_idx on wasix_concurrent_probe (backend_pid);
SQL

client_pids=()
client_logs=()
for client in $(seq 1 "$connections"); do
  client_log="$report_dir/client-$client.log"
  client_logs+=("$client_log")
  PGCONNECT_TIMEOUT=10 "$NATIVE_INSTALL_DIR/bin/psql" "$conn" \
    -X -q \
    -v ON_ERROR_STOP=1 \
    -v "client_id=$client" \
    -v "iterations=$iterations" \
    -v "hold_seconds=$hold_seconds" \
    -f "$client_sql" \
    >"$client_log" 2>&1 &
  client_pids+=("$!")
done

deadline=$(( $(date +%s) + client_timeout ))
timed_out=0
while :; do
  running=0
  for pid in "${client_pids[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      running=1
      break
    fi
  done
  if [ "$running" -eq 0 ]; then
    break
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    timed_out=1
    for pid in "${client_pids[@]}"; do
      kill "$pid" 2>/dev/null || true
    done
    sleep 0.5
    for pid in "${client_pids[@]}"; do
      kill -9 "$pid" 2>/dev/null || true
    done
    break
  fi
  sleep 0.1
done

client_status=0
for index in "${!client_pids[@]}"; do
  pid="${client_pids[$index]}"
  client=$((index + 1))
  log="${client_logs[$index]}"
  set +e
  wait "$pid"
  status=$?
  set -e
  if [ "$timed_out" -eq 1 ] && [ "$status" -eq 143 ]; then
    status=124
  fi
  printf '%s\t%s\t%s\n' "$client" "$status" "$log" >>"$summary_tsv"
  if [ "$status" -ne 0 ]; then
    client_status=1
  fi
done

set +e
run_logged_timeout "$verify_timeout" "$verify_log" \
  "$NATIVE_INSTALL_DIR/bin/psql" "$conn" \
    -X -q -A -t -F $'\t' \
    -v ON_ERROR_STOP=1 \
    -f "$verify_sql"
verify_status=$?
set -e
verify_line=""
if [ "$verify_status" -eq 0 ]; then
  verify_line="$(tail -n 1 "$verify_log")"
fi

expected_rows=$((connections * iterations))
rows_written=""
clients_seen=""
backends_seen=""
rows_finished=""
all_clients_overlapped=""
if [ "$verify_status" -eq 0 ]; then
  IFS=$'\t' read -r rows_written clients_seen backends_seen rows_finished all_clients_overlapped <<EOF
$verify_line
EOF
fi

overall_status=0
if [ "$client_status" -ne 0 ] || [ "$verify_status" -ne 0 ]; then
  overall_status=1
fi
if [ "${rows_written:-0}" != "$expected_rows" ]; then
  overall_status=1
fi
if [ "${rows_finished:-0}" != "$expected_rows" ]; then
  overall_status=1
fi
if [ "${clients_seen:-0}" != "$connections" ]; then
  overall_status=1
fi
if [ "${backends_seen:-0}" != "$connections" ]; then
  overall_status=1
fi
case "$all_clients_overlapped" in
  true|t) ;;
  *) overall_status=1 ;;
esac

{
  printf '\n## Verification\n\n'
  printf -- '- Expected rows: `%s`\n' "$expected_rows"
  printf -- '- Rows written: `%s`\n' "${rows_written:-}"
  printf -- '- Rows finished: `%s`\n' "${rows_finished:-}"
  printf -- '- Clients seen: `%s`\n' "${clients_seen:-}"
  printf -- '- Distinct backend PIDs: `%s`\n' "${backends_seen:-}"
  printf -- '- All clients overlapped: `%s`\n' "${all_clients_overlapped:-}"
  printf -- '- Client fanout timed out: `%s`\n' "$timed_out"
  printf -- '- Verify exit code: `%s`\n' "$verify_status"
  printf -- '- Client summary TSV: `%s`\n' "$summary_tsv"
  printf -- '- Verify log: `%s`\n' "$verify_log"
  printf -- '- Server log: `%s`\n' "$server_log"
  printf '\n## Result\n\n'
  printf -- '- Exit code: `%s`\n' "$overall_status"
} >>"$summary"

if [ "$overall_status" -ne 0 ]; then
  printf 'failed: WASIX concurrent connections smoke; see %s\n' "$summary" >&2
else
  printf 'passed: WASIX concurrent connections smoke; see %s\n' "$summary"
fi
exit "$overall_status"
