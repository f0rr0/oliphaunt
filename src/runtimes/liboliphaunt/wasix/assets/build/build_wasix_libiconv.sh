#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$ROOT/wasix_third_party.sh"

REPO_ROOT="$(oliphaunt_wasix_repo_root "$ROOT")"
GENERATED_ROOT="$(oliphaunt_wasix_generated_root "$REPO_ROOT")"
LIBICONV_VERSION="${LIBICONV_VERSION:-1.19}"
LIBICONV_URL="${LIBICONV_URL:-https://ftp.gnu.org/gnu/libiconv/libiconv-$LIBICONV_VERSION.tar.gz}"
LIBICONV_SHA256="${LIBICONV_SHA256:-88dd96a8c0464eca144fc791ae60cd31cd8ee78321e67397e25fc095c4a19aa6}"
LIBICONV_SOURCE_DIR="${LIBICONV_SOURCE_DIR:-$REPO_ROOT/target/oliphaunt-sources/checkouts/libiconv}"
LIBICONV_ARCHIVE="${LIBICONV_ARCHIVE:-$GENERATED_ROOT/source-cache/libiconv-$LIBICONV_VERSION.tar.gz}"
LIBICONV_BUILD_DIR="${LIBICONV_BUILD_DIR:-$GENERATED_ROOT/work/libiconv-wasix-build}"
LIBICONV_PREFIX="${LIBICONV_PREFIX:-$GENERATED_ROOT/work/libiconv-wasix}"
JOBS="${JOBS:-4}"

. "$ROOT/docker_wasix_env.sh"
. "$ROOT/profile_flags.sh"
oliphaunt_wasix_apply_wasix_profile configure

script_sha256="$(oliphaunt_wasix_script_sha256 "$0")"
helper_sha256="$(oliphaunt_wasix_script_sha256 "$ROOT/wasix_third_party.sh")"
wasixcc_version="$(wasixcc --version 2>/dev/null)"
wasixcc_version="${wasixcc_version%%$'\n'*}"
stamp="url=$LIBICONV_URL
sha256=$LIBICONV_SHA256
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
  if [ -f "$LIBICONV_SOURCE_DIR/configure" ]; then
    oliphaunt_wasix_copy_source_clean "$LIBICONV_SOURCE_DIR" "$LIBICONV_BUILD_DIR"
  else
    mkdir -p "$(dirname "$LIBICONV_ARCHIVE")"
    if [ ! -f "$LIBICONV_ARCHIVE" ] ||
       [ "$(sha256sum "$LIBICONV_ARCHIVE" | awk '{print $1}')" != "$LIBICONV_SHA256" ]; then
      tmp_archive="$LIBICONV_ARCHIVE.tmp"
      rm -f "$tmp_archive"
      curl -fsSL --retry 8 --retry-all-errors --retry-delay 5 --connect-timeout 20 \
        "$LIBICONV_URL" -o "$tmp_archive"
      actual_sha="$(sha256sum "$tmp_archive" | awk '{print $1}')"
      if [ "$actual_sha" != "$LIBICONV_SHA256" ]; then
        echo "libiconv archive sha256 mismatch: expected $LIBICONV_SHA256 got $actual_sha" >&2
        exit 1
      fi
      mv "$tmp_archive" "$LIBICONV_ARCHIVE"
    fi
    tar -xzf "$LIBICONV_ARCHIVE" -C "$LIBICONV_BUILD_DIR" --strip-components=1
  fi
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
