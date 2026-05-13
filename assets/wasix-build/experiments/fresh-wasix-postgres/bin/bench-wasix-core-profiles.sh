#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"

profiles=()
skip_build=0
skip_native=0
start_port="${PGPORT:-55470}"
sql_file="$FRESH_ROOT/bench/sql/perf-probes.sql"
sql_timeout="${WASIX_BENCH_SQL_TIMEOUT:-180}"
bench_rows="${WASIX_BENCH_ROWS:-100000}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --profile)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--profile requires a WASIX_CORE_PROFILE value" >&2
        exit 2
      fi
      profiles+=("$(fresh_normalize_wasix_core_profile "$1")")
      ;;
    --profiles)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--profiles requires a space-separated profile list" >&2
        exit 2
      fi
      for profile in $1; do
        profiles+=("$(fresh_normalize_wasix_core_profile "$profile")")
      done
      ;;
    --skip-build)
      skip_build=1
      ;;
    --skip-native)
      skip_native=1
      ;;
    --sql)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--sql requires a SQL file path" >&2
        exit 2
      fi
      sql_file="$1"
      ;;
    --start-port)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--start-port requires a port number" >&2
        exit 2
      fi
      start_port="$1"
      ;;
    --sql-timeout)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--sql-timeout requires a timeout in seconds, or 0 to disable" >&2
        exit 2
      fi
      sql_timeout="$1"
      ;;
    --rows)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--rows requires the number of generated benchmark rows" >&2
        exit 2
      fi
      bench_rows="$1"
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
  shift
done

if [ "${#profiles[@]}" -eq 0 ]; then
  profiles=(safe-o2 o3 o3-wasmopt o3-thinlto release-o3)
fi

fresh_ensure_dirs

if [ ! -f "$sql_file" ]; then
  echo "SQL benchmark file does not exist: $sql_file" >&2
  exit 2
fi

matrix_report_dir="$FRESH_WORK_ROOT/reports/perf-matrix"
matrix_run_root="$FRESH_WORK_ROOT/run/perf-matrix"
summary_tsv="$matrix_report_dir/summary.tsv"
summary_md="$matrix_report_dir/summary.md"
mkdir -p "$matrix_report_dir" "$matrix_run_root"

now_ms() {
  if command -v perl >/dev/null 2>&1; then
    perl -MTime::HiRes=time -e 'printf "%.0f\n", time() * 1000'
  else
    printf '%s000\n' "$(date +%s)"
  fi
}

record_result() {
  local target="$1"
  local profile="$2"
  local phase="$3"
  local status="$4"
  local ms="$5"
  local log="$6"
  local notes="$7"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$target" "$profile" "$phase" "$status" "$ms" "$log" "$notes" >>"$summary_tsv"
}

stop_pid() {
  local pid="${1:-}"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
}

run_logged_timeout() {
  local timeout_seconds="$1"
  shift
  local log="$1"
  shift
  local pid started_ms elapsed_seconds status

  "$@" >"$log" 2>&1 &
  pid=$!
  started_ms="$(now_ms)"
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$timeout_seconds" != "0" ]; then
      elapsed_seconds=$((( $(now_ms) - started_ms ) / 1000))
      if [ "$elapsed_seconds" -ge "$timeout_seconds" ]; then
        {
          printf '\nbenchmark command timed out after %s seconds\n' "$timeout_seconds"
          printf 'command:'
          printf ' %q' "$@"
          printf '\n'
        } >>"$log"
        kill "$pid" 2>/dev/null || true
        sleep 1
        kill -9 "$pid" 2>/dev/null || true
        wait "$pid" 2>/dev/null || true
        return 124
      fi
    fi
    sleep 1
  done
  if wait "$pid"; then
    return 0
  fi
  status=$?
  return "$status"
}

