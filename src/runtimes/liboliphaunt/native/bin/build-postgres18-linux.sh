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

case "$(uname -s):$(uname -m)" in
  Linux:x86_64|Linux:amd64)
    target_id="linux-x64-gnu"
    linux_host="x86_64-unknown-linux-gnu"
    ;;
  Linux:aarch64|Linux:arm64)
    target_id="linux-arm64-gnu"
    linux_host="aarch64-unknown-linux-gnu"
    ;;
  *)
    echo "build-postgres18-linux.sh: unsupported Linux target $(uname -s)/$(uname -m)" >&2
    exit 2
    ;;
esac

work_root="${OLIPHAUNT_LINUX_WORK_ROOT:-${OLIPHAUNT_WORK_ROOT:-$repo_root/target/liboliphaunt-pg18-$target_id}}"
source_cache="$work_root/source"
tarball="$source_cache/postgresql-${pg_version}.tar.bz2"
build_dir="$work_root/postgresql-${pg_version}"
install_dir="$work_root/install"
out_dir="$work_root/out"
embedded_modules_dir="$out_dir/modules"
objects_rsp="$out_dir/liboliphaunt-$target_id-objects.rsp"
lib_out="$out_dir/liboliphaunt.so"
stamp="$build_dir/.liboliphaunt-$target_id-build.sha256"
runtime_stamp="$install_dir/.oliphaunt-postgres-runtime.sha256"
extension_build_stamp="$out_dir/native-extension-artifacts.sha256"
postgis_dependency_log="$work_root/postgis-native-dependencies.log"
configure_log="$work_root/configure.log"
make_log="$work_root/make.log"
script_mode="${1:-build}"

icu_source_dir="$(oliphaunt_icu_source_dir "$repo_root")"
icu_native_build_dir="$work_root/icu-native"
icu_build_dir="$work_root/icu-$target_id-build"
icu_prefix="$work_root/icu-$target_id"
icu_data_dir="$work_root/icu/share/icu"
icu_cflags="$(oliphaunt_icu_cflags "$icu_prefix")"
icu_static_libs="$(oliphaunt_icu_static_libs "$icu_prefix")"
icu_cpp_libs="-lstdc++"
icu_libs="$icu_static_libs $icu_cpp_libs"

liboliphaunt_sources=(
  "$repo_root/src/runtimes/liboliphaunt/native/src/liboliphaunt_native.c"
  "$repo_root/src/runtimes/liboliphaunt/native/src/liboliphaunt_runtime.c"
  "$repo_root/src/runtimes/liboliphaunt/native/src/liboliphaunt_protocol.c"
  "$repo_root/src/runtimes/liboliphaunt/native/src/liboliphaunt_bootstrap.c"
  "$repo_root/src/runtimes/liboliphaunt/native/src/liboliphaunt_process.c"
  "$repo_root/src/runtimes/liboliphaunt/native/src/liboliphaunt_trace.c"
  "$repo_root/src/runtimes/liboliphaunt/native/src/liboliphaunt_fs.c"
  "$repo_root/src/runtimes/liboliphaunt/native/src/liboliphaunt_archive.c"
  "$repo_root/src/runtimes/liboliphaunt/native/src/liboliphaunt_archive_tar.c"
  "$repo_root/src/runtimes/liboliphaunt/native/src/liboliphaunt_static_extensions.c"
  "$repo_root/src/runtimes/liboliphaunt/native/src/liboliphaunt_builtin_extensions.c"
)

plpgsql_objects=(
  src/pl/plpgsql/src/pl_comp.o
  src/pl/plpgsql/src/pl_exec.o
  src/pl/plpgsql/src/pl_funcs.o
  src/pl/plpgsql/src/pl_gram.o
  src/pl/plpgsql/src/pl_handler.o
  src/pl/plpgsql/src/pl_scanner.o
)

jit_objects=(src/backend/jit/jit.o)

contrib_extensions=(
  amcheck
  auto_explain
  bloom
  btree_gin
  btree_gist
  citext
  cube
  dict_int
  dict_xsyn
  earthdistance
  file_fdw
  fuzzystrmatch
  hstore
  intarray
  isn
  lo
  ltree
  pageinspect
  pg_buffercache
  pg_freespacemap
  pgcrypto
  uuid-ossp
  pg_surgery
  pg_trgm
  pg_visibility
  pg_walinspect
  seg
  tablefunc
  tcn
  tsm_system_rows
  tsm_system_time
  unaccent
)

external_extensions=(
  pg_ivm
  pg_hashids
  pg_uuidv7
  pgtap
  pgvector
  pg_textsearch
  postgis
)

required_extension_controls=(
  amcheck
  bloom
  btree_gin
  btree_gist
  citext
  cube
  dict_int
  dict_xsyn
  earthdistance
  file_fdw
  fuzzystrmatch
  hstore
  intarray
  isn
  lo
  ltree
  pageinspect
  pg_buffercache
  pg_freespacemap
  pg_hashids
  pg_ivm
  pgcrypto
  postgis
  pg_surgery
  pg_textsearch
  pg_trgm
  pg_uuidv7
  pg_visibility
  pg_walinspect
  pgtap
  seg
  tablefunc
  tcn
  tsm_system_rows
  tsm_system_time
  unaccent
  uuid-ossp
  vector
)

required_extension_modules=(
  _int
  amcheck
  auto_explain
  bloom
  btree_gin
  btree_gist
  citext
  cube
  dict_int
  dict_xsyn
  earthdistance
  file_fdw
  fuzzystrmatch
  hstore
  isn
  lo
  ltree
  pageinspect
  pg_buffercache
  pg_freespacemap
  pg_hashids
  pg_ivm
  pgcrypto
  postgis-3
  pg_surgery
  pg_textsearch
  pg_trgm
  pg_uuidv7
  pg_visibility
  pg_walinspect
  seg
  tablefunc
  tcn
  tsm_system_rows
  tsm_system_time
  unaccent
  uuid-ossp
  vector
)

native_extension_filter_fail() {
  echo "build-postgres18-linux.sh: $*" >&2
  exit 1
}

native_extensions_include_postgis() {
  local extension
  for extension in "${external_extensions[@]}"; do
    [ "$extension" != "postgis" ] || return 0
  done
  return 1
}

native_extension_has_control_artifacts() {
  case "$1" in
    auto_explain) return 1 ;;
    *) return 0 ;;
  esac
}

