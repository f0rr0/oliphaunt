#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$ROOT/wasix_third_party.sh"

REPO_ROOT="$(oliphaunt_wasix_repo_root "$ROOT")"
JSONC_SOURCE_DIR="${JSONC_SOURCE_DIR:-$REPO_ROOT/target/oliphaunt-sources/checkouts/json-c}"
GENERATED_ROOT="$(oliphaunt_wasix_generated_root "$REPO_ROOT")"
JSONC_PREFIX="${JSONC_PREFIX:-$GENERATED_ROOT/work/json-c-wasix}"
JSONC_BUILD_DIR="${JSONC_BUILD_DIR:-$GENERATED_ROOT/work/json-c-wasix-build}"
JOBS="${JOBS:-4}"

if [ ! -f "$JSONC_SOURCE_DIR/CMakeLists.txt" ]; then
  echo "missing JSON-C source checkout at $JSONC_SOURCE_DIR; run assets fetch/source-spine first" >&2
  exit 1
fi

. "$ROOT/docker_wasix_env.sh"
. "$ROOT/profile_flags.sh"
oliphaunt_wasix_apply_wasix_profile build

source_commit="$(oliphaunt_wasix_source_commit "$JSONC_SOURCE_DIR")"
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

if [ -f "$JSONC_PREFIX/.oliphaunt-wasix-json-c-build" ] &&
   [ -f "$JSONC_PREFIX/include/json-c/json.h" ] &&
   [ -f "$JSONC_PREFIX/lib/libjson-c.a" ] &&
   [ "$(cat "$JSONC_PREFIX/.oliphaunt-wasix-json-c-build")" = "$stamp" ]; then
  echo "$JSONC_PREFIX"
  exit 0
fi

{
  rm -rf "$JSONC_BUILD_DIR" "$JSONC_PREFIX"
  mkdir -p "$JSONC_BUILD_DIR" "$(dirname "$JSONC_PREFIX")"
  oliphaunt_wasix_static_cmake_build \
    "$JSONC_SOURCE_DIR" \
    "$JSONC_BUILD_DIR" \
    "$JSONC_PREFIX" \
    -DDISABLE_WERROR=ON \
    -DBUILD_APPS=OFF \
    -DHAVE_SNPRINTF=ON \
    -DBUILD_TESTING=OFF
} >&2

test -f "$JSONC_PREFIX/include/json-c/json.h"
test -f "$JSONC_PREFIX/lib/libjson-c.a"
printf '%s\n' "$stamp" > "$JSONC_PREFIX/.oliphaunt-wasix-json-c-build"
echo "$JSONC_PREFIX"
