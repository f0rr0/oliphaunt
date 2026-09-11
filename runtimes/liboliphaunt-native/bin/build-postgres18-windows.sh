#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/common.sh"
repo_root="$(oliphaunt_resolve_repo_root "$script_dir")"
cd "$repo_root"
source third-party/postgres/fetch-source.sh
source runtimes/liboliphaunt-native/tools/liboliphaunt-extension-guard.sh

fail() {
  echo "build-postgres18-windows.sh: $*" >&2
  exit 1
}
case "$(uname -s)" in MINGW* | MSYS*) ;; *) fail 'run on Windows in Git Bash with an MSVC developer environment' ;; esac
[ "$#" -le 1 ] || fail 'usage: build-postgres18-windows.sh [--check-current]'
case "${1:-}" in '' | --check-current) ;; *) fail 'usage: build-postgres18-windows.sh [--check-current]' ;; esac
native_path() { cygpath -m "$1"; }
native() { MSYS2_ARG_CONV_EXCL='*' "$@"; }
sha256() { oliphaunt_postgresql_sha256_file "$1"; }
logged() {
  local name="$1"
  shift
  if "$@" >"$work_root/$name" 2>&1; then return; else
    local status=$?
    oliphaunt_tail_log_excerpt "$work_root/$name" 160 >&2
    echo "Windows build failed; see $work_root/$name" >&2
    return "$status"
  fi
}
first_file() {
  local root="$1" pattern result
  shift
  for pattern in "$@"; do
    result="$(find "$root" -type f -name "$pattern" -print | LC_ALL=C sort | sed -n '1p')"
    if [ -n "$result" ]; then
      printf '%s\n' "$result"
      return
    fi
  done
  fail "missing $* under $root"
}

