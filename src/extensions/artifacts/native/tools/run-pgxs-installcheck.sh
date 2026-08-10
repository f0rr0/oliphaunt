#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null)" || {
  echo "run-pgxs-installcheck.sh: unable to determine the repository root" >&2
  exit 1
}

fail() {
  echo "run-pgxs-installcheck.sh: $*" >&2
  exit 1
}

require_file() {
  if [ ! -f "$1" ] || [ -L "$1" ]; then
    fail "missing regular $2 at $1"
  fi
}

runtime="${OLIPHAUNT_EXTENSION_CURRENT_RUNTIME:-}"
sql_name="${OLIPHAUNT_EXTENSION_SQL_NAME:-}"
source_name="${OLIPHAUNT_EXTENSION_SOURCE_NAME:-}"
source_commit="${OLIPHAUNT_EXTENSION_SOURCE_COMMIT:-}"
included_suites="${OLIPHAUNT_EXTENSION_INCLUDED_SUITES:-}"
suite_target_prefix="${OLIPHAUNT_EXTENSION_SUITE_TARGET_PREFIX:-}"
aggregate_suites="${OLIPHAUNT_EXTENSION_AGGREGATE_SUITES:-}"
excluded_suites="${OLIPHAUNT_EXTENSION_EXCLUDED_SUITES:-}"
preload_libraries="${OLIPHAUNT_EXTENSION_SHARED_PRELOAD_LIBRARIES:-}"
test_locale="${OLIPHAUNT_EXTENSION_TEST_LOCALE:-}"

case "$sql_name" in
  ""|*[!a-z0-9_-]*) fail "OLIPHAUNT_EXTENSION_SQL_NAME must be a safe SQL extension name" ;;
esac
case "$source_name" in
  ""|*[!a-z0-9_-]*) fail "OLIPHAUNT_EXTENSION_SOURCE_NAME must be a safe source name" ;;
esac
case "$source_commit" in
  *[!0-9a-f]*) fail "OLIPHAUNT_EXTENSION_SOURCE_COMMIT must be a full lowercase Git SHA" ;;
esac
[ "${#source_commit}" -eq 40 ] || \
  fail "OLIPHAUNT_EXTENSION_SOURCE_COMMIT must be a full lowercase Git SHA"
[ "$included_suites" = "regress" ] || \
  fail "pgxs-installcheck currently requires included_suites = [\"regress\"]"
case "$suite_target_prefix" in
  ""|*[!a-z0-9_-]*) fail "OLIPHAUNT_EXTENSION_SUITE_TARGET_PREFIX must be a safe Make target prefix" ;;
esac
case "$aggregate_suites" in
  ""|*[!a-z0-9_,-]*) fail "OLIPHAUNT_EXTENSION_AGGREGATE_SUITES contains an unsafe suite name" ;;
esac
case "$excluded_suites" in
  *[!a-z0-9_,-]*) fail "OLIPHAUNT_EXTENSION_EXCLUDED_SUITES contains an unsafe suite name" ;;
esac
case "$preload_libraries" in
  *[!a-z0-9_,-]*) fail "OLIPHAUNT_EXTENSION_SHARED_PRELOAD_LIBRARIES contains an unsafe library name" ;;
esac
case "$test_locale" in
  ""|*[!A-Za-z0-9._@-]*) fail "OLIPHAUNT_EXTENSION_TEST_LOCALE must be a safe explicit locale" ;;
esac

[ -n "$runtime" ] || fail "OLIPHAUNT_EXTENSION_CURRENT_RUNTIME must name the exact candidate runtime"
runtime="$(cd "$runtime" 2>/dev/null && pwd)" || fail "runtime is not a directory: $runtime"
for command_name in awk cmp cp git make mkdir mktemp rm rsync sed sort; do
  command -v "$command_name" >/dev/null 2>&1 || fail "missing required command: $command_name"
done
for tool in initdb pg_config pg_ctl postgres psql; do
  require_file "$runtime/bin/$tool" "runtime tool $tool"
done
require_file "$runtime/lib/postgresql/$sql_name.so" "$sql_name module"
require_file "$runtime/share/postgresql/extension/$sql_name.control" "$sql_name control file"

checkout="$root/target/oliphaunt-sources/checkouts/$source_name"
if [ ! -d "$checkout" ] || [ -L "$checkout" ] || [ ! -d "$checkout/.git" ] || [ -L "$checkout/.git" ]; then
  fail "missing verified $source_name checkout; run the source-fetch-native-runtime dependency"
fi
actual_commit="$(git -C "$checkout" rev-parse --verify 'HEAD^{commit}')"
[ "$actual_commit" = "$source_commit" ] || \
  fail "$source_name checkout is at $actual_commit, expected $source_commit"
[ -z "$(git -C "$checkout" status --porcelain=v1 --untracked-files=all)" ] || \
  fail "$source_name checkout must be clean"

work_parent="$root/target/extension-upstream-installcheck"
mkdir -p "$work_parent"
if [ ! -d "$work_parent" ] || [ -L "$work_parent" ]; then
  fail "upstream test work parent must be a real directory: $work_parent"
