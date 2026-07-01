#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$script_dir/common.sh"
. "$script_dir/icu.sh"
repo_root="$(oliphaunt_resolve_repo_root "$script_dir")"
pg_version="18.4"
pg_sha256="81a81ec695fb0c7901407defaa1d2f7973617154cf27ba74e3a7ab8e64436094"
pg_url="https://ftp.postgresql.org/pub/source/v${pg_version}/postgresql-${pg_version}.tar.bz2"
source_manifest="$repo_root/src/runtimes/liboliphaunt/native/postgres18/source.toml"
patch_dir="$repo_root/src/runtimes/liboliphaunt/native/patches/postgresql-${pg_version}"
work_root="${OLIPHAUNT_IOS_SIMULATOR_CHECK_ROOT:-$repo_root/target/liboliphaunt-ios-simulator-check}"
source_cache="$work_root/source"
tarball="$source_cache/postgresql-${pg_version}.tar.bz2"
build_dir="$work_root/postgresql-${pg_version}"
install_dir="$work_root/install"
stamp="$build_dir/.liboliphaunt-ios-simulator-check.sha256"
make_log="$work_root/make.log"
configure_log="$work_root/configure.log"
icu_source_dir="$(oliphaunt_icu_source_dir "$repo_root")"
icu_native_build_dir="$work_root/icu-native"
icu_build_dir="$work_root/icu-ios-simulator-build"
icu_prefix="$work_root/icu-ios-simulator"
icu_cflags="$(oliphaunt_icu_cflags "$icu_prefix")"
icu_static_libs="$(oliphaunt_icu_static_libs "$icu_prefix")"
icu_cpp_libs="-lc++"
icu_libs="$icu_static_libs $icu_cpp_libs"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "PostgreSQL iOS simulator probe requires Darwin" >&2
  exit 2
fi

if ! command -v xcrun >/dev/null 2>&1; then
  echo "missing required command: xcrun" >&2
  exit 1
fi

if ! command -v rg >/dev/null 2>&1; then
  echo "missing required command: rg" >&2
  exit 1
fi

sdk_path="$(xcrun --sdk iphonesimulator --show-sdk-path 2>/dev/null || true)"
clang_path="$(xcrun --find --sdk iphonesimulator clang 2>/dev/null || true)"
clangxx_path="$(xcrun --find --sdk iphonesimulator clang++ 2>/dev/null || true)"
ar_path="$(xcrun --find --sdk iphonesimulator ar 2>/dev/null || true)"
ranlib_path="$(xcrun --find --sdk iphonesimulator ranlib 2>/dev/null || true)"
if [ -z "$sdk_path" ] || [ -z "$clang_path" ] || [ -z "$clangxx_path" ] || [ -z "$ar_path" ] || [ -z "$ranlib_path" ]; then
  echo "iPhoneSimulator SDK is unavailable" >&2
  exit 1
fi
oliphaunt_icu_require_source "$icu_source_dir"

min_ios="${OLIPHAUNT_IOS_SIMULATOR_MIN_VERSION:-17.0}"
cc=("$clang_path" -target "arm64-apple-ios${min_ios}-simulator" "-mios-simulator-version-min=${min_ios}" -isysroot "$sdk_path")
cxx=("$clangxx_path" -target "arm64-apple-ios${min_ios}-simulator" "-mios-simulator-version-min=${min_ios}" -isysroot "$sdk_path")
ccache_mode="${OLIPHAUNT_CCACHE:-auto}"
if [ "$ccache_mode" != "0" ] && [ "$ccache_mode" != "off" ]; then
  ccache_bin=""
  if [ "$ccache_mode" = "auto" ]; then
    ccache_bin="$(command -v ccache || true)"
  else
    ccache_bin="$ccache_mode"
  fi
  if [ -n "$ccache_bin" ]; then
    cc=("$ccache_bin" "${cc[@]}")
    cxx=("$ccache_bin" "${cxx[@]}")
  fi
fi
cc_string="${cc[*]}"
cxx_string="${cxx[*]}"

patch_series() {
  sed -n '/series = \[/,/\]/p' "$source_manifest" |
    sed -n 's/.*"\([^"]*\.patch\)".*/\1/p'
}

patch_series_hash() {
  while IFS= read -r patch_name; do
    [ -n "$patch_name" ] || continue
    shasum -a 256 "$patch_dir/$patch_name"
  done < <(patch_series) | shasum -a 256 | awk '{print $1}'
}

desired_hash() {
  {
    printf 'pg_version=%s\n' "$pg_version"
    printf 'pg_sha256=%s\n' "$pg_sha256"
    printf 'sdk_path=%s\n' "$sdk_path"
    printf 'clang_path=%s\n' "$clang_path"
    printf 'clangxx_path=%s\n' "$clangxx_path"
    printf 'min_ios=%s\n' "$min_ios"
    printf 'cc=%s\n' "$cc_string"
    printf 'cxx=%s\n' "$cxx_string"
    printf 'ar=%s\n' "$ar_path"
    printf 'ranlib=%s\n' "$ranlib_path"
    printf 'icu_source=%s\n' "$(oliphaunt_icu_source_commit "$icu_source_dir")"
    printf 'icu_script=%s\n' "$(oliphaunt_icu_script_sha256 "$script_dir")"
    printf 'patch_series_hash=%s\n' "$(patch_series_hash)"
    shasum -a 256 "$0"
    shasum -a 256 "$source_manifest"
  } | shasum -a 256 | awk '{print $1}'
}