target_id=windows-x64-msvc
work_root="$(cygpath -u "${OLIPHAUNT_WINDOWS_WORK_ROOT:-${OLIPHAUNT_WORK_ROOT:-$repo_root/target/liboliphaunt-pg18-$target_id}}")"
postgres_source="$(bun third-party/postgres/source.mts)"
IFS=$'\t' read -r pg_version pg_sha256 pg_url <<<"$postgres_source"
build_dir="$work_root/postgresql-$pg_version"
runtime_build_dir="$work_root/meson-runtime"
embedded_build_dir="$work_root/meson-embedded"
install_dir="$work_root/install"
out_dir="$work_root/out"
obj_dir="$out_dir/obj"
dll_out="$out_dir/bin/oliphaunt.dll"
import_lib_out="$out_dir/lib/oliphaunt.lib"
embedded_modules_dir="$out_dir/modules"
stamp="$out_dir/oliphaunt-windows.inputs.sha256"
external_checkout_root="$repo_root/target/oliphaunt-sources/checkouts"
icu_windows_root="$external_checkout_root/icu-windows"
build_extensions="${OLIPHAUNT_BUILD_EXTENSIONS:-0}"
native_extension_sql_names="${OLIPHAUNT_NATIVE_EXTENSION_SQL_NAMES:-${OLIPHAUNT_EXTENSION_SQL_NAMES:-}}"
vc_runtime_tool="$repo_root/tools/packaging/windows-vc-runtime-closure.mts"
core_modules=(dict_snowball plpgsql)
icu_dlls=(icudt76.dll icuin76.dll icuuc76.dll)
sources=("$repo_root"/runtimes/liboliphaunt-native/src/*.c)

selected() {
  [ "$build_extensions" != 0 ] || return 1
  [ -n "$native_extension_sql_names" ] || return 0
  local name
  local -a names
  IFS=',' read -r -a names <<<"$native_extension_sql_names"
  for name in "${names[@]}"; do
    name="${name//[[:space:]]/}"
    [ "$name" != "$1" ] || return 0
  done
  return 1
}

configure_tools() {
  : "${VCToolsInstallDir:?Run Git Bash with the Visual Studio x64 developer environment; CI uses setup-msvc}"
  local msvc_bin tool perl_dir
  msvc_bin="$(cygpath -u "$VCToolsInstallDir")/bin/Hostx64/x64"
  for tool in cl.exe link.exe lib.exe dumpbin.exe; do
    [ -f "$msvc_bin/$tool" ] || fail "missing MSVC tool $msvc_bin/$tool"
  done
  # MSVC must precede Git's unrelated link.exe; native Perl must precede MSYS Perl.
  for perl_dir in /c/Strawberry/perl/bin /c/Perl64/bin; do
    if [ -x "$perl_dir/perl.exe" ]; then
      export PATH="$perl_dir:$PATH"
      break
    fi
  done
  export PATH="$msvc_bin:$PATH"
  hash -r
  for tool in cl.exe link.exe lib.exe dumpbin.exe; do
    [ "$(native_path "$(command -v "$tool")")" = "$(native_path "$msvc_bin/$tool")" ] || fail "$tool is not from MSVC"
  done
  case "$(command -v perl.exe)" in */Git/usr/bin/* | /usr/bin/*) fail 'PostgreSQL requires native Windows Perl, not MSYS Perl' ;; esac
  export CC=cl.exe CXX=cl.exe AR=lib.exe CCACHE_DISABLE=1
  for tool in git bun perl.exe meson ninja; do command -v "$tool" >/dev/null || fail "missing build tool: $tool"; done
  [ "$(meson --version | tr -d '\r')" = 1.10.0 ] || fail 'expected Meson 1.10.0'
  local ninja_version
  ninja_version="$(ninja --version | tr -d '\r')"
  case "$ninja_version" in
    1.13.0 | 1.13.0.gd74ef.kitware.jobserver-pipe-1 | 1.13.0.git.kitware.jobserver-pipe-1) ;;
    *) fail "expected Ninja from the pinned 1.13.0 distribution, got $ninja_version" ;;
  esac
  export ICU_ROOT
  ICU_ROOT="$(native_path "$icu_windows_root")"
}

extension_catalog() {
  bun extensions/tools/native-extension-files.mts
}
windows_extension_modules() {
  [ "$build_extensions" != 0 ] || return 0
  local sql_name stem
  while IFS=$'\t' read -r sql_name stem; do
    if selected "$sql_name" && [ "$stem" != - ]; then printf '%s\t%s\n' "$sql_name" "$stem"; fi
  done < <(awk -F '\t' 'NR>1 { print $1 "\t" $2 }' "$catalog")
}
windows_extension_prune() {
  [ "$build_extensions" = 0 ] || return 0
  local sql_name stem data_files item suffix
  while IFS=$'\t' read -r sql_name stem data_files; do
    rm -f "$install_dir/share/postgresql/extension/$sql_name.control" "$install_dir/share/postgresql/extension/$sql_name"--*.sql
    if [ "$stem" != - ]; then
      for suffix in dll so dylib; do rm -f "$install_dir/lib/postgresql/$stem.$suffix"; done
    fi
    if [ "$data_files" != - ]; then
      local -a data
      IFS=',' read -r -a data <<<"$data_files"
      for item in "${data[@]}"; do [ -z "$item" ] || rm -rf "$install_dir/share/postgresql/$item"; done
    fi
  done < <(awk -F '\t' 'NR>1 { print $1 "\t" $2 "\t" $3 }' "$catalog")
  rm -f "$install_dir"/share/postgresql/extension/{postgis*,rtpostgis*,pgtap-*,uninstall_postgis,uninstall_legacy,uninstall_pgtap}.sql
  rm -rf "$install_dir/share/postgresql/contrib" "$install_dir/share/postgresql/proj"
}
windows_extension_base_absent() {
  [ "$build_extensions" = 0 ] || return 0
  oliphaunt_assert_base_runtime_has_no_optional_extensions "$catalog" "$install_dir" || return
  local sql_name
  while IFS= read -r sql_name; do
    if compgen -G "$install_dir/share/postgresql/extension/$sql_name--*.sql" >/dev/null; then return 1; fi
  done < <(awk -F '\t' 'NR>1 { print $1 }' "$catalog")
  [ ! -d "$install_dir/share/postgresql/contrib" ] && [ ! -d "$install_dir/share/postgresql/proj" ]
}

module_binding() {
  [ -f "$1" ] || return 1
  local imports
  imports="$(native dumpbin.exe /dependents "$(native_path "$1")")" || return
  local server=0 embedded=0
  if oliphaunt_text_matches_ere "$imports" '^[[:space:]]*postgres\.exe[[:space:]]*$'; then server=1; fi
  if oliphaunt_text_matches_ere "$imports" '^[[:space:]]*oliphaunt\.dll[[:space:]]*$'; then embedded=1; fi
  case "$server:$embedded" in 0:0) echo neutral ;; 1:0) echo server ;; 0:1) echo embedded ;; *) echo crossed ;; esac
}
module_profiles_ready() {
  local stem="$1" required="$2" server embedded
  server="$(module_binding "$install_dir/lib/postgresql/$stem.dll")" || return
  embedded="$(module_binding "$embedded_modules_dir/$stem.dll")" || return
  case "$server" in server | neutral) ;; *) return 1 ;; esac
  case "$embedded:$required" in embedded:* | neutral:0) ;; *) return 1 ;; esac
  if [ "$(sha256 "$install_dir/lib/postgresql/$stem.dll")" = "$(sha256 "$embedded_modules_dir/$stem.dll")" ]; then
    [ "$server:$embedded" = neutral:neutral ] || return 1
  fi
}
public_exports() {
  sed -nE 's/^OLIPHAUNT_API[[:space:]]+.*[[:space:]*](oliphaunt_[a-z0-9_]+)\(.*/\1/p' runtimes/liboliphaunt-native/include/oliphaunt.h
}
artifact_ready() {
  [ -s "$dll_out" ] && [ -s "$import_lib_out" ] || return 1
  local stem sql_name name exports symbol
  for stem in "${core_modules[@]}"; do module_profiles_ready "$stem" 1 || return; done
  while IFS=$'\t' read -r sql_name stem; do module_profiles_ready "$stem" 0 || return; done < <(windows_extension_modules)
  for name in "${icu_dlls[@]}"; do [ -s "$out_dir/bin/$name" ] || return 1; done
  bun "$vc_runtime_tool" verify --root "$install_dir" --profile provider --search-root "$install_dir/bin" || return
  bun "$vc_runtime_tool" verify --root "$out_dir" --profile provider --search-root "$out_dir/bin" || return
  exports="$(native dumpbin.exe /exports "$(native_path "$dll_out")")" || return
  while IFS= read -r symbol; do
    oliphaunt_text_matches_ere "$exports" "(^|[^A-Za-z0-9_])$symbol([^A-Za-z0-9_]|$)" || return
  done < <(public_exports)
}
runtime_ready() {
  local file
  for file in bin/{initdb,postgres,pg_config}.exe include/pg_config.h share/postgresql/{postgresql.conf.sample,snowball_create.sql,timezone/UTC} lib/postgresql/dict_snowball.dll; do
    [ -s "$install_dir/$file" ] && [ ! -L "$install_dir/$file" ] || return 1
  done
  grep -F '#define USE_ICU 1' "$install_dir/include/pg_config.h" >/dev/null || return
  for file in "$build_dir"/src/backend/snowball/stopwords/*.stop; do
    [ -s "$install_dir/share/postgresql/tsearch_data/${file##*/}" ] || return 1
  done
  for file in "${icu_dlls[@]}"; do [ -s "$install_dir/bin/$file" ] || return 1; done
  [ -f "$install_dir/.oliphaunt-postgres-runtime.sha256" ] && [ "$(cat "$install_dir/.oliphaunt-postgres-runtime.sha256")" = "$desired_hash" ] || return 1
  windows_extension_base_absent
}

