#!/usr/bin/env bash
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
cd "$root"
abi_only=0
smoke_only=0
cluster_seeds=0
root_arg=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --abi-only) abi_only=1 ;;
    --smoke-only) smoke_only=1 ;;
    --cluster-seeds) cluster_seeds=1 ;;
    --root)
      root_arg="${2:?--root requires a directory}"
      shift
      ;;
    -h | --help)
      echo 'usage: run-host-c-smoke.sh [--abi-only|--smoke-only] [--cluster-seeds] [--root DIR]'
      exit 0
      ;;
    -*)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
    *)
      [ -z "$root_arg" ] || exit 2
      root_arg="$1"
      ;;
  esac
  shift
done
if [ "$abi_only" = 1 ] && { [ "$smoke_only" = 1 ] || [ "$cluster_seeds" = 1 ]; }; then
  echo '--abi-only cannot be combined with --smoke-only or --cluster-seeds' >&2
  exit 2
fi
case "$(uname -s):$(uname -m)" in
  Darwin:arm64 | Darwin:aarch64)
    platform=macos
    target=macos-arm64
    ;;
  Darwin:x86_64)
    platform=macos
    target=macos-x64
    ;;
  Linux:x86_64 | Linux:amd64)
    platform=linux
    target=linux-x64-gnu
    ;;
  Linux:aarch64 | Linux:arm64)
    platform=linux
    target=linux-arm64-gnu
    ;;
  MINGW*:x86_64 | MSYS*:x86_64 | CYGWIN*:x86_64)
    platform=windows
    target=windows-x64-msvc
    ;;
  *)
    echo 'unsupported native smoke host' >&2
    exit 2
    ;;
