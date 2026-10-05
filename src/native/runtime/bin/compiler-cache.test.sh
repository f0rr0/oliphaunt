#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fixture="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-compiler-cache.XXXXXX")"
trap 'rm -rf "$fixture"' EXIT

# The desktop builders execute platform setup at top level. Exercise their
# actual compiler setup and recipe bodies without starting PostgreSQL builds.
load_recipe() {
  local body
  body="$(awk -v name="$2" '$0 == name "() {" {copy=1} copy {print} copy && $0 == "}" {exit}' "$1")"
  [ -n "$body" ]
  eval "$body"
}
load_compilers() {
  eval "$(awk -v end="$2" '/^cc=\(/ {copy=1} copy && /^native_cflags=/ {exit} copy {print} copy && end == "strings" && /^cxx_string=/ {exit}' "$1")"
}

mkdir -p "$fixture/bin"
export CAPTURE="$fixture/calls"
cat > "$fixture/bin/compiler" <<'SH'
#!/usr/bin/env bash
printf 'compile=<%s>\n' "$*" >>"$CAPTURE"
while [ "$#" -gt 0 ]; do
  if [ "$1" = -o ]; then printf object >"$2"; break; fi
  shift
done
SH
cat > "$fixture/bin/ccache" <<'SH'
#!/usr/bin/env bash
printf 'cache\n' >>"$CAPTURE"
exec "$@"
SH
cat > "$fixture/bin/cmake" <<'SH'
#!/usr/bin/env bash
printf 'launchers=<%s>/<%s>\n' "$CMAKE_C_COMPILER_LAUNCHER" "$CMAKE_CXX_COMPILER_LAUNCHER" >>"$CAPTURE"
printf 'arg=<%s>\n' "$@" >>"$CAPTURE"
SH
cat > "$fixture/bin/archive" <<'SH'
#!/usr/bin/env bash
if [ "$1" = -static ]; then printf archive >"$3"; else printf archive >"$2"; fi
SH
chmod +x "$fixture/bin/"*
export PATH="$fixture/bin:$PATH"

# Simulate an absent optional cache without depending on the host's installation.
command() {
  if [ "$1" = -v ] && [ "${2:-}" = ccache ] && [ "$cache_available" = 0 ]; then return 1; fi
  builtin command "$@"
}
. "$script_dir/mobile-postgis-extensions.sh"
native_cc="$fixture/bin/compiler"
native_cxx="$native_cc"
unset OLIPHAUNT_POSTGIS_CC
clang_path="$native_cc"
clangxx_path="$native_cc"
sdk_path=/sdk
min_ios=17.0
min_macos=11.0
ndk_root=/ndk
android_api=24
jobs=2
export CMAKE_C_COMPILER_LAUNCHER=inherited-c
export CMAKE_CXX_COMPILER_LAUNCHER=inherited-cxx

