#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$ROOT/wasix_third_party.sh"

REPO_ROOT="$(oliphaunt_wasix_repo_root "$ROOT")"
LIBXML2_SOURCE_DIR="${LIBXML2_SOURCE_DIR:-$REPO_ROOT/target/oliphaunt-sources/checkouts/libxml2}"
GENERATED_ROOT="$(oliphaunt_wasix_generated_root "$REPO_ROOT")"
LIBXML2_PREFIX="${LIBXML2_PREFIX:-$GENERATED_ROOT/work/libxml2-wasix}"
LIBXML2_BUILD_DIR="${LIBXML2_BUILD_DIR:-$GENERATED_ROOT/work/libxml2-wasix-build}"
JOBS="${JOBS:-4}"

if [ ! -f "$LIBXML2_SOURCE_DIR/CMakeLists.txt" ]; then
  echo "missing libxml2 source checkout at $LIBXML2_SOURCE_DIR; run assets fetch/source-spine first" >&2
  exit 1
fi

. "$ROOT/docker_wasix_env.sh"
. "$ROOT/profile_flags.sh"
oliphaunt_wasix_apply_wasix_profile build

source_commit="$(oliphaunt_wasix_source_commit "$LIBXML2_SOURCE_DIR")"
script_sha256="$(oliphaunt_wasix_script_sha256 "$0")"
helper_sha256="$(oliphaunt_wasix_script_sha256 "$ROOT/wasix_third_party.sh")"
wasixcc_version="$(wasixcc --version 2>/dev/null)"
wasixcc_version="${wasixcc_version%%$'\n'*}"
stamp="source=$source_commit
script=$script_sha256
helper=$helper_sha256
profile=$(oliphaunt_wasix_wasix_profile_signature)
wasixcc=$wasixcc_version
cmake=static-no-programs-no-threads-no-iconv"

if [ -f "$LIBXML2_PREFIX/.oliphaunt-wasix-libxml2-build" ] &&
   [ -f "$LIBXML2_PREFIX/include/libxml2/libxml/parser.h" ] &&
   [ -f "$LIBXML2_PREFIX/lib/libxml2.a" ] &&
   [ -x "$LIBXML2_PREFIX/bin/xml2-config" ] &&
   [ "$(cat "$LIBXML2_PREFIX/.oliphaunt-wasix-libxml2-build")" = "$stamp" ]; then
  echo "$LIBXML2_PREFIX"
  exit 0
fi

{
  rm -rf "$LIBXML2_BUILD_DIR" "$LIBXML2_PREFIX"
  mkdir -p "$LIBXML2_BUILD_DIR" "$(dirname "$LIBXML2_PREFIX")"
  oliphaunt_wasix_static_cmake_build \
    "$LIBXML2_SOURCE_DIR" \
    "$LIBXML2_BUILD_DIR" \
    "$LIBXML2_PREFIX" \
    -DLIBXML2_WITH_PROGRAMS=OFF \
    -DLIBXML2_WITH_TESTS=OFF \
    -DLIBXML2_WITH_PYTHON=OFF \
    -DLIBXML2_WITH_THREADS=OFF \
    -DLIBXML2_WITH_THREAD_ALLOC=OFF \
    -DLIBXML2_WITH_MODULES=OFF \
    -DLIBXML2_WITH_ICONV=OFF \
    -DLIBXML2_WITH_ZLIB=OFF \
    -DLIBXML2_WITH_LZMA=OFF \
    -DLIBXML2_WITH_HTTP=OFF
} >&2

test -f "$LIBXML2_PREFIX/include/libxml2/libxml/parser.h"
test -f "$LIBXML2_PREFIX/lib/libxml2.a"
test -x "$LIBXML2_PREFIX/bin/xml2-config"
printf '%s\n' "$stamp" > "$LIBXML2_PREFIX/.oliphaunt-wasix-libxml2-build"
echo "$LIBXML2_PREFIX"
