#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null)" || {
  echo "pg_textsearch-qualification: unable to determine the repository root" >&2
  exit 1
}

fail() {
  echo "pg_textsearch-qualification: $*" >&2
  exit 1
}

require_file() {
  if [ ! -f "$1" ] || [ -L "$1" ]; then
    fail "missing regular $2 at $1"
  fi
}

source_runtime="${1:?usage: qualify.sh NATIVE_RUNTIME}"
manifest="$script_dir/upgrade/source.toml"
source_name="$(bun -e 'console.log(Bun.TOML.parse(await Bun.file(process.argv[1]).text()).name)' "$manifest")"
old_commit="$(bun -e 'console.log(Bun.TOML.parse(await Bun.file(process.argv[1]).text()).commit)' "$manifest")"
old_version="$(bun -e 'console.log(Bun.TOML.parse(await Bun.file(process.argv[1]).text())["extension-control"]["default-version"])' "$manifest")"
source_control_path=pg_textsearch.control
[ -n "$source_runtime" ] || fail "the qualification plan must provide the current native runtime"
source_runtime="$(cd "$source_runtime" 2>/dev/null && pwd)" || fail "current native runtime is not a directory: $source_runtime"
export ICU_DATA="$(dirname "$source_runtime")/icu/share/icu"

for command_name in awk cat cmp cp find git grep install make mktemp rm rsync; do
  command -v "$command_name" >/dev/null 2>&1 || fail "missing required command: $command_name"
done
for tool in initdb pg_config pg_ctl pg_dump postgres psql; do
  require_file "$source_runtime/bin/$tool" "current runtime tool $tool"
done
require_file "$source_runtime/lib/postgresql/pg_textsearch.so" "current pg_textsearch module"
require_file "$source_runtime/share/postgresql/extension/pg_textsearch.control" "current pg_textsearch control file"
current_version="$(awk -F"'" '/^[[:space:]]*default_version[[:space:]]*=/ { print $2 }' \
  "$source_runtime/share/postgresql/extension/pg_textsearch.control")"
[ -n "$current_version" ] || fail "current runtime pg_textsearch control file has no default_version"

current_sql_files=("$source_runtime"/share/postgresql/extension/pg_textsearch--*.sql)
[ -e "${current_sql_files[0]}" ] || fail "current runtime has no pg_textsearch SQL files"
if ! grep -Eq "^[[:space:]]*default_version[[:space:]]*=[[:space:]]*'$current_version'[[:space:]]*$" \
  "$source_runtime/share/postgresql/extension/pg_textsearch.control"; then
  fail "current runtime pg_textsearch control file does not declare $current_version"
fi

checkout="$root/target/oliphaunt-sources/checkouts/$source_name"
if [ ! -d "$checkout" ] || [ -L "$checkout" ] || [ ! -d "$checkout/.git" ] || [ -L "$checkout/.git" ]; then
  fail "missing verified pg_textsearch $old_version source checkout; run the source-fetch-extensions dependency"
fi
actual_old_commit="$(git -C "$checkout" rev-parse --verify 'HEAD^{commit}')"
[ "$actual_old_commit" = "$old_commit" ] || \
  fail "pg_textsearch $old_version checkout is at $actual_old_commit, expected $old_commit"
[ -z "$(git -C "$checkout" status --porcelain=v1 --untracked-files=all)" ] || \
  fail "pg_textsearch $old_version checkout must be clean"
require_file "$checkout/$source_control_path" "pinned pg_textsearch control file"
checkout_old_version="$(awk -F"'" '/^[[:space:]]*default_version[[:space:]]*=/ { print $2 }' \
  "$checkout/$source_control_path")"
[ "$checkout_old_version" = "$old_version" ] || \
  fail "upgrade manifest declares $old_version but the pinned source control declares $checkout_old_version"

work_parent="$root/target/pg-textsearch-upgrade"
mkdir -p "$work_parent"
if [ ! -d "$work_parent" ] || [ -L "$work_parent" ]; then
  fail "upgrade work parent must be a real directory: $work_parent"
fi
work_root="$(mktemp -d "$work_parent/run.XXXXXX")"
old_source="$work_root/old-source"
current_source="$work_root/current-source"
runtime="$work_root/runtime"
data_dir="$work_root/data"
socket_dir="$(mktemp -d /tmp/oliphaunt-textsearch-upgrade.XXXXXX)"
server_log="$work_root/postgres.log"
preserved_log="$work_parent/postgres.log"
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
      echo "pg_textsearch-qualification: could not confirm server shutdown; preserving $work_root" >&2
    fi
  fi
  if [ "$status" -ne 0 ] && [ -f "$server_log" ]; then
    cp "$server_log" "$preserved_log" 2>/dev/null || true
    echo "pg_textsearch-qualification: preserved failing server log at $preserved_log" >&2
  fi
  if [ "$status" -ne 0 ] && [ -f "$current_source/test/regression.diffs" ]; then
    cat "$current_source/test/regression.diffs" >&2
    cp "$current_source/test/regression.diffs" "$work_parent/regression.diffs"
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

