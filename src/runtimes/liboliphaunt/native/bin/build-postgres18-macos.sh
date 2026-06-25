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
work_root="${OLIPHAUNT_WORK_ROOT:-$repo_root/target/liboliphaunt-pg18}"
source_cache="$work_root/source"
tarball="$source_cache/postgresql-${pg_version}.tar.bz2"
build_dir="$work_root/postgresql-${pg_version}"
install_dir="$work_root/install"
out_dir="$work_root/out"
embedded_modules_dir="$out_dir/modules"
postgis_dependency_log="$work_root/postgis-native-dependencies.log"
liboliphaunt_build_stamp="$out_dir/liboliphaunt.dylib.inputs.sha256"
extension_build_stamp="$out_dir/native-extension-artifacts.sha256"
postgres_runtime_stamp="$install_dir/.oliphaunt-postgres-runtime.sha256"
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
liboliphaunt_objects=()
lib_out="$out_dir/liboliphaunt.dylib"
objects_rsp="$out_dir/liboliphaunt_objects.rsp"
build_stamp="$build_dir/.liboliphaunt-build.sha256"
script_mode="${1:-build}"
icu_source_dir="$(oliphaunt_icu_source_dir "$repo_root")"
icu_native_build_dir="$work_root/icu-native"
icu_build_dir="$work_root/icu-macos-build"
icu_prefix="$work_root/icu-macos"
icu_data_dir="$work_root/icu/share/icu"
icu_cflags="$(oliphaunt_icu_cflags "$icu_prefix")"
icu_static_libs="$(oliphaunt_icu_static_libs "$icu_prefix")"
icu_cpp_libs="-lc++"
icu_libs="$icu_static_libs $icu_cpp_libs"

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
  echo "build-postgres18-macos.sh: $*" >&2
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

verify_source_manifest() {
  grep -q "version = \"$pg_version\"" "$source_manifest" &&
    grep -q "url = \"$pg_url\"" "$source_manifest" &&
    grep -q "sha256 = \"$pg_sha256\"" "$source_manifest"
}

