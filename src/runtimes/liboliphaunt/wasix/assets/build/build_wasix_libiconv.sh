#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$ROOT/wasix_third_party.sh"

REPO_ROOT="$(oliphaunt_wasix_repo_root "$ROOT")"
GENERATED_ROOT="$(oliphaunt_wasix_generated_root "$REPO_ROOT")"
LIBICONV_SOURCE_DIR="$REPO_ROOT/target/oliphaunt-sources/checkouts/libiconv"
LIBICONV_SOURCE_PIN="$LIBICONV_SOURCE_DIR/.oliphaunt-source-pin"
LIBICONV_SOURCE_MANIFEST="$REPO_ROOT/src/extensions/external/postgis/dependencies/libiconv/source.toml"
LIBICONV_BUILD_DIR="${LIBICONV_BUILD_DIR:-$GENERATED_ROOT/work/libiconv-wasix-build}"
LIBICONV_PREFIX="${LIBICONV_PREFIX:-$GENERATED_ROOT/work/libiconv-wasix}"
JOBS="${JOBS:-4}"

. "$ROOT/docker_wasix_env.sh"
. "$ROOT/profile_flags.sh"
oliphaunt_wasix_apply_wasix_profile configure

if [ ! -f "$LIBICONV_SOURCE_DIR/configure" ] || [ ! -f "$LIBICONV_SOURCE_PIN" ]; then
  echo "pinned libiconv source checkout is missing; run tools/dev/bun.sh tools/policy/fetch-sources.mjs wasix-runtime --force" >&2
  exit 1
fi
source_tree_sha256="$(python3 "$REPO_ROOT/tools/policy/verify-source-tree.py" \
  --checkout "$LIBICONV_SOURCE_DIR" \
  --manifest "$LIBICONV_SOURCE_MANIFEST")"

script_sha256="$(oliphaunt_wasix_script_sha256 "$0")"
helper_sha256="$(oliphaunt_wasix_script_sha256 "$ROOT/wasix_third_party.sh")"
source_pin_sha256="$(sha256sum "$LIBICONV_SOURCE_PIN" | awk '{print $1}')"
wasixcc_version="$(wasixcc --version 2>/dev/null)"
wasixcc_version="${wasixcc_version%%$'\n'*}"
stamp="source-pin=$source_pin_sha256
source-tree=$source_tree_sha256
script=$script_sha256
helper=$helper_sha256
profile=$(oliphaunt_wasix_wasix_profile_signature)
wasixcc=$wasixcc_version
configure=static-no-shared-no-nls"

if [ -f "$LIBICONV_PREFIX/.oliphaunt-wasix-libiconv-build" ] &&
   [ -f "$LIBICONV_PREFIX/include/iconv.h" ] &&
   [ -f "$LIBICONV_PREFIX/lib/libiconv.a" ] &&
   [ "$(cat "$LIBICONV_PREFIX/.oliphaunt-wasix-libiconv-build")" = "$stamp" ]; then
  echo "$LIBICONV_PREFIX"
  exit 0
fi

{
  rm -rf "$LIBICONV_BUILD_DIR" "$LIBICONV_PREFIX"
  mkdir -p "$LIBICONV_BUILD_DIR" "$(dirname "$LIBICONV_PREFIX")"
  oliphaunt_wasix_copy_source_clean "$LIBICONV_SOURCE_DIR" "$LIBICONV_BUILD_DIR"
  cd "$LIBICONV_BUILD_DIR"
  ./configure \
    --build="$(build-aux/config.guess)" \
    --host=wasm32-wasi \
    --prefix="$LIBICONV_PREFIX" \
    --disable-shared \
    --enable-static \
    --disable-nls \
    CC=wasixcc \
    AR=wasixar \
    RANLIB=wasixranlib \
    CFLAGS="$OLIPHAUNT_WASM_PROFILE_CFLAGS -fPIC -Wno-unused-command-line-argument"
  oliphaunt_wasix_apply_wasix_profile build
  make -s -j"$JOBS"
  make -s install
} >&2

test -f "$LIBICONV_PREFIX/include/iconv.h"
test -f "$LIBICONV_PREFIX/lib/libiconv.a"
printf '%s\n' "$stamp" > "$LIBICONV_PREFIX/.oliphaunt-wasix-libiconv-build"
echo "$LIBICONV_PREFIX"
