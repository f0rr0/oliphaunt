#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$ROOT" rev-parse --show-toplevel 2>/dev/null || (cd "$ROOT/../../../../../.." && pwd))"

OPENSSL_SOURCE_DIR="${OPENSSL_SOURCE_DIR:-$REPO_ROOT/target/oliphaunt-sources/checkouts/openssl}"
GENERATED_ROOT="${CONTAINER_GENERATED_ROOT:-${OLIPHAUNT_WASM_GENERATED_ROOT:-$REPO_ROOT/target/oliphaunt-wasix/wasix-build}}"
OPENSSL_PREFIX="${OPENSSL_PREFIX:-$GENERATED_ROOT/work/openssl-wasix}"
OPENSSL_BUILD_DIR="${OPENSSL_BUILD_DIR:-$GENERATED_ROOT/work/openssl-wasix-build}"
JOBS="${JOBS:-4}"

if [ ! -f "$OPENSSL_SOURCE_DIR/Configure" ]; then
  echo "missing OpenSSL source checkout at $OPENSSL_SOURCE_DIR; run assets fetch/source-spine first" >&2
  exit 1
fi

. "$ROOT/docker_wasix_env.sh"
. "$ROOT/profile_flags.sh"
oliphaunt_wasix_apply_wasix_profile build

source_commit="$(git -C "$OPENSSL_SOURCE_DIR" rev-parse HEAD)"
script_sha256="$(sha256sum "$0" | awk '{print $1}')"
wasixcc_version="$(wasixcc --version 2>/dev/null)"
wasixcc_version="${wasixcc_version%%$'\n'*}"
stamp="source=$source_commit
script=$script_sha256
profile=$(oliphaunt_wasix_wasix_profile_signature)
wasixcc=$wasixcc_version
configure=no-asm no-shared no-tests no-apps no-docs no-module no-engine no-dso no-zlib no-pinshared no-dgram no-sock no-threads no-secure-memory"

if [ -f "$OPENSSL_PREFIX/.oliphaunt-wasix-openssl-build" ] &&
   [ -f "$OPENSSL_PREFIX/include/openssl/evp.h" ] &&
   [ -f "$OPENSSL_PREFIX/lib/libcrypto.a" ] &&
   [ "$(cat "$OPENSSL_PREFIX/.oliphaunt-wasix-openssl-build")" = "$stamp" ]; then
  echo "$OPENSSL_PREFIX"
  exit 0
fi

{
  rm -rf "$OPENSSL_BUILD_DIR" "$OPENSSL_PREFIX"
  mkdir -p "$OPENSSL_BUILD_DIR" "$(dirname "$OPENSSL_PREFIX")"
  cp -a "$OPENSSL_SOURCE_DIR/." "$OPENSSL_BUILD_DIR/"
  rm -rf "$OPENSSL_BUILD_DIR/.git"

  (
    cd "$OPENSSL_BUILD_DIR"
    CC=wasixcc \
    AR=wasixar \
    RANLIB=wasixranlib \
    ./Configure gcc \
      no-asm \
      no-shared \
      no-tests \
      no-apps \
      no-docs \
      no-module \
      no-engine \
      no-dso \
      no-zlib \
      no-pinshared \
      no-dgram \
      no-sock \
      no-threads \
      no-secure-memory \
      --prefix="$OPENSSL_PREFIX" \
      --openssldir="$OPENSSL_PREFIX/ssl" \
      CFLAGS="$OLIPHAUNT_WASM_PROFILE_CFLAGS -fPIC -Wno-unused-command-line-argument"
    make -s -j"$JOBS" build_libs
    make -s install_dev >/dev/null
  )
} >&2

test -f "$OPENSSL_PREFIX/include/openssl/evp.h"
test -f "$OPENSSL_PREFIX/lib/libcrypto.a"
printf '%s\n' "$stamp" > "$OPENSSL_PREFIX/.oliphaunt-wasix-openssl-build"
echo "$OPENSSL_PREFIX"