patch_series_hash() {
  shasum -a 256 "$patch_dir"/*.patch | shasum -a 256 | awk '{print $1}'
}

module_depends_on_liboliphaunt() {
  local module="$1"
  [ -f "$module" ] || return 1
  case "$(otool -L "$module" 2>/dev/null || true)" in
    *"@rpath/liboliphaunt.dylib"*) return 0 ;;
    *) return 1 ;;
  esac
}

module_has_postgres_symbols_bound_to_liboliphaunt() {
  local module="$1"
  nm -m "$module" 2>/dev/null |
    awk 'index($0, "(from liboliphaunt)") { found = 1 } END { exit found ? 0 : 1 }'
}

liboliphaunt_artifact_ready() {
  [ -f "$lib_out" ] || return 1
  local symbols
  symbols="$(nm -g "$lib_out" 2>/dev/null || true)"
  local symbol
  for symbol in \
    _oliphaunt_init \
    _oliphaunt_exec_protocol \
    _oliphaunt_exec_simple_query \
    _oliphaunt_exec_protocol_stream \
    _oliphaunt_backup \
    _oliphaunt_backup_ex \
    _oliphaunt_restore \
    _oliphaunt_cancel \
    _oliphaunt_detach \
    _oliphaunt_close \
    _oliphaunt_register_static_extensions \
    _oliphaunt_last_error \
    _oliphaunt_version \
    _oliphaunt_capabilities \
    _oliphaunt_free_response
  do
    case "$symbols" in *"$symbol"*) ;; *) return 1 ;; esac
  done
  oliphaunt_icu_linked_symbols_ready "$symbols" || return 1
}

postgres_install_icu_ready() {
  [ -x "$install_dir/bin/pg_config" ] || return 1
  local configure_args
  configure_args="$("$install_dir/bin/pg_config" --configure 2>/dev/null || true)"
  case "$configure_args" in
    *"--with-icu"*) ;;
    *) return 1 ;;
  esac
  case "$configure_args" in
    *"U_STATIC_IMPLEMENTATION"*) ;;
    *) return 1 ;;
  esac
  [ -f "$install_dir/include/pg_config.h" ] || return 1
  grep -Eq '^#define USE_ICU 1\b' "$install_dir/include/pg_config.h" &&
    grep -q 'U_STATIC_IMPLEMENTATION' "$install_dir/include/pg_config.h"
}

hash_object_response_file_inputs() {
  [ -f "$objects_rsp" ] || return 1
  while IFS= read -r object; do
    [ -n "$object" ] || continue
    if [ ! -f "$object" ]; then
      echo "liboliphaunt link object is missing: $object" >&2
      return 1
    fi
    stat -f '%m %z %N' "$object"
  done < "$objects_rsp"
}

liboliphaunt_build_fingerprint() {
  {
    printf 'pg_version=%s\n' "$pg_version"
    printf 'cc=%s\n' "$CC"
    printf 'native_cflags=%s\n' "$native_cflags"
    printf 'build_hash=%s\n' "$desired_build_hash"
    printf 'install_name=%s\n' '@rpath/liboliphaunt.dylib'
    printf 'liboliphaunt_sources=%s\n' "${liboliphaunt_sources[*]}"
    shasum -a 256 "$repo_root/src/runtimes/liboliphaunt/native/include/oliphaunt.h"
    shasum -a 256 "$repo_root/src/runtimes/liboliphaunt/native/src/liboliphaunt_internal.h"
    local source
    for source in "${liboliphaunt_sources[@]}"; do
      shasum -a 256 "$source"
    done
    shasum -a 256 "$objects_rsp"
    hash_object_response_file_inputs
    stat -f '%m %z %N' src/common/libpgcommon_srv.a
    stat -f '%m %z %N' src/port/libpgport_srv.a
  } | shasum -a 256 | awk '{print $1}'
}

liboliphaunt_artifacts_current() {
  [ -d "$build_dir" ] || return 1
  [ -f "$build_stamp" ] || return 1
  [ "$(cat "$build_stamp")" = "$desired_build_hash" ] || return 1
  oliphaunt_icu_artifacts_ready "$icu_prefix" || return 1
  [ -f "$liboliphaunt_build_stamp" ] || return 1
  [ -x "$install_dir/bin/initdb" ] || return 1
  [ -x "$install_dir/bin/postgres" ] || return 1
  postgres_install_icu_ready || return 1
  [ -f "$objects_rsp" ] || return 1
  [ -f src/common/libpgcommon_srv.a ] || return 1
  [ -f src/port/libpgport_srv.a ] || return 1
  liboliphaunt_artifact_ready || return 1

  local desired_liboliphaunt_hash
  if ! desired_liboliphaunt_hash="$(liboliphaunt_build_fingerprint)"; then
    return 1
  fi
  [ "$(cat "$liboliphaunt_build_stamp")" = "$desired_liboliphaunt_hash" ] || return 1
}

hash_extension_source_tree() {
  local source_dir="$1"
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
    printf 'cc=%s\n' "$CC"
    printf 'postgis_cc=%s\n' "$postgis_cc"
    printf 'build_hash=%s\n' "$desired_build_hash"
    printf 'normal_be_dllibs=%s\n' "$normal_module_be_dllibs"
    printf 'embedded_be_dllibs=%s\n' "$embedded_module_be_dllibs"
    stat -f '%m %z %N' "$install_dir/bin/postgres"
    shasum -a 256 "$repo_root/src/runtimes/liboliphaunt/native/include/oliphaunt.h"
    shasum -a 256 "$repo_root/src/runtimes/liboliphaunt/native/src/liboliphaunt_internal.h"
    local source
    for source in "${liboliphaunt_sources[@]}"; do
      shasum -a 256 "$source"
    done
    printf 'contrib_extensions=%s\n' "${contrib_extensions[*]}"
    printf 'external_extensions=%s\n' "${external_extensions[*]}"

    local extension
    for extension in "${contrib_extensions[@]}"; do
      printf 'contrib:%s\n' "$extension"
      hash_extension_source_tree "$build_dir/contrib/$extension"
    done
    for extension in "${external_extensions[@]}"; do
      printf 'external:%s\n' "$extension"
      hash_extension_source_tree "$repo_root/target/oliphaunt-sources/checkouts/$extension"
    done
    if native_extensions_include_postgis; then
      local dependency
      for dependency in geos proj sqlite json-c libxml2; do
        if [ -d "$repo_root/target/oliphaunt-sources/checkouts/$dependency" ]; then
          printf 'postgis-dependency:%s\n' "$dependency"
          hash_extension_source_tree "$repo_root/target/oliphaunt-sources/checkouts/$dependency"
        fi
      done
    fi
    hash_extension_source_tree "$repo_root/src/runtimes/liboliphaunt/native/portable-uuid"
  } | shasum -a 256 | awk '{print $1}'
}

native_extension_artifacts_ready() {
  local extension
  for extension in "${required_extension_controls[@]}"; do
    if [ ! -f "$install_dir/share/postgresql/extension/$extension.control" ]; then
      return 1
    fi
    if ! compgen -G "$install_dir/share/postgresql/extension/$extension--*.sql" >/dev/null; then
      return 1
    fi
  done

  local module
  for module in "${required_extension_modules[@]}"; do
    if [ ! -f "$install_dir/lib/postgresql/$module.dylib" ]; then
      return 1
    fi
    if module_depends_on_liboliphaunt "$install_dir/lib/postgresql/$module.dylib"; then
      return 1
    fi
    if [ ! -f "$embedded_modules_dir/$module.dylib" ]; then
      return 1
    fi
  done
  if native_extensions_include_postgis; then
    [ -f "$install_dir/share/postgresql/proj/proj.db" ] || return 1
  fi
}

base_runtime_optional_extensions_absent() {
  local extension
  for extension in "${required_extension_controls[@]}"; do
    if [ -f "$install_dir/share/postgresql/extension/$extension.control" ]; then
      return 1
    fi
  done

  local module
  for module in "${required_extension_modules[@]}"; do
    if [ -f "$install_dir/lib/postgresql/$module.dylib" ]; then
      return 1
    fi
  done

  [ ! -d "$install_dir/share/postgresql/contrib" ] || return 1
  [ ! -d "$install_dir/share/postgresql/proj" ] || return 1
}

prune_base_runtime_optional_extensions() {
  if [ "${OLIPHAUNT_BUILD_EXTENSIONS:-0}" != "0" ]; then
    return 0
  fi

  local extension_dir="$install_dir/share/postgresql/extension"
  local module_dir="$install_dir/lib/postgresql"
  local extension
  if [ -d "$extension_dir" ]; then
    for extension in "${required_extension_controls[@]}"; do
      rm -f "$extension_dir/$extension.control"
      rm -f "$extension_dir/$extension--"*.sql
    done
    rm -f "$extension_dir/postgis"*.sql "$extension_dir/rtpostgis"*.sql
    rm -f "$extension_dir/uninstall_postgis.sql" "$extension_dir/uninstall_legacy.sql"
    rm -f "$extension_dir/pgtap-"*.sql "$extension_dir/uninstall_pgtap.sql"
  fi

  local module
  if [ -d "$module_dir" ]; then
    for module in "${required_extension_modules[@]}"; do
      rm -f "$module_dir/$module.dylib"
    done
  fi

  rm -rf "$install_dir/share/postgresql/contrib" "$install_dir/share/postgresql/proj"
}

native_extension_artifacts_current() {
  [ -d "$build_dir" ] || return 1
  [ -f "$build_stamp" ] || return 1
  [ "$(cat "$build_stamp")" = "$desired_build_hash" ] || return 1
  [ -x "$install_dir/bin/postgres" ] || return 1
  [ -f "$lib_out" ] || return 1
  [ -d "$build_dir/contrib" ] || return 1
  [ -f "$extension_build_stamp" ] || return 1

  local desired_extension_hash
  if ! desired_extension_hash="$(extension_build_fingerprint)"; then
    return 1
  fi
  [ "$(cat "$extension_build_stamp")" = "$desired_extension_hash" ] || return 1
  native_extension_artifacts_ready || return 1
}

if [ "$(uname -s)" != "Darwin" ]; then
  echo "native PostgreSQL 18 liboliphaunt build currently targets macOS only" >&2
  exit 2
fi

if ! verify_source_manifest; then
  echo "native liboliphaunt source manifest does not match build constants: $source_manifest" >&2
  exit 1
fi
oliphaunt_icu_require_source "$icu_source_dir"

native_cc="${OLIPHAUNT_CC:-cc}"
native_cxx="${OLIPHAUNT_CXX:-c++}"
ccache_mode="${OLIPHAUNT_CCACHE:-auto}"
if [ "$ccache_mode" != "0" ] && [ "$ccache_mode" != "off" ]; then
  if [ "$ccache_mode" != "auto" ]; then
    ccache_bin="$ccache_mode"
  else
    ccache_bin="$(command -v ccache || true)"
  fi
  if [ -n "$ccache_bin" ]; then
    export CC="$ccache_bin $native_cc"
    export CXX="$ccache_bin $native_cxx"
  else
    export CC="$native_cc"
    export CXX="$native_cxx"
  fi
else
  export CC="$native_cc"
  export CXX="$native_cxx"
fi

native_cflags="$(oliphaunt_native_release_cflags -fPIC -DOLIPHAUNT_EMBEDDED)"
desired_patch_hash="$(patch_series_hash)"
desired_build_hash="$(
  {
    printf 'patches=%s\n' "$desired_patch_hash"
    printf 'cc=%s\n' "$CC"
    printf 'cxx=%s\n' "$CXX"
    printf 'native_cflags=%s\n' "$native_cflags"
    printf 'icu_source=%s\n' "$(oliphaunt_icu_source_commit "$icu_source_dir")"
    printf 'icu_script=%s\n' "$(oliphaunt_icu_script_sha256 "$script_dir")"
    printf 'postgres_configure=with-icu\n'
  } | shasum -a 256 | awk '{print $1}'
)"
current_build_hash=""
if [ -f "$build_stamp" ]; then
  current_build_hash="$(cat "$build_stamp")"
fi

normal_module_be_dllibs="-bundle_loader $install_dir/bin/postgres"
embedded_module_be_dllibs="-L$out_dir -loliphaunt -Wl,-rpath,$out_dir"
postgis_cc="${OLIPHAUNT_POSTGIS_CC:-$native_cc}"
portable_uuid_dir="$repo_root/src/runtimes/liboliphaunt/native/portable-uuid"
native_uuid_dependency_dir="$work_root/portable-uuid-native"
native_uuid_archive="$native_uuid_dependency_dir/lib/libuuid.a"

if [ "$script_mode" = "--check-oliphaunt-current" ]; then
  if [ -d "$build_dir" ] && (cd "$build_dir" && liboliphaunt_artifacts_current); then
    echo "native liboliphaunt dylib is current"
    exit 0
  fi
  echo "native liboliphaunt dylib is missing or stale" >&2
  exit 1
fi

if [ "$script_mode" = "--check-extension-artifacts-current" ]; then
  if native_extension_artifacts_current; then
    echo "native extension artifacts are current"
    exit 0
  fi
  echo "native extension artifacts are missing or stale" >&2
  exit 1
fi

if [ "$script_mode" != "build" ] && [ "$script_mode" != "--runtime-only" ]; then
  cat >&2 <<'MSG'
usage: src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh [--runtime-only|--print-required-extension-artifacts|--check-oliphaunt-current|--check-extension-artifacts-current]
MSG
  exit 2
fi

jobs="${OLIPHAUNT_JOBS:-$(sysctl -n hw.ncpu 2>/dev/null || echo 4)}"
mkdir -p "$source_cache" "$out_dir"
icu_host="$(sh "$icu_source_dir/config.guess")"
oliphaunt_icu_build_target \
  "$icu_source_dir" \
  "$script_dir" \
  "$icu_native_build_dir" \
  "$icu_build_dir" \
  "$icu_prefix" \
  "$jobs" \
  "macos" \
  "$icu_host" \
  "$CC" \
  "$CXX" \
  "ar" \
  "ranlib" \
  "$native_cflags" \
  "$native_cflags -std=c++17" \
  ""

if [ ! -f "$tarball" ]; then
  curl -L --fail --silent --show-error "$pg_url" -o "$tarball"
fi

(
  cd "$source_cache"
  printf '%s  %s\n' "$pg_sha256" "postgresql-${pg_version}.tar.bz2" | shasum -a 256 -c -
)

if [ -d "$build_dir" ] && [ "$current_build_hash" != "$desired_build_hash" ]; then
  rm -rf "$build_dir"
fi

postgres_source_configure_complete() {
  [ -f "$build_dir/config.status" ] &&
    [ -f "$build_dir/src/include/pg_config.h" ]
}

postgres_source_configure_reusable() {
  if postgres_source_configure_complete; then
    return 0
  fi
  [ ! -f "$build_dir/config.status" ] &&
    [ ! -f "$build_dir/config.log" ]
}

if [ -d "$build_dir" ] && ! postgres_source_configure_reusable; then
  echo "discarding incomplete PostgreSQL configure tree at $build_dir" >&2
  rm -rf "$build_dir"
fi

if [ ! -d "$build_dir" ]; then
  tar -xjf "$tarball" -C "$work_root"
fi

cd "$build_dir"

patches_applied() {
  grep -q 'OliphauntEmbeddedIO' src/include/libpq/libpq-be.h &&
    grep -q 'oliphaunt_io' src/backend/libpq/be-secure.c &&
    grep -q 'oliphaunt_embedded_main' src/backend/tcop/postgres.c &&
    grep -q 'oliphaunt_embedded' meson_options.txt &&
    grep -q 'OLIPHAUNT_EMBEDDED' meson.build &&
    grep -q 'OLIPHAUNT_EMBEDDED' src/include/tcop/tcopprot.h &&
    grep -q 'oliphaunt_embedded_proc_exit' src/include/storage/ipc.h &&
    grep -q 'original_cwd' src/backend/tcop/postgres.c &&
    grep -q 'oliphaunt_static_extension_lookup' src/backend/utils/fmgr/dfmgr.c &&
    grep -q 'getenv("ICU_DATA")' src/bin/initdb/initdb.c &&
    grep -q 'OLIPHAUNT_EMBEDDED_NO_SHELL_COMMANDS' src/backend/archive/shell_archive.c &&
    grep -q 'OLIPHAUNT_EMBEDDED_NO_SHELL_COMMANDS' src/backend/access/transam/xlogarchive.c
}

if ! patches_applied; then
  git init -q
  for patch_file in "$patch_dir"/*.patch; do
    GIT_CEILING_DIRECTORIES="$work_root" git apply --recount --whitespace=nowarn "$patch_file"
  done
  printf '%s\n' "$desired_build_hash" > "$build_stamp"
fi

if ! patches_applied; then
  echo "PostgreSQL embedded patch verification failed" >&2
  exit 1
fi

if [ ! -f "$build_stamp" ]; then
  printf '%s\n' "$desired_build_hash" > "$build_stamp"
fi

if [ ! -f config.status ]; then
  echo "Using CC=$CC"
  CPPFLAGS="$icu_cflags" \
  LDFLAGS="-L$icu_prefix/lib" \
  ICU_CFLAGS="$icu_cflags" \
  ICU_LIBS="$icu_libs" \
    ./configure \
    --prefix="$install_dir" \
    --without-readline \
    --with-icu \
    --without-llvm \
    --without-pam \
    --with-openssl=no \
    --without-zlib \
    --disable-nls
fi

if ! postgres_source_configure_complete; then
  echo "PostgreSQL configure did not produce config.status and src/include/pg_config.h" >&2
  exit 1
fi

runtime_installed() {
  [ -x "$install_dir/bin/initdb" ] &&
    [ -x "$install_dir/bin/postgres" ] &&
    [ -f "$install_dir/share/postgresql/postgresql.conf.sample" ] &&
    oliphaunt_icu_files_data_ready "$icu_data_dir" &&
    [ -f "$postgres_runtime_stamp" ] &&
    [ "$(cat "$postgres_runtime_stamp")" = "$desired_build_hash" ] &&
    postgres_install_icu_ready &&
    { [ "${OLIPHAUNT_BUILD_EXTENSIONS:-0}" != "0" ] || base_runtime_optional_extensions_absent; }
}

install_normal_plpgsql_module() {
  make -C src/pl/plpgsql/src clean
  make -C src/pl/plpgsql/src \
    CC="$CC" \
    BE_DLLLIBS="$normal_module_be_dllibs" \
    install
}

copy_embedded_modules_from_dir() {
  local source_dir="$1"
  mkdir -p "$embedded_modules_dir"
  while IFS= read -r module; do
    cp -p "$module" "$embedded_modules_dir/$(basename "$module")"
  done < <(find "$source_dir" -maxdepth 1 -type f -name "*.dylib" -print)
}

audit_embedded_module() {
  local module="$1"
  if nm -m "$module" 2>/dev/null |
    awk '/_(hash_create|hash_search) \(from libSystem\)/ { found = 1 } END { exit found ? 0 : 1 }'; then
    echo "embedded module bound PostgreSQL hash symbols to libSystem: $module" >&2
    exit 1
  fi
}

compile_liboliphaunt_objects() {
  local index
  for index in "${!liboliphaunt_sources[@]}"; do
    $CC $(oliphaunt_native_release_cflags -fPIC) \
      -I"$repo_root/src/runtimes/liboliphaunt/native/include" \
      -I"$repo_root/src/runtimes/liboliphaunt/native/src" \
      -c "${liboliphaunt_sources[$index]}" \
      -o "${liboliphaunt_objects[$index]}"
  done
}

link_liboliphaunt_dylib() {
  $CC -dynamiclib -undefined dynamic_lookup \
    -Wl,-install_name,@rpath/liboliphaunt.dylib \
    -o "$lib_out" \
    "${liboliphaunt_objects[@]}" \
    @"$objects_rsp" \
    src/common/libpgcommon_srv.a \
    src/port/libpgport_srv.a \
    $icu_libs \
    -lpthread
}

build_liboliphaunt_dylib() {
  local desired_liboliphaunt_hash
  desired_liboliphaunt_hash="$(liboliphaunt_build_fingerprint)"

  if [ "${OLIPHAUNT_FORCE_RELINK:-0}" != "1" ] &&
    [ -f "$liboliphaunt_build_stamp" ] &&
    [ "$(cat "$liboliphaunt_build_stamp")" = "$desired_liboliphaunt_hash" ] &&
    liboliphaunt_artifact_ready; then
    echo "reusing native liboliphaunt dylib"
    return
  fi

  rm -f "$liboliphaunt_build_stamp"
  compile_liboliphaunt_objects
  link_liboliphaunt_dylib
  if ! liboliphaunt_artifact_ready; then
    echo "native liboliphaunt dylib did not export the required C ABI symbols" >&2
    exit 1
  fi
  printf '%s\n' "$desired_liboliphaunt_hash" > "$liboliphaunt_build_stamp"
}

audit_embedded_extension_modules() {
  local module
  for module in "$embedded_modules_dir"/*.dylib; do
    [ -e "$module" ] || continue
    audit_embedded_module "$module"
  done
}

native_openssl_prefix() {
  local candidate
  for candidate in \
    "${OLIPHAUNT_OPENSSL_PREFIX:-}" \
    "${OPENSSL_PREFIX:-}" \
    /opt/homebrew/opt/openssl@3 \
    /usr/local/opt/openssl@3 \
    /opt/homebrew/opt/openssl \
    /usr/local/opt/openssl
  do
    [ -n "$candidate" ] || continue
    if [ -f "$candidate/include/openssl/evp.h" ] &&
      { [ -f "$candidate/lib/libcrypto.a" ] || [ -f "$candidate/lib/libcrypto.dylib" ]; }; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  if command -v brew >/dev/null 2>&1; then
    for candidate in "$(brew --prefix openssl@3 2>/dev/null || true)" "$(brew --prefix openssl 2>/dev/null || true)"; do
      [ -n "$candidate" ] || continue
      if [ -f "$candidate/include/openssl/evp.h" ] &&
        { [ -f "$candidate/lib/libcrypto.a" ] || [ -f "$candidate/lib/libcrypto.dylib" ]; }; then
        printf '%s\n' "$candidate"
        return 0
      fi
    done
  fi
  echo "pgcrypto requires OpenSSL headers and libcrypto; set OLIPHAUNT_OPENSSL_PREFIX to a prefix containing include/openssl/evp.h and lib/libcrypto.{a,dylib}" >&2
  return 1
}

native_brew_prefix() {
  local formula="$1"
  local candidate
  if command -v brew >/dev/null 2>&1; then
    candidate="$(brew --prefix "$formula" 2>/dev/null || true)"
    if [ -n "$candidate" ] && [ -d "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  fi
  return 1
}

native_dependency_prefix() {
  local env_var="$1"
  local formula="$2"
  shift 2
  local override="${!env_var:-}"
  local candidate
  for candidate in "$override" "$@"; do
    [ -n "$candidate" ] || continue
    if [ -d "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  if native_brew_prefix "$formula"; then
    return 0
  fi
  return 1
}

native_dependency_tool() {
  local env_var="$1"
  local tool="$2"
  local formula="$3"
  shift 3
  local override="${!env_var:-}"
  local candidate
  if [ -n "$override" ] && [ -x "$override" ]; then
    printf '%s\n' "$override"
    return 0
  fi
  if command -v "$tool" >/dev/null 2>&1; then
    command -v "$tool"
    return 0
  fi
  for candidate in "$@"; do
    [ -n "$candidate" ] || continue
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  candidate="$(native_brew_prefix "$formula" || true)"
  if [ -n "$candidate" ] && [ -x "$candidate/bin/$tool" ]; then
    printf '%s\n' "$candidate/bin/$tool"
    return 0
  fi
  return 1
}

native_postgis_dependency_root="${OLIPHAUNT_NATIVE_POSTGIS_DEPENDENCY_ROOT:-$work_root/postgis-native-dependencies}"
postgis_configure_env=()
postgis_make_args=()

native_postgis_fail() {
  echo "PostGIS native dependency build: $*" >&2
  exit 1
}

native_postgis_require_tools() {
  local cmd
  for cmd in cmake rsync; do
    command -v "$cmd" >/dev/null 2>&1 || native_postgis_fail "missing required command: $cmd"
  done
}

native_postgis_dependency_archive() {
  local name="$1"
  local archive="$2"
  [ -f "$archive" ] || native_postgis_fail "missing dependency archive for $name: $archive"
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
  if [ -f "$archive" ] && [ -d "$dependency_dir/include/json-c" ]; then
    native_postgis_dependency_archive json-c "$archive"
    return 0
  fi
  [ -f "$source_dir/CMakeLists.txt" ] || native_postgis_fail "missing JSON-C checkout: $source_dir"
  rm -rf "$build_root" "$dependency_dir"
  native_postgis_cmake_install "$source_dir" "$build_root" "$dependency_dir" \
    -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
    -DBUILD_SHARED_LIBS=OFF \
    -DBUILD_STATIC_LIBS=ON \
    -DBUILD_APPS=OFF \
    -DBUILD_TESTING=OFF \
    -DDISABLE_WERROR=ON
  [ -f "$archive" ] || native_postgis_fail "JSON-C build did not produce $archive"
  native_postgis_dependency_archive json-c "$archive"
}

build_native_postgis_sqlite_dependency() {
  local source_dir="$repo_root/target/oliphaunt-sources/checkouts/sqlite"
  local dependency_dir="$native_postgis_dependency_root/sqlite"
  local build_root="$work_root/sqlite-native-build"
  local archive="$dependency_dir/lib/libsqlite3.a"
  if [ -f "$archive" ] && [ -f "$dependency_dir/include/sqlite3.h" ]; then
    native_postgis_dependency_archive sqlite "$archive"
    return 0
  fi
  [ -x "$source_dir/configure" ] || native_postgis_fail "missing SQLite checkout: $source_dir"
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
  [ -f "$archive" ] || native_postgis_fail "SQLite build did not produce $archive"
  native_postgis_dependency_archive sqlite "$archive"
}

build_native_postgis_geos_dependency() {
  local source_dir="$repo_root/target/oliphaunt-sources/checkouts/geos"
  local dependency_dir="$native_postgis_dependency_root/geos"
  local build_root="$work_root/geos-native-build"
  local geos_c_archive="$dependency_dir/lib/libgeos_c.a"
  local geos_archive="$dependency_dir/lib/libgeos.a"
  if [ -f "$geos_c_archive" ] && [ -f "$geos_archive" ] && [ -f "$dependency_dir/include/geos_c.h" ]; then
    native_postgis_dependency_archive geos-c "$geos_c_archive"
    native_postgis_dependency_archive geos "$geos_archive"
    return 0
  fi
  [ -f "$source_dir/CMakeLists.txt" ] || native_postgis_fail "missing GEOS checkout: $source_dir"
  rm -rf "$build_root" "$dependency_dir"
  native_postgis_cmake_install "$source_dir" "$build_root" "$dependency_dir" \
    -DBUILD_SHARED_LIBS=OFF \
    -DBUILD_TESTING=OFF \
    -DBUILD_BENCHMARKS=OFF \
    -DBUILD_GEOSOP=OFF \
    -DGEOS_BUILD_DEVELOPER=OFF
  [ -f "$geos_c_archive" ] || native_postgis_fail "GEOS build did not produce $geos_c_archive"
  [ -f "$geos_archive" ] || native_postgis_fail "GEOS build did not produce $geos_archive"
  native_postgis_dependency_archive geos-c "$geos_c_archive"
  native_postgis_dependency_archive geos "$geos_archive"
}

build_native_postgis_libxml2_dependency() {
  local source_dir="$repo_root/target/oliphaunt-sources/checkouts/libxml2"
  local dependency_dir="$native_postgis_dependency_root/libxml2"
  local build_root="$work_root/libxml2-native-build"
  local archive="$dependency_dir/lib/libxml2.a"
  if [ -f "$archive" ] && [ -x "$dependency_dir/bin/xml2-config" ]; then
    native_postgis_dependency_archive libxml2 "$archive"
    return 0
  fi
  [ -f "$source_dir/CMakeLists.txt" ] || native_postgis_fail "missing libxml2 checkout: $source_dir"
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
  [ -f "$archive" ] || native_postgis_fail "libxml2 build did not produce $archive"
  native_postgis_dependency_archive libxml2 "$archive"
}

build_native_postgis_proj_dependency() {
  local source_dir="$repo_root/target/oliphaunt-sources/checkouts/proj"
  local dependency_dir="$native_postgis_dependency_root/proj"
  local sqlite_dir="$native_postgis_dependency_root/sqlite"
  local build_root="$work_root/proj-native-build"
  local archive="$dependency_dir/lib/libproj.a"
  if [ -f "$archive" ] && [ -f "$dependency_dir/share/proj/proj.db" ]; then
    native_postgis_dependency_archive proj "$archive"
    return 0
  fi
  [ -f "$source_dir/CMakeLists.txt" ] || native_postgis_fail "missing PROJ checkout: $source_dir"
  [ -f "$sqlite_dir/lib/libsqlite3.a" ] || native_postgis_fail "PROJ dependency requires SQLite archive first"
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
  [ -f "$archive" ] || native_postgis_fail "PROJ build did not produce $archive"
  [ -f "$dependency_dir/share/proj/proj.db" ] || native_postgis_fail "PROJ build did not produce proj.db"
  native_postgis_dependency_archive proj "$archive"
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
  --clibs|--libs)
    echo "-L$native_postgis_dependency_root/geos/lib -lgeos_c -lgeos -lc++"
    ;;
  --cflags)
    echo "-I$native_postgis_dependency_root/geos/include"
    ;;
  --version)
    echo "3.14.0dev"
    ;;
  *)
    exec "$native_postgis_dependency_root/geos/bin/geos-config" "\$@"
    ;;
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
      *" --libs "*) echo "-L$native_postgis_dependency_root/proj/lib -lproj -L$native_postgis_dependency_root/sqlite/lib -lsqlite3 -lc++"; exit 0 ;;
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

use_native_postgis_dependency_bundle() {
  build_native_postgis_dependencies
  local scripts_dir="$work_root/postgis-native-dependency-scripts"
  rm -rf "$scripts_dir"
  mkdir -p "$scripts_dir"
  native_postgis_geos_config_script "$scripts_dir/geos-config"
  native_postgis_pkg_config_script "$scripts_dir/pkg-config"

  postgis_proj_prefix="$native_postgis_dependency_root/proj"
  postgis_configure_args=(
    "--with-geosconfig=$scripts_dir/geos-config"
    "--with-jsondir=$native_postgis_dependency_root/json-c"
    "--with-xml2config=$native_postgis_dependency_root/libxml2/bin/xml2-config"
  )
  postgis_configure_env=(
    "PATH=$scripts_dir:$PATH"
    "PKG_CONFIG=$scripts_dir/pkg-config"
    "PKG_CONFIG_ALLOW_SYSTEM_CFLAGS=1"
    "PKG_CONFIG_ALLOW_SYSTEM_LIBS=1"
    "PKG_CONFIG_LIBDIR=$native_postgis_dependency_root/json-c/lib/pkgconfig:$native_postgis_dependency_root/proj/lib/pkgconfig:$native_postgis_dependency_root/sqlite/lib/pkgconfig"
    "PKG_CONFIG_PATH=$native_postgis_dependency_root/json-c/lib/pkgconfig:$native_postgis_dependency_root/proj/lib/pkgconfig:$native_postgis_dependency_root/sqlite/lib/pkgconfig"
    "CPPFLAGS=-I$native_postgis_dependency_root/libxml2/include/libxml2 -I$native_postgis_dependency_root/proj/include -I$native_postgis_dependency_root/json-c/include -I$native_postgis_dependency_root/json-c/include/json-c -I$native_postgis_dependency_root/geos/include"
    "LDFLAGS=-L$native_postgis_dependency_root/geos/lib -L$native_postgis_dependency_root/proj/lib -L$native_postgis_dependency_root/sqlite/lib -L$native_postgis_dependency_root/json-c/lib -L$native_postgis_dependency_root/libxml2/lib"
    "LIBS=-lsqlite3 -lc++"
    "JSONC_CFLAGS=-I$native_postgis_dependency_root/json-c/include -I$native_postgis_dependency_root/json-c/include/json-c"
    "JSONC_LIBS=-L$native_postgis_dependency_root/json-c/lib -ljson-c"
    "CXX=${OLIPHAUNT_CXX:-c++}"
  )
  postgis_make_args=(
    "LDFLAGS=-L$native_postgis_dependency_root/geos/lib -L$native_postgis_dependency_root/proj/lib -L$native_postgis_dependency_root/sqlite/lib -L$native_postgis_dependency_root/json-c/lib -L$native_postgis_dependency_root/libxml2/lib"
    "LIBS=-lgeos_c -lgeos -lproj -lsqlite3 -ljson-c -lxml2 -lc++"
  )
}

pgcrypto_make_args=()
configure_pgcrypto_make_args() {
  local openssl_prefix
  openssl_prefix="$(native_openssl_prefix)"
  pgcrypto_make_args=("PG_CPPFLAGS=-I$openssl_prefix/include")
  if [ -f "$openssl_prefix/lib/libcrypto.a" ]; then
    pgcrypto_make_args+=("PG_LDFLAGS=$openssl_prefix/lib/libcrypto.a")
  else
    pgcrypto_make_args+=("PG_LDFLAGS=-L$openssl_prefix/lib" "LIBS=-lcrypto")
  fi
}

postgis_configure_args=()
postgis_proj_prefix=""
configure_postgis_configure_args() {
  postgis_configure_env=()
  postgis_make_args=()
  if [ "${OLIPHAUNT_POSTGIS_USE_PINNED_DEPS:-0}" = "1" ]; then
    use_native_postgis_dependency_bundle
    return
  fi

  local geos_config
  geos_config="$(native_dependency_tool \
    OLIPHAUNT_GEOS_CONFIG \
    geos-config \
    geos \
    /opt/homebrew/opt/geos/bin/geos-config \
    /usr/local/opt/geos/bin/geos-config || true)"
  local proj_prefix
  proj_prefix="$(native_dependency_prefix \
    OLIPHAUNT_PROJ_PREFIX \
    proj \
    /opt/homebrew/opt/proj \
    /usr/local/opt/proj || true)"
  local json_prefix
  json_prefix="$(native_dependency_prefix \
    OLIPHAUNT_JSONC_PREFIX \
    json-c \
    /opt/homebrew/opt/json-c \
    /usr/local/opt/json-c || true)"
  if [ -z "$geos_config" ] || [ -z "$proj_prefix" ] || [ -z "$json_prefix" ]; then
    echo "PostGIS native dependencies were not all available from the host; building pinned dependencies from target/oliphaunt-sources/checkouts" >&2
    use_native_postgis_dependency_bundle
    return
  fi

  postgis_proj_prefix="$proj_prefix"
  postgis_configure_args=(
    "--with-geosconfig=$geos_config"
    "--with-projdir=$proj_prefix"
    "--with-jsondir=$json_prefix"
  )
}

build_native_uuid_dependency() {
  local object="$native_uuid_dependency_dir/portable_uuid.o"

  if [ -f "$native_uuid_archive" ] && [ -d "$native_uuid_dependency_dir/include/uuid" ]; then
    return 0
  fi
  [ -f "$portable_uuid_dir/portable_uuid.c" ] || {
    echo "portable UUID source is missing: $portable_uuid_dir" >&2
    exit 1
  }

  rm -rf "$native_uuid_dependency_dir"
  mkdir -p "$native_uuid_dependency_dir/include" "$native_uuid_dependency_dir/lib"
  cp -R "$portable_uuid_dir/include/uuid" "$native_uuid_dependency_dir/include/"
  $CC $native_cflags \
    -I"$portable_uuid_dir/include" \
    -I"$build_dir/src/include" \
    -I"$build_dir/src/include/port" \
    -c "$portable_uuid_dir/portable_uuid.c" \
    -o "$object"
  ar crs "$native_uuid_archive" "$object"
  ranlib "$native_uuid_archive"
  [ -s "$native_uuid_archive" ] || {
    echo "portable UUID native build did not produce $native_uuid_archive" >&2
    exit 1
  }
}

build_contrib_extension() {
  local extension="$1"
  local -a extra_make_args
  local -a embedded_extra_make_args
  local extra_make_args_count=0
  local embedded_extra_make_args_count=0
  local embedded_pg_ldflags="$embedded_module_be_dllibs"
  local arg
  if [ "$extension" = "pgcrypto" ]; then
    configure_pgcrypto_make_args
    extra_make_args=("${pgcrypto_make_args[@]}")
    extra_make_args_count="${#pgcrypto_make_args[@]}"
  elif [ "$extension" = "uuid-ossp" ]; then
    build_native_uuid_dependency
    extra_make_args=(
      "PG_CPPFLAGS=-I$portable_uuid_dir/include -DHAVE_UUID_E2FS=1 -DHAVE_UUID_UUID_H=1"
      "UUID_LIBS=$native_uuid_archive"
    )
    extra_make_args_count=2
  fi
  if [ "$extra_make_args_count" -gt 0 ]; then
    for arg in "${extra_make_args[@]}"; do
      case "$arg" in
        PG_LDFLAGS=*)
          embedded_pg_ldflags="${arg#PG_LDFLAGS=} $embedded_pg_ldflags"
          ;;
        *)
          embedded_extra_make_args+=("$arg")
          embedded_extra_make_args_count=$((embedded_extra_make_args_count + 1))
          ;;
      esac
    done
  fi
  embedded_extra_make_args+=("PG_LDFLAGS=$embedded_pg_ldflags")
  embedded_extra_make_args_count=$((embedded_extra_make_args_count + 1))

  make -C "contrib/$extension" clean
  if [ "$extra_make_args_count" -gt 0 ]; then
    make -C "contrib/$extension" \
      CC="$CC" \
      BE_DLLLIBS="$normal_module_be_dllibs" \
      "${extra_make_args[@]}" \
      install
  else
    make -C "contrib/$extension" \
      CC="$CC" \
      BE_DLLLIBS="$normal_module_be_dllibs" \
      install
  fi
  make -C "contrib/$extension" clean
  if [ "$embedded_extra_make_args_count" -gt 0 ]; then
    make -C "contrib/$extension" \
      CC="$CC" \
      "${embedded_extra_make_args[@]}" \
      all
  else
    make -C "contrib/$extension" \
      CC="$CC" \
      all
  fi
  copy_embedded_modules_from_dir "contrib/$extension"
}

pgxs_extension_link_args() {
  local extension="$1"
  local link_kind="$2"
  local link_flags="$3"
  local be_dllibs="$link_flags"
  case "$extension" in
    pg_textsearch|pgvector|vector)
      if [ -n "$be_dllibs" ]; then
        be_dllibs="$be_dllibs -lm"
      else
        printf '%s\n' "SHLIB_LINK=-lm"
      fi
      ;;
    *)
      ;;
  esac
  if [ -n "$link_flags" ]; then
    case "$link_kind" in
      normal)
        printf '%s\n' "BE_DLLLIBS=$be_dllibs"
        ;;
      embedded)
        printf '%s\n' "PG_LDFLAGS=$link_flags"
        printf '%s\n' "BE_DLLLIBS=$be_dllibs"
        ;;
      *)
        echo "unknown PGXS extension link kind: $link_kind" >&2
        exit 1
        ;;
    esac
  fi
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
  done < <(pgxs_extension_link_args "$extension" "normal" "$normal_module_be_dllibs")
  while IFS= read -r arg; do
    [ -n "$arg" ] || continue
    embedded_link_args+=("$arg")
  done < <(pgxs_extension_link_args "$extension" "embedded" "$embedded_module_be_dllibs")
  if [ ! -d "$checkout" ]; then
    echo "native extension checkout is missing: $checkout" >&2
    exit 1
  fi
  rm -rf "$build_checkout"
  mkdir -p "$(dirname "$build_checkout")"
  cp -a "$checkout/." "$build_checkout/"
  rm -rf "$build_checkout/.git"
  make -C "$build_checkout" \
    PG_CONFIG="$install_dir/bin/pg_config" \
    clean
  make -C "$build_checkout" \
    PG_CONFIG="$install_dir/bin/pg_config" \
    CC="$CC" \
    OPTFLAGS="" \
    "${normal_link_args[@]}" \
    install
  make -C "$build_checkout" \
    PG_CONFIG="$install_dir/bin/pg_config" \
    clean
  make -C "$build_checkout" \
    PG_CONFIG="$install_dir/bin/pg_config" \
    CC="$CC" \
    OPTFLAGS="" \
    "${embedded_link_args[@]}" \
    all
  copy_embedded_modules_from_dir "$build_checkout"
}

normalize_installed_module_suffix() {
  local stem="$1"
  local module_dir="$install_dir/lib/postgresql"
  if [ ! -f "$module_dir/$stem.dylib" ] && [ -f "$module_dir/$stem.so" ]; then
    cp -p "$module_dir/$stem.so" "$module_dir/$stem.dylib"
  fi
}

copy_embedded_postgis_module() {
  local source_dir="$1"
  local candidate
  mkdir -p "$embedded_modules_dir"
  for candidate in "$source_dir/postgis-3.dylib" "$source_dir/postgis-3.so"; do
    if [ -f "$candidate" ]; then
      cp -p "$candidate" "$embedded_modules_dir/postgis-3.dylib"
      if ! module_depends_on_liboliphaunt "$embedded_modules_dir/postgis-3.dylib"; then
        echo "embedded PostGIS is not linked against liboliphaunt: $embedded_modules_dir/postgis-3.dylib" >&2
        exit 1
      fi
      return
    fi
  done
  echo "PostGIS embedded module was not produced under $source_dir" >&2
  exit 1
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
    /opt/homebrew/opt/proj/share/proj/proj.db \
    /usr/local/opt/proj/share/proj/proj.db \
    /opt/homebrew/share/proj/proj.db \
    /usr/local/share/proj/proj.db
  do
    [ -n "$candidate" ] || continue
    if [ -f "$candidate" ]; then
      proj_db="$candidate"
      break
    fi
  done
  if [ -z "$proj_db" ]; then
    echo "PostGIS requires proj/proj.db; set OLIPHAUNT_PROJ_DATADIR or install PROJ data files" >&2
    exit 1
  fi
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
  if [ ! -f "$checkout/configure.ac" ]; then
    echo "native PostGIS checkout is missing or incomplete: $checkout" >&2
    echo "run the source-spine fetch before building native PostGIS artifacts" >&2
    exit 1
  fi
  configure_postgis_configure_args

  rm -rf "$postgis_build_dir"
  mkdir -p "$(dirname "$postgis_build_dir")"
  cp -a "$checkout/." "$postgis_build_dir/"
  rm -rf "$postgis_build_dir/.git"

  (
    cd "$postgis_build_dir"
    local -a embedded_postgis_make_args=()
    local embedded_postgis_has_ldflags=0
    local embedded_postgis_ldflags="$embedded_module_be_dllibs"
    local arg
    for arg in "${postgis_make_args[@]}"; do
      case "$arg" in
        LDFLAGS=*)
          embedded_postgis_make_args+=("LDFLAGS=$embedded_postgis_ldflags ${arg#LDFLAGS=}")
          embedded_postgis_has_ldflags=1
          ;;
        *)
          embedded_postgis_make_args+=("$arg")
          ;;
      esac
    done
    if [ "$embedded_postgis_has_ldflags" -eq 0 ]; then
      embedded_postgis_make_args+=("LDFLAGS=$embedded_postgis_ldflags")
    fi

    export CC="$postgis_cc"
    if [ ! -f configure ]; then
      ./autogen.sh
    fi
    if [ "${#postgis_configure_env[@]}" -gt 0 ]; then
      export "${postgis_configure_env[@]}"
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
      --disable-nls

    patch_postgis_generated_makefiles "$postgis_build_dir"
    # PostGIS' generated revision header is referenced through postgis_config.h.
    # Build it before parallel sub-makes so compiler jobs cannot race the
    # top-level header generation target.
    make postgis_revision.h
    make clean || true
    make postgis_revision.h
    make -C doc CC="$postgis_cc" "${postgis_make_args[@]}" comments-install
    make -j"$jobs" -C postgis CC="$postgis_cc" "${postgis_make_args[@]}" install
    # PostGIS extension SQL generation has shared raster helper outputs even
    # when raster support is disabled, so keep this packaging phase serial.
    make -j1 -C extensions CC="$postgis_cc" "${postgis_make_args[@]}" all
    make -j1 -C extensions CC="$postgis_cc" "${postgis_make_args[@]}" install
    make -C postgis clean || true
    make postgis_revision.h
    make -j"$jobs" -C postgis CC="$postgis_cc" BE_DLLLIBS="$embedded_module_be_dllibs" "${embedded_postgis_make_args[@]}" all
  )

  normalize_installed_module_suffix postgis-3
  copy_embedded_postgis_module "$postgis_build_dir/postgis"
  stage_postgis_data_files "$postgis_build_dir"
}

build_embedded_plpgsql_module() {
  local module="$embedded_modules_dir/plpgsql.dylib"
  if module_depends_on_liboliphaunt "$module" && module_has_postgres_symbols_bound_to_liboliphaunt "$module"; then
    return
  fi
  make -C src/pl/plpgsql/src clean
  make -C src/pl/plpgsql/src \
    CC="$CC" \
    BE_DLLLIBS="$embedded_module_be_dllibs" \
    all
  mkdir -p "$embedded_modules_dir"
  cp -p src/pl/plpgsql/src/plpgsql.dylib "$module"
  if ! module_depends_on_liboliphaunt "$module"; then
    echo "embedded plpgsql is not linked against liboliphaunt: $module" >&2
    exit 1
  fi
  if ! module_has_postgres_symbols_bound_to_liboliphaunt "$module"; then
    echo "embedded plpgsql does not bind PostgreSQL symbols to liboliphaunt: $module" >&2
    exit 1
  fi
  audit_embedded_module "$module"
}

build_native_extension_artifacts() {
  if [ "${OLIPHAUNT_BUILD_EXTENSIONS:-0}" = "0" ]; then
    return
  fi

  local desired_extension_hash
  desired_extension_hash="$(extension_build_fingerprint)"

  if [ "${OLIPHAUNT_FORCE_EXTENSION_REBUILD:-0}" != "1" ] &&
    [ -f "$extension_build_stamp" ] &&
    [ "$(cat "$extension_build_stamp")" = "$desired_extension_hash" ] &&
    native_extension_artifacts_ready; then
    audit_embedded_extension_modules
    echo "reusing native extension artifacts"
    return
  fi

  rm -f "$extension_build_stamp"
  rm -f "$embedded_modules_dir/age.dylib" "$embedded_modules_dir/pg_hashids.dylib"

  local extension
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

  audit_embedded_extension_modules
  if ! native_extension_artifacts_ready; then
    echo "native extension build did not produce the required normal and embedded artifacts" >&2
    exit 1
  fi

  # Some extension builds generate source/header files inside their checkout or
  # contrib directory. Stamp the post-build fingerprint so --check-current
  # verifies the actual artifact-producing tree instead of the pre-build input
  # shape.
  desired_extension_hash="$(extension_build_fingerprint)"
  printf '%s\n' "$desired_extension_hash" > "$extension_build_stamp"
}

# Build and install a normal PostgreSQL tree first. initdb needs the matching
# sibling postgres binary and the installed share/lib tree needs core modules
# such as dict_snowball and plpgsql. Keep this separate from the embedded/PIC
# object pass so the runtime tools stay normal PostgreSQL while backend modules
# use embedded-friendly Darwin symbol lookup.
if ! runtime_installed; then
  rm -f "$postgres_runtime_stamp"
  # The embedded dylib pass intentionally rebuilds backend objects with
  # OLIPHAUNT_EMBEDDED. If the normal runtime install later becomes stale, do
  # not let make reuse those objects for the postgres/initdb toolchain.
  make clean CC="$CC"
  make -j"$jobs" CC="$CC"
  make install CC="$CC"
fi

if module_depends_on_liboliphaunt "$install_dir/lib/postgresql/plpgsql.dylib"; then
  install_normal_plpgsql_module
fi
oliphaunt_icu_stage_data "$icu_prefix" "$icu_data_dir"
rm -rf "$install_dir/share/icu"
prune_base_runtime_optional_extensions
printf '%s\n' "$desired_build_hash" > "$postgres_runtime_stamp"

if [ "$script_mode" = "--runtime-only" ]; then
  echo "$install_dir"
  exit 0
fi

regenerate_backend_headers() {
  rm -f src/include/nodes/header-stamp src/include/utils/header-stamp
  make -C src/backend generated-headers CC="$CC"
}

native_backend_objects_ready() {
  for required in \
    src/backend/tcop/postgres.o \
    src/backend/libpq/be-secure.o \
    src/backend/libpq/pqcomm.o
  do
    if [ ! -f "$required" ]; then
      return 1
    fi
  done
  for objfile in src/backend/*/objfiles.txt; do
    if [ ! -s "$objfile" ]; then
      return 1
    fi
  done
  nm -g src/backend/tcop/postgres.o | grep -q '_oliphaunt_embedded_main' || return 1
}