for builder in linux macos ios-device ios-simulator android-arm64 macos-static; do
  case "$builder" in
    macos-static) file="$script_dir/build-macos-extension-archives.sh" ;;
    *) file="$script_dir/build-postgres18-$builder.sh" ;;
  esac
  case "$builder" in
    linux|macos) setup_end=native; load_recipe "$file" native_postgis_cmake_install ;;
    *) setup_end=strings ;;
  esac
  for mode in auto missing off 0 custom; do
    cache_available=1
    export OLIPHAUNT_CCACHE="$mode" ccache_bin=/inherited-cache
    case "$mode" in
      missing) cache_available=0; export OLIPHAUNT_CCACHE=auto ;;
      custom) export OLIPHAUNT_CCACHE="$fixture/bin/ccache" ;;
    esac
    load_compilers "$file" "$setup_end"
    case "$mode" in
      auto|custom) expected_launcher="$fixture/bin/ccache" ;;
      *) expected_launcher= ;;
    esac
    [ "$ccache_bin" = "$expected_launcher" ]
    [ "$native_cc" = "$fixture/bin/compiler" ]
    expected_cc="${cc[*]}"
    if [ "$builder" = macos ]; then
      eval "$(awk '/^postgis_cc=|^postgis_cc_string=/ {print}' "$file")"
      [ "$postgis_cc" = "$native_cc" ]
      [ "$postgis_cc_string" = "$expected_cc" ]
      OLIPHAUNT_POSTGIS_CC='/custom/compiler --flag'
      eval "$(awk '/^postgis_cc=|^postgis_cc_string=/ {print}' "$file")"
      [ "$postgis_cc" = "$OLIPHAUNT_POSTGIS_CC" ]
      [ "$postgis_cc_string" = "$OLIPHAUNT_POSTGIS_CC" ]
      unset OLIPHAUNT_POSTGIS_CC
    fi
    : >"$CAPTURE"
    make_log="$fixture/cmake.log"
    postgis_dependency_log="$make_log"
    case "$builder" in
      linux|macos) native_postgis_cmake_install /source /build /install ;;
      *)
        case "$builder" in
          macos-static) oliphaunt_mobile_target=macos-arm64 ;;
          *) oliphaunt_mobile_target="$builder" ;;
        esac
        android_abi=arm64-v8a
        oliphaunt_postgis_cmake_install /source /build /install
        if [ "$builder" = android-arm64 ]; then
          oliphaunt_mobile_target=android-x86_64
          android_abi=x86_64
          oliphaunt_postgis_cmake_install /source /build /install
          grep -F 'arg=<-DANDROID_ABI=x86_64>' "$CAPTURE" >/dev/null
        else
          grep -F "arg=<-DCMAKE_OSX_SYSROOT=$sdk_path>" "$CAPTURE" >/dev/null
        fi
        ;;
    esac
    ! grep '^launchers=' "$CAPTURE" | grep -Fv "launchers=<$expected_launcher>/<$expected_launcher>"
    for language in C CXX; do
      grep -F "arg=<-DCMAKE_${language}_COMPILER_LAUNCHER=$expected_launcher>" "$CAPTURE" >/dev/null
    done
    grep -F 'arg=<-j2>' "$CAPTURE" >/dev/null
    [ "$CMAKE_C_COMPILER_LAUNCHER" = inherited-c ]
    [ "$CMAKE_CXX_COMPILER_LAUNCHER" = inherited-cxx ]
  done
done

# Run the SQLite recipes against a tiny source fixture to check both configure's
# compiler string and the direct compile, including Android's cross flags.
repo_root="$fixture/repo"
source_root="$repo_root/target/oliphaunt-sources/checkouts/sqlite"
mkdir -p "$source_root"
cat >"$source_root/configure" <<'SH'
#!/usr/bin/env bash
[ "$CC" = "$EXPECTED_CC" ]
SH
chmod +x "$source_root/configure"
touch "$source_root/sqlite3.c" "$source_root/sqlite3.h" "$source_root/sqlite3ext.h"
oliphaunt_native_release_cflags() { printf '%s\n' -fPIC; }
oliphaunt_postgis_selected() { return 0; }
native_postgis_dependency_archive() { test -s "$2"; }
rsync() { cp -R "$source_dir/." "$build_root/"; }
make() { return 0; }
ar() { "$fixture/bin/archive" "$@"; }
ranlib() { return 0; }
llvm_ar="$fixture/bin/archive"
llvm_ranlib=/bin/true
for builder in linux macos android-arm64; do
  file="$script_dir/build-postgres18-$builder.sh"
  for mode in custom off; do
    export OLIPHAUNT_CCACHE="$mode"
    [ "$mode" != custom ] || export OLIPHAUNT_CCACHE="$fixture/bin/ccache"
    cache_available=1
    setup_end=native
    [ "$builder" != android-arm64 ] || setup_end=strings
    load_compilers "$file" "$setup_end"
    export EXPECTED_CC="${cc[*]}"
    work_root="$fixture/$builder-$mode"
    native_postgis_dependency_root="$work_root/dependencies"
    mobile_static_dependency_root="$native_postgis_dependency_root"
    mkdir -p "$work_root"
    make_log="$work_root/make.log"
    postgis_dependency_log="$make_log"
    : >"$CAPTURE"
    if [ "$builder" = android-arm64 ]; then
      oliphaunt_mobile_target=android-arm64
      android_host=aarch64-linux-android
      mobile_static_dependency_archives=()
      build_postgis_sqlite_dependency
    else
      load_recipe "$file" build_native_postgis_sqlite_dependency
      build_native_postgis_sqlite_dependency
    fi
    grep -F 'compile=<' "$CAPTURE" >/dev/null
    if [ "$mode" = custom ]; then grep -Fx cache "$CAPTURE" >/dev/null;
    else ! grep -Fx cache "$CAPTURE"; fi
  done
done
printf 'Compiler cache setup, CMake launchers, overrides, and SQLite recipes passed\n'
