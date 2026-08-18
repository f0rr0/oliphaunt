#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"

fresh_ensure_dirs

report="$REPORT_DIR/wasix-core-smoke.md"
initdb_log="$REPORT_DIR/wasix-initdb.log"
prewarm_log="$REPORT_DIR/wasix-prewarm.log"
fresh_write_report_header "$report" "WASIX Core Smoke"

set +e
wasmer_bin="$(fresh_wasmer_bin 2>>"$report")"
wasmer_status=$?
set -e
if [ "$wasmer_status" -ne 0 ]; then
  {
    printf '## Result\n\n'
    printf -- '- Status: `blocked`\n'
    printf -- '- Blocker: Wasmer CLI is missing or failed pinned-build validation.\n\n'
    printf 'Run `%s/runtime/bin/build-runtime.sh`, or set `WASMER_BIN` and `WASMER_BUILD_RECEIPT` to a matching pinned build.\n' "$FRESH_ROOT"
  } >>"$report"
  echo "blocked: Wasmer CLI is missing or failed pinned-build validation; see $report" >&2
  exit 2
fi

if [ ! -x "$WASIX_INSTALL_DIR/bin/initdb" ]; then
  "$FRESH_ROOT/bin/build-wasix-core.sh"
fi

wasmer_bin_hash="$(fresh_wasmer_bin_hash "$wasmer_bin")"
wasmer_cache_dir="$(fresh_wasmer_cache_dir "$wasmer_bin")"
wasmer_compiler="$(fresh_wasmer_compiler)"
wasmer_llvm_opt_level=aggressive
wasmer_stack_size="${WASMER_STACK_SIZE:-33554432}"
wasmer_compiler_threads="${WASMER_COMPILER_THREADS:-$(fresh_jobs)}"
fresh_require_wasmer_compiler_cli "$wasmer_bin" "$wasmer_compiler" run

pgdata="$RUN_DIR/wasix-core/pgdata"
dev_shm="$RUN_DIR/wasix-core/dev-shm"
fresh_require_managed_generated_path "$RUN_DIR/wasix-core" "WASIX smoke run root"
fresh_require_managed_generated_path "$pgdata" "WASIX smoke PGDATA"
fresh_require_managed_generated_path "$dev_shm" "WASIX smoke shared-memory root"
rm -rf "$pgdata"
rm -rf "$dev_shm"
mkdir -p "$RUN_DIR/wasix-core" "$dev_shm"

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
  --volume "$FRESH_WORK_ROOT:$FRESH_WORK_ROOT"
  --volume "$WASIX_INSTALL_DIR/lib:/lib"
  --volume "$dev_shm:/dev/shm"
)

{
  printf '## Runtime\n\n'
  printf -- '- Wasmer binary: `%s`\n' "$wasmer_bin"
  printf -- '- Wasmer binary hash: `%s`\n' "$wasmer_bin_hash"
  printf -- '- Wasmer version: `%s`\n' "$(fresh_wasmer_version "$wasmer_bin" 2>/dev/null || true)"
  printf -- '- Wasmer cache dir: `%s`\n' "$wasmer_cache_dir"
  printf -- '- WASIX core profile: `%s`\n' "$WASIX_CORE_PROFILE"
  printf -- '- WASIX install dir: `%s`\n' "$WASIX_INSTALL_DIR"
  printf -- '- Wasmer compiler: `%s`\n' "$wasmer_compiler"
  printf -- '- Wasmer LLVM opt level: `%s`\n' "$wasmer_llvm_opt_level"
  printf -- '- Wasmer stack size: `%s`\n' "$wasmer_stack_size"
  printf -- '- Wasmer compiler threads: `%s`\n' "$wasmer_compiler_threads"
  printf -- '- Guest mapping: `%s:%s`\n' "$FRESH_WORK_ROOT" "$FRESH_WORK_ROOT"
  printf -- '- Library mapping: `%s:/lib`\n' "$WASIX_INSTALL_DIR/lib"
  printf -- '- Shared-memory mapping: `%s:/dev/shm`\n' "$dev_shm"
  printf -- '- Prewarm log: `%s`\n' "$prewarm_log"
  printf -- '- Initdb log: `%s`\n\n' "$initdb_log"
} >>"$report"

