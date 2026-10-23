#!/usr/bin/env bash
set -euo pipefail

payload="$PWD/$1"
fixture="$PWD/$3"
runtime="$TEST_TMPDIR/runtime"
database="$TEST_TMPDIR/database"
consumer_bin="$TEST_TMPDIR/consumer/bin"
mkdir -p "$runtime" "$database" "$consumer_bin"
tar -xf "$payload" -C "$runtime"
# Relocation removes the compiled consumers' Bazel runfiles loader fallback.
cp "$PWD/$2" "$consumer_bin/runtime_smoke"
cp "$PWD/$4" "$consumer_bin/profile_smoke"
smoke="$consumer_bin/runtime_smoke"
profile_smoke="$consumer_bin/profile_smoke"
export LD_LIBRARY_PATH="$runtime/lib"
mv "$runtime/lib/liboliphaunt.so" "$runtime/lib/liboliphaunt.so.disabled"
missing_runtime_status=0
"$profile_smoke" > "$TEST_TMPDIR/missing-runtime.log" 2>&1 || missing_runtime_status=$?
mv "$runtime/lib/liboliphaunt.so.disabled" "$runtime/lib/liboliphaunt.so"
if [ "$missing_runtime_status" -ne 127 ]; then
  cat "$TEST_TMPDIR/missing-runtime.log" >&2
  echo 'consumer resolved liboliphaunt outside the candidate payload' >&2
  exit 1
fi
export OLIPHAUNT_STREAM_QUEUE_MAX_BYTES=4096
OLIPHAUNT_INTERNAL_SKIP_SYSTEM_COLLATION_DISCOVERY=1 OLIPHAUNT_INTERNAL_SKIP_ICU_DISCOVERY=1 \
  "$runtime/bin/initdb" -D "$database/pgdata" -U postgres --auth=trust --no-sync --locale-provider=libc --locale=C --encoding=UTF8
printf '%s\n' '{"schema":"oliphaunt-database-root-v1","engineFamily":"native","pgdata":"pgdata","postgresMajor":18,"physicalFormat":"native-pg18-v1"}' > "$database/.oliphaunt.json"
# Each process opens the same files: the second execution proves persistence.
"$smoke" "$database/pgdata" "$runtime" "$fixture"
"$smoke" "$database/pgdata" "$runtime" "$fixture"

icu_database="$TEST_TMPDIR/icu-database"
mkdir "$icu_database"
ICU_DATA="$runtime/share/icu" OLIPHAUNT_INTERNAL_SKIP_SYSTEM_COLLATION_DISCOVERY=1 \
  "$runtime/bin/initdb" -D "$icu_database/pgdata" -U postgres --auth=trust --no-sync --locale-provider=icu --icu-locale=en-US --encoding=UTF8
printf '%s\n' '{"schema":"oliphaunt-database-root-v1","engineFamily":"native","pgdata":"pgdata","postgresMajor":18,"physicalFormat":"native-pg18-v1"}' > "$icu_database/.oliphaunt.json"
for attempt in 1 2; do
  ICU_DATA=/ambient/unverified-icu "$profile_smoke" "$icu_database/pgdata" "$runtime" \
    "WITH ordered AS (SELECT item FROM (VALUES ('z'), ('a'), (chr(228))) AS input(item) ORDER BY item) SELECT CASE WHEN datlocprovider = 'i' AND datlocale = 'en-US' AND (SELECT string_agg(item, ',') FROM ordered) = 'a,' || chr(228) || ',z' THEN 'BAZEL_ICU_OK' ELSE 'BAZEL_ICU_MISMATCH' END FROM pg_database WHERE datname = current_database()" BAZEL_ICU_OK
done
