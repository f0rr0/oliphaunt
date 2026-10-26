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
dependency_smoke="$TEST_TMPDIR/dependency-load.sql"
full_smoke="$TEST_TMPDIR/catalog-smoke.sql"
module_paths="$TEST_TMPDIR/candidate-modules.txt"
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
# Load PostgreSQL roots declared by the candidate controls and their current
# activation SQL. Support libraries must fail through those roots.
: > "$module_paths"
for member in "$@"; do
  member_files=$(tar -xzvf "$PWD/$member" -C "$runtime" --exclude=extension.json)
  while IFS= read -r control; do
    case "$control" in
      share/postgresql/extension/*.control)
        module=$(awk -F "'" '/^[[:space:]]*module_pathname[[:space:]]*=/ { print $2 }' "$runtime/$control")
        default_version=$(awk -F "'" '/^[[:space:]]*default_version[[:space:]]*=/ { print $2 }' "$runtime/$control")
        printf '%s\n' "$module" > "$TEST_TMPDIR/control-modules"
        sql="${control%.control}--$default_version.sql"
        if [[ -n "$default_version" ]] && grep -Fxq "$sql" <<< "$member_files"; then
          # Match the conventional C-function AS 'library', 'symbol' form,
          # including declarations split across lines. Never scan old versions.
          awk -F "'" 'BEGIN { RS = ";" }
            { for (i = 2; i < NF; i++)
                if ($(i-1) ~ /(^|[^[:alnum:]_])[Aa][Ss][[:space:]]*$/ &&
                    $(i+1) ~ /^[[:space:]]*,[[:space:]]*$/) print $i
            }' "$runtime/$sql" >> "$TEST_TMPDIR/control-modules"
        fi
        while IFS= read -r candidate; do
          [[ -z "$candidate" ]] && continue
          [[ "${candidate^^}" == MODULE_PATHNAME ]] && candidate="$module"
          stem=${candidate#\$libdir/}
          if [[ "$stem" == "$candidate" || ! "$stem" =~ ^[A-Za-z_][A-Za-z0-9_.-]*$ ]]; then
            printf 'candidate SQL/control declares an unsupported module path: %s\n' "$control" >&2
            exit 1
          fi
          [[ "$candidate" == *.so ]] || candidate+=.so
          grep -Fxq "lib/postgresql/${candidate#\$libdir/}" <<< "$member_files"
          printf '%s\n' "$candidate" >> "$module_paths"
        done < "$TEST_TMPDIR/control-modules"
        ;;
    esac
  done <<< "$member_files"
done
sort -u "$module_paths" -o "$module_paths"
: > "$dependency_smoke"
while IFS= read -r module; do
  printf "LOAD '%s';\n-- oliphaunt-statement\n" "$module" >> "$dependency_smoke"
done < "$module_paths"
cat "$dependency_smoke" "$smoke" > "$full_smoke"
printf "SELECT 'candidate-extension-smoke-ok';\n" >> "$dependency_smoke"
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
  { printf 'BEGIN;\n\n'; cat "$install" "${1:-$full_smoke}"; printf '\nCOMMIT;\n\n'; } | sed 's/^-- oliphaunt-statement$//'
}

startup_args=()
while IFS= read -r assignment; do
  [[ -z "$assignment" ]] || startup_args+=(-c "$assignment")
done < "$startup"

dependency_probe() {
  local profile="$1" database="$2"
  if [[ "$profile" == modules ]]; then
    "$consumer" "$database/pgdata" "$runtime" --sql-plan "$install" "$dependency_smoke" "$startup"
  else
    server_sql "$dependency_smoke" | "$runtime/bin/postgres" --single -j -D "$database/pgdata" "${startup_args[@]}" postgres
  fi
}

database="$TEST_TMPDIR/embedded"
initialize "$database"
"$consumer" "$database/pgdata" "$runtime" --sql-plan "$install" "$full_smoke" "$startup"
"$consumer" "$database/pgdata" "$runtime" --sql-plan "$install" "$full_smoke" "$startup"

database="$TEST_TMPDIR/server"
initialize "$database"
log="$TEST_TMPDIR/server.log"
server_sql | "$runtime/bin/postgres" --single -j -D "$database/pgdata" "${startup_args[@]}" postgres > "$log" 2>&1
response=$(<"$log")
if [[ "$response" != *"$server_success_row"* || "$response" == *ERROR:* || "$response" == *FATAL:* || "$response" == *"not ok"* ]]; then
  printf '%s\n' "$response" >&2
  exit 1
fi

while IFS= read -r name; do
  [[ -z "$name" ]] && continue
  for profile in postgresql modules; do
    directory="$runtime/lib/postgresql"
    [[ "$profile" == modules ]] && directory="$library/modules"
    mv "$directory/$name" "$directory/$name.hidden"
    database="$TEST_TMPDIR/missing-dependency-$profile-$name"
    initialize "$database"
    log="$TEST_TMPDIR/missing-dependency-$profile-$name.log"
    set +e
    dependency_probe "$profile" "$database" > "$log" 2>&1
    status=$?
    set -e
    mv "$directory/$name.hidden" "$directory/$name"
    response=$(<"$log")
    missing_dependency=false
    filename_pattern="(^|[\"/[:space:]])${name//./\\.}([\":[:space:]]|$)"
    while IFS= read -r line; do
      case "$line" in
        *'could not access file '*) diagnostic=${line#*'could not access file '} ;;
        *'could not load library '*) diagnostic=${line#*'could not load library '} ;;
        *) continue ;;
      esac
      if [[ "$diagnostic" =~ $filename_pattern && "$diagnostic" == *'No such file or directory'* ]]; then
        missing_dependency=true
      fi
    done < "$log"
    if [[ "$missing_dependency" != true ||
      ( "$profile" == modules && "$status" != 1 ) ||
      ( "$profile" == postgresql && "$status" != 0 && "$status" != 1 ) ||
      ( "$profile" == postgresql && ( ( "$response" != *ERROR:* && "$response" != *FATAL:* ) || "$response" == *"$server_success_row"* ) ) ]]; then
      printf 'relocated %s consumer did not reject missing candidate dependency %s (status %s)\n%s\n' "$profile" "$name" "$status" "$response" >&2
      exit 1
    fi
  done
done < "$dependencies"