write_native_file() {
  printf "[binaries]\nc = 'cl.exe'\ncpp = 'cl.exe'\nar = 'lib.exe'\n" >"$1"
  if [ "$2" = embedded ]; then printf "\n[built-in options]\nc_args = ['/D_CRT_SECURE_NO_WARNINGS']\n" >>"$1"; fi
}
meson_setup() {
  local directory="$1" profile="$2" native_file="$work_root/meson-$2-native.ini"
  write_native_file "$native_file" "$profile"
  local -a options=(--native-file "$(native_path "$native_file")" --prefix "$(native_path "$install_dir")" --buildtype=release -Db_pch=false -Dreadline=disabled -Dicu=enabled -Dldap=disabled -Dllvm=disabled -Dzlib=disabled -Dzstd=disabled -Dlz4=disabled -Dnls=disabled -Dssl=none -Ddocs=disabled -Dtap_tests=disabled -Dplperl=disabled -Dplpython=disabled -Dpltcl=disabled)
  if [ "$profile" = embedded ]; then options+=(-Doliphaunt_embedded=true -Doliphaunt_embedded_module_provider=); fi
  [ -d "$directory" ] || logged "meson-$profile-setup.log" meson setup "$(native_path "$directory")" "$(native_path "$build_dir")" "${options[@]}"
}
stage_icu_runtime() {
  local name
  mkdir -p "$1"
  for name in "${icu_dlls[@]}"; do cp "$icu_windows_root/bin64/$name" "$1/"; done
}
assert_symbol() {
  local symbols
  symbols="$(native dumpbin.exe /symbols "$(native_path "$1")")"
  oliphaunt_text_matches_ere "$symbols" "(^|[^A-Za-z0-9_])_?$2([^A-Za-z0-9_]|$)" || fail "$1 lacks embedded symbol $2"
}
link_embedded() {
  local postgres_lib postgres_def source object stem
  postgres_lib="$(first_file "$embedded_build_dir" postgres_lib.lib postgres_lib.a)"
  postgres_def="$(first_file "$embedded_build_dir" postgres.def)"
  assert_symbol "$postgres_lib" oliphaunt_embedded_main
  mkdir -p "$out_dir/bin" "$out_dir/lib"
  rm -rf "$obj_dir"
  mkdir -p "$obj_dir"
  # Public C functions use the header's dllexport declarations. These two hooks
  # come from PostgreSQL's archive and need explicit exports for embedded modules.
  local -a arguments=(/nologo /DLL /INCREMENTAL:NO "/OUT:$(native_path "$dll_out")" "/IMPLIB:$(native_path "$import_lib_out")" "/PDB:$(native_path "$out_dir/bin/oliphaunt.pdb")" "/DEF:$(native_path "$postgres_def")" "/WHOLEARCHIVE:$(native_path "$postgres_lib")" /EXPORT:oliphaunt_embedded_kill /EXPORT:oliphaunt_embedded_raise)
  for source in "${sources[@]}"; do
    stem="${source##*/}"
    stem="${stem%.c}"
    object="$obj_dir/$stem.obj"
    logged "compile-$stem.log" native cl.exe /nologo /std:c11 /O2 /Zi /MD /DOLIPHAUNT_EMBEDDED /DOLIPHAUNT_BUILTIN_PLPGSQL /DOLIPHAUNT_BUILDING_DLL /D_CRT_SECURE_NO_WARNINGS "/I$(native_path "$repo_root/runtimes/liboliphaunt-native/include")" "/I$(native_path "$repo_root/runtimes/liboliphaunt-native/src")" /c "$(native_path "$source")" "/Fo$(native_path "$object")"
    arguments+=("$(native_path "$object")")
  done
  for stem in pl_comp pl_exec pl_funcs pl_gram pl_handler pl_scanner; do
    local -a matches=()
    while IFS= read -r -d '' object; do matches+=("$object"); done < <(find "$embedded_build_dir/src/pl/plpgsql/src" -type f -name "*$stem.c.obj" -print0)
    [ "${#matches[@]}" = 1 ] || fail "expected one PL/pgSQL object for $stem, found ${#matches[@]}"
    case "$stem" in pl_gram) assert_symbol "${matches[0]}" plpgsql_yyparse ;; pl_handler) assert_symbol "${matches[0]}" plpgsql_call_handler ;; esac
    arguments+=("$(native_path "${matches[0]}")")
  done
  for stem in icuin icuuc icudt; do arguments+=("$(native_path "$icu_windows_root/lib64/$stem.lib")"); done
  arguments+=(ws2_32.lib secur32.lib advapi32.lib shell32.lib user32.lib bcrypt.lib)
  printf '"%s"\r\n' "${arguments[@]}" >"$out_dir/link-oliphaunt.rsp"
  logged link-oliphaunt.log native link.exe "@$(native_path "$out_dir/link-oliphaunt.rsp")"
}
build_modules() {
  local -a stems=("${core_modules[@]}") matches
  local sql_name stem source
  while IFS=$'\t' read -r sql_name stem; do stems+=("$stem"); done < <(windows_extension_modules)
  logged meson-embedded-module-provider.log meson configure "$(native_path "$embedded_build_dir")" "-Doliphaunt_embedded_module_provider=$(native_path "$import_lib_out")"
  logged meson-embedded-modules.log meson compile -C "$(native_path "$embedded_build_dir")" "${stems[@]}"
  rm -rf "$embedded_modules_dir"
  mkdir -p "$embedded_modules_dir"
  for stem in "${stems[@]}"; do
    matches=()
    while IFS= read -r -d '' source; do matches+=("$source"); done < <(find "$embedded_build_dir" -type f -name "$stem.dll" -print0)
    [ "${#matches[@]}" = 1 ] || fail "expected one embedded $stem.dll, found ${#matches[@]}"
    cp "${matches[0]}" "$embedded_modules_dir/$stem.dll"
  done
}