current_checkout="$root/target/oliphaunt-sources/checkouts/pg_textsearch"
current_commit="$(bun -e 'console.log(Bun.TOML.parse(await Bun.file(process.argv[1]).text()).commit)' "$script_dir/../source.toml")"
[ -d "$current_checkout/.git" ] && [ ! -L "$current_checkout" ] || fail "missing current source checkout"
[ "$(git -C "$current_checkout" rev-parse HEAD)" = "$current_commit" ] || fail "current source pin differs"
[ -z "$(git -C "$current_checkout" status --porcelain=v1 --untracked-files=all)" ] || fail "current source checkout must be clean"
cmp "$current_checkout/pg_textsearch.control" "$source_runtime/share/postgresql/extension/pg_textsearch.control" || \
  fail "installed control file differs from the pinned upstream source"
rsync -a --delete --exclude .git/ "$current_checkout/" "$current_source/"

rsync -a --delete --exclude .git/ "$checkout/" "$old_source/"
PATH="$source_runtime/bin:$PATH" make -C "$old_source" PG_CONFIG="$source_runtime/bin/pg_config" -j2
require_file "$old_source/pg_textsearch.so" "built pg_textsearch $old_version module"

rsync -a --delete "$source_runtime/" "$runtime/"
extension_dir="$runtime/share/postgresql/extension"
module="$runtime/lib/postgresql/pg_textsearch.so"
find "$extension_dir" -maxdepth 1 -type f -name 'pg_textsearch--*.sql' -delete
install -m 0755 "$old_source/pg_textsearch.so" "$module"
install -m 0644 "$old_source/$source_control_path" "$extension_dir/pg_textsearch.control"
old_sql_files=("$old_source"/sql/pg_textsearch--*.sql)
[ -e "${old_sql_files[0]}" ] || fail "pinned pg_textsearch $old_version source has no SQL files"
install -m 0644 "${old_sql_files[@]}" "$extension_dir/"

mkdir -p "$socket_dir"
PATH="$runtime/bin:$PATH" "$runtime/bin/initdb" -D "$data_dir" --auth-local=trust --auth-host=reject --locale=C.UTF-8 --encoding=UTF8 >/dev/null
if [[ "$socket_dir" == *"'"* ]]; then
  fail "upgrade socket path must not contain a single quote"
fi
cat >>"$data_dir/postgresql.conf" <<EOF
listen_addresses = ''
unix_socket_directories = '$socket_dir'
fsync = off
full_page_writes = off
shared_preload_libraries = 'pg_textsearch'
EOF

start_server() {
  server_start_attempted=1
  PATH="$runtime/bin:$PATH" "$runtime/bin/pg_ctl" start -D "$data_dir" -l "$server_log" -w >/dev/null
  server_running=1
  server_start_attempted=0
}

stop_server() {
  PATH="$runtime/bin:$PATH" "$runtime/bin/pg_ctl" stop -D "$data_dir" -m fast -w >/dev/null
  server_running=0
  server_start_attempted=0
}

psql_db() {
  PATH="$runtime/bin:$PATH" "$runtime/bin/psql" -X -v ON_ERROR_STOP=1 -h "$socket_dir" -d "$1" "${@:2}"
}

start_server
psql_db postgres -c 'CREATE DATABASE pg_textsearch_upgrade' >/dev/null
psql_db pg_textsearch_upgrade -v old_version="$old_version" <<'SQL'
CREATE EXTENSION pg_textsearch VERSION :'old_version';
CREATE TABLE upgrade_docs(id integer PRIMARY KEY, body text NOT NULL);
INSERT INTO upgrade_docs
SELECT id,
       CASE
         WHEN id = 1 THEN 'postgres database postgres database query migration'
         WHEN id = 3 THEN 'legacyalpha legacyalpha persisted posting'
         WHEN id = 4 THEN 'deletionproof deletionproof persisted posting'
         WHEN id = 5 THEN 'legacybeta legacybeta persisted posting'
         WHEN id = 6 THEN 'deletionproof surviving persisted posting'
         WHEN id % 2 = 0 THEN 'postgres database guide'
         ELSE 'unrelated document about wildlife'
       END
FROM generate_series(1, 256) AS id;
CREATE INDEX upgrade_docs_bm25 ON upgrade_docs USING bm25(body)
  WITH (text_config = 'english');
