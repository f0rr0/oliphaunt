#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$ROOT/wasix_third_party.sh"

REPO_ROOT="$(oliphaunt_wasix_repo_root "$ROOT")"
SQLITE_SOURCE_DIR="${SQLITE_SOURCE_DIR:-$REPO_ROOT/target/oliphaunt-sources/checkouts/sqlite}"
GENERATED_ROOT="$(oliphaunt_wasix_generated_root "$REPO_ROOT")"
SQLITE_PREFIX="${SQLITE_PREFIX:-$GENERATED_ROOT/work/sqlite-wasix}"
SQLITE_BUILD_DIR="${SQLITE_BUILD_DIR:-$GENERATED_ROOT/work/sqlite-wasix-build}"
JOBS="${JOBS:-4}"

if [ ! -x "$SQLITE_SOURCE_DIR/configure" ]; then
  echo "missing SQLite source checkout at $SQLITE_SOURCE_DIR; run assets fetch/source-spine first" >&2
  exit 1
fi

. "$ROOT/docker_wasix_env.sh"
. "$ROOT/profile_flags.sh"
oliphaunt_wasix_apply_wasix_profile build

source_commit="$(oliphaunt_wasix_source_commit "$SQLITE_SOURCE_DIR")"
script_sha256="$(oliphaunt_wasix_script_sha256 "$0")"
helper_sha256="$(oliphaunt_wasix_script_sha256 "$ROOT/wasix_third_party.sh")"
wasixcc_version="$(wasixcc --version 2>/dev/null)"
wasixcc_version="${wasixcc_version%%$'\n'*}"
stamp="source=$source_commit
script=$script_sha256
helper=$helper_sha256
profile=$(oliphaunt_wasix_wasix_profile_signature)
wasixcc=$wasixcc_version
configure=amalgamation-static-threadsafe0-hidden-symbols"

if [ -f "$SQLITE_PREFIX/.oliphaunt-wasix-sqlite-build" ] &&
   [ -f "$SQLITE_PREFIX/include/sqlite3.h" ] &&
   [ -f "$SQLITE_PREFIX/lib/libsqlite3.a" ] &&
   [ "$(cat "$SQLITE_PREFIX/.oliphaunt-wasix-sqlite-build")" = "$stamp" ]; then
  echo "$SQLITE_PREFIX"
  exit 0
fi

{
  rm -rf "$SQLITE_BUILD_DIR" "$SQLITE_PREFIX"
  oliphaunt_wasix_copy_source_clean "$SQLITE_SOURCE_DIR" "$SQLITE_BUILD_DIR"

  (
    cd "$SQLITE_BUILD_DIR"
    ./configure --disable-shared --enable-static --disable-readline
    make -s -j"$JOBS" sqlite3.c sqlite3.h
    mkdir -p "$SQLITE_PREFIX/include" "$SQLITE_PREFIX/lib/pkgconfig"
    wasixcc \
      $OLIPHAUNT_WASM_PROFILE_CFLAGS \
      -fPIC \
      -fvisibility=hidden \
      -DSQLITE_THREADSAFE=0 \
      -DSQLITE_OMIT_LOAD_EXTENSION \
      -Wno-unused-command-line-argument \
      -c sqlite3.c \
      -o sqlite3.o
    wasixar crs "$SQLITE_PREFIX/lib/libsqlite3.a" sqlite3.o
    wasixranlib "$SQLITE_PREFIX/lib/libsqlite3.a"
    cp sqlite3.h sqlite3ext.h "$SQLITE_PREFIX/include/"
    cat >"$SQLITE_PREFIX/lib/pkgconfig/sqlite3.pc" <<EOF
prefix=$SQLITE_PREFIX
exec_prefix=\${prefix}
libdir=\${prefix}/lib
includedir=\${prefix}/include

Name: SQLite
Description: SQL database engine
Version: $(cat VERSION)
Libs: -L\${libdir} -lsqlite3
Cflags: -I\${includedir}
EOF
  )
} >&2

test -f "$SQLITE_PREFIX/include/sqlite3.h"
test -f "$SQLITE_PREFIX/lib/libsqlite3.a"
printf '%s\n' "$stamp" > "$SQLITE_PREFIX/.oliphaunt-wasix-sqlite-build"
echo "$SQLITE_PREFIX"