# The extension owner supplies source/Meson generation and optional SQL installation.
source "$repo_root/extensions/artifacts/native/tools/build-windows-extensions.sh"
configure_tools
for required in include/unicode/ucol.h lib64/{icudt,icuin,icuuc}.lib bin64/{icudt76,icuin76,icuuc76}.dll; do
  [ -s "$icu_windows_root/$required" ] || fail "missing pinned Windows ICU dependency $required"
done
catalog="$(mktemp)"
trap 'rm -f "$catalog"' EXIT
extension_catalog >"$catalog"
desired_hash="$(
  set -e
  {
    printf '%s\n' "postgres=$pg_version/$pg_sha256" "target=$target_id" "extensions=$build_extensions/$native_extension_sql_names" "msvc=${VCToolsVersion:-}" "windows_sdk=${WindowsSDKVersion:-}"
    sha256 "$(command -v cl.exe)"
    sha256 "$(command -v link.exe)"
    for input in third-party/postgres/{source.toml,source.mts,fetch-source.sh} runtimes/liboliphaunt-native/postgres/series runtimes/liboliphaunt-native/sources/icu-windows.toml extensions/generated/pgxs-build.tsv extensions/catalog/native-components.toml extensions/tools/native-component-contract.mts runtimes/liboliphaunt-native/tools/liboliphaunt-extension-guard.sh "$vc_runtime_tool" runtimes/liboliphaunt-native/tools/native-runtime-payload-policy.json "$catalog"; do sha256 "$input"; done
    while IFS= read -r patch; do
      case "$patch" in '' | '#'*) continue ;; esac
      sha256 "$patch"
    done <runtimes/liboliphaunt-native/postgres/series
    while IFS= read -r -d '' input; do
      printf '%s\n' "$input"
      sha256 "$input"
    done < <(find runtimes/liboliphaunt-native/src runtimes/liboliphaunt-native/include runtimes/liboliphaunt-native/portable-uuid extensions/artifacts/native/tools -type f ! -name '*.test.*' ! -path '*/fixtures/*' ! -name '*.md' -print0 | sort -z)
    sha256 "${BASH_SOURCE[0]}"
    sha256 runtimes/liboliphaunt-native/bin/common.sh
    if [ "$build_extensions" != 0 ]; then
      while IFS= read -r -d '' input; do
        printf '%s\n' "$input"
        sha256 "$input"
      done < <(find extensions/external third-party/icu third-party/openssl -type f ! -name '*.test.*' ! -path '*/fixtures/*' ! -name '*.md' -print0 | sort -z)
    fi
  } | sha256sum | awk '{print $1}'
)"
if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$desired_hash" ] && runtime_ready && artifact_ready; then
  echo "Windows $target_id liboliphaunt DLL is current"
  exit 0