fi
work_root="$(mktemp -d "$work_parent/$sql_name.XXXXXX")"
source_dir="$work_root/source"
data_dir="$work_root/data"
socket_dir="$(mktemp -d "/tmp/oliphaunt-$sql_name-pgxs.XXXXXX")"
server_log="$work_root/postgres.log"
preserved_log="/tmp/oliphaunt-$sql_name-upstream-postgres.log"
preserved_diff="/tmp/oliphaunt-$sql_name-upstream-regression.diffs"
server_start_attempted=0
server_running=0

cleanup() {
  local status="$?"
  local may_remove=1
  trap - EXIT HUP INT TERM
  if [ "$server_running" = 1 ] || [ -f "$data_dir/postmaster.pid" ] || \
     { [ "$server_start_attempted" = 1 ] && "$runtime/bin/pg_ctl" status -D "$data_dir" >/dev/null 2>&1; }; then
    if ! "$runtime/bin/pg_ctl" stop -D "$data_dir" -m immediate -w >/dev/null 2>&1; then
      may_remove=0
      echo "run-pgxs-installcheck.sh: could not confirm server shutdown; preserving $work_root" >&2
    fi
  fi
  if [ "$status" -ne 0 ]; then
    if [ -f "$server_log" ]; then
      cp "$server_log" "$preserved_log" 2>/dev/null || true
      echo "run-pgxs-installcheck.sh: preserved failing server log at $preserved_log" >&2
    fi
    if [ -f "$source_dir/test/regression.diffs" ]; then
      cp "$source_dir/test/regression.diffs" "$preserved_diff" 2>/dev/null || true
      echo "run-pgxs-installcheck.sh: preserved regression diff at $preserved_diff" >&2
    fi
  fi
  if [ "$may_remove" = 1 ] && [ ! -f "$data_dir/postmaster.pid" ]; then
    rm -rf "$work_root"
    rm -rf "$socket_dir"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

rsync -a --delete --exclude .git/ "$checkout/" "$source_dir/"

make_database="$work_root/make-database.txt"
make_targets="$work_root/make-test-targets.txt"
declared_targets="$work_root/declared-test-targets.txt"
make_database_result=0
PATH="$runtime/bin:$PATH" make -C "$source_dir" -qp \
  PG_CONFIG="$runtime/bin/pg_config" >"$make_database" 2>&1 || make_database_result="$?"
case "$make_database_result" in
  0|1) ;;
  *) fail "cannot inspect the pinned $source_name Make target database (exit $make_database_result)" ;;
esac
LC_ALL=C awk -F: -v prefix="$suite_target_prefix" \
  'index($1, prefix) == 1 && $1 ~ /^[a-z][a-z0-9_-]*$/ { print $1 }' \
  "$make_database" | LC_ALL=C sort -u >"$make_targets"
IFS=',' read -r -a declared_target_names <<<"$aggregate_suites,$excluded_suites"
printf '%s\n' "${declared_target_names[@]}" | LC_ALL=C sort -u >"$declared_targets"
if ! cmp -s "$make_targets" "$declared_targets"; then
  echo "run-pgxs-installcheck.sh: discovered pinned Make test targets:" >&2
  sed 's/^/  /' "$make_targets" >&2
  echo "run-pgxs-installcheck.sh: declared aggregate/excluded test targets:" >&2
  sed 's/^/  /' "$declared_targets" >&2
  fail "upstream Make test target inventory drifted from the qualification manifest"
fi

PATH="$runtime/bin:$PATH" "$runtime/bin/initdb" \
  -D "$data_dir" --auth-local=trust --auth-host=reject \
  --locale="$test_locale" --encoding=UTF8 >/dev/null
if [[ "$socket_dir" == *"'"* ]]; then
  fail "upstream test socket path must not contain a single quote"
fi
{
  printf "listen_addresses = ''\n"
  printf "unix_socket_directories = '%s'\n" "$socket_dir"
  printf "fsync = off\n"
  printf "full_page_writes = off\n"
  if [ -n "$preload_libraries" ]; then
    printf "shared_preload_libraries = '%s'\n" "$preload_libraries"
  fi
} >>"$data_dir/postgresql.conf"

server_start_attempted=1
PATH="$runtime/bin:$PATH" "$runtime/bin/pg_ctl" \
  start -D "$data_dir" -l "$server_log" -w >/dev/null
server_running=1
server_start_attempted=0

echo "running $sql_name upstream suites: $included_suites"
if [ -n "$excluded_suites" ]; then
  echo "documented non-PGXS suites excluded from this runner: $excluded_suites"
fi
PATH="$runtime/bin:$PATH" \
  PGHOST="$socket_dir" \
  PGPORT=5432 \
  make -C "$source_dir" \
    PG_CONFIG="$runtime/bin/pg_config" \
    installcheck

PATH="$runtime/bin:$PATH" "$runtime/bin/pg_ctl" \
  stop -D "$data_dir" -m fast -w >/dev/null
server_running=0

echo "$sql_name upstream PGXS installcheck passed at $source_commit"
