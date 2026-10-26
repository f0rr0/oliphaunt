#!/usr/bin/env bash
set -euo pipefail

carrier="$TEST_TMPDIR/host"
runtime="$carrier/$8"
library="$carrier/$9"
consumer="$TEST_TMPDIR/consumer/bin/extension-smoke"
install="$PWD/$3"
smoke="$PWD/$4"
startup="$PWD/$5"
environment="$PWD/$6"
dependencies="$PWD/$7"
# Match a returned row, rather than a failed statement echo containing its SQL.
server_success_row='?column? = "candidate-extension-smoke-ok"'
mkdir -p "$carrier" "${consumer%/*}"
cp "$PWD/$2" "$consumer"
tar -xf "$PWD/$1" -C "$carrier"
test -d "$runtime"
test -f "$library/liboliphaunt.so"
runtime=$(cd "$runtime" && pwd -P)
library=$(cd "$library" && pwd -P)
shift 9
for member in "$@"; do
  tar -xzf "$PWD/$member" -C "$runtime" --exclude=extension.json
done
if [[ "$library" != "$runtime/lib" && -d "$runtime/lib/modules" ]]; then
  mkdir -p "$library/modules"
  cp -a "$runtime/lib/modules/." "$library/modules/"
  rm -rf "$runtime/lib/modules"
fi
while IFS=$'\t' read -r name relative required_file; do
  [[ -z "$name" ]] && continue
  test -f "$runtime/$relative/$required_file"
  export "$name=$runtime/$relative"
done < "$environment"
export LD_LIBRARY_PATH="$library:$runtime/lib"
mv "$library/liboliphaunt.so" "$library/liboliphaunt.so.hidden"
set +e
"$consumer" > "$TEST_TMPDIR/missing-library.log" 2>&1
status=$?
set -e
mv "$library/liboliphaunt.so.hidden" "$library/liboliphaunt.so"
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

server_sql() {
  # Stand-alone PostgreSQL returns zero after SQL errors. A transaction prevents
  # later statements from printing the success sentinel after any earlier error.
  { printf 'BEGIN;\n\n'; cat "$install" "$smoke"; printf '\nCOMMIT;\n\n'; } | sed 's/^-- oliphaunt-statement$//'
}

startup_args=()
while IFS= read -r assignment; do
  [[ -z "$assignment" ]] || startup_args+=(-c "$assignment")
done < "$startup"

while IFS= read -r name; do
  [[ -z "$name" ]] && continue
  for profile in postgresql modules; do
    directory="$runtime/lib/postgresql"
    [[ "$profile" == modules ]] && directory="$library/modules"
    mv "$directory/$name" "$directory/$name.hidden"
    database="$TEST_TMPDIR/missing-dependency-$profile-$name"
    initialize "$database"
    set +e
    if [[ "$profile" == modules ]]; then
      "$consumer" "$database/pgdata" "$runtime" --sql-plan "$install" "$smoke" "$startup" > "$database/consumer.log" 2>&1
    else
      server_sql | "$runtime/bin/postgres" --single -j -D "$database/pgdata" "${startup_args[@]}" postgres > "$database/consumer.log" 2>&1
    fi
    status=$?
    set -e
    mv "$directory/$name.hidden" "$directory/$name"
    response=$(<"$database/consumer.log")
    stem=${name%.*}
    if [[ ( "$response" != *"$name"* && "$response" != *"\"$stem\""* ) ||
      ( "$profile" == modules && "$status" == 0 ) ||
      ( "$profile" == postgresql && ( ( "$response" != *ERROR:* && "$response" != *FATAL:* ) || "$response" == *"$server_success_row"* ) ) ]]; then
      printf 'relocated %s consumer did not reject missing candidate dependency %s (status %s)\n%s\n' "$profile" "$name" "$status" "$response" >&2
      exit 1
    fi
  done
done < "$dependencies"

database="$TEST_TMPDIR/embedded"
initialize "$database"
"$consumer" "$database/pgdata" "$runtime" --sql-plan "$install" "$smoke" "$startup"
"$consumer" "$database/pgdata" "$runtime" --sql-plan "$install" "$smoke" "$startup"

database="$TEST_TMPDIR/server"
initialize "$database"
log="$TEST_TMPDIR/server.log"
server_sql | "$runtime/bin/postgres" --single -j -D "$database/pgdata" "${startup_args[@]}" postgres > "$log" 2>&1
response=$(<"$log")
if [[ "$response" != *"$server_success_row"* || "$response" == *ERROR:* || "$response" == *FATAL:* || "$response" == *"not ok"* ]]; then
  printf '%s\n' "$response" >&2
  exit 1
fi
