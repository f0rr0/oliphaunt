#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$ROOT/wasix_third_party.sh"

REPO_ROOT="$(oliphaunt_wasix_repo_root "$ROOT")"
NATIVE_ICU_HELPER="$REPO_ROOT/src/runtimes/liboliphaunt/native/bin/icu.sh"
. "$NATIVE_ICU_HELPER"
ICU_SOURCE_DIR="${ICU_SOURCE_DIR:-$REPO_ROOT/target/oliphaunt-sources/checkouts/icu/icu4c/source}"
GENERATED_ROOT="$(oliphaunt_wasix_generated_root "$REPO_ROOT")"
ICU_NATIVE_BUILD_DIR="${ICU_NATIVE_BUILD_DIR:-$GENERATED_ROOT/work/icu-native}"
ICU_PREFIX="${ICU_PREFIX:-$GENERATED_ROOT/work/icu-wasix}"
ICU_BUILD_DIR="${ICU_BUILD_DIR:-$GENERATED_ROOT/work/icu-wasix-build}"
JOBS="${JOBS:-4}"

if [ ! -x "$ICU_SOURCE_DIR/configure" ]; then
  echo "missing ICU source checkout at $ICU_SOURCE_DIR; run \`cargo run -p xtask -- assets fetch\` first" >&2
  exit 1
fi

. "$ROOT/docker_wasix_env.sh"
. "$ROOT/profile_flags.sh"
oliphaunt_wasix_apply_wasix_profile build

source_commit="$(oliphaunt_wasix_source_commit "$ICU_SOURCE_DIR/../../")"
script_sha256="$(oliphaunt_wasix_script_sha256 "$0")"
helper_sha256="$(oliphaunt_wasix_script_sha256 "$ROOT/wasix_third_party.sh")"
native_icu_helper_sha256="$(oliphaunt_wasix_script_sha256 "$NATIVE_ICU_HELPER")"
wasixcc_version="$(wasixcc --version 2>/dev/null)"
wasixcc_version="${wasixcc_version%%$'\n'*}"
stamp="schema=oliphaunt-wasix-icu-v8
source=$source_commit
script=$script_sha256
helper=$helper_sha256
native-icu-helper=$native_icu_helper_sha256
profile=$(oliphaunt_wasix_wasix_profile_signature)
wasixcc=$wasixcc_version
canonical-data-sha256=$(oliphaunt_icu_canonical_data_sha256)
configure=files-data-static-libs-static-consumer-no-extra-target-tools-stub-data-archive-pinned-upstream-data
wasix-platform-fragment=mh-linux
wasix-timezone-cache=no-tzname
wasix-data-packaging=files-without-assembly"

icu_wasix_config_ready() {
  local makefile_inc="$ICU_BUILD_DIR/config/Makefile.inc"
  [ -f "$makefile_inc" ] || return 1
  grep -q '^include .*/config/mh-linux$' "$makefile_inc"
}

if [ -f "$ICU_PREFIX/.oliphaunt-wasix-icu-build" ] &&
  [ -f "$ICU_PREFIX/include/unicode/ucol.h" ] &&
  [ -f "$ICU_PREFIX/lib/libicui18n.a" ] &&
  [ -f "$ICU_PREFIX/lib/libicuuc.a" ] &&
  oliphaunt_icu_stub_data_archive_ready "$ICU_PREFIX/lib/libicudata.a" &&
  oliphaunt_icu_files_data_ready "$ICU_PREFIX/share/icu" &&
  [ "$(cat "$ICU_PREFIX/.oliphaunt-wasix-icu-build")" = "$stamp" ]; then
  echo "$ICU_PREFIX"
  exit 0
fi

{
  rm -rf "$ICU_BUILD_DIR" "$ICU_PREFIX"
  mkdir -p "$ICU_BUILD_DIR" "$(dirname "$ICU_PREFIX")"
  oliphaunt_icu_build_native_tools \
    "$ICU_SOURCE_DIR" \
    "$(dirname "$NATIVE_ICU_HELPER")" \
    "$ICU_NATIVE_BUILD_DIR" \
    "$JOBS"
  oliphaunt_icu_require_canonical_data "$(oliphaunt_icu_canonical_data_archive "$ICU_SOURCE_DIR")"

  (
    cd "$ICU_BUILD_DIR"
    CC=wasixcc \
      CXX=wasixcc++ \
      AR=wasixar \
      RANLIB=wasixranlib \
      icu_cv_host_frag=mh-linux \
      ac_cv_var_tzname=no \
      ac_cv_var__tzname=no \
      CFLAGS="$OLIPHAUNT_WASM_PROFILE_CFLAGS -fPIC -fvisibility=hidden -Wno-unused-command-line-argument" \
      CXXFLAGS="$OLIPHAUNT_WASM_PROFILE_CFLAGS -std=c++17 -fPIC -fvisibility=hidden -fvisibility-inlines-hidden -Wno-unused-command-line-argument" \
      LDFLAGS="$OLIPHAUNT_WASM_PROFILE_LDFLAGS" \
      "$ICU_SOURCE_DIR/configure" \
      --host=wasm32-wasi \
      --with-cross-build="$ICU_NATIVE_BUILD_DIR" \
      --with-data-packaging=files \
      --disable-shared \
      --enable-static \
      --disable-tests \
      --disable-samples \
      --disable-tools \
      --disable-extras \
      --disable-icuio \
      --disable-layoutex \
      --prefix="$ICU_PREFIX"
    icu_wasix_config_ready
    icu_pkgdata_opts="-O $ICU_BUILD_DIR/data/icupkg.inc -w"
    icu_data_name="$(
      awk -F' = ' '$1 == "ICUDATA_NAME" { print $2; exit }' \
        "$ICU_BUILD_DIR/config/Makefile.inc"
    )"
    if [[ ! "$icu_data_name" =~ ^icudt[0-9]+[a-z]+$ ]]; then
      echo "invalid ICU data name in $ICU_BUILD_DIR/config/Makefile.inc: $icu_data_name" >&2
      exit 1
    fi
    # ICU 76.1 does not order genrb after cnvalias.icu. Complete the alias
    # file before parallel data generators can map a partially written file.
    make -j1 -C data "out/build/$icu_data_name/cnvalias.icu" PKGDATA_OPTS="$icu_pkgdata_opts"
    make -j"$JOBS" PKGDATA_OPTS="$icu_pkgdata_opts"
    oliphaunt_icu_prepare_files_data_install_dirs "$ICU_BUILD_DIR" "$ICU_PREFIX"
    make install PKGDATA_OPTS="$icu_pkgdata_opts"
    make -j"$JOBS" -C data packagedata PKGDATA_OPTS="$icu_pkgdata_opts"
    oliphaunt_icu_install_canonical_files_data "$ICU_SOURCE_DIR" "$ICU_NATIVE_BUILD_DIR" "$ICU_PREFIX"
    oliphaunt_icu_install_stub_data_archive "$ICU_BUILD_DIR" "$ICU_PREFIX"
  )
} >&2

test -f "$ICU_PREFIX/include/unicode/ucol.h"
test -f "$ICU_PREFIX/lib/libicui18n.a"
test -f "$ICU_PREFIX/lib/libicuuc.a"
oliphaunt_icu_stub_data_archive_ready "$ICU_PREFIX/lib/libicudata.a"
oliphaunt_icu_files_data_ready "$ICU_PREFIX/share/icu"
printf '%s\n' "$stamp" > "$ICU_PREFIX/.oliphaunt-wasix-icu-build"
echo "$ICU_PREFIX"
