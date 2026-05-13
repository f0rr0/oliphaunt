#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"

port="${PGPORT:-55436}"
suite_name="${NATIVE_REGRESS_SUITE_NAME:-native-regress-subset}"
tests=("$@")
if [ "${#tests[@]}" -eq 0 ]; then
  tests=(boolean case copy)
fi

fresh_ensure_dirs
"$FRESH_ROOT/bin/build-native-oracle.sh" >/dev/null

pg_regress_bin="$NATIVE_BUILD_DIR/src/test/regress/pg_regress"
if [ ! -x "$pg_regress_bin" ]; then
  echo "pg_regress is missing after native oracle build: $pg_regress_bin" >&2
  exit 2
fi

suite_root="$RUN_DIR/$suite_name"
pgdata="$suite_root/pgdata"
regress_out="$suite_root/pg_regress"
report_dir="$REPORT_DIR/$suite_name"

rm -rf "$suite_root"
mkdir -p "$pgdata" "$regress_out" "$report_dir"

initdb_log="$report_dir/initdb.log"
server_log="$report_dir/server.log"
wait_log="$report_dir/wait.log"
regress_log="$report_dir/pg-regress.log"
summary="$report_dir/summary.md"

{
  printf '# Native pg_regress Subset\n\n'
  printf -- '- Generated: `%s`\n' "$(fresh_timestamp)"
  printf -- '- Port: `%s`\n' "$port"
  printf -- '- Tests: `%s`\n' "${tests[*]}"
  printf -- '- PGDATA: `%s`\n' "$pgdata"
  printf -- '- Output dir: `%s`\n' "$regress_out"
  printf -- '- Report dir: `%s`\n\n' "$report_dir"
} >"$summary"

"$NATIVE_INSTALL_DIR/bin/initdb" \
  -D "$pgdata" \
  -A trust \
  --no-locale \
  --encoding=UTF8 \
  --no-instructions \
  >"$initdb_log" 2>&1

set +e
"$NATIVE_INSTALL_DIR/bin/postgres" \
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
      "postgresql://$(id -un)@127.0.0.1:$port/postgres" \
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
  echo "native server did not become ready; see $server_log and $wait_log" >&2
  exit 2
fi

set +e
(
  cd "$NATIVE_BUILD_DIR/src/test/regress"
  "$pg_regress_bin" \
    --use-existing \
    --host=127.0.0.1 \
    --port="$port" \
    --user="$(id -un)" \
    --dbname=postgres \
    --bindir="$NATIVE_INSTALL_DIR/bin" \
    --dlpath="$NATIVE_BUILD_DIR/src/test/regress" \
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