filter_native_extension_selection() {
  local raw="${OLIPHAUNT_NATIVE_EXTENSION_SQL_NAMES:-${OLIPHAUNT_EXTENSION_SQL_NAMES:-}}"
  [ -n "$raw" ] || return 0

  local contrib_plan="$repo_root/src/extensions/generated/contrib-build.tsv"
  local pgxs_plan="$repo_root/src/extensions/generated/pgxs-build.tsv"
  local -a selected_contrib=()
  local -a selected_external=()
  local -a selected_controls=()
  local -a selected_modules=()
  local sql contrib_dir external_id module_file module_stem

  while IFS= read -r sql; do
    sql="$(printf '%s' "$sql" | xargs)"
    [ -n "$sql" ] || continue
    if native_extension_has_control_artifacts "$sql"; then
      selected_controls+=("$sql")
    fi

    contrib_dir="$(awk -F '\t' -v sql="$sql" 'NR > 1 && $2 == sql { print $3; found = 1; exit } END { exit found ? 0 : 1 }' "$contrib_plan" || true)"
    if [ -n "$contrib_dir" ]; then
      selected_contrib+=("$contrib_dir")
      module_file="$(awk -F '\t' -v sql="$sql" 'NR > 1 && $2 == sql { print $4; found = 1; exit } END { exit found ? 0 : 1 }' "$contrib_plan" || true)"
    else
      case "$sql" in
        postgis)
          selected_external+=(postgis)
          module_file="postgis-3.so"
          ;;
        *)
          external_id="$(awk -F '\t' -v sql="$sql" 'NR > 1 && $2 == sql { print $1; found = 1; exit } END { exit found ? 0 : 1 }' "$pgxs_plan" || true)"
          [ -n "$external_id" ] || native_extension_filter_fail "unknown native extension selection: $sql"
          selected_external+=("$external_id")
          module_file="$(awk -F '\t' -v sql="$sql" 'NR > 1 && $2 == sql { print $4; found = 1; exit } END { exit found ? 0 : 1 }' "$pgxs_plan" || true)"
          ;;
      esac
    fi

    if [ -n "$module_file" ] && [ "$module_file" != "-" ]; then
      module_stem="${module_file%.*}"
      selected_modules+=("$module_stem")
    fi
  done < <(printf '%s\n' "$raw" | tr ',' '\n')

  [ "${#selected_controls[@]}" -gt 0 ] ||
    [ "${#selected_modules[@]}" -gt 0 ] ||
    native_extension_filter_fail "OLIPHAUNT_NATIVE_EXTENSION_SQL_NAMES did not select any extensions"
  contrib_extensions=()
  external_extensions=()
  required_extension_controls=()
  required_extension_modules=()
  if [ "${#selected_contrib[@]}" -gt 0 ]; then
    contrib_extensions=("${selected_contrib[@]}")
  fi
  if [ "${#selected_external[@]}" -gt 0 ]; then
    external_extensions=("${selected_external[@]}")
  fi
  if [ "${#selected_controls[@]}" -gt 0 ]; then
    required_extension_controls=("${selected_controls[@]}")
  fi
  if [ "${#selected_modules[@]}" -gt 0 ]; then
    required_extension_modules=("${selected_modules[@]}")
  fi
}

filter_native_extension_selection

if [ "$script_mode" = "--print-required-extension-artifacts" ]; then
  for extension in "${required_extension_controls[@]}"; do
    printf 'control:%s\n' "$extension"
  done
  for module in "${required_extension_modules[@]}"; do
    printf 'module:%s\n' "$module"
  done
  exit 0
fi

fail() {
  echo "build-postgres18-linux.sh: $*" >&2
  exit 1
}

for cmd in cc c++ curl git make nm patch perl readelf rg shasum tar; do
  command -v "$cmd" >/dev/null 2>&1 || fail "missing required command: $cmd"
done

[ "$(uname -s)" = "Linux" ] || fail "Linux native build must run on Linux"
oliphaunt_icu_require_source "$icu_source_dir"

native_cc="${OLIPHAUNT_CC:-cc}"
native_cxx="${OLIPHAUNT_CXX:-c++}"
cc=("$native_cc")
cxx=("$native_cxx")
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
native_cflags="$(oliphaunt_native_release_cflags -fPIC -DOLIPHAUNT_EMBEDDED)"
postgres_embedded_copt="$(oliphaunt_native_release_cflags -fPIC -DOLIPHAUNT_EMBEDDED | sed 's/^-O2 //')"
liboliphaunt_cflags="$native_cflags -DOLIPHAUNT_BUILTIN_PLPGSQL"
embedded_module_be_dllibs="-Wl,--no-as-needed -Wl,-z,defs -L$out_dir -Wl,-rpath,$out_dir -loliphaunt"
normal_module_be_dllibs=""
jobs="${OLIPHAUNT_JOBS:-$(nproc 2>/dev/null || echo 4)}"
portable_uuid_dir="$repo_root/src/runtimes/liboliphaunt/native/portable-uuid"
native_uuid_dependency_dir="$work_root/portable-uuid-native"
native_uuid_archive="$native_uuid_dependency_dir/lib/libuuid.a"

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
    printf 'target_id=%s\n' "$target_id"
    printf 'linux_host=%s\n' "$linux_host"
    printf 'cc=%s\n' "$cc_string"
    printf 'cxx=%s\n' "$cxx_string"
    printf 'icu_source=%s\n' "$(oliphaunt_icu_source_commit "$icu_source_dir")"
    printf 'icu_script=%s\n' "$(oliphaunt_icu_script_sha256 "$script_dir")"
    printf 'native_cflags=%s\n' "$native_cflags"
    printf 'postgres_embedded_copt=%s\n' "$postgres_embedded_copt"
    printf 'liboliphaunt_cflags=%s\n' "$liboliphaunt_cflags"
    printf 'embedded_module_be_dllibs=%s\n' "$embedded_module_be_dllibs"
    printf 'patch_series_hash=%s\n' "$(patch_series_hash)"
    shasum -a 256 "$script_dir/$(basename "$0")"
    printf 'liboliphaunt_sources=%s\n' "${liboliphaunt_sources[*]}"
    shasum -a 256 "$source_manifest"
    shasum -a 256 "${liboliphaunt_sources[@]}"
  } | shasum -a 256 | awk '{print $1}'
}

hash_extension_source_tree() {
  local source_dir="$1"
  [ -d "$source_dir" ] || return 0
  find "$source_dir" -type f \( \
    -name "CMakeLists.txt" -o \
    -name "configure" -o \
    -name "*.c" -o \
    -name "*.cc" -o \
    -name "*.cpp" -o \
    -name "*.h" -o \
    -name "*.hpp" -o \
    -name "*.sql" -o \
    -name "*.control" -o \
    -name "*.in" -o \
    -name "Makefile" -o \
    -name "*.mk" \
  \) -print |
    LC_ALL=C sort |
    while IFS= read -r file; do
      shasum -a 256 "$file"
    done
}

extension_build_fingerprint() {
  {
    printf 'pg_version=%s\n' "$pg_version"
    printf 'target_id=%s\n' "$target_id"
    printf 'cc=%s\n' "$cc_string"
    printf 'cxx=%s\n' "$cxx_string"
    printf 'normal_be_dllibs=%s\n' "$normal_module_be_dllibs"
    printf 'embedded_be_dllibs=%s\n' "$embedded_module_be_dllibs"
    printf 'base_hash=%s\n' "$(desired_hash)"
    shasum -a 256 "$script_dir/$(basename "$0")"
    shasum -a 256 "$repo_root/src/runtimes/liboliphaunt/native/include/oliphaunt.h"
    shasum -a 256 "$repo_root/src/runtimes/liboliphaunt/native/src/liboliphaunt_internal.h"
    printf 'contrib_extensions=%s\n' "${contrib_extensions[*]}"
    printf 'external_extensions=%s\n' "${external_extensions[*]}"
    local extension dependency
    for extension in "${contrib_extensions[@]}"; do
      printf 'contrib:%s\n' "$extension"
      hash_extension_source_tree "$build_dir/contrib/$extension"
    done
    for extension in "${external_extensions[@]}"; do
      printf 'external:%s\n' "$extension"
      hash_extension_source_tree "$repo_root/target/oliphaunt-sources/checkouts/$extension"
    done
    if native_extensions_include_postgis; then
      for dependency in geos proj sqlite json-c libxml2; do
        if [ -d "$repo_root/target/oliphaunt-sources/checkouts/$dependency" ]; then
          printf 'postgis-dependency:%s\n' "$dependency"
          hash_extension_source_tree "$repo_root/target/oliphaunt-sources/checkouts/$dependency"
        fi
      done
    fi
    hash_extension_source_tree "$portable_uuid_dir"
  } | shasum -a 256 | awk '{print $1}'
}

