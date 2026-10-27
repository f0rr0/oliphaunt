#!/usr/bin/env bash
set -euo pipefail

runtime="$TEST_TMPDIR/runtime"
smoke="$TEST_TMPDIR/consumer/bin/extension-smoke"
versions=("$3" "$4" "$5")
mkdir -p "$runtime" "${smoke%/*}"
cp "$PWD/$2" "$smoke"
tar -xf "$PWD/$1" -C "$runtime"
shift 5
for member in "$@"; do
  tar -xzf "$PWD/$member" -C "$runtime" --exclude=extension.json
done
export LD_LIBRARY_PATH="$runtime/lib"
# Relocation removes the consumer's source-runfiles RUNPATH fallback. Prove the
# actual candidate shared library is necessary before any positive SQL test.
mv "$runtime/lib/liboliphaunt.so" "$runtime/lib/liboliphaunt.so.hidden"
set +e
"$smoke" > "$TEST_TMPDIR/missing-library.log" 2>&1
status=$?
set -e
mv "$runtime/lib/liboliphaunt.so.hidden" "$runtime/lib/liboliphaunt.so"
if [[ "$status" != 127 ]]; then
  printf 'relocated consumer accepted a missing candidate library (status %s)\n' "$status" >&2
  exit 1
fi

initialize() {
  local database="$1"
  mkdir -p "$database"
  OLIPHAUNT_INTERNAL_SKIP_SYSTEM_COLLATION_DISCOVERY=1 OLIPHAUNT_INTERNAL_SKIP_ICU_DISCOVERY=1 \
    "$runtime/bin/initdb" -D "$database/pgdata" -U postgres --auth=trust --no-sync --locale-provider=libc --locale=C --encoding=UTF8
  printf '%s\n' '{"schema":"oliphaunt-database-root-v1","engineFamily":"native","pgdata":"pgdata","postgresMajor":18,"physicalFormat":"native-pg18-v1"}' > "$database/.oliphaunt.json"
}

database="$TEST_TMPDIR/embedded"
initialize "$database"
# Fresh installation and a new process reopening the persisted extensions.
"$smoke" "$database/pgdata" "$runtime" "${versions[@]}"
"$smoke" "$database/pgdata" "$runtime" "${versions[@]}"

# Independently exercise the ordinary PostgreSQL ABI variants from the same
# archive. Single-user mode avoids an ambient pg_ctl or workstation server.
database="$TEST_TMPDIR/server"
initialize "$database"
log="$TEST_TMPDIR/server.log"
"$runtime/bin/postgres" --single -D "$database/pgdata" postgres > "$log" 2>&1 <<'SQL'
CREATE EXTENSION pg_trgm;
CREATE EXTENSION vector;
CREATE EXTENSION pgtap;
SELECT 'server-extensions-ok' WHERE similarity('same', 'same') = 1 AND ('[1,2,3]'::vector <-> '[1,2,4]'::vector) = 1;
SELECT plan(1);
SELECT ok(similarity('same', 'same') = 1, 'server contrib');
SELECT count(*) FROM finish();
SQL
response=$(<"$log")
if [[ "$response" != *server-extensions-ok* || "$response" != *"ok 1 - server contrib"* || "$response" == *ERROR:* || "$response" == *FATAL:* ]]; then
  printf '%s\n' "$response" >&2
  exit 1
fi
