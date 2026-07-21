#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$ROOT/wasix_third_party.sh"

REPO_ROOT="$(oliphaunt_wasix_repo_root "$ROOT")"
GEOS_SOURCE_DIR="${GEOS_SOURCE_DIR:-$REPO_ROOT/target/oliphaunt-sources/checkouts/geos}"
GENERATED_ROOT="$(oliphaunt_wasix_generated_root "$REPO_ROOT")"
GEOS_PREFIX="${GEOS_PREFIX:-$GENERATED_ROOT/work/geos-wasix}"
GEOS_BUILD_DIR="${GEOS_BUILD_DIR:-$GENERATED_ROOT/work/geos-wasix-build}"
JOBS="${JOBS:-4}"

if [ ! -f "$GEOS_SOURCE_DIR/CMakeLists.txt" ]; then
  echo "missing GEOS source checkout at $GEOS_SOURCE_DIR; run assets fetch/source-spine first" >&2
  exit 1
fi

. "$ROOT/docker_wasix_env.sh"
. "$ROOT/profile_flags.sh"
oliphaunt_wasix_apply_wasix_profile build

source_commit="$(oliphaunt_wasix_source_commit "$GEOS_SOURCE_DIR")"
script_sha256="$(oliphaunt_wasix_script_sha256 "$0")"
helper_sha256="$(oliphaunt_wasix_script_sha256 "$ROOT/wasix_third_party.sh")"
wasixcc_version="$(wasixcc --version 2>/dev/null)"
wasixcc_version="${wasixcc_version%%$'\n'*}"
stamp="source=$source_commit
script=$script_sha256
helper=$helper_sha256
profile=$(oliphaunt_wasix_wasix_profile_signature)
wasixcc=$wasixcc_version
cmake=static-libs-only-no-tests"

if [ -f "$GEOS_PREFIX/.oliphaunt-wasix-geos-build" ] &&
   [ -f "$GEOS_PREFIX/include/geos_c.h" ] &&
   [ -f "$GEOS_PREFIX/lib/libgeos_c.a" ] &&
   [ -f "$GEOS_PREFIX/lib/libgeos.a" ] &&
   [ "$(cat "$GEOS_PREFIX/.oliphaunt-wasix-geos-build")" = "$stamp" ]; then
  echo "$GEOS_PREFIX"
  exit 0
fi

{
  rm -rf "$GEOS_BUILD_DIR" "$GEOS_PREFIX"
  mkdir -p "$GEOS_BUILD_DIR" "$(dirname "$GEOS_PREFIX")"
  oliphaunt_wasix_static_cmake_build \
    "$GEOS_SOURCE_DIR" \
    "$GEOS_BUILD_DIR" \
    "$GEOS_PREFIX" \
    -DBUILD_TESTING=OFF \
    -DBUILD_BENCHMARKS=OFF \
    -DBUILD_GEOSOP=OFF \
    -DGEOS_BUILD_DEVELOPER=OFF
} >&2

test -f "$GEOS_PREFIX/include/geos_c.h"
test -f "$GEOS_PREFIX/lib/libgeos_c.a"
test -f "$GEOS_PREFIX/lib/libgeos.a"
printf '%s\n' "$stamp" > "$GEOS_PREFIX/.oliphaunt-wasix-geos-build"
echo "$GEOS_PREFIX"
