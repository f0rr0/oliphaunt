#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$ROOT/wasix_third_party.sh"

REPO_ROOT="$(oliphaunt_wasix_repo_root "$ROOT")"
PROJ_SOURCE_DIR="${PROJ_SOURCE_DIR:-$REPO_ROOT/target/oliphaunt-sources/checkouts/proj}"
GENERATED_ROOT="$(oliphaunt_wasix_generated_root "$REPO_ROOT")"
PROJ_PREFIX="${PROJ_PREFIX:-$GENERATED_ROOT/work/proj-wasix}"
PROJ_BUILD_DIR="${PROJ_BUILD_DIR:-$GENERATED_ROOT/work/proj-wasix-build}"
SQLITE_PREFIX="${SQLITE_PREFIX:-$("$ROOT/build_wasix_sqlite.sh")}"
JOBS="${JOBS:-4}"

if [ ! -f "$PROJ_SOURCE_DIR/CMakeLists.txt" ]; then
  echo "missing PROJ source checkout at $PROJ_SOURCE_DIR; run bash third-party/tools/fetch-sources.sh wasix-runtime --force first" >&2
  exit 1
fi

. "$ROOT/docker_wasix_env.sh"
. "$ROOT/profile_flags.sh"
oliphaunt_wasix_apply_wasix_profile build

source_commit="$(oliphaunt_wasix_source_commit "$PROJ_SOURCE_DIR")"
sqlite_stamp="$(cat "$SQLITE_PREFIX/.oliphaunt-wasix-sqlite-build")"
script_sha256="$(oliphaunt_wasix_script_sha256 "$0")"
helper_sha256="$(oliphaunt_wasix_script_sha256 "$ROOT/wasix_third_party.sh")"
sqlite_script_sha256="$(oliphaunt_wasix_script_sha256 "$ROOT/build_wasix_sqlite.sh")"
wasixcc_version="$(wasixcc --version 2>/dev/null)"
wasixcc_version="${wasixcc_version%%$'\n'*}"
stamp="source=$source_commit
sqlite=$sqlite_stamp
script=$script_sha256
sqlite_script=$sqlite_script_sha256
helper=$helper_sha256
profile=$(oliphaunt_wasix_wasix_profile_signature)
wasixcc=$wasixcc_version
cmake=static-libs-only-no-tiff-no-curl-no-libdl-embedded-projdb-install-projdb"

if [ -f "$PROJ_PREFIX/.oliphaunt-wasix-proj-build" ] &&
   [ -f "$PROJ_PREFIX/include/proj.h" ] &&
   [ -f "$PROJ_PREFIX/lib/libproj.a" ] &&
   [ -f "$PROJ_PREFIX/share/proj/proj.db" ] &&
   [ "$(cat "$PROJ_PREFIX/.oliphaunt-wasix-proj-build")" = "$stamp" ]; then
  echo "$PROJ_PREFIX"
  exit 0
fi

{
  rm -rf "$PROJ_BUILD_DIR"
  mkdir -p "$PROJ_BUILD_DIR" "$(dirname "$PROJ_PREFIX")"
  install_stage="$(mktemp -d "$PROJ_PREFIX.install.XXXXXX")"
  staged_prefix="$install_stage$PROJ_PREFIX"
  trap 'rm -rf "$install_stage"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  DESTDIR="$install_stage" oliphaunt_wasix_static_cmake_build \
    "$PROJ_SOURCE_DIR" \
    "$PROJ_BUILD_DIR" \
    "$PROJ_PREFIX" \
    -DSQLite3_INCLUDE_DIR="$SQLITE_PREFIX/include" \
    -DSQLite3_LIBRARY="$SQLITE_PREFIX/lib/libsqlite3.a" \
    -DEXE_SQLITE3="$(command -v sqlite3)" \
    -DENABLE_TIFF=OFF \
    -DENABLE_CURL=OFF \
    -DENABLE_EMSCRIPTEN_FETCH=OFF \
    -DHAVE_LIBDL=OFF \
    -DBUILD_APPS=OFF \
    -DBUILD_TESTING=OFF \
    -DBUILD_EXAMPLES=OFF \
    -DEMBED_RESOURCE_FILES=ON \
    -DUSE_ONLY_EMBEDDED_RESOURCE_FILES=ON
  mkdir -p "$staged_prefix/share/proj"
  cp "$PROJ_BUILD_DIR/data/proj.db" "$staged_prefix/share/proj/proj.db"
} >&2

test -f "$staged_prefix/include/proj.h"
test -f "$staged_prefix/lib/libproj.a"
test -f "$staged_prefix/share/proj/proj.db"
printf '%s\n' "$stamp" > "$staged_prefix/.oliphaunt-wasix-proj-build"
oliphaunt_wasix_publish_prefix "$staged_prefix" "$PROJ_PREFIX"
echo "$PROJ_PREFIX"