validate_native_objects() {
  if ! native_backend_objects_ready; then
    echo "native backend object build did not produce the required embedded objects" >&2
    exit 1
  fi
}

liboliphaunt_objects=()
for source in "${liboliphaunt_sources[@]}"; do
  object="$out_dir/$(basename "${source%.c}").o"
  liboliphaunt_objects+=("$object")
done

# Rebuild backend objects for the dylib only when the patched backend object
# tree is missing. C ABI iteration should normally recompile and relink only the
# liboliphaunt translation units above.
if native_backend_objects_ready; then
  echo "reusing native PostgreSQL backend objects"
else
  make -C src/backend clean
  regenerate_backend_headers
  set +e
  make -j"$jobs" -C src/backend \
    CC="$CC" \
    CFLAGS="$native_cflags" \
    postgres
  native_make_status=$?
  set -e
  validate_native_objects
  if [ "$native_make_status" -ne 0 ]; then
    echo "native backend executable link failed after objects were produced; continuing with dylib link" >&2
  fi
fi

make -C src/timezone CC="$CC" CFLAGS="$native_cflags" localtime.o pgtz.o strftime.o

{
  cat src/backend/*/objfiles.txt
  printf 'src/timezone/localtime.o src/timezone/pgtz.o src/timezone/strftime.o\n'
} | tr '[:space:]' '\n' | sed '/^$/d' > "$objects_rsp"

build_liboliphaunt_dylib
build_embedded_plpgsql_module
build_native_extension_artifacts

echo "$lib_out"
echo "Set LIBOLIPHAUNT_PATH=$lib_out"
echo "Set OLIPHAUNT_INITDB=$install_dir/bin/initdb"
echo "Set OLIPHAUNT_POSTGRES=$install_dir/bin/postgres"