apply_patch_series() {
  local patch_name
  while IFS= read -r patch_name; do
    [ -n "$patch_name" ] || continue
    GIT_CEILING_DIRECTORIES="$work_root" git apply --recount --whitespace=nowarn "$patch_dir/$patch_name" >/dev/null
  done < <(patch_series)
}

patched_source_ready() {
  grep -Fq 'OliphauntEmbeddedIO' "$build_dir/src/include/libpq/libpq-be.h" &&
    grep -Fq 'oliphaunt_embedded_main' "$build_dir/src/backend/tcop/postgres.c" &&
    grep -Fq 'getenv("ICU_DATA")' "$build_dir/src/bin/initdb/initdb.c" &&
    grep -Fq 'oliphaunt_embedded' "$build_dir/meson_options.txt" &&
    grep -Fq 'OLIPHAUNT_EMBEDDED' "$build_dir/meson.build"
}

prepare_source() {
  mkdir -p "$source_cache" "$work_root" "$out_dir"
  if [ ! -f "$tarball" ]; then
    curl -L --fail --silent --show-error "$pg_url" -o "$tarball"
  fi
  (
    cd "$source_cache"
    printf '%s  %s\n' "$pg_sha256" "postgresql-${pg_version}.tar.bz2" | shasum -a 256 -c -
  ) >&2

  local wanted
  wanted="$(desired_hash)"
  if [ -d "$build_dir" ] && { [ ! -f "$stamp" ] || [ "$(cat "$stamp")" != "$wanted" ]; }; then
    rm -rf "$build_dir"
  fi
  if [ ! -d "$build_dir" ]; then
    tar -xjf "$tarball" -C "$work_root"
    (
      cd "$build_dir"
      git init -q
      apply_patch_series
    )
  fi
  patched_source_ready || fail "PostgreSQL embedded patch verification failed"
}

build_icu() {
  oliphaunt_icu_build_target \
    "$icu_source_dir" \
    "$script_dir" \
    "$icu_native_build_dir" \
    "$icu_build_dir" \
    "$icu_prefix" \
    "$jobs" \
    "$target_id" \
    "$linux_host" \
    "$cc_string" \
    "$cxx_string" \
    "ar" \
    "ranlib" \
    "$native_cflags" \
    "$native_cflags -std=c++17" \
    ""
}

configure_source() {
  if [ ! -f "$build_dir/config.status" ]; then
    (
      cd "$build_dir"
      CPPFLAGS="$icu_cflags" \
      LDFLAGS="-L$icu_prefix/lib" \
      ICU_CFLAGS="$icu_cflags" \
      ICU_LIBS="$icu_libs" \
      CC="$cc_string" \
      CXX="$cxx_string" \
        ./configure \
          --prefix="$install_dir" \
          --without-readline \
          --with-icu \
          --without-llvm \
          --without-pam \
          --with-openssl=no \
          --without-zlib \
          --disable-nls
    ) > "$configure_log" 2>&1
  fi
}

runtime_installed() {
  [ -x "$install_dir/bin/initdb" ] &&
    [ -x "$install_dir/bin/postgres" ] &&
    [ -f "$install_dir/share/postgresql/postgresql.conf.sample" ] &&
    oliphaunt_icu_files_data_ready "$icu_data_dir" &&
    [ -f "$runtime_stamp" ] &&
    [ "$(cat "$runtime_stamp")" = "$(desired_hash)" ] &&
    "$install_dir/bin/pg_config" --configure 2>/dev/null | rg -q -- "--with-icu" &&
    { [ "${OLIPHAUNT_BUILD_EXTENSIONS:-0}" != "0" ] || base_runtime_optional_extensions_absent; }
}

explain_runtime_install_state() {
  local wanted
  wanted="$(desired_hash)"
  for required in \
    "$install_dir/bin/initdb" \
    "$install_dir/bin/postgres" \
    "$install_dir/bin/pg_config"
  do
    if [ ! -x "$required" ]; then
      echo "missing executable runtime file: $required" >&2
    fi
  done
  if [ ! -f "$install_dir/share/postgresql/postgresql.conf.sample" ]; then
    echo "missing runtime file: $install_dir/share/postgresql/postgresql.conf.sample" >&2
  fi
  if ! oliphaunt_icu_files_data_ready "$icu_data_dir"; then
    echo "missing native ICU sidecar data files under $icu_data_dir" >&2
  fi
  if [ ! -f "$runtime_stamp" ]; then
    echo "missing runtime stamp: $runtime_stamp" >&2
  elif [ "$(cat "$runtime_stamp")" != "$wanted" ]; then
    echo "stale runtime stamp: $runtime_stamp" >&2
  fi
  if [ -x "$install_dir/bin/pg_config" ] &&
     ! "$install_dir/bin/pg_config" --configure 2>/dev/null | rg -q -- "--with-icu"; then
    echo "installed PostgreSQL runtime was not configured with ICU" >&2
    "$install_dir/bin/pg_config" --configure >&2 || true
  fi
}

install_runtime() {
  runtime_installed && return 0
  (
    cd "$build_dir"
    : > "$make_log"
    make clean CC="$cc_string" >> "$make_log" 2>&1 || true
    make -j"$jobs" CC="$cc_string" >> "$make_log" 2>&1
    make install CC="$cc_string" >> "$make_log" 2>&1
  )
  oliphaunt_icu_stage_data "$icu_prefix" "$icu_data_dir"
  rm -rf "$install_dir/share/icu"
  prune_base_runtime_optional_extensions
  desired_hash > "$runtime_stamp"
  if ! runtime_installed; then
    explain_runtime_install_state
    tail -120 "$make_log" >&2 || true
    fail "PostgreSQL Linux runtime install is incomplete; see $make_log"
  fi
}

backend_objects_ready() {
  for required in \
    src/backend/tcop/postgres.o \
    src/backend/libpq/be-secure.o \
    src/backend/libpq/pqcomm.o \
    src/common/libpgcommon_srv.a \
    src/port/libpgport_srv.a
  do
    [ -f "$required" ] || return 1
  done
  for objfile in src/backend/*/objfiles.txt; do
    [ -s "$objfile" ] || return 1
  done
}

explain_backend_object_state() {
  local required objfile
  for required in \
    src/backend/tcop/postgres.o \
    src/backend/libpq/be-secure.o \
    src/backend/libpq/pqcomm.o \
    src/common/libpgcommon_srv.a \
    src/port/libpgport_srv.a
  do
    if [ ! -f "$required" ]; then
      echo "missing backend object/library: $build_dir/$required" >&2
    fi
  done

  for objfile in src/backend/*/objfiles.txt; do
    if [ ! -s "$objfile" ]; then
      echo "missing or empty backend object list: $build_dir/$objfile" >&2
    fi
  done

  echo "backend objects were built, but required object files or object lists are incomplete" >&2
}

plpgsql_objects_ready() {
  local object
  for object in "${plpgsql_objects[@]}"; do
    [ -f "$object" ] || return 1
  done
  nm -g src/pl/plpgsql/src/pl_handler.o | rg -q "plpgsql_call_handler" || return 1
}

jit_objects_ready() {
  local object
  for object in "${jit_objects[@]}"; do
    [ -f "$object" ] || return 1
  done
  nm -g src/backend/jit/jit.o | rg -q "pg_jit_available" || return 1
}

