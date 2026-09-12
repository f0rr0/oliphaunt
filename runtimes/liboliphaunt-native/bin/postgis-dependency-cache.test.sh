#!/usr/bin/env bash
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/postgis-dependency-cache.sh"
fixture="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-postgis-cache.XXXXXX")"
trap 'rm -rf "$fixture"' EXIT
deps="$fixture/dependencies"
build="$fixture/build"
fingerprint="$(printf 'a%.0s' {1..64})"
new_fingerprint="$(printf 'b%.0s' {1..64})"
archive="$deps/archive.a"

populate() {
  mkdir -p "$deps" "$build"
  printf library > "$archive"
  printf object > "$build/object.o"
}

# Reusing a complete cache does not revoke it. A caller interrupted after
# preparation must leave the same verified libraries available to the next run.
populate
oliphaunt_postgis_dependency_cache_commit "$deps" "$fingerprint" "$archive"
oliphaunt_postgis_dependency_cache_prepare "$deps" "$fingerprint" "$build"
test "$(cat "$archive")" = library
test "$(cat "$build/object.o")" = object
oliphaunt_postgis_dependency_cache_prepare "$deps" "$fingerprint" "$build"
test "$(cat "$archive")" = library
test "$(cat "$build/object.o")" = object
oliphaunt_postgis_dependency_cache_is_complete "$deps" "$fingerprint"

# Toolchain changes and changed output bytes both invalidate installed and build trees.
for change in fingerprint bytes; do
  populate
  oliphaunt_postgis_dependency_cache_commit "$deps" "$fingerprint" "$archive"
  wanted="$fingerprint"
  if [ "$change" = fingerprint ]; then wanted="$new_fingerprint"; else printf corrupt > "$archive"; fi
  oliphaunt_postgis_dependency_cache_prepare "$deps" "$wanted" "$build"
  test ! -e "$archive"
  test ! -e "$build"
done

# Empty outputs cannot commit a repair; an interrupted repair cannot be reused.
populate
: > "$archive"
if oliphaunt_postgis_dependency_cache_commit "$deps" "$fingerprint" "$archive"; then exit 1; fi
printf partial > "$archive"
oliphaunt_postgis_dependency_cache_prepare "$deps" "$fingerprint" "$build"
test ! -e "$archive"

# Invalid inputs must fail without deleting existing output.
populate
if oliphaunt_postgis_dependency_cache_prepare "$deps" invalid "$build"; then exit 1; fi
if oliphaunt_postgis_dependency_cache_prepare / "$fingerprint" "$build"; then exit 1; fi
test "$(cat "$archive")" = library
test "$(cat "$build/object.o")" = object
printf 'PostGIS dependency cache checks passed\n'