esac
absolute() {
  if [ "$platform" = windows ]; then
    cygpath -au "$1"
  else case "$1" in /*) printf '%s\n' "$1" ;; *) printf '%s/%s\n' "$root" "$1" ;; esac fi
}
native_path() {
  if [ "$platform" = windows ]; then cygpath -am "$1"; else printf '%s\n' "$1"; fi
}
require_file() { [ -f "$1" ] || {
  echo "missing required file: $1" >&2
  exit 1
}; }
work_root="$root/target/liboliphaunt-pg18-$target"
[ "$platform" != macos ] || work_root="$root/target/liboliphaunt-pg18"
work_root="$(absolute "${OLIPHAUNT_WORK_ROOT:-$work_root}")"
install_dir="$(absolute "${OLIPHAUNT_INSTALL_DIR:-$work_root/install}")"
exe_suffix=''
case "$platform" in
  windows)
    library="$work_root/out/bin/oliphaunt.dll"
    exe_suffix=.exe
    ;;
  macos) library="$work_root/out/liboliphaunt.dylib" ;;
  linux) library="$work_root/out/liboliphaunt.so" ;;
esac
library="$(absolute "${LIBOLIPHAUNT_PATH:-$library}")"
library_dir="$(dirname "$library")"
out_dir="$library_dir"
[ "$platform" != windows ] || out_dir="$(dirname "$library_dir")"
bin_dir="$(absolute "${OLIPHAUNT_SMOKE_BIN_DIR:-$library_dir}")"
initdb="$(absolute "${OLIPHAUNT_INITDB:-$install_dir/bin/initdb$exe_suffix}")"
postgres="$(absolute "${OLIPHAUNT_POSTGRES:-$install_dir/bin/postgres$exe_suffix}")"
pg_version="$(bun runtimes/liboliphaunt-native/tools/native-smoke-data.mts postgres-version)"
build_dir="$work_root/postgresql-$pg_version"
include_dir="$root/runtimes/liboliphaunt-native/include"
source_dir="$root/runtimes/liboliphaunt-native/src"
smoke_dir="$root/runtimes/liboliphaunt-native/smoke"
require_file "$library"
mkdir -p "$bin_dir"
printf 'liboliphaunt host target: %s\nliboliphaunt work root: %s\n' "$target" "$work_root" >&2

msvc_env_file=''
cluster_root=''
remove_icu=0
smoke_failure_root=''
cleanup() {
  [ -z "$msvc_env_file" ] || rm -f "$msvc_env_file"
  [ -z "$cluster_root" ] || rm -rf "$cluster_root"
  [ "$remove_icu" = 0 ] || rm -rf "$install_dir/share/icu"
  [ -z "$smoke_failure_root" ] || printf 'native smoke root: %s\n' "$smoke_failure_root" >&2
  return 0
}
trap cleanup EXIT
if [ "$platform" = windows ] && ! command -v cl.exe >/dev/null; then
  program_files="$(printenv 'ProgramFiles(x86)')"
  vswhere="$(cygpath -u "$program_files")/Microsoft Visual Studio/Installer/vswhere.exe"
  require_file "$vswhere"
  vs_root="$("$vswhere" -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath)"
  vs_root="${vs_root%$'\r'}"
  [ -n "$vs_root" ] || {
    echo 'Visual Studio Build Tools were not found' >&2
    exit 1
  }
  vs_command="$(cygpath -aw "$vs_root/Common7/Tools/VsDevCmd.bat")"
  msvc_env_file="$(mktemp)"
  MSYS2_ARG_CONV_EXCL='*' cmd.exe /d /s /c "call \"$vs_command\" -arch=x64 -host_arch=x64 >nul && set" >"$msvc_env_file"
  while IFS='=' read -r name value; do
    value="${value%$'\r'}"
    case "$name" in
      PATH | Path)
        PATH="$(cygpath -up "$value")"
        export PATH
        ;;
      INCLUDE | LIB | LIBPATH) export "$name=$value" ;;
    esac
  done <"$msvc_env_file"
  command -v cl.exe >/dev/null
fi
case "$platform" in
  windows) export PATH="$library_dir:$install_dir/bin:$PATH" ;;
  macos) export DYLD_LIBRARY_PATH="$library_dir:$install_dir/lib:${DYLD_LIBRARY_PATH:-}" ;;
  linux) export LD_LIBRARY_PATH="$library_dir:$install_dir/lib:${LD_LIBRARY_PATH:-}" ;;
esac
LIBOLIPHAUNT_PATH="$(native_path "$library")"
OLIPHAUNT_INSTALL_DIR="$(native_path "$install_dir")"
OLIPHAUNT_POSTGRES="$(native_path "$postgres")"
export LIBOLIPHAUNT_PATH OLIPHAUNT_INSTALL_DIR OLIPHAUNT_POSTGRES
export OLIPHAUNT_STREAM_QUEUE_MAX_BYTES="${OLIPHAUNT_STREAM_QUEUE_MAX_BYTES:-4096}"
compile() {
  local kind="$1" name="$2" output="$bin_dir/$2$exe_suffix"
  local source="$smoke_dir/$name.c" include
  local includes=() flags=() compiler=() prefix=()
  if [ "$name" = liboliphaunt_smoke ]; then
    includes=("$source_dir" "$build_dir/src/include" "$work_root/meson-embedded/src/include" "$install_dir/include")
    [ "$platform" != windows ] || includes+=("$build_dir/src/include/port/win32")
  fi
  if [ "$platform" = windows ]; then
    require_file "$out_dir/lib/oliphaunt.lib"
    flags=("/I$(native_path "$include_dir")")
    for include in ${includes[@]+"${includes[@]}"}; do flags+=("/I$(native_path "$include")"); done
    MSYS2_ARG_CONV_EXCL='*' cl.exe /nologo /std:c11 /Zi /MD /D_CRT_SECURE_NO_WARNINGS /DWIN32_LEAN_AND_MEAN \
      "${flags[@]}" "$(native_path "$source")" /link "/LIBPATH:$(native_path "$out_dir/lib")" oliphaunt.lib "/OUT:$(native_path "$output")"
  else
    if [ "$kind" = abi ]; then
      read -r -a compiler <<<"${OLIPHAUNT_ABI_CC:-cc}"
      flags+=(-pedantic)
    else read -r -a compiler <<<"${OLIPHAUNT_SMOKE_CC:-cc}"; fi
    case "${OLIPHAUNT_CCACHE:-auto}" in
      0 | off) ;;
      auto) if command -v ccache >/dev/null; then prefix=(ccache); fi ;;
      *) prefix=("$OLIPHAUNT_CCACHE") ;;
    esac
    for include in ${includes[@]+"${includes[@]}"}; do flags+=(-I "$include"); done
    ${prefix[@]+"${prefix[@]}"} "${compiler[@]}" -std=c11 -Wall -Wextra -Werror -O0 -g -I "$include_dir" \
      ${flags[@]+"${flags[@]}"} "$source" -L "$library_dir" "-Wl,-rpath,$library_dir" -pthread -loliphaunt -o "$output"
  fi
}
if [ "$smoke_only" = 0 ]; then
  compile abi liboliphaunt_abi_conformance
  "$bin_dir/liboliphaunt_abi_conformance$exe_suffix"
fi
[ "$abi_only" = 0 ] || exit 0
require_file "$initdb"
require_file "$postgres"
compile smoke liboliphaunt_smoke
if [ -n "$root_arg" ]; then
  smoke_root="$(absolute "$root_arg")"
else
  scratch="$(absolute "${OLIPHAUNT_SMOKE_ROOT:-$work_root}")"
  mkdir -p "$scratch"
  smoke_root="$(mktemp -d "$scratch/smoke.XXXXXX")"
fi
smoke_failure_root="$smoke_root"
if [ ! -e "$smoke_root/.oliphaunt.json" ]; then
  if [ ! -d "$smoke_root" ] || [ -n "$(ls -A "$smoke_root")" ]; then
    echo "native smoke root is nonempty or missing: $smoke_root" >&2
    exit 1
  fi
  OLIPHAUNT_INTERNAL_SKIP_SYSTEM_COLLATION_DISCOVERY=1 OLIPHAUNT_INTERNAL_SKIP_ICU_DISCOVERY=1 \
    "$initdb" -D "$(native_path "$smoke_root/pgdata")" -U postgres --auth=trust --no-sync --locale-provider=libc --locale=C --encoding=UTF8
  bun runtimes/liboliphaunt-native/tools/native-smoke-data.mts managed-root "$smoke_root"
fi
archive_fixture="$root/runtimes/liboliphaunt-native/smoke/fixtures/physical-archive-native-v1.properties"
require_file "$archive_fixture"
for _attempt in 1 2; do
  "$bin_dir/liboliphaunt_smoke$exe_suffix" "$(native_path "$smoke_root/pgdata")" "$(native_path "$install_dir")" "$(native_path "$archive_fixture")"
done
smoke_failure_root=''
[ -n "$root_arg" ] || rm -rf "$smoke_root"
[ "$cluster_seeds" = 1 ] || exit 0
standard_seed="$(absolute "${OLIPHAUNT_STANDARD_CLUSTER_SEED:?standard cluster seed is required}")"
icu_seed="$(absolute "${OLIPHAUNT_ICU_CLUSTER_SEED:?ICU cluster seed is required}")"
icu_data="$(absolute "${OLIPHAUNT_ICU_DATA_DIR:?ICU data is required}")"
compile smoke liboliphaunt_cluster_seed_smoke
cluster_root="$(mktemp -d)"
if [ ! -e "$install_dir/share/icu" ]; then
  mkdir -p "$install_dir/share"
  remove_icu=1
  cp -R "$icu_data" "$install_dir/share/icu"
fi
for profile in standard icu; do
  seed="$standard_seed"
  [ "$profile" != icu ] || seed="$icu_seed"
  mkdir "$cluster_root/$profile"
  cp -R "$seed/files" "$cluster_root/$profile/pgdata"
  chmod 700 "$cluster_root/$profile/pgdata"
  bun runtimes/liboliphaunt-native/tools/native-smoke-data.mts managed-root "$cluster_root/$profile"
  probe="$(bun runtimes/liboliphaunt-native/tools/native-smoke-data.mts profile "$profile")"
  sql="${probe%$'\n'*}"
  expected="${probe##*$'\n'}"
  for _attempt in 1 2; do
    env -u OLIPHAUNT_ICU_DATA_DIR ICU_DATA=/ambient/unverified-icu \
      "$bin_dir/liboliphaunt_cluster_seed_smoke$exe_suffix" "$(native_path "$cluster_root/$profile/pgdata")" "$(native_path "$install_dir")" "$sql" "$expected"
  done
done
mkdir "$cluster_root/standard-icu-import"
cp -R "$standard_seed/files" "$cluster_root/standard-icu-import/pgdata"
chmod 700 "$cluster_root/standard-icu-import/pgdata"
bun runtimes/liboliphaunt-native/tools/native-smoke-data.mts managed-root "$cluster_root/standard-icu-import"
for _attempt in 1 2; do
  ICU_DATA=/ambient/unverified-icu OLIPHAUNT_INTERNAL_SKIP_SYSTEM_COLLATION_DISCOVERY=1 \
    "$bin_dir/liboliphaunt_cluster_seed_smoke$exe_suffix" "$(native_path "$cluster_root/standard-icu-import/pgdata")" "$(native_path "$install_dir")" \
    "SELECT pg_import_system_collations('pg_catalog'); SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_collation WHERE collname LIKE '%-x-icu') THEN 'OLIPHAUNT_ICU_IMPORT_OK' ELSE 'OLIPHAUNT_ICU_IMPORT_MISSING' END" OLIPHAUNT_ICU_IMPORT_OK
done
printf 'native standard and ICU cluster seeds passed open, catalog, close, and reopen qualification\n' >&2