build_backend_objects() {
  (
    cd "$build_dir"
    : > "$make_log"
    make -C src/backend clean >> "$make_log" 2>&1 || true
    make -C src/common clean >> "$make_log" 2>&1 || true
    make -C src/port clean >> "$make_log" 2>&1 || true
    rm -f src/include/nodes/header-stamp src/include/utils/header-stamp
    make -C src/backend generated-headers CC="$cc_string" >> "$make_log" 2>&1
    set +e
    make -j"$jobs" -C src/backend \
      CC="$cc_string" \
      CUSTOM_COPT="$postgres_embedded_copt" \
      postgres >> "$make_log" 2>&1
    local make_status=$?
    set -e
    make -C src/common CC="$cc_string" CUSTOM_COPT="$postgres_embedded_copt" libpgcommon_srv.a >> "$make_log" 2>&1
    make -C src/port CC="$cc_string" CUSTOM_COPT="$postgres_embedded_copt" libpgport_srv.a >> "$make_log" 2>&1
    backend_objects_ready || {
      explain_backend_object_state
      tail -120 "$make_log" >&2 || true
      fail "PostgreSQL Linux backend objects are incomplete"
    }
    if [ "$make_status" -ne 0 ]; then
      echo "PostgreSQL $target_id executable link failed after objects were produced; continuing with shared library link" >&2
    fi
  )
}

build_timezone_objects() {
  (
    cd "$build_dir"
    make -C src/timezone clean >> "$make_log" 2>&1 || true
    make -C src/timezone CC="$cc_string" CUSTOM_COPT="$postgres_embedded_copt" localtime.o pgtz.o strftime.o >> "$make_log" 2>&1
  )
}

build_plpgsql_objects() {
  (
    cd "$build_dir"
    if plpgsql_objects_ready; then
      echo "reusing PostgreSQL $target_id PL/pgSQL objects" >&2
      return
    fi
    make -C src/pl/plpgsql/src clean >> "$make_log" 2>&1
    make -C src/pl/plpgsql/src \
      CC="$cc_string" \
      CUSTOM_COPT="$postgres_embedded_copt" \
      pl_comp.o pl_exec.o pl_funcs.o pl_gram.o pl_handler.o pl_scanner.o >> "$make_log" 2>&1
    plpgsql_objects_ready || {
      tail -120 "$make_log" >&2 || true
      fail "PostgreSQL Linux PL/pgSQL objects are incomplete"
    }
  )
}

module_depends_on_liboliphaunt() {
  local module="$1"
  [ -f "$module" ] || return 1
  readelf -d "$module" 2>/dev/null |
    rg -q 'Shared library: \[liboliphaunt\.so\]'
}

native_extension_artifacts_ready() {
  local extension module
  for extension in "${required_extension_controls[@]}"; do
    [ -f "$install_dir/share/postgresql/extension/$extension.control" ] || return 1
    compgen -G "$install_dir/share/postgresql/extension/$extension--*.sql" >/dev/null || return 1
  done

  for module in "${required_extension_modules[@]}"; do
    [ -f "$install_dir/lib/postgresql/$module.so" ] || return 1
    module_depends_on_liboliphaunt "$install_dir/lib/postgresql/$module.so" && return 1
    [ -f "$embedded_modules_dir/$module.so" ] || return 1
    module_depends_on_liboliphaunt "$embedded_modules_dir/$module.so" || return 1
  done
  if native_extensions_include_postgis; then
    [ -f "$install_dir/share/postgresql/proj/proj.db" ] || return 1
  fi
}

base_runtime_optional_extensions_absent() {
  local extension module
  for extension in "${required_extension_controls[@]}"; do
    [ ! -f "$install_dir/share/postgresql/extension/$extension.control" ] || return 1
  done
  for module in "${required_extension_modules[@]}"; do
    [ ! -f "$install_dir/lib/postgresql/$module.so" ] || return 1
  done
  [ ! -d "$install_dir/share/postgresql/contrib" ] || return 1
  [ ! -d "$install_dir/share/postgresql/proj" ] || return 1
}

prune_base_runtime_optional_extensions() {
  [ "${OLIPHAUNT_BUILD_EXTENSIONS:-0}" = "0" ] || return 0

  local extension_dir="$install_dir/share/postgresql/extension"
  local module_dir="$install_dir/lib/postgresql"
  local extension module
  if [ -d "$extension_dir" ]; then
    for extension in "${required_extension_controls[@]}"; do
      rm -f "$extension_dir/$extension.control"
      rm -f "$extension_dir/$extension--"*.sql
    done
    rm -f "$extension_dir/postgis"*.sql "$extension_dir/rtpostgis"*.sql
    rm -f "$extension_dir/uninstall_postgis.sql" "$extension_dir/uninstall_legacy.sql"
    rm -f "$extension_dir/pgtap-"*.sql "$extension_dir/uninstall_pgtap.sql"
  fi
  if [ -d "$module_dir" ]; then
    for module in "${required_extension_modules[@]}"; do
      rm -f "$module_dir/$module.so"
    done
  fi
  rm -rf "$install_dir/share/postgresql/contrib" "$install_dir/share/postgresql/proj"
}

native_extension_artifacts_current() {
  [ -d "$build_dir" ] || return 1
  [ -x "$install_dir/bin/postgres" ] || return 1
  [ -f "$lib_out" ] || return 1
  [ -f "$extension_build_stamp" ] || return 1
  local wanted
  wanted="$(extension_build_fingerprint)" || return 1
  [ "$(cat "$extension_build_stamp")" = "$wanted" ] || return 1
  native_extension_artifacts_ready || return 1
}

embedded_plpgsql_module_ready() {
  module_depends_on_liboliphaunt "$embedded_modules_dir/plpgsql.so"
}

build_embedded_plpgsql_module() {
  (
    cd "$build_dir"
    if embedded_plpgsql_module_ready; then
      echo "reusing PostgreSQL $target_id embedded PL/pgSQL module" >&2
      return
    fi
    make -C src/pl/plpgsql/src clean >> "$make_log" 2>&1
    make -C src/pl/plpgsql/src \
      CC="$cc_string" \
      CUSTOM_COPT="$postgres_embedded_copt" \
      BE_DLLLIBS="$embedded_module_be_dllibs" \
      all >> "$make_log" 2>&1
    mkdir -p "$embedded_modules_dir"
    cp -p src/pl/plpgsql/src/plpgsql.so "$embedded_modules_dir/plpgsql.so"
    embedded_plpgsql_module_ready || {
      tail -120 "$make_log" >&2 || true
      fail "PostgreSQL Linux embedded PL/pgSQL module is not linked against liboliphaunt"
    }
  )
}

copy_embedded_modules_from_dir() {
  local source_dir="$1"
  mkdir -p "$embedded_modules_dir"
  while IFS= read -r module; do
    [ -n "$module" ] || continue
    cp -p "$module" "$embedded_modules_dir/$(basename "$module")"
  done < <(find "$source_dir" -maxdepth 1 -type f -name "*.so" -print)
}