fi
[ "${1:-}" != --check-current ] || fail "Windows $target_id liboliphaunt DLL is missing or stale"
mkdir -p "$work_root/source"
tarball="$work_root/source/postgresql-$pg_version.tar.bz2"
oliphaunt_fetch_postgresql_source_archive "$tarball" "$pg_version" "$pg_sha256" "$pg_url"
if [ ! -f "$stamp" ] || [ "$(cat "$stamp")" != "$desired_hash" ]; then
  rm -rf "$build_dir" "$runtime_build_dir" "$embedded_build_dir" "$install_dir" "$out_dir" "$work_root/windows-dependencies" "$work_root"/*-windows-build "$work_root/pgtap-windows"
fi
mkdir -p "$out_dir"
if [ ! -d "$build_dir" ]; then
  tar -xjf "$tarball" -C "$work_root" --no-same-owner --no-same-permissions
  git -C "$build_dir" init -q
  while IFS= read -r patch; do
    case "$patch" in '' | '#'*) continue ;; esac
    git -C "$build_dir" apply --whitespace=error-all "$repo_root/$patch"
  done <runtimes/liboliphaunt-native/postgres/series
fi
windows_extension_prepare
if ! runtime_ready; then
  meson_setup "$runtime_build_dir" runtime
  logged meson-runtime-compile.log meson compile -C "$(native_path "$runtime_build_dir")"
  logged meson-runtime-install.log meson install -C "$(native_path "$runtime_build_dir")"
  stage_icu_runtime "$install_dir/bin"
  windows_extension_install
  windows_extension_prune
  printf '%s' "$desired_hash" >"$install_dir/.oliphaunt-postgres-runtime.sha256"
  runtime_ready || fail 'PostgreSQL Windows runtime install is incomplete'
fi
(
  export CFLAGS=''
  meson_setup "$embedded_build_dir" embedded
  logged meson-embedded-bootstrap-provider.log meson configure "$(native_path "$embedded_build_dir")" -Doliphaunt_embedded_module_provider=
  for target in postgres_lib postgres.def plpgsql; do logged "meson-embedded-$target.log" meson compile -C "$(native_path "$embedded_build_dir")" "$target"; done
)
link_embedded
stage_icu_runtime "$out_dir/bin"
build_modules
for directory in "$install_dir" "$out_dir"; do bun "$vc_runtime_tool" stage --root "$directory" --profile provider --destination "$directory/bin"; done
artifact_ready || fail 'Windows DLL or module/VC runtime closure is incomplete'
printf '%s' "$desired_hash" >"$stamp"
echo "$dll_out"
