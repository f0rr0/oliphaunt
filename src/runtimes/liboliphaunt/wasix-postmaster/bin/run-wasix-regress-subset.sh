#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"

port="${PGPORT:-55435}"
suite_name="${WASIX_REGRESS_SUITE_NAME-wasix-regress-subset}"
case "$suite_name" in
  ''|[!A-Za-z0-9]*|*[!A-Za-z0-9._-]*)
    printf 'invalid WASIX regression suite name: %s\n' "$suite_name" >&2
    exit 2
    ;;
esac
tests=("$@")
if [ "${#tests[@]}" -eq 0 ]; then
  tests=(boolean case copy)
fi
for test_name in "${tests[@]}"; do
  case "$test_name" in
    ''|*[!A-Za-z0-9_]*|[0-9]*)
      printf 'invalid PostgreSQL regression test name: %s\n' "$test_name" >&2
      exit 2
      ;;
  esac
done

fresh_ensure_dirs

wasmer_bin="$(fresh_wasmer_bin)"
wasmer_bin_hash="$(fresh_wasmer_bin_hash "$wasmer_bin")"
wasmer_cache_dir="$(fresh_wasmer_cache_dir "$wasmer_bin")"
wasmer_compiler="$(fresh_wasmer_compiler)"
wasmer_llvm_opt_level=aggressive
wasmer_stack_size="${WASMER_STACK_SIZE:-33554432}"
wasmer_compiler_threads="${WASMER_COMPILER_THREADS:-$(fresh_jobs)}"
fresh_require_wasmer_compiler_cli "$wasmer_bin" "$wasmer_compiler" run
pg_regress_bin="$CLIENT_TOOLS_BUILD_DIR/src/test/regress/pg_regress"
"$FRESH_ROOT/bin/build-native-client-tools.sh" >/dev/null
if [ ! -x "$WASIX_INSTALL_DIR/bin/postgres" ]; then
  "$FRESH_ROOT/bin/build-wasix-core.sh"
fi
fresh_lock_postgres_baseline shared
baseline_fingerprint="$(fresh_postgres_baseline_fingerprint)"
fresh_require_postgres_baseline "$baseline_fingerprint" || {
  printf 'WASIX regression refused an invalid PostgreSQL baseline: %s\n' \
    "$BASELINE_DIR" >&2
  exit 2
}
for test_name in "${tests[@]}"; do
  [ -f "$BASELINE_DIR/src/test/regress/sql/$test_name.sql" ] &&
    [ ! -L "$BASELINE_DIR/src/test/regress/sql/$test_name.sql" ] &&
    [ -f "$BASELINE_DIR/src/test/regress/expected/$test_name.out" ] &&
    [ ! -L "$BASELINE_DIR/src/test/regress/expected/$test_name.out" ] || {
    printf 'unknown PostgreSQL regression test: %s\n' "$test_name" >&2
    exit 2
  }
done
if [ "${WASIX_SKIP_PRECOMPILE:-0}" != "1" ]; then
  "$FRESH_ROOT/bin/precompile-wasix-core.sh" >/dev/null
fi

suite_root="$RUN_DIR/$suite_name"
pgdata="$suite_root/pgdata"
dev_shm="$suite_root/dev-shm"
regress_out="$suite_root/pg_regress"
report_dir="$REPORT_DIR/$suite_name"
fresh_require_managed_generated_path "$suite_root" WASIX_REGRESS_SUITE_ROOT
fresh_require_managed_generated_path "$report_dir" WASIX_REGRESS_REPORT_DIR

rm -rf "$suite_root"
mkdir -p "$pgdata" "$dev_shm" "$regress_out" "$report_dir" "$wasmer_cache_dir"

initdb_log="$report_dir/initdb.log"
server_log="$report_dir/server.log"
wait_log="$report_dir/wait.log"
regress_log="$report_dir/pg-regress.log"
summary="$report_dir/summary.md"

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

{
  printf '# WASIX pg_regress Subset\n\n'
  printf -- '- Generated: `%s`\n' "$(fresh_timestamp)"
  printf -- '- Port: `%s`\n' "$port"
  printf -- '- Tests: `%s`\n' "${tests[*]}"
  printf -- '- PGDATA: `%s`\n' "$pgdata"
  printf -- '- Output dir: `%s`\n' "$regress_out"
  printf -- '- Report dir: `%s`\n\n' "$report_dir"
  printf -- '- Wasmer binary hash: `%s`\n' "$wasmer_bin_hash"
  printf -- '- Wasmer cache dir: `%s`\n' "$wasmer_cache_dir"
  printf -- '- WASIX core profile: `%s`\n' "$WASIX_CORE_PROFILE"
  printf -- '- WASIX install dir: `%s`\n' "$WASIX_INSTALL_DIR"
  printf -- '- Wasmer compiler: `%s`\n' "$wasmer_compiler"
  printf -- '- Wasmer LLVM opt level: `%s`\n' "$wasmer_llvm_opt_level"
  printf -- '- Wasmer stack size: `%s`\n' "$wasmer_stack_size"
  printf -- '- Wasmer compiler threads: `%s`\n' "$wasmer_compiler_threads"
} >"$summary"

env "${wasmer_env[@]}" \
  "$wasmer_bin" "${wasmer_args[@]}" "$WASIX_INSTALL_DIR/bin/initdb" -- \
    -D "$pgdata" \
    -A trust \
    --no-locale \
    --encoding=UTF8 \
    --no-instructions \
    >"$initdb_log" 2>&1

set +e
env "${wasmer_env[@]}" \
  "$wasmer_bin" "${wasmer_args[@]}" "$WASIX_INSTALL_DIR/bin/postgres" -- \
    -D "$pgdata" \
    -h 127.0.0.1 \
    -p "$port" \
    -c unix_socket_directories= \
    >"$server_log" 2>&1 &
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
for _ in $(seq 1 150); do
  if "$CLIENT_TOOLS_INSTALL_DIR/bin/psql" \
      "postgresql://wasix@127.0.0.1:$port/postgres" \
      -X -q -c 'select 1' >>"$wait_log" 2>&1; then
    ready=1
    break
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    echo "server exited before readiness" >>"$wait_log"
    break
  fi
  sleep 0.2
done
if [ "$ready" -ne 1 ]; then
  echo "WASIX server did not become ready; see $server_log and $wait_log" >&2
  exit 2
fi

set +e
(
  cd "$BASELINE_DIR/src/test/regress"
  "$pg_regress_bin" \
    --use-existing \
    --host=127.0.0.1 \
    --port="$port" \
    --user=wasix \
    --dbname=postgres \
    --bindir="$CLIENT_TOOLS_INSTALL_DIR/bin" \
    --inputdir="$BASELINE_DIR/src/test/regress" \
    --outputdir="$regress_out" \
    "${tests[@]}"
) >"$regress_log" 2>&1
status=$?
set -e

{
  printf '## Result\n\n'
  printf -- '- Exit code: `%s`\n' "$status"
  printf -- '- Log: `%s`\n' "$regress_log"
  if [ -f "$regress_out/regression.diffs" ]; then
    printf -- '- Diffs: `%s`\n' "$regress_out/regression.diffs"
  fi
} >>"$summary"

cat "$regress_log"
exit "$status"