native_openssl_prefix() {
  local candidate
  for candidate in "${OLIPHAUNT_OPENSSL_PREFIX:-}" /usr/local /usr; do
    [ -n "$candidate" ] || continue
    if [ -f "$candidate/include/openssl/evp.h" ] &&
      { [ -f "$candidate/lib/libcrypto.a" ] || [ -f "$candidate/lib64/libcrypto.a" ] || [ -f "$candidate/lib/libcrypto.so" ] || [ -f "$candidate/lib64/libcrypto.so" ]; }; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

configure_pgcrypto_make_args() {
  pgcrypto_make_args=()
  if command -v pkg-config >/dev/null 2>&1 && pkg-config --exists openssl; then
    pgcrypto_make_args=(
      "PG_CPPFLAGS=$(pkg-config --cflags openssl)"
      "PG_LDFLAGS=$(pkg-config --libs openssl)"
    )
    return
  fi

  local openssl_prefix lib_dir
  openssl_prefix="$(native_openssl_prefix)" || fail "pgcrypto requires OpenSSL headers and libcrypto; install openssl-devel/libssl-dev or set OLIPHAUNT_OPENSSL_PREFIX"
  lib_dir="$openssl_prefix/lib"
  [ -d "$openssl_prefix/lib64" ] && lib_dir="$openssl_prefix/lib64"
  if [ -f "$lib_dir/libcrypto.a" ]; then
    pgcrypto_make_args=("PG_CPPFLAGS=-I$openssl_prefix/include" "PG_LDFLAGS=$lib_dir/libcrypto.a")
  else
    pgcrypto_make_args=("PG_CPPFLAGS=-I$openssl_prefix/include" "PG_LDFLAGS=-L$lib_dir" "LIBS=-lcrypto")
  fi
}

build_native_uuid_dependency() {
  local object="$native_uuid_dependency_dir/portable_uuid.o"
  if [ -f "$native_uuid_archive" ] && [ -d "$native_uuid_dependency_dir/include/uuid" ]; then
    return 0
  fi
  [ -f "$portable_uuid_dir/portable_uuid.c" ] || fail "portable UUID source is missing: $portable_uuid_dir"
  rm -rf "$native_uuid_dependency_dir"
  mkdir -p "$native_uuid_dependency_dir/include" "$native_uuid_dependency_dir/lib"
  cp -R "$portable_uuid_dir/include/uuid" "$native_uuid_dependency_dir/include/"
  "${cc[@]}" $native_cflags \
    -I"$portable_uuid_dir/include" \
    -I"$build_dir/src/include" \
    -I"$build_dir/src/include/port" \
    -c "$portable_uuid_dir/portable_uuid.c" \
    -o "$object"
  ar crs "$native_uuid_archive" "$object"
  ranlib "$native_uuid_archive"
  [ -s "$native_uuid_archive" ] || fail "portable UUID native build did not produce $native_uuid_archive"
}

build_contrib_extension() {
  local extension="$1"
  local -a extra_make_args=()
  local -a embedded_extra_make_args=()
  local embedded_pg_ldflags="$embedded_module_be_dllibs"
  local arg
  if [ "$extension" = "pgcrypto" ]; then
    configure_pgcrypto_make_args
    extra_make_args=("${pgcrypto_make_args[@]}")
  elif [ "$extension" = "uuid-ossp" ]; then
    build_native_uuid_dependency
    extra_make_args=(
      "PG_CPPFLAGS=-I$portable_uuid_dir/include -DHAVE_UUID_E2FS=1 -DHAVE_UUID_UUID_H=1"
      "UUID_LIBS=$native_uuid_archive"
    )
  fi
  for arg in "${extra_make_args[@]}"; do
    case "$arg" in
      PG_LDFLAGS=*)
        embedded_pg_ldflags="${arg#PG_LDFLAGS=} $embedded_pg_ldflags"
        ;;
      *)
        embedded_extra_make_args+=("$arg")
        ;;
    esac
  done
  embedded_extra_make_args+=("PG_LDFLAGS=$embedded_pg_ldflags")

  (
    cd "$build_dir"
    make -C "contrib/$extension" clean >> "$make_log" 2>&1 || true
    make -C "contrib/$extension" \
      CC="$cc_string" \
      BE_DLLLIBS="$normal_module_be_dllibs" \
      "${extra_make_args[@]}" \
      install >> "$make_log" 2>&1
    make -C "contrib/$extension" clean >> "$make_log" 2>&1 || true
    make -C "contrib/$extension" \
      CC="$cc_string" \
      "${embedded_extra_make_args[@]}" \
      all >> "$make_log" 2>&1
    copy_embedded_modules_from_dir "contrib/$extension"
  )
}

pgxs_extension_link_args() {
  local extension="$1"
  local be_dllibs="$2"
  [ -z "$be_dllibs" ] || printf '%s\n' "PG_LDFLAGS=$be_dllibs"
  case "$extension" in
    pg_textsearch|pgvector|vector)
      printf '%s\n' "SHLIB_LINK=-lm"
      ;;
    *)
      ;;
  esac
}

pgxs_extension_source_rel() {
  local extension="$1"
  local pgxs_plan="$repo_root/src/extensions/generated/pgxs-build.tsv"
  awk -F '\t' -v extension="$extension" '
    NR > 1 && ($1 == extension || $3 == "target/oliphaunt-sources/checkouts/" extension) {
      print $3
      found = 1
      exit
    }
    END { exit found ? 0 : 1 }
  ' "$pgxs_plan"
}

build_pgxs_extension() {
  local extension="$1"
  local source_rel
  source_rel="$(pgxs_extension_source_rel "$extension" || true)"
  [ -n "$source_rel" ] || native_extension_filter_fail "unknown PGXS extension source mapping: $extension"
  local checkout="$repo_root/$source_rel"
  local build_checkout="$work_root/external-$extension"
  local -a normal_link_args=()
  local -a embedded_link_args=()
  while IFS= read -r arg; do
    [ -n "$arg" ] || continue
    normal_link_args+=("$arg")
  done < <(pgxs_extension_link_args "$extension" "$normal_module_be_dllibs")
  while IFS= read -r arg; do
    [ -n "$arg" ] || continue
    embedded_link_args+=("$arg")
  done < <(pgxs_extension_link_args "$extension" "$embedded_module_be_dllibs")
  [ -d "$checkout" ] || fail "native extension checkout is missing: $checkout"
  rm -rf "$build_checkout"
  mkdir -p "$(dirname "$build_checkout")"
  cp -a "$checkout/." "$build_checkout/"
  rm -rf "$build_checkout/.git"
  make -C "$build_checkout" PG_CONFIG="$install_dir/bin/pg_config" clean >> "$make_log" 2>&1 || true
  make -C "$build_checkout" \
    PG_CONFIG="$install_dir/bin/pg_config" \
    CC="$cc_string" \
    OPTFLAGS="" \
    "${normal_link_args[@]}" \
    install >> "$make_log" 2>&1
  make -C "$build_checkout" PG_CONFIG="$install_dir/bin/pg_config" clean >> "$make_log" 2>&1 || true
  make -C "$build_checkout" \
    PG_CONFIG="$install_dir/bin/pg_config" \
    CC="$cc_string" \
    OPTFLAGS="" \
    "${embedded_link_args[@]}" \
    all >> "$make_log" 2>&1
  copy_embedded_modules_from_dir "$build_checkout"
}

native_postgis_dependency_root="${OLIPHAUNT_NATIVE_POSTGIS_DEPENDENCY_ROOT:-$work_root/postgis-native-dependencies}"
postgis_configure_args=()
postgis_configure_env=()
postgis_make_args=()
postgis_proj_prefix=""

native_postgis_require_tools() {
  local cmd
  for cmd in cmake rsync sqlite3; do
    command -v "$cmd" >/dev/null 2>&1 || fail "PostGIS native dependency build missing required command: $cmd"
  done
}

native_postgis_cmake_install() {
  local source_dir="$1"
  local build_root="$2"
  local dependency_dir="$3"
  shift 3
  cmake -S "$source_dir" -B "$build_root" \
    -DCMAKE_INSTALL_PREFIX="$dependency_dir" \
    -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
    "$@" >> "$postgis_dependency_log" 2>&1
  cmake --build "$build_root" --target install -- -j"$jobs" >> "$postgis_dependency_log" 2>&1
}

