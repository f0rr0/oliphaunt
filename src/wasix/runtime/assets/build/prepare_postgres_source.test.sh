#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
git -C "$fixture" init -q
build="$fixture/src/wasix/runtime/assets/build"
mkdir -p "$build/wasix_shim" "$fixture/tools/dev" \
  "$fixture/src/third-party/postgres" "$fixture/src/wasix/runtime/postgres" \
  "$fixture/archive/postgresql-18.4/src/include/port/wasix-dl" "$fixture/cache"
cp "$script_dir/prepare_postgres_source.sh" "$script_dir/wasix_third_party.sh" "$script_dir/source_lane.sh" "$build/"
: > "$fixture/tools/dev/acquisition.sh"
printf 'oliphaunt_fetch_postgresql_source_archive() { :; }\n' > "$fixture/src/third-party/postgres/fetch-source.sh"
printf 'exit 0\n' > "$fixture/src/third-party/postgres/apply-series.sh"
printf 'contract-v1\n' > "$build/wasix_shim/oliphaunt_wasix_protocol_contract.generated.h"
printf 'src/wasix/runtime/assets/build/wasix_shim/oliphaunt_wasix_protocol_contract.generated.h\n' > "$fixture/src/wasix/runtime/postgres/source-inputs"
: > "$fixture/src/wasix/runtime/postgres/series"
tar -cjf "$fixture/cache/postgresql-18.4.tar.bz2" -C "$fixture/archive" postgresql-18.4
archive_sha="$(shasum -a 256 "$fixture/cache/postgresql-18.4.tar.bz2" | awk '{print $1}')"
printf 'version = "18.4"\nurl = "https://example.invalid/postgresql.tar.bz2"\nsha256 = "%s"\n' "$archive_sha" > "$fixture/src/third-party/postgres/source.toml"
export SOURCE_CACHE="$fixture/cache" OLIPHAUNT_WASM_GENERATED_ROOT="$fixture/generated"
prepared="$(bash "$build/prepare_postgres_source.sh")"
header="$prepared/src/include/port/wasix-dl/oliphaunt_wasix_protocol_contract.generated.h"
ln "$header" "$fixture/original-header"

# Extension and tools producers prepare the same already-built source in parallel.
# A valid cache must preserve the shared header inode, not unlink and replace it.
pids=()
for index in {1..8}; do
  bash "$build/prepare_postgres_source.sh" > "$fixture/result-$index" &
  pids+=("$!")
done
for pid in "${pids[@]}"; do wait "$pid"; done
for index in {1..8}; do
  [ "$(cat "$fixture/result-$index")" = "$prepared" ]
done
[[ "$header" -ef "$fixture/original-header" ]]
cmp "$header" "$build/wasix_shim/oliphaunt_wasix_protocol_contract.generated.h"

# An invalid cached header must be repaired even when its input receipt matches.
printf 'corrupt\n' > "$header"
[ "$(bash "$build/prepare_postgres_source.sh")" = "$prepared" ]
cmp "$header" "$build/wasix_shim/oliphaunt_wasix_protocol_contract.generated.h"

# A changed generated contract invalidates the source fingerprint as before.
printf 'contract-v2\n' > "$build/wasix_shim/oliphaunt_wasix_protocol_contract.generated.h"
[ "$(bash "$build/prepare_postgres_source.sh")" = "$prepared" ]
cmp "$header" "$build/wasix_shim/oliphaunt_wasix_protocol_contract.generated.h"

# Preserve preparation failures instead of reporting an empty path as outside
# the Docker mount (the misleading secondary diagnostic in the hosted failure).
printf 'corrupt archive\n' > "$fixture/cache/postgresql-18.4.tar.bz2"
if ROOT="$build" REPO_ROOT="$fixture" bash -c \
  'source "$ROOT/source_lane.sh"; oliphaunt_wasix_prepare_source_for_docker stable' \
  > "$fixture/failure-path" 2> "$fixture/failure-log"; then
  exit 1
fi
grep -q 'checksum mismatch' "$fixture/failure-log"
! grep -q 'outside repo mount' "$fixture/failure-log"
[ ! -s "$fixture/failure-path" ]
printf 'Concurrent cached PostgreSQL source preparation and header repair passed.\n'