warm_wasix_binary() {
  local binary="$1"
  shift

  {
    printf '## %s %s\n\n' "$(basename "$binary")" "$*"
  } >>"$prewarm_log"

  env "${wasmer_env[@]}" \
    "$wasmer_bin" "${wasmer_args[@]}" "$binary" -- "$@" \
    >>"$prewarm_log" 2>&1
}

if [ "${WASIX_SKIP_PREWARM:-0}" != "1" ]; then
  : >"$prewarm_log"
  if [ "${WASIX_SKIP_PRECOMPILE:-0}" != "1" ]; then
    "$FRESH_ROOT/bin/precompile-wasix-core.sh" >>"$prewarm_log" 2>&1
  fi
  set +e
  warm_wasix_binary "$WASIX_INSTALL_DIR/bin/postgres" --version
  prewarm_postgres_status=$?
  warm_wasix_binary "$WASIX_INSTALL_DIR/bin/initdb" --version
  prewarm_initdb_status=$?
  set -e

  if [ "$prewarm_postgres_status" -ne 0 ] || [ "$prewarm_initdb_status" -ne 0 ]; then
    {
      printf '## Result\n\n'
      printf -- '- Status: `blocked`\n'
      printf -- '- Gate: `prewarm`\n'
      printf -- '- postgres --version exit code: `%s`\n' "$prewarm_postgres_status"
      printf -- '- initdb --version exit code: `%s`\n\n' "$prewarm_initdb_status"
      printf 'The runtime could not load the core PostgreSQL tools. Inspect `%s`.\n' "$prewarm_log"
    } >>"$report"
    printf 'blocked: WASIX prewarm failed; see %s and %s\n' "$report" "$prewarm_log" >&2
    exit 2
  fi
else
  : >"$prewarm_log"
  printf 'prewarm skipped because WASIX_SKIP_PREWARM=1\n' >"$prewarm_log"
fi

: >"$initdb_log"
set +e
env "${wasmer_env[@]}" \
  "$wasmer_bin" "${wasmer_args[@]}" "$WASIX_INSTALL_DIR/bin/initdb" -- \
    -D "$pgdata" \
    -A trust \
    --no-locale \
    --encoding=UTF8 \
    --no-instructions \
    >"$initdb_log" 2>&1
initdb_status=$?
set -e

if [ "$initdb_status" -ne 0 ]; then
  blocker="initdb failed under WASIX; inspect the initdb log"
  if grep -q '/bin/sh' "$initdb_log" || grep -q 'could not execute command ".*postgres.*-V"' "$initdb_log"; then
    blocker="shell-less PostgreSQL subprocess contract failed: WASIX popen/system routed through /bin/sh"
  elif grep -q 'program "postgres" is needed by initdb' "$initdb_log"; then
    blocker="initdb could not validate the sibling postgres executable through PostgreSQL's normal lookup path"
  fi

  {
    printf '## Result\n\n'
    printf -- '- Status: `blocked`\n'
    printf -- '- Gate: `initdb`\n'
    printf -- '- Exit code: `%s`\n' "$initdb_status"
    printf -- '- Blocker: %s.\n\n' "$blocker"
    printf 'This is a runtime/process execution blocker for the WASIX core loop, not a PostgreSQL success shim candidate.\n'
  } >>"$report"

  printf 'blocked: WASIX initdb failed; see %s and %s\n' "$report" "$initdb_log" >&2
  exit 2
fi

{
  printf '## Result\n\n'
  printf -- '- Status: `pass`\n'
  printf -- '- Gate: `initdb`\n'
  printf -- '- Data directory: `%s`\n\n' "$pgdata"
  printf 'Server/socket behavior is qualified separately by smoke-wasix-concurrent-connections.sh using `%s/bin/postgres` and `%s/bin/psql`.\n' \
    "$WASIX_INSTALL_DIR" "$WASIX_INSTALL_DIR"
} >>"$report"

echo "passed: WASIX initdb gate; see $report"
