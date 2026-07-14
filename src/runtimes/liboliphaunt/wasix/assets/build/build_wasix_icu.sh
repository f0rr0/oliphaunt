#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$ROOT/wasix_third_party.sh"

REPO_ROOT="$(oliphaunt_wasix_repo_root "$ROOT")"
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
wasixcc_version="$(wasixcc --version 2>/dev/null)"
wasixcc_version="${wasixcc_version%%$'\n'*}"
stamp="schema=oliphaunt-wasix-icu-v5
source=$source_commit
script=$script_sha256
helper=$helper_sha256
profile=$(oliphaunt_wasix_wasix_profile_signature)
wasixcc=$wasixcc_version
configure=files-data-static-libs-static-consumer-no-extra-target-tools-stub-data-archive
wasix-platform-fragment=mh-linux
wasix-timezone-cache=no-tzname
wasix-data-packaging=files-without-assembly"

icu_native_tool_names() {
  printf '%s\n' \
    makeconv \
    gencnval \
    gencfu \
    genbrk \
    gendict \
    genrb \
    gensprep \
    icupkg \
    pkgdata \
    genccode \
    gencmn
}

icu_native_tools_ready() {
  [ -f "$ICU_NATIVE_BUILD_DIR/icudefs.mk" ] || return 1
  [ -f "$ICU_NATIVE_BUILD_DIR/config/icucross.mk" ] || return 1
  [ -f "$ICU_NATIVE_BUILD_DIR/config/icucross.inc" ] || return 1
  [ -f "$ICU_NATIVE_BUILD_DIR/lib/libicui18n.a" ] || return 1
  [ -f "$ICU_NATIVE_BUILD_DIR/lib/libicuuc.a" ] || return 1
  [ -f "$ICU_NATIVE_BUILD_DIR/stubdata/libicudata.a" ] || return 1
  [ -f "$ICU_NATIVE_BUILD_DIR/lib/libicutu.a" ] || return 1
  local tool
  while IFS= read -r tool; do
    [ -x "$ICU_NATIVE_BUILD_DIR/bin/$tool" ] || return 1
  done < <(icu_native_tool_names)
}

icu_stub_data_archive_ready() {
  local archive="$1"
  [ -f "$archive" ] || return 1
  local members
  members="$(ar -t "$archive")" || return 1
  grep -q '^stubdata\.ao$' <<< "$members" || return 1
  ! grep -Eq '^icudt[0-9]+[a-z]*_dat\.o$' <<< "$members"
}

icu_files_data_ready() {
  local data_root="$1"
  [ -d "$data_root" ] || return 1
  [ -n "$(
    find "$data_root" -type f \
      \( -path '*/icudt[0-9]*[a-z]/*' -o -name 'icudt[0-9]*[a-z].dat' \) \
      -print -quit
  )" ]
}

icu_wasix_config_ready() {
  local makefile_inc="$ICU_BUILD_DIR/config/Makefile.inc"
  [ -f "$makefile_inc" ] || return 1
  grep -q '^include .*/config/mh-linux$' "$makefile_inc"
}

icu_install_stub_data_archive() {
  local built_archive="$ICU_BUILD_DIR/stubdata/libicudata.a"
  local installed_archive="$ICU_PREFIX/lib/libicudata.a"
  local tmp_archive="$installed_archive.tmp"

  icu_stub_data_archive_ready "$built_archive"
  mkdir -p "$ICU_PREFIX/lib"
  rm -f "$tmp_archive"
  cp "$built_archive" "$tmp_archive"
  chmod 0644 "$tmp_archive"
  mv "$tmp_archive" "$installed_archive"
}

icu_prepare_files_data_install_dirs() {
  local version
  version="$(
    awk -F' = ' '$1 == "VERSION" { print $2; exit }' "$ICU_BUILD_DIR/config/Makefile.inc"
  )"
  [ -n "$version" ] || {
    echo "unable to determine ICU version from $ICU_BUILD_DIR/config/Makefile.inc" >&2
    return 1
  }

  local build_data_root="$ICU_BUILD_DIR/data/out/build"
  local install_data_root="$ICU_PREFIX/share/icu/$version"
  [ -d "$build_data_root" ] || {
    echo "missing generated ICU files-data root: $build_data_root" >&2
    return 1
  }
  mkdir -p "$install_data_root"
  while IFS= read -r dir; do
    local relative="${dir#"$build_data_root"/}"
    [ "$relative" != "$dir" ] || continue
    mkdir -p "$install_data_root/$relative"
  done < <(find "$build_data_root" -type d -print)
}

if [ -f "$ICU_PREFIX/.oliphaunt-wasix-icu-build" ] &&
  [ -f "$ICU_PREFIX/include/unicode/ucol.h" ] &&
  [ -f "$ICU_PREFIX/lib/libicui18n.a" ] &&
  [ -f "$ICU_PREFIX/lib/libicuuc.a" ] &&
  icu_stub_data_archive_ready "$ICU_PREFIX/lib/libicudata.a" &&
  icu_files_data_ready "$ICU_PREFIX/share/icu" &&
  [ "$(cat "$ICU_PREFIX/.oliphaunt-wasix-icu-build")" = "$stamp" ]; then
  echo "$ICU_PREFIX"
  exit 0
fi

{
  rm -rf "$ICU_NATIVE_BUILD_DIR" "$ICU_BUILD_DIR" "$ICU_PREFIX"
  mkdir -p "$ICU_NATIVE_BUILD_DIR" "$ICU_BUILD_DIR" "$(dirname "$ICU_PREFIX")"

  (
    cd "$ICU_NATIVE_BUILD_DIR"
    "$ICU_SOURCE_DIR/configure" \
      --disable-shared \
      --enable-static \
      --disable-tests \
      --disable-samples \
      --disable-extras \
      --disable-icuio \
      --disable-layoutex
    make all-local
    mkdir -p lib bin
    make -j"$JOBS" -C stubdata
    make -j"$JOBS" -C common
    make -j"$JOBS" -C i18n
    make -j"$JOBS" -C tools/toolutil
    while IFS= read -r tool; do
      make -j"$JOBS" -C "tools/$tool"
    done < <(icu_native_tool_names)
  )
  icu_native_tools_ready

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
    make -j"$JOBS" PKGDATA_OPTS="$icu_pkgdata_opts"
    icu_prepare_files_data_install_dirs
    make install PKGDATA_OPTS="$icu_pkgdata_opts"
    make -j"$JOBS" -C data packagedata PKGDATA_OPTS="$icu_pkgdata_opts"
    icu_install_stub_data_archive
  )
} >&2

test -f "$ICU_PREFIX/include/unicode/ucol.h"
test -f "$ICU_PREFIX/lib/libicui18n.a"
test -f "$ICU_PREFIX/lib/libicuuc.a"
icu_stub_data_archive_ready "$ICU_PREFIX/lib/libicudata.a"
icu_files_data_ready "$ICU_PREFIX/share/icu"
printf '%s\n' "$stamp" > "$ICU_PREFIX/.oliphaunt-wasix-icu-build"
echo "$ICU_PREFIX"
