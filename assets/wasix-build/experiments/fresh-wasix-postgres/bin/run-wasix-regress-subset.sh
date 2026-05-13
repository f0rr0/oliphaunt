#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"

port="${PGPORT:-55435}"
suite_name="${WASIX_REGRESS_SUITE_NAME:-wasix-regress-subset}"
tests=("$@")
if [ "${#tests[@]}" -eq 0 ]; then
  tests=(boolean case copy)
fi

fresh_ensure_dirs

wasmer_bin="$(fresh_wasmer_bin)"
wasmer_bin_hash="$(fresh_wasmer_bin_hash "$wasmer_bin")"
wasmer_cache_dir="$(fresh_wasmer_cache_dir "$wasmer_bin")"
wasmer_compiler="$(fresh_wasmer_compiler)"
wasmer_llvm_opt_level="${WASMER_LLVM_OPT_LEVEL:-aggressive}"
wasmer_stack_size="${WASMER_STACK_SIZE:-33554432}"
wasmer_compiler_threads="${WASMER_COMPILER_THREADS:-$(fresh_jobs)}"
fresh_require_wasmer_compiler_cli "$wasmer_bin" "$wasmer_compiler" run
pg_regress_bin="$NATIVE_BUILD_DIR/src/test/regress/pg_regress"
"$FRESH_ROOT/bin/build-native-oracle.sh" >/dev/null
if [ ! -x "$WASIX_INSTALL_DIR/bin/postgres" ]; then
  "$FRESH_ROOT/bin/build-wasix-core.sh"
fi
"$FRESH_ROOT/bin/build-wasix-regress-support.sh" >/dev/null
if [ "${WASIX_SKIP_PRECOMPILE:-0}" != "1" ]; then
  "$FRESH_ROOT/bin/precompile-wasix-core.sh" >/dev/null
fi

suite_root="$RUN_DIR/$suite_name"
pgdata="$suite_root/pgdata"
dev_shm="$suite_root/dev-shm"
regress_out="$suite_root/pg_regress"
report_dir="$REPORT_DIR/$suite_name"

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
  printf -- '- WASMER_LLVM_FULL_O3_PIPELINE: `%s`\n' "${WASMER_LLVM_FULL_O3_PIPELINE:-0}"
  printf -- '- WASMER_LLVM_INDIRECT_CALL_CACHE: `%s`\n' "${WASMER_LLVM_INDIRECT_CALL_CACHE:-0}"
  printf -- '- Wasmer stack size: `%s`\n' "$wasmer_stack_size"
  printf -- '- Wasmer compiler threads: `%s`\n' "$wasmer_compiler_threads"
  printf -- '- Dynamic library path: `%s`\n' "$WASIX_INSTALL_DIR/lib/postgresql"
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
  if "$NATIVE_INSTALL_DIR/bin/psql" \
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
    --bindir="$NATIVE_INSTALL_DIR/bin" \
    --dlpath="$WASIX_INSTALL_DIR/lib/postgresql" \
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