write_header() {
  {
    printf '# WASIX Core Performance Matrix\n\n'
    printf -- '- Generated: `%s`\n' "$(fresh_timestamp)"
    printf -- '- SQL probe: `%s`\n' "$sql_file"
    printf -- '- SQL rows: `%s`\n' "$bench_rows"
    printf -- '- SQL timeout: `%s seconds`\n' "$sql_timeout"
    printf -- '- Profiles: `%s`\n' "${profiles[*]}"
    printf -- '- Start port: `%s`\n' "$start_port"
    printf -- '- Summary TSV: `%s`\n\n' "$summary_tsv"
    printf '## Profiles\n\n'
    for profile in "${profiles[@]}"; do
      fresh_resolve_wasix_core_profile "$profile"
      printf -- '- `%s`: %s\n' "$profile" "$FRESH_WASIX_CORE_PROFILE_DESCRIPTION"
      printf '  - CFLAGS: `%s`\n' "$FRESH_WASIX_CORE_PROFILE_CFLAGS"
      printf '  - LDFLAGS: `%s`\n' "$FRESH_WASIX_CORE_PROFILE_LDFLAGS"
      printf '  - wasm-opt: `%s`\n' "$FRESH_WASIX_CORE_PROFILE_WASM_OPT"
      printf '  - wasm-opt flags: `%s`\n' "$FRESH_WASIX_CORE_PROFILE_WASM_OPT_FLAGS"
      printf '  - install: `%s`\n' "$(fresh_wasix_core_install_dir_for "$profile")"
    done
    printf '\n## Results\n\n'
    printf 'Raw phase results are in `%s`.\n' "$summary_tsv"
  } >"$summary_md"

  printf 'target\tprofile\tphase\tstatus\tms\tlog\tnotes\n' >"$summary_tsv"
}

bench_native() {
  local port="$1"
  local run_root="$matrix_run_root/native"
  local report_root="$matrix_report_dir/native"
  local pgdata="$run_root/pgdata"
  local server_log="$report_root/server.log"
  local initdb_log="$report_root/initdb.log"
  local wait_log="$report_root/wait.log"
  local sql_log="$report_root/sql.log"
  local server_pid=""
  local started_ms ended_ms phase_ms status

  mkdir -p "$run_root" "$report_root"
  rm -rf "$pgdata"

  if [ "$skip_build" -ne 1 ]; then
    "$FRESH_ROOT/bin/build-native-oracle.sh" >/dev/null
  fi

  started_ms="$(now_ms)"
  set +e
  "$NATIVE_INSTALL_DIR/bin/initdb" \
    -D "$pgdata" \
    -A trust \
    --no-locale \
    --encoding=UTF8 \
    --no-instructions \
    >"$initdb_log" 2>&1
  status=$?
  set -e
  ended_ms="$(now_ms)"
  phase_ms=$((ended_ms - started_ms))
  record_result native native initdb "$status" "$phase_ms" "$initdb_log" ""
  if [ "$status" -ne 0 ]; then
    return "$status"
  fi

  started_ms="$(now_ms)"
  set +e
  "$NATIVE_INSTALL_DIR/bin/postgres" \
    -D "$pgdata" \
    -h 127.0.0.1 \
    -p "$port" \
    -c unix_socket_directories= \
    >"$server_log" 2>&1 &
  server_pid=$!
  set -e

  : >"$wait_log"
  status=2
  for _ in $(seq 1 300); do
    if "$NATIVE_INSTALL_DIR/bin/psql" \
        "postgresql://$(id -un)@127.0.0.1:$port/postgres" \
        -X -q -c 'select 1' >>"$wait_log" 2>&1; then
      status=0
      break
    fi
    if ! kill -0 "$server_pid" 2>/dev/null; then
      echo "native server exited before readiness" >>"$wait_log"
      break
    fi
    sleep 0.1
  done
  ended_ms="$(now_ms)"
  phase_ms=$((ended_ms - started_ms))
  record_result native native start_ready "$status" "$phase_ms" "$wait_log" "port=$port"
  if [ "$status" -ne 0 ]; then
    stop_pid "$server_pid"
    return "$status"
  fi

  started_ms="$(now_ms)"
  set +e
  run_logged_timeout "$sql_timeout" "$sql_log" \
    "$NATIVE_INSTALL_DIR/bin/psql" \
    "postgresql://$(id -un)@127.0.0.1:$port/postgres" \
    -X -q -v "perf_rows=$bench_rows" -f "$sql_file"
  status=$?
  set -e
  ended_ms="$(now_ms)"
  phase_ms=$((ended_ms - started_ms))
  record_result native native sql_probe "$status" "$phase_ms" "$sql_log" "timeout=${sql_timeout}s"

  stop_pid "$server_pid"
  return "$status"
}

