#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"

fresh_ensure_dirs

"$FRESH_ROOT/bin/build-native-oracle.sh" >/dev/null

pgdata="$RUN_DIR/native-oracle/pgdata"
socket_dir="$RUN_DIR/native-oracle/socket"
log_file="$REPORT_DIR/native-smoke-postgres.log"
report="$REPORT_DIR/native-smoke.md"
port="${PGPORT:-55432}"

run_root="$RUN_DIR/native-oracle"
fresh_require_managed_generated_path "$run_root" "native smoke run root"
fresh_require_managed_generated_path "$pgdata" "native smoke PGDATA"
fresh_require_managed_generated_path "$socket_dir" "native smoke socket directory"
rm -rf "$run_root"
mkdir -p "$pgdata" "$socket_dir"

fresh_write_report_header "$report" "Native Oracle Smoke"

"$NATIVE_INSTALL_DIR/bin/initdb" -D "$pgdata" --no-locale --encoding=UTF8 >"$REPORT_DIR/native-initdb.log" 2>&1

"$NATIVE_INSTALL_DIR/bin/pg_ctl" \
  -D "$pgdata" \
  -l "$log_file" \
  -o "-h 127.0.0.1 -p $port -c unix_socket_directories=" \
  -w start

cleanup() {
  "$NATIVE_INSTALL_DIR/bin/pg_ctl" -D "$pgdata" -m fast -w stop >/dev/null 2>&1 || true
}
trap cleanup EXIT

"$NATIVE_INSTALL_DIR/bin/psql" \
  "postgresql://127.0.0.1:$port/postgres" \
  -f "$FRESH_ROOT/bench/sql/core-smoke.sql" \
  >"$REPORT_DIR/native-core-smoke.out" 2>&1

"$NATIVE_INSTALL_DIR/bin/pg_ctl" -D "$pgdata" -m fast -w stop >/dev/null
trap - EXIT

{
  printf '## Result\n\n'
  printf -- '- Status: `pass`\n'
  printf -- '- Initdb log: `%s`\n' "$REPORT_DIR/native-initdb.log"
  printf -- '- Server log: `%s`\n' "$log_file"
  printf -- '- SQL output: `%s`\n' "$REPORT_DIR/native-core-smoke.out"
} >>"$report"

printf 'native oracle smoke passed\n'