build_native_postgis_jsonc_dependency() {
  local source_dir="$repo_root/target/oliphaunt-sources/checkouts/json-c"
  local dependency_dir="$native_postgis_dependency_root/json-c"
  local build_root="$work_root/json-c-native-build"
  local archive="$dependency_dir/lib/libjson-c.a"
  [ -f "$archive" ] && [ -d "$dependency_dir/include/json-c" ] && return 0
  [ -f "$source_dir/CMakeLists.txt" ] || fail "missing JSON-C checkout: $source_dir"
  rm -rf "$build_root" "$dependency_dir"
  native_postgis_cmake_install "$source_dir" "$build_root" "$dependency_dir" \
    -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
    -DBUILD_SHARED_LIBS=OFF \
    -DBUILD_STATIC_LIBS=ON \
    -DBUILD_APPS=OFF \
    -DBUILD_TESTING=OFF \
    -DDISABLE_WERROR=ON
  [ -f "$archive" ] || fail "JSON-C build did not produce $archive"
}

build_native_postgis_sqlite_dependency() {
  local source_dir="$repo_root/target/oliphaunt-sources/checkouts/sqlite"
  local dependency_dir="$native_postgis_dependency_root/sqlite"
  local build_root="$work_root/sqlite-native-build"
  local archive="$dependency_dir/lib/libsqlite3.a"
  [ -f "$archive" ] && [ -f "$dependency_dir/include/sqlite3.h" ] && return 0
  [ -x "$source_dir/configure" ] || fail "missing SQLite checkout: $source_dir"
  rm -rf "$build_root" "$dependency_dir"
  mkdir -p "$build_root" "$dependency_dir/include" "$dependency_dir/lib"
  rsync -a --delete --exclude .git "$source_dir/" "$build_root/"
  (
    cd "$build_root"
    CC="$native_cc" CFLAGS="$(oliphaunt_native_release_cflags -fPIC)" ./configure \
      --disable-shared \
      --enable-static \
      --prefix="$dependency_dir" >> "$postgis_dependency_log" 2>&1
    make -j"$jobs" sqlite3.c >> "$postgis_dependency_log" 2>&1
    "$native_cc" $(oliphaunt_native_release_cflags -fPIC) \
      -DSQLITE_THREADSAFE=0 \
      -DSQLITE_OMIT_LOAD_EXTENSION \
      -c sqlite3.c \
      -o sqlite3.o >> "$postgis_dependency_log" 2>&1
    ar crs "$archive" sqlite3.o >> "$postgis_dependency_log" 2>&1
    ranlib "$archive" >> "$postgis_dependency_log" 2>&1
    cp -p sqlite3.h sqlite3ext.h "$dependency_dir/include/"
  )
  [ -f "$archive" ] || fail "SQLite build did not produce $archive"
}

build_native_postgis_geos_dependency() {
  local source_dir="$repo_root/target/oliphaunt-sources/checkouts/geos"
  local dependency_dir="$native_postgis_dependency_root/geos"
  local build_root="$work_root/geos-native-build"
  [ -f "$dependency_dir/lib/libgeos_c.a" ] && [ -f "$dependency_dir/lib/libgeos.a" ] && [ -f "$dependency_dir/include/geos_c.h" ] && return 0
  [ -f "$source_dir/CMakeLists.txt" ] || fail "missing GEOS checkout: $source_dir"
  rm -rf "$build_root" "$dependency_dir"
  native_postgis_cmake_install "$source_dir" "$build_root" "$dependency_dir" \
    -DBUILD_SHARED_LIBS=OFF \
    -DBUILD_TESTING=OFF \
    -DBUILD_BENCHMARKS=OFF \
    -DBUILD_GEOSOP=OFF \
    -DGEOS_BUILD_DEVELOPER=OFF
  [ -f "$dependency_dir/lib/libgeos_c.a" ] || fail "GEOS build did not produce libgeos_c.a"
  [ -f "$dependency_dir/lib/libgeos.a" ] || fail "GEOS build did not produce libgeos.a"
}

build_native_postgis_libxml2_dependency() {
  local source_dir="$repo_root/target/oliphaunt-sources/checkouts/libxml2"
  local dependency_dir="$native_postgis_dependency_root/libxml2"
  local build_root="$work_root/libxml2-native-build"
  local archive="$dependency_dir/lib/libxml2.a"
  [ -f "$archive" ] && [ -x "$dependency_dir/bin/xml2-config" ] && return 0
  [ -f "$source_dir/CMakeLists.txt" ] || fail "missing libxml2 checkout: $source_dir"
  rm -rf "$build_root" "$dependency_dir"
  native_postgis_cmake_install "$source_dir" "$build_root" "$dependency_dir" \
    -DBUILD_SHARED_LIBS=OFF \
    -DLIBXML2_WITH_PROGRAMS=OFF \
    -DLIBXML2_WITH_TESTS=OFF \
    -DLIBXML2_WITH_PYTHON=OFF \
    -DLIBXML2_WITH_THREADS=OFF \
    -DLIBXML2_WITH_MODULES=OFF \
    -DLIBXML2_WITH_ICONV=OFF \
    -DLIBXML2_WITH_ZLIB=OFF \
    -DLIBXML2_WITH_LZMA=OFF \
    -DLIBXML2_WITH_HTTP=OFF
  [ -f "$archive" ] || fail "libxml2 build did not produce $archive"
}

build_native_postgis_proj_dependency() {
  local source_dir="$repo_root/target/oliphaunt-sources/checkouts/proj"
  local dependency_dir="$native_postgis_dependency_root/proj"
  local sqlite_dir="$native_postgis_dependency_root/sqlite"
  local build_root="$work_root/proj-native-build"
  local archive="$dependency_dir/lib/libproj.a"
  [ -f "$archive" ] && [ -f "$dependency_dir/share/proj/proj.db" ] && return 0
  [ -f "$source_dir/CMakeLists.txt" ] || fail "missing PROJ checkout: $source_dir"
  [ -f "$sqlite_dir/lib/libsqlite3.a" ] || fail "PROJ dependency requires SQLite archive first"
  rm -rf "$build_root" "$dependency_dir"
  native_postgis_cmake_install "$source_dir" "$build_root" "$dependency_dir" \
    -DBUILD_SHARED_LIBS=OFF \
    "-DSQLite3_INCLUDE_DIR=$sqlite_dir/include" \
    "-DSQLite3_LIBRARY=$sqlite_dir/lib/libsqlite3.a" \
    "-DEXE_SQLITE3=$(command -v sqlite3)" \
    -DENABLE_TIFF=OFF \
    -DENABLE_CURL=OFF \
    -DENABLE_EMSCRIPTEN_FETCH=OFF \
    -DHAVE_LIBDL=OFF \
    -DBUILD_APPS=OFF \
    -DBUILD_TESTING=OFF \
    -DBUILD_EXAMPLES=OFF \
    -DEMBED_RESOURCE_FILES=ON \
    -DUSE_ONLY_EMBEDDED_RESOURCE_FILES=ON
  mkdir -p "$dependency_dir/share/proj"
  if [ -f "$build_root/data/proj.db" ]; then
    cp -p "$build_root/data/proj.db" "$dependency_dir/share/proj/proj.db"
  fi
  [ -f "$archive" ] || fail "PROJ build did not produce $archive"
  [ -f "$dependency_dir/share/proj/proj.db" ] || fail "PROJ build did not produce proj.db"
}

build_native_postgis_dependencies() {
  native_postgis_require_tools
  mkdir -p "$(dirname "$postgis_dependency_log")"
  : > "$postgis_dependency_log"
  build_native_postgis_jsonc_dependency
  build_native_postgis_sqlite_dependency
  build_native_postgis_geos_dependency
  build_native_postgis_libxml2_dependency
  build_native_postgis_proj_dependency
}