bench_wasix_profile() {
  local profile="$1"
  local port="$2"
  local install_dir
  local run_root="$matrix_run_root/$profile"
  local report_root="$matrix_report_dir/$profile"
  local pgdata="$run_root/pgdata"
  local dev_shm="$run_root/dev-shm"
  local initdb_log="$report_root/initdb.log"
  local server_log="$report_root/server.log"
  local wait_log="$report_root/wait.log"
  local sql_log="$report_root/sql.log"
  local precompile_log="$report_root/precompile.log"
  local build_log="$report_root/build.log"
  local backend_log="$report_root/wasmer-backend.log"
  local wasmer_bin wasmer_cache_dir wasmer_compiler wasmer_llvm_opt_level wasmer_stack_size wasmer_compiler_threads
  local started_ms ended_ms phase_ms status server_pid

  install_dir="$(fresh_wasix_core_install_dir_for "$profile")"
  mkdir -p "$run_root" "$dev_shm" "$report_root"
  rm -rf "$pgdata" "$dev_shm"
  mkdir -p "$dev_shm"

  if [ "$skip_build" -ne 1 ]; then
    started_ms="$(now_ms)"
    set +e
    WASIX_CORE_PROFILE="$profile" \
      WASIX_BUILD_DIR="$(fresh_wasix_core_build_dir_for "$profile")" \
      WASIX_INSTALL_DIR="$install_dir" \
      REPORT_DIR="$(fresh_wasix_core_report_dir_for "$profile")" \
      RUN_DIR="$(fresh_wasix_core_run_dir_for "$profile")" \
      "$FRESH_ROOT/bin/build-wasix-core.sh" >"$build_log" 2>&1
    status=$?
    set -e
    ended_ms="$(now_ms)"
    phase_ms=$((ended_ms - started_ms))
    record_result wasix "$profile" build "$status" "$phase_ms" "$build_log" "install=$install_dir"
    if [ "$status" -ne 0 ]; then
      return "$status"
    fi
  elif [ ! -x "$install_dir/bin/postgres" ]; then
    record_result wasix "$profile" build 2 0 "$build_log" "missing install with --skip-build"
    return 2
  fi

  started_ms="$(now_ms)"
  set +e
  WASIX_CORE_PROFILE="$profile" \
    WASIX_BUILD_DIR="$(fresh_wasix_core_build_dir_for "$profile")" \
    WASIX_INSTALL_DIR="$install_dir" \
    REPORT_DIR="$(fresh_wasix_core_report_dir_for "$profile")" \
    RUN_DIR="$(fresh_wasix_core_run_dir_for "$profile")" \
    WASIX_PRECOMPILE_SCOPE=runtime \
    "$FRESH_ROOT/bin/precompile-wasix-core.sh" >"$precompile_log" 2>&1
  status=$?
  set -e
  ended_ms="$(now_ms)"
  phase_ms=$((ended_ms - started_ms))
  record_result wasix "$profile" precompile "$status" "$phase_ms" "$precompile_log" ""
  if [ "$status" -ne 0 ]; then
    return "$status"
  fi

  wasmer_bin="$(fresh_wasmer_bin)"
  wasmer_cache_dir="$(fresh_wasmer_cache_dir "$wasmer_bin")"
  wasmer_compiler="$(fresh_wasmer_compiler)"
  wasmer_llvm_opt_level="${WASMER_LLVM_OPT_LEVEL:-aggressive}"
  wasmer_stack_size="${WASMER_STACK_SIZE:-33554432}"
  wasmer_compiler_threads="${WASMER_COMPILER_THREADS:-$(fresh_jobs)}"
  if ! fresh_require_wasmer_compiler_cli "$wasmer_bin" "$wasmer_compiler" run >"$backend_log" 2>&1; then
    record_result wasix "$profile" backend 2 0 "$backend_log" "compiler=$wasmer_compiler"
    return 2
  fi

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
    --volume "$install_dir/lib:/lib"
    --volume "$dev_shm:/dev/shm"
  )

  started_ms="$(now_ms)"
  set +e
  env "${wasmer_env[@]}" \
    "$wasmer_bin" "${wasmer_args[@]}" "$install_dir/bin/initdb" -- \
      -D "$pgdata" \
      -A trust \
      --no-locale \
      --encoding=UTF8 \
      --no-instructions \
      >"$initdb_log" 2>&1
  status=$?
  set -e
  ended_ms="$(now_ms)"
  phase_ms=$((ended_ms - started_ms))
  record_result wasix "$profile" initdb "$status" "$phase_ms" "$initdb_log" ""
  if [ "$status" -ne 0 ]; then
    return "$status"
  fi

  started_ms="$(now_ms)"
  set +e
  env "${wasmer_env[@]}" \
    "$wasmer_bin" "${wasmer_args[@]}" "$install_dir/bin/postgres" -- \
      -D "$pgdata" \
      -h 127.0.0.1 \
      -p "$port" \
      -c unix_socket_directories= \
      >"$server_log" 2>&1 &
  server_pid=$!
  set -e

  : >"$wait_log"
  status=2
  for _ in $(seq 1 300); do
    if "$NATIVE_INSTALL_DIR/bin/psql" \
        "postgresql://wasix@127.0.0.1:$port/postgres" \
        -X -q -c 'select 1' >>"$wait_log" 2>&1; then
      status=0
      break
    fi
    if ! kill -0 "$server_pid" 2>/dev/null; then
      echo "WASIX server exited before readiness" >>"$wait_log"
      break
    fi
    sleep 0.1
  done
  ended_ms="$(now_ms)"
  phase_ms=$((ended_ms - started_ms))
  record_result wasix "$profile" start_ready "$status" "$phase_ms" "$wait_log" "port=$port"
  if [ "$status" -ne 0 ]; then
    stop_pid "$server_pid"
    return "$status"
  fi

  started_ms="$(now_ms)"
  set +e
  run_logged_timeout "$sql_timeout" "$sql_log" \
    "$NATIVE_INSTALL_DIR/bin/psql" \
    "postgresql://wasix@127.0.0.1:$port/postgres" \
    -X -q -v "perf_rows=$bench_rows" -f "$sql_file"
  status=$?
  set -e
  ended_ms="$(now_ms)"
  phase_ms=$((ended_ms - started_ms))
  record_result wasix "$profile" sql_probe "$status" "$phase_ms" "$sql_log" "timeout=${sql_timeout}s"

  stop_pid "$server_pid"
  return "$status"
}

write_header

overall_status=0
port="$start_port"

if [ "$skip_native" -ne 1 ]; then
  if ! bench_native "$port"; then
    overall_status=1
  fi
  port=$((port + 1))
fi

for profile in "${profiles[@]}"; do
  if ! bench_wasix_profile "$profile" "$port"; then
    overall_status=1
  fi
  port=$((port + 1))
done

{
  printf '\n## Completion\n\n'
  printf -- '- Exit code: `%s`\n' "$overall_status"
  printf -- '- Finished: `%s`\n' "$(fresh_timestamp)"
} >>"$summary_md"

printf 'performance matrix written to %s\n' "$summary_tsv"
exit "$overall_status"