SELECT bm25_spill_index('upgrade_docs_bm25');
DO $$
DECLARE top_id integer;
BEGIN
  SELECT id INTO top_id
  FROM upgrade_docs
  ORDER BY body <@> to_bm25query('postgres database', 'upgrade_docs_bm25')
  LIMIT 1;
  IF top_id IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'old pg_textsearch query returned unexpected top id %', top_id;
  END IF;
END $$;
SQL
stop_server

find "$extension_dir" -maxdepth 1 -type f -name 'pg_textsearch--*.sql' -delete
install -m 0755 "$source_runtime/lib/postgresql/pg_textsearch.so" "$module"
install -m 0644 "$source_runtime/share/postgresql/extension/pg_textsearch.control" "$extension_dir/pg_textsearch.control"
install -m 0644 "${current_sql_files[@]}" "$extension_dir/"

start_server
psql_db pg_textsearch_upgrade <<'SQL'
DO $$
DECLARE top_id integer;
BEGIN
  SELECT id INTO top_id
  FROM upgrade_docs
  ORDER BY body <@> to_bm25query('postgres database', 'upgrade_docs_bm25')
  LIMIT 1;
  IF top_id IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'pre-upgrade query with the current library returned unexpected top id %', top_id;
  END IF;
END $$;
ALTER EXTENSION pg_textsearch UPDATE;
INSERT INTO upgrade_docs VALUES
  (1000, 'upgrade sentinel upgrade sentinel upgrade sentinel migration proof');
UPDATE upgrade_docs
SET body = 'mutationproof mutationproof updated persisted row'
WHERE id = 2;
DELETE FROM upgrade_docs WHERE id = 4;
SELECT bm25_force_merge('upgrade_docs_bm25');
SQL

assert_upgraded_state() {
  local database="$1"
  local installed_version
  psql_db "$database" <<'SQL'
DO $$
DECLARE
  actual_body text;
  actual_count bigint;
  top_id integer;
  probe record;
BEGIN
  SELECT count(*) INTO actual_count FROM upgrade_docs;
  IF actual_count IS DISTINCT FROM 256 THEN
    RAISE EXCEPTION 'upgraded table contains % rows, expected 256', actual_count;
  END IF;

  SELECT body INTO actual_body FROM upgrade_docs WHERE id = 2;
  IF actual_body IS DISTINCT FROM 'mutationproof mutationproof updated persisted row' THEN
    RAISE EXCEPTION 'updated row 2 has unexpected body %', actual_body;
  END IF;
  IF EXISTS (SELECT 1 FROM upgrade_docs WHERE id = 4) THEN
    RAISE EXCEPTION 'deleted row 4 is still visible';
  END IF;

  FOR probe IN SELECT * FROM (VALUES
    ('postgres database', 1), ('legacyalpha', 3), ('legacybeta', 5),
    ('mutationproof', 2), ('upgrade sentinel', 1000), ('deletionproof', 6)
  ) AS expected(term, id)
  LOOP
    SELECT id INTO top_id
    FROM upgrade_docs
    ORDER BY body <@> to_bm25query(probe.term, 'upgrade_docs_bm25')
    LIMIT 1;
    IF top_id IS DISTINCT FROM probe.id THEN
      RAISE EXCEPTION 'upgraded query % returned id %, expected %', probe.term, top_id, probe.id;
    END IF;
  END LOOP;
END $$;
SQL
  installed_version="$(psql_db "$database" -Atc \
    "SELECT extversion FROM pg_extension WHERE extname = 'pg_textsearch'")"
  [ "$installed_version" = "$current_version" ] || \
    fail "$database pg_textsearch version is $installed_version, expected $current_version"
}

assert_upgraded_state pg_textsearch_upgrade
stop_server
start_server
assert_upgraded_state pg_textsearch_upgrade

PATH="$runtime/bin:$PATH" "$runtime/bin/pg_dump" \
  -h "$socket_dir" --format=plain --no-owner --no-privileges \
  -d pg_textsearch_upgrade >"$work_root/upgrade.sql"
psql_db postgres -c 'CREATE DATABASE pg_textsearch_upgrade_restore' >/dev/null
psql_db pg_textsearch_upgrade_restore -f "$work_root/upgrade.sql" >/dev/null
assert_upgraded_state pg_textsearch_upgrade_restore

echo "pg_textsearch upgrade qualification passed: $old_version ($old_commit) -> $current_version"

# PGXS owns REGRESS and installcheck prerequisites, including upstream C tests.
PATH="$runtime/bin:$PATH" PGHOST="$socket_dir" PGPORT=5432 \
  make -C "$current_source" PG_CONFIG="$source_runtime/bin/pg_config" installcheck
stop_server
echo "pg_textsearch upstream PGXS installcheck passed at $current_commit"