native_postgis_geos_config_script() {
  local path="$1"
  cat > "$path" <<EOF
#!/bin/sh
set -eu
case "\${1:-}" in
  --clibs|--libs) echo "-L$native_postgis_dependency_root/geos/lib -lgeos_c -lgeos -lstdc++ -lm" ;;
  --cflags) echo "-I$native_postgis_dependency_root/geos/include" ;;
  --version) echo "3.14.0dev" ;;
  *) exec "$native_postgis_dependency_root/geos/bin/geos-config" "\$@" ;;
esac
EOF
  chmod +x "$path"
}

native_postgis_pkg_config_script() {
  local path="$1"
  cat > "$path" <<EOF
#!/bin/sh
set -eu
case "\${1:-}" in
  --atleast-pkgconfig-version) exit 0 ;;
esac
pkg=""
for arg in "\$@"; do
  case "\$arg" in
    proj*) pkg="proj"; break ;;
    json-c*) pkg="json-c"; break ;;
  esac
done
case "\$pkg" in
  proj)
    case " \$* " in
      *" --exists "*) exit 0 ;;
      *" --modversion "*) echo "9.8.1"; exit 0 ;;
      *" --cflags "*) echo "-I$native_postgis_dependency_root/proj/include"; exit 0 ;;
      *" --libs "*) echo "-L$native_postgis_dependency_root/proj/lib -lproj -L$native_postgis_dependency_root/sqlite/lib -lsqlite3 -lstdc++ -lm"; exit 0 ;;
    esac
    ;;
  json-c)
    case " \$* " in
      *" --exists "*) exit 0 ;;
      *" --modversion "*) echo "0.18"; exit 0 ;;
      *" --cflags "*) echo "-I$native_postgis_dependency_root/json-c/include -I$native_postgis_dependency_root/json-c/include/json-c"; exit 0 ;;
      *" --libs "*) echo "-L$native_postgis_dependency_root/json-c/lib -ljson-c"; exit 0 ;;
    esac
    ;;
esac
exit 1
EOF
  chmod +x "$path"
}

configure_postgis_configure_args() {
  build_native_postgis_dependencies
  local scripts_dir="$work_root/postgis-native-dependency-scripts"
  rm -rf "$scripts_dir"
  mkdir -p "$scripts_dir"
  native_postgis_geos_config_script "$scripts_dir/geos-config"
  native_postgis_pkg_config_script "$scripts_dir/pkg-config"
  postgis_proj_prefix="$native_postgis_dependency_root/proj"
  postgis_configure_args=(
    "--with-xml2config=$native_postgis_dependency_root/libxml2/bin/xml2-config"
  )
  postgis_configure_env=(
    "PATH=$scripts_dir:$PATH"
    "PKG_CONFIG=$scripts_dir/pkg-config"
    "PKG_CONFIG_ALLOW_SYSTEM_CFLAGS=1"
    "PKG_CONFIG_ALLOW_SYSTEM_LIBS=1"
    "PKG_CONFIG_LIBDIR=$native_postgis_dependency_root/json-c/lib/pkgconfig:$native_postgis_dependency_root/proj/lib/pkgconfig:$native_postgis_dependency_root/sqlite/lib/pkgconfig:$native_postgis_dependency_root/libxml2/lib/pkgconfig"
    "PKG_CONFIG_PATH=$native_postgis_dependency_root/json-c/lib/pkgconfig:$native_postgis_dependency_root/proj/lib/pkgconfig:$native_postgis_dependency_root/sqlite/lib/pkgconfig:$native_postgis_dependency_root/libxml2/lib/pkgconfig"
    "CPPFLAGS=-I$native_postgis_dependency_root/libxml2/include/libxml2 -I$native_postgis_dependency_root/proj/include -I$native_postgis_dependency_root/json-c/include -I$native_postgis_dependency_root/json-c/include/json-c -I$native_postgis_dependency_root/geos/include"
    "LDFLAGS=-L$native_postgis_dependency_root/geos/lib -L$native_postgis_dependency_root/proj/lib -L$native_postgis_dependency_root/sqlite/lib -L$native_postgis_dependency_root/json-c/lib -L$native_postgis_dependency_root/libxml2/lib"
    "LIBS=-lsqlite3 -lstdc++ -lm"
    "JSONC_CFLAGS=-I$native_postgis_dependency_root/json-c/include -I$native_postgis_dependency_root/json-c/include/json-c"
    "JSONC_LIBS=-L$native_postgis_dependency_root/json-c/lib -ljson-c"
    "CXX=$native_cxx"
  )
  postgis_make_args=(
    "LDFLAGS=-L$native_postgis_dependency_root/geos/lib -L$native_postgis_dependency_root/proj/lib -L$native_postgis_dependency_root/sqlite/lib -L$native_postgis_dependency_root/json-c/lib -L$native_postgis_dependency_root/libxml2/lib"
    "LIBS=-lgeos_c -lgeos -lproj -lsqlite3 -ljson-c -lxml2 -lstdc++ -lm"
  )
}

copy_embedded_postgis_module() {
  local source_dir="$1"
  mkdir -p "$embedded_modules_dir"
  [ -f "$source_dir/postgis-3.so" ] || fail "PostGIS embedded module was not produced under $source_dir"
  cp -p "$source_dir/postgis-3.so" "$embedded_modules_dir/postgis-3.so"
  module_depends_on_liboliphaunt "$embedded_modules_dir/postgis-3.so" ||
    fail "embedded PostGIS is not linked against liboliphaunt: $embedded_modules_dir/postgis-3.so"
}

stage_postgis_data_files() {
  local postgis_build_dir="$1"
  local proj_db=""
  local candidate
  for candidate in \
    "$postgis_build_dir/share/proj/proj.db" \
    "${postgis_proj_prefix:-}/share/proj/proj.db" \
    "${OLIPHAUNT_PROJ_PREFIX:-}/share/proj/proj.db" \
    "${OLIPHAUNT_PROJ_DATADIR:-}/proj.db" \
    /usr/share/proj/proj.db \
    /usr/local/share/proj/proj.db
  do
    [ -n "$candidate" ] || continue
    if [ -f "$candidate" ]; then
      proj_db="$candidate"
      break
    fi
  done
  [ -n "$proj_db" ] || fail "PostGIS requires proj/proj.db; set OLIPHAUNT_PROJ_DATADIR"
  mkdir -p "$install_dir/share/postgresql/proj"
  cp -p "$proj_db" "$install_dir/share/postgresql/proj/proj.db"
}

patch_postgis_generated_makefiles() {
  local postgis_build_dir="$1"
  local makefile
  while IFS= read -r makefile; do
    perl -0pi -e 's/\$\(LIBTOOL\) --mode=compile \$\(CC\)/\$(LIBTOOL) --tag=CC --mode=compile \$(CC)/g' "$makefile"
  done < <(find "$postgis_build_dir" -name Makefile -type f -print)
}