apply_patch_series() {
  local patch_name
  while IFS= read -r patch_name; do
    [ -n "$patch_name" ] || continue
    GIT_CEILING_DIRECTORIES="$work_root" git apply --recount --whitespace=nowarn "$patch_dir/$patch_name" >/dev/null
  done < <(patch_series)
}

prepare_source() {
  mkdir -p "$source_cache" "$work_root"

  if [ ! -f "$tarball" ]; then
    curl -L --fail --silent --show-error "$pg_url" -o "$tarball"
  fi
  (
    cd "$source_cache"
    printf '%s  %s\n' "$pg_sha256" "postgresql-${pg_version}.tar.bz2" | shasum -a 256 -c -
  )

  local wanted
  wanted="$(desired_hash)"
  if [ -d "$build_dir" ] && { [ ! -f "$stamp" ] || [ "$(cat "$stamp")" != "$wanted" ]; }; then
    rm -rf "$build_dir"
  fi
  if [ ! -d "$build_dir" ]; then
    tar -xjf "$tarball" -C "$work_root"
    (
      cd "$build_dir"
      apply_patch_series
    )
  fi
  printf '%s\n' "$wanted" > "$stamp"
}

configure_source() {
  export CC="$cc_string"
  export CXX="$cxx_string"
  export CFLAGS="-O2 -g -fPIC -DOLIPHAUNT_EMBEDDED"
  export CPPFLAGS="-isysroot $sdk_path $icu_cflags"
  export LDFLAGS="-isysroot $sdk_path -L$icu_prefix/lib"
  export ICU_CFLAGS="$icu_cflags"
  export ICU_LIBS="$icu_libs"

  if [ ! -f "$build_dir/config.status" ]; then
    (
      cd "$build_dir"
      ./configure \
        --host=aarch64-apple-darwin \
        --prefix="$install_dir" \
        --without-readline \
        --with-icu \
        --without-llvm \
        --without-pam \
        --with-openssl=no \
        --without-zlib \
        --disable-nls \
        ac_cv_file__dev_urandom=yes
    ) > "$configure_log" 2>&1
  fi
}

build_icu() {
  oliphaunt_icu_build_target \
    "$icu_source_dir" \
    "$script_dir" \
    "$icu_native_build_dir" \
    "$icu_build_dir" \
    "$icu_prefix" \
    "${OLIPHAUNT_JOBS:-$(sysctl -n hw.ncpu 2>/dev/null || echo 4)}" \
    "ios-simulator-check" \
    "aarch64-apple-darwin" \
    "$cc_string" \
    "$cxx_string" \
    "$ar_path" \
    "$ranlib_path" \
    "-O2 -g -fPIC -DOLIPHAUNT_EMBEDDED" \
    "-O2 -g -fPIC -DOLIPHAUNT_EMBEDDED" \
    "-isysroot $sdk_path"
}

compile_probe_objects() {
  : > "$make_log"
  (
    cd "$build_dir"
    make -C src/backend generated-headers
    make -C src/backend/archive shell_archive.o V=1
    make -C src/backend/access/transam xlogarchive.o V=1
    make -C src/backend/libpq be-secure.o V=1
    make -C src/backend/libpq pqcomm.o V=1
    make -C src/backend/tcop postgres.o V=1
    make -C src/backend/storage/ipc ipc.o V=1
    make -C src/backend/utils/fmgr dfmgr.o V=1
  ) > "$make_log" 2>&1

  if rg -n "warning:|error:" "$make_log" >/dev/null; then
    rg -n "warning:|error:" "$make_log" >&2
    echo "PostgreSQL iOS simulator probe must be warning-clean" >&2
    exit 1
  fi
}

verify_probe_symbols() {
  local source_root="$build_dir/src"
  rg -q --fixed-strings "OLIPHAUNT_EMBEDDED_NO_SHELL_COMMANDS" "$source_root/backend/archive/shell_archive.c"
  rg -q --fixed-strings "OLIPHAUNT_EMBEDDED_NO_SHELL_COMMANDS" "$source_root/backend/access/transam/xlogarchive.c"
  rg -q --fixed-strings "oliphaunt_embedded_main" "$source_root/include/tcop/tcopprot.h"
  rg -q --fixed-strings 'getenv("ICU_DATA")' "$source_root/bin/initdb/initdb.c"
  rg -q --fixed-strings "oliphaunt_static_extension_magic(file_scanner->static_extension)" "$source_root/backend/utils/fmgr/dfmgr.c"
}

prepare_source
build_icu
configure_source
compile_probe_objects
verify_probe_symbols

echo "PostgreSQL 18 iOS simulator embedded probe passed: $build_dir"