build_postgis_extension() {
  local checkout="$repo_root/target/oliphaunt-sources/checkouts/postgis"
  local postgis_build_dir="$work_root/postgis-native"
  [ -f "$checkout/configure.ac" ] || fail "native PostGIS checkout is missing or incomplete: $checkout"
  configure_postgis_configure_args
  rm -rf "$postgis_build_dir"
  mkdir -p "$(dirname "$postgis_build_dir")"
  cp -a "$checkout/." "$postgis_build_dir/"
  rm -rf "$postgis_build_dir/.git"
  (
    cd "$postgis_build_dir"
    export CC="$native_cc"
    export "${postgis_configure_env[@]}"
    if [ ! -f configure ]; then
      ./autogen.sh >> "$make_log" 2>&1
    fi
    ./configure \
      --prefix="$install_dir" \
      --with-pgconfig="$install_dir/bin/pg_config" \
      "${postgis_configure_args[@]}" \
      --without-protobuf \
      --without-raster \
      --without-topology \
      --without-sfcgal \
      --without-address-standardizer \
      --without-tiger \
      --disable-nls >> "$make_log" 2>&1
    patch_postgis_generated_makefiles "$postgis_build_dir"
    make postgis_revision.h >> "$make_log" 2>&1
    make clean >> "$make_log" 2>&1 || true
    make postgis_revision.h >> "$make_log" 2>&1
    make -C doc CC="$native_cc" "${postgis_make_args[@]}" comments-install >> "$make_log" 2>&1
    make -j"$jobs" -C postgis CC="$native_cc" "${postgis_make_args[@]}" install >> "$make_log" 2>&1
    make -j1 -C extensions CC="$native_cc" "${postgis_make_args[@]}" all >> "$make_log" 2>&1
    make -j1 -C extensions CC="$native_cc" "${postgis_make_args[@]}" install >> "$make_log" 2>&1
    make -C postgis clean >> "$make_log" 2>&1 || true
    make postgis_revision.h >> "$make_log" 2>&1
    make -j"$jobs" -C postgis CC="$native_cc" BE_DLLLIBS="$embedded_module_be_dllibs" "${postgis_make_args[@]}" all >> "$make_log" 2>&1
  )
  copy_embedded_postgis_module "$postgis_build_dir/postgis"
  stage_postgis_data_files "$postgis_build_dir"
}

build_native_extension_artifacts() {
  [ "${OLIPHAUNT_BUILD_EXTENSIONS:-0}" != "0" ] || return 0
  local wanted extension
  wanted="$(extension_build_fingerprint)"
  if [ "${OLIPHAUNT_FORCE_EXTENSION_REBUILD:-0}" != "1" ] &&
    [ -f "$extension_build_stamp" ] &&
    [ "$(cat "$extension_build_stamp")" = "$wanted" ] &&
    native_extension_artifacts_ready; then
    echo "reusing Linux $target_id native extension artifacts"
    return 0
  fi

  rm -f "$extension_build_stamp"
  mkdir -p "$embedded_modules_dir"
  for extension in "${contrib_extensions[@]}"; do
    build_contrib_extension "$extension"
  done
  for extension in "${external_extensions[@]}"; do
    if [ "$extension" = "postgis" ]; then
      build_postgis_extension
    else
      build_pgxs_extension "$extension"
    fi
  done
  native_extension_artifacts_ready || {
    tail -160 "$make_log" >&2 || true
    fail "Linux $target_id native extension build did not produce required artifacts"
  }
  extension_build_fingerprint > "$extension_build_stamp"
}

build_jit_objects() {
  (
    cd "$build_dir"
    if jit_objects_ready; then
      echo "reusing PostgreSQL $target_id JIT stub objects" >&2
      return
    fi
    make -C src/backend/jit CC="$cc_string" CUSTOM_COPT="$postgres_embedded_copt" jit.o >> "$make_log" 2>&1
    jit_objects_ready || {
      tail -120 "$make_log" >&2 || true
      fail "PostgreSQL Linux JIT stub objects are incomplete"
    }
  )
}

build_liboliphaunt_objects() {
  local source object
  liboliphaunt_objects=()
  for source in "${liboliphaunt_sources[@]}"; do
    object="$out_dir/$(basename "${source%.c}").o"
    liboliphaunt_objects+=("$object")
    "${cc[@]}" $liboliphaunt_cflags \
      -I"$repo_root/src/runtimes/liboliphaunt/native/include" \
      -I"$repo_root/src/runtimes/liboliphaunt/native/src" \
      -c "$source" \
      -o "$object"
  done
}

write_objects_response_file() {
  (
    cd "$build_dir"
    {
      cat src/backend/*/objfiles.txt
      printf '%s\n' "${jit_objects[@]}"
      printf 'src/timezone/localtime.o src/timezone/pgtz.o src/timezone/strftime.o\n'
      printf '%s\n' "${plpgsql_objects[@]}"
    } | tr '[:space:]' '\n' | sed '/^$/d' | awk '!seen[$0]++' > "$objects_rsp"
  )
}

link_liboliphaunt() {
  (
    cd "$build_dir"
    "${cc[@]}" -shared \
      -Wl,-soname,liboliphaunt.so \
      -Wl,-z,defs \
      -o "$lib_out" \
      "${liboliphaunt_objects[@]}" \
      @"$objects_rsp" \
      src/common/libpgcommon_srv.a \
      src/port/libpgport_srv.a \
      $icu_libs \
      -lpthread \
      -lm \
      -ldl
  )
}

artifact_ready() {
  [ -f "$lib_out" ] || return 1
  embedded_plpgsql_module_ready || return 1
  oliphaunt_icu_artifacts_ready "$icu_prefix" || return 1
  local dynamic_symbols linked_symbols
  dynamic_symbols="$(nm -D --defined-only "$lib_out" 2>/dev/null || true)"
  linked_symbols="$(nm -S --defined-only "$lib_out" 2>/dev/null || true)"
  oliphaunt_icu_linked_symbols_ready "$linked_symbols" || return 1
  local symbol
  for symbol in \
    oliphaunt_init \
    oliphaunt_exec_protocol \
    oliphaunt_exec_simple_query \
    oliphaunt_exec_protocol_stream \
    oliphaunt_backup \
    oliphaunt_backup_ex \
    oliphaunt_restore \
    oliphaunt_cancel \
    oliphaunt_detach \
    oliphaunt_close \
    oliphaunt_register_static_extensions \
    oliphaunt_last_error \
    oliphaunt_version \
    oliphaunt_capabilities \
    oliphaunt_free_response
  do
    case "$dynamic_symbols" in *" $symbol"*) ;; *) return 1 ;; esac
  done
}

usage() {
  cat >&2 <<'MSG'
usage: src/runtimes/liboliphaunt/native/bin/build-postgres18-linux.sh [--runtime-only|--print-required-extension-artifacts|--check-current|--check-extension-artifacts-current]
MSG
}

case "$script_mode" in
  build)
    prepare_source
    build_icu
    configure_source
    install_runtime
    if artifact_ready &&
      (cd "$build_dir" && backend_objects_ready && plpgsql_objects_ready && jit_objects_ready) &&
      [ -f "$stamp" ] &&
      [ "$(cat "$stamp")" = "$(desired_hash)" ]; then
      echo "$lib_out"
      exit 0
    fi
    build_backend_objects
    build_jit_objects
    build_timezone_objects
    build_plpgsql_objects
    build_liboliphaunt_objects
    write_objects_response_file
    link_liboliphaunt
    build_embedded_plpgsql_module
    build_native_extension_artifacts
    artifact_ready || fail "Linux liboliphaunt shared library did not pass export checks"
    desired_hash > "$stamp"
    echo "$lib_out"
    ;;
  --runtime-only)
    prepare_source
    build_icu
    configure_source
    install_runtime
    echo "$install_dir"
    ;;
  --check-current)
    if artifact_ready &&
      (cd "$build_dir" && backend_objects_ready && plpgsql_objects_ready && jit_objects_ready) &&
      runtime_installed &&
      [ -f "$stamp" ] &&
      [ "$(cat "$stamp")" = "$(desired_hash)" ]; then
      echo "Linux $target_id liboliphaunt shared library is current"
      exit 0
    fi
    echo "Linux $target_id liboliphaunt shared library is missing or stale" >&2
    exit 1
    ;;
  --check-extension-artifacts-current)
    if native_extension_artifacts_current; then
      echo "Linux $target_id native extension artifacts are current"
      exit 0
    fi
    echo "Linux $target_id native extension artifacts are missing or stale" >&2
    exit 1
    ;;
  *)
    usage
    exit 2
    ;;
esac
