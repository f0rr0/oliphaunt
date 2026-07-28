#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$script_dir/common.sh"
. "$script_dir/icu.sh"
. "$script_dir/mobile-static-extensions.sh"
. "$script_dir/mobile-postgis-extensions.sh"
script_path="$script_dir/$(basename "$0")"
repo_root="$(oliphaunt_resolve_repo_root "$script_dir")"
. "$repo_root/src/postgres/versions/18/fetch-source.sh"
oliphaunt_mobile_target="ios-device"
pg_version="18.4"
pg_sha256="81a81ec695fb0c7901407defaa1d2f7973617154cf27ba74e3a7ab8e64436094"
pg_url="https://ftp.postgresql.org/pub/source/v${pg_version}/postgresql-${pg_version}.tar.bz2"
source_manifest="$repo_root/src/runtimes/liboliphaunt/native/postgres18/source.toml"
patch_dir="$repo_root/src/runtimes/liboliphaunt/native/patches/postgresql-${pg_version}"
work_root="${OLIPHAUNT_IOS_DEVICE_ROOT:-$repo_root/target/liboliphaunt-ios-device}"
source_cache="$work_root/source"
tarball="$source_cache/postgresql-${pg_version}.tar.bz2"
build_dir="$work_root/postgresql-${pg_version}"
install_dir="$work_root/install"
out_dir="$work_root/out"
stamp="$build_dir/.liboliphaunt-ios-device-build.sha256"
configure_log="$work_root/configure.log"
make_log="$work_root/make.log"
objects_rsp="$out_dir/liboliphaunt-ios-objects.rsp"
lib_out="$out_dir/liboliphaunt.dylib"
mobile_static_registry_source="$out_dir/liboliphaunt_mobile_static_registry.c"
mobile_static_registry_object="$out_dir/liboliphaunt_mobile_static_registry.o"
script_mode="${1:-build}"
icu_source_dir="$(oliphaunt_icu_source_dir "$repo_root")"
icu_native_build_dir="$work_root/icu-native"
icu_build_dir="$work_root/icu-ios-device-build"
icu_prefix="$work_root/icu-ios-device"
icu_cflags="$(oliphaunt_icu_cflags "$icu_prefix")"
icu_static_libs="$(oliphaunt_icu_static_libs "$icu_prefix")"
icu_cpp_libs="-lc++"
icu_libs="$icu_static_libs $icu_cpp_libs"
failure_phase="initialization"

report_failure() {
  local status="${1:-1}"
  local line="${2:-unknown}"
  local log
  if [ "$status" -eq 0 ]; then
    return 0
  fi
  trap - EXIT
  printf 'PostgreSQL iOS device build failed during %s (line %s, status %s)\n' \
    "$failure_phase" "$line" "$status" >&2
  for log in "$configure_log" "$make_log"; do
    if [ -s "$log" ]; then
      printf '%s\n' "--- tail of $log ---" >&2
      tail -160 "$log" >&2 || true
    fi
  done
  exit "$status"
}

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

jit_objects=(
  src/backend/jit/jit.o
)

generated_header_stamps=(
  src/include/catalog/bki-stamp
  src/include/nodes/header-stamp
  src/include/utils/header-stamp
)

generated_header_files=(
  src/backend/parser/gram.h
  src/include/catalog/pg_proc_d.h
  src/include/catalog/schemapg.h
  src/include/nodes/nodetags.h
  src/include/storage/lwlocknames.h
  src/include/utils/errcodes.h
  src/include/utils/fmgroids.h
  src/include/utils/fmgrprotos.h
  src/include/utils/pgstat_wait_event.c
  src/include/utils/probes.h
  src/include/utils/wait_event_funcs_data.c
  src/include/utils/wait_event_types.h
)

mobile_static_extensions=()
mobile_static_objects=()
mobile_static_dependency_archives=()
mobile_static_dependency_root="$out_dir/dependencies"
export OLIPHAUNT_MOBILE_STATIC_DEPENDENCY_ROOT="$mobile_static_dependency_root"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "PostgreSQL iOS device build requires Darwin" >&2
  exit 2
fi

for cmd in curl git nm patch perl rg shasum xcrun; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "missing required command: $cmd" >&2
    exit 1
  fi
done

sdk_path="$(xcrun --sdk iphoneos --show-sdk-path 2>/dev/null || true)"
clang_path="$(xcrun --find --sdk iphoneos clang 2>/dev/null || true)"
clangxx_path="$(xcrun --find --sdk iphoneos clang++ 2>/dev/null || true)"
ar_path="$(xcrun --find --sdk iphoneos ar 2>/dev/null || true)"
ranlib_path="$(xcrun --find --sdk iphoneos ranlib 2>/dev/null || true)"
libtool_path="$(xcrun --find --sdk iphoneos libtool 2>/dev/null || true)"
if [ -z "$sdk_path" ] || [ -z "$clang_path" ] || [ -z "$clangxx_path" ] || [ -z "$ar_path" ] || [ -z "$ranlib_path" ] || [ -z "$libtool_path" ]; then
  echo "iPhoneOS SDK is unavailable" >&2
  exit 1
fi
oliphaunt_icu_require_source "$icu_source_dir"

min_ios="${OLIPHAUNT_IOS_MIN_VERSION:-17.0}"
cc=("$clang_path" -target "arm64-apple-ios${min_ios}" "-miphoneos-version-min=${min_ios}" -isysroot "$sdk_path")
cxx=("$clangxx_path" -target "arm64-apple-ios${min_ios}" "-miphoneos-version-min=${min_ios}" -isysroot "$sdk_path")
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
native_cflags="$(oliphaunt_native_release_cflags -fPIC -march=armv8-a+crc -DOLIPHAUNT_EMBEDDED -DOLIPHAUNT_EMBEDDED_MOBILE_SHMEM)"
liboliphaunt_cflags="$native_cflags -DOLIPHAUNT_BUILTIN_PLPGSQL"
pg_extension_cflags="$native_cflags $icu_cflags"
jobs="${OLIPHAUNT_JOBS:-$(sysctl -n hw.ncpu 2>/dev/null || echo 4)}"

parse_mobile_static_extensions() {
  local raw="${OLIPHAUNT_MOBILE_STATIC_EXTENSIONS:-}"
  [ -n "$raw" ] || return 0
  local extension
  while IFS= read -r extension; do
    extension="$(printf '%s' "$extension" | xargs)"
    [ -n "$extension" ] || continue
    if ! oliphaunt_mobile_static_extension_spec "$extension" >/dev/null; then
      echo "unsupported iOS mobile static extension: $extension" >&2
      printf 'supported iOS mobile static extensions: ' >&2
      oliphaunt_mobile_static_supported_extensions | paste -sd ',' - >&2
      exit 2
    fi
    mobile_static_extensions+=("$(oliphaunt_mobile_static_extension_sql_name "$extension")")
  done < <(printf '%s\n' "$raw" | tr ',' '\n')
}

mobile_static_extensions_include() {
  local wanted="$1"
  local extension
  for extension in ${mobile_static_extensions[@]+"${mobile_static_extensions[@]}"}; do
    [ "$extension" = "$wanted" ] && return 0
  done
  return 1
}

mobile_static_dependency_selected() {
  local wanted="$1"
  local extension dependency
  for extension in ${mobile_static_extensions[@]+"${mobile_static_extensions[@]}"}; do
    while IFS= read -r dependency; do
      [ -n "$dependency" ] || continue
      [ "$dependency" = "$wanted" ] && return 0
    done < <(oliphaunt_mobile_static_extension_dependencies "$extension")
  done
  return 1
}

hash_mobile_static_extension_sources() {
  local extension file
  for extension in ${mobile_static_extensions[@]+"${mobile_static_extensions[@]}"}; do
    while IFS= read -r file; do
      [ -n "$file" ] || continue
      shasum -a 256 "$file"
    done < <(oliphaunt_mobile_static_extension_hash_inputs "$repo_root" "$build_dir" "$extension")
  done
}

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
    printf 'native_cflags=%s\n' "$native_cflags"
    printf 'liboliphaunt_cflags=%s\n' "$liboliphaunt_cflags"
    printf 'pg_extension_cflags=%s\n' "$pg_extension_cflags"
    printf 'mobile_static_extensions=%s\n' "${mobile_static_extensions[*]-}"
    printf 'postgis_source_date_epoch=%s\n' "$(oliphaunt_postgis_reproducible_epoch)"
    printf 'patch_series_hash=%s\n' "$(patch_series_hash)"
    printf 'liboliphaunt_sources=%s\n' "${liboliphaunt_sources[*]}"
    printf 'plpgsql_objects=%s\n' "${plpgsql_objects[*]}"
    printf 'jit_objects=%s\n' "${jit_objects[*]}"
    printf 'script_sha256=%s\n' "$(shasum -a 256 "$script_path" | awk '{print $1}')"
    shasum -a 256 "$script_dir/postgres-backend-objects.mk"
    shasum -a 256 "$script_dir/mobile-static-extensions.sh" "$script_dir/mobile-postgis-extensions.sh"
    shasum -a 256 \
      "$repo_root/src/extensions/external/postgis/tools/reproducible-time.sh" \
      "$repo_root/src/extensions/external/postgis/tools/reproducible-bin/date"
    shasum -a 256 "$source_manifest"
    shasum -a 256 "${liboliphaunt_sources[@]}"
    hash_mobile_static_extension_sources
  } | shasum -a 256 | awk '{print $1}'
}

apply_patch_series() {
  local patch_name
  while IFS= read -r patch_name; do
    [ -n "$patch_name" ] || continue
    GIT_CEILING_DIRECTORIES="$work_root" git apply --whitespace=error-all "$patch_dir/$patch_name" >/dev/null
  done < <(patch_series)
}

patched_source_ready() {
  grep -Fq 'OliphauntEmbeddedIO' "$build_dir/src/include/libpq/libpq-be.h" &&
    grep -Fq 'oliphaunt_embedded_main' "$build_dir/src/backend/tcop/postgres.c" &&
    grep -Fq 'oliphaunt_embedded_kill' "$build_dir/src/port/pqsignal.c" &&
    grep -Fq 'oliphaunt_embedded_raise' "$build_dir/src/port/pqsignal.c" &&
    grep -Fq 'getenv("ICU_DATA")' "$build_dir/src/bin/initdb/initdb.c" &&
    grep -Fq 'oliphaunt_embedded' "$build_dir/meson_options.txt" &&
    grep -Fq 'OLIPHAUNT_EMBEDDED' "$build_dir/meson.build"
}

artifact_ready() {
  [ -f "$lib_out" ] || return 1
  oliphaunt_icu_artifacts_ready "$icu_prefix" || return 1
  xcrun vtool -show-build "$lib_out" 2>/dev/null | rg -q "platform IOS" || return 1
  local symbols
  symbols="$(nm -g "$lib_out" 2>/dev/null || true)"
  local linked_symbols
  linked_symbols="$(nm "$lib_out" 2>/dev/null || true)"
  oliphaunt_icu_linked_symbols_ready "$linked_symbols" || return 1
  local undefined_symbols
  undefined_symbols="$(nm -u "$lib_out" 2>/dev/null || true)"
  if printf '%s\n' "$undefined_symbols" | rg -q '_shm(get|ctl|dt)|_shm_open|_sem(get|ctl|op|open|close|unlink|wait|post|trywait|init|destroy)'; then
    return 1
  fi
  local symbol
  for symbol in \
    _oliphaunt_init \
    _oliphaunt_init_ex \
    _oliphaunt_exec_protocol \
    _oliphaunt_exec_protocol_stream \
    _oliphaunt_backup \
    _oliphaunt_backup_ex \
    _oliphaunt_restore \
    _oliphaunt_cancel \
    _oliphaunt_detach \
    _oliphaunt_logical_generation \
    _oliphaunt_close_if_generation \
    _oliphaunt_close \
    _oliphaunt_register_static_extensions \
    _oliphaunt_last_error \
    _oliphaunt_version \
    _oliphaunt_capabilities \
    _oliphaunt_free_response \
    _oliphaunt_embedded_kill \
    _oliphaunt_embedded_raise
  do
    case "$symbols" in *"$symbol"*) ;; *) return 1 ;; esac
  done
  if [ "${#mobile_static_extensions[@]}" -gt 0 ]; then
    case "$symbols" in *"_liboliphaunt_selected_static_extensions"*) ;; *) return 1 ;; esac
    local extension stem prefix
    for extension in ${mobile_static_extensions[@]+"${mobile_static_extensions[@]}"}; do
      stem="$(oliphaunt_mobile_static_extension_module_stem "$extension")"
      prefix="$(oliphaunt_static_symbol_prefix "$stem")"
      [ -f "$out_dir/extensions/$stem/liboliphaunt_extension_$stem.a" ] || return 1
      case "$symbols" in *"_${prefix}_Pg_magic_func"*) ;; *) return 1 ;; esac
    done
  fi
}

backend_objects_ready() {
  for required in \
    src/backend/tcop/postgres.o \
    src/backend/libpq/be-secure.o \
    src/backend/libpq/pqcomm.o \
    src/backend/port/oliphaunt_embedded_sema.o \
    src/backend/port/oliphaunt_embedded_shmem.o
  do
    [ -f "$required" ] || return 1
  done
  for objfile in src/backend/*/objfiles.txt; do
    [ -s "$objfile" ] || return 1
  done
  nm -g src/backend/tcop/postgres.o | rg -q "_oliphaunt_embedded_main" || return 1
}

support_libraries_ready() {
  for required in \
    src/common/libpgcommon_srv.a \
    src/port/libpgport_srv.a
  do
    [ -f "$required" ] || return 1
  done

  local symbols
  symbols="$(nm -gU src/port/libpgport_srv.a 2>/dev/null || true)"
  local symbol
  for symbol in _oliphaunt_embedded_kill _oliphaunt_embedded_raise; do
    grep -Eq "[[:space:]]${symbol}$" <<< "$symbols" || return 1
  done
}

plpgsql_objects_ready() {
  local object
  for object in "${plpgsql_objects[@]}"; do
    [ -f "$object" ] || return 1
  done
  nm -g src/pl/plpgsql/src/pl_handler.o | rg -q "_plpgsql_call_handler" || return 1
}

jit_objects_ready() {
  local object
  for object in "${jit_objects[@]}"; do
    [ -f "$object" ] || return 1
  done
  nm -g src/backend/jit/jit.o | rg -q "_pg_jit_available" || return 1
}

generated_headers_ready() {
  local required
  for required in "${generated_header_stamps[@]}"; do
    [ -f "$required" ] || return 1
  done
  for required in "${generated_header_files[@]}"; do
    [ -s "$required" ] || return 1
  done
}

explain_generated_header_state() {
  local required
  for required in "${generated_header_stamps[@]}"; do
    if [ ! -f "$required" ]; then
      echo "missing PostgreSQL generated-header stamp: $build_dir/$required" >&2
    fi
  done
  for required in "${generated_header_files[@]}"; do
    if [ ! -s "$required" ]; then
      echo "missing or empty PostgreSQL generated header: $build_dir/$required" >&2
    fi
  done
}

prepare_source() {
  mkdir -p "$source_cache" "$work_root" "$out_dir"

  oliphaunt_fetch_postgresql_source_archive "$tarball" "$pg_version" "$pg_sha256" "$pg_url"
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
  if ! patched_source_ready; then
    echo "PostgreSQL embedded patch verification failed" >&2
    exit 1
  fi
}

configure_source() {
  export CC="$cc_string"
  export CXX="$cxx_string"
  export CFLAGS="$native_cflags"
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
    "$jobs" \
    "ios-device" \
    "aarch64-apple-darwin" \
    "$cc_string" \
    "$cxx_string" \
    "$ar_path" \
    "$ranlib_path" \
    "$native_cflags" \
    "$native_cflags" \
    "-isysroot $sdk_path"
}

build_generated_headers() {
  (
    cd "$build_dir"

    # PostgreSQL's generated-header targets use stamp files for multi-output
    # generators. Invalidate both the stamps and their generated sources so a
    # restored or interrupted build cannot silently reuse a stale header.
    rm -f \
      src/backend/nodes/node-support-stamp \
      src/backend/nodes/nodetags.h \
      src/backend/storage/lmgr/lwlocknames.h \
      src/backend/utils/errcodes.h \
      src/backend/utils/fmgr-stamp \
      src/backend/utils/fmgroids.h \
      src/backend/utils/fmgrprotos.h \
      src/backend/utils/fmgrtab.c \
      src/backend/utils/pgstat_wait_event.c \
      src/backend/utils/probes.h \
      src/backend/utils/wait_event_funcs_data.c \
      src/backend/utils/wait_event_types.h \
      src/include/catalog/bki-stamp \
      src/include/nodes/header-stamp \
      src/include/nodes/nodetags.h \
      src/include/storage/lwlocknames.h \
      src/include/utils/errcodes.h \
      src/include/utils/fmgroids.h \
      src/include/utils/fmgrprotos.h \
      src/include/utils/header-stamp \
      src/include/utils/pgstat_wait_event.c \
      src/include/utils/probes.h \
      src/include/utils/wait_event_funcs_data.c \
      src/include/utils/wait_event_types.h

    make -C src/backend generated-headers \
      OLIPHAUNT_EMBEDDED_MOBILE_SHMEM=1 \
      CC="$cc_string" >> "$make_log" 2>&1

    if ! generated_headers_ready; then
      explain_generated_header_state
      echo "PostgreSQL iOS device generated headers are incomplete" >&2
      exit 1
    fi
  )
}

build_backend_objects() {
  (
    cd "$build_dir"
    if ! generated_headers_ready; then
      explain_generated_header_state
      echo "PostgreSQL iOS device backend objects require generated headers" >&2
      exit 1
    fi
    if backend_objects_ready; then
      echo "reusing PostgreSQL iOS device backend objects" >&2
      return
    fi

    make -j"$jobs" -C src/backend \
      -f "$script_dir/postgres-backend-objects.mk" \
      OLIPHAUNT_EMBEDDED_MOBILE_SHMEM=1 \
      CC="$cc_string" \
      CFLAGS="$native_cflags" \
      oliphaunt-backend-objects >> "$make_log" 2>&1

    if ! backend_objects_ready; then
      tail -120 "$make_log" >&2 || true
      echo "PostgreSQL iOS device backend objects are incomplete" >&2
      exit 1
    fi
  )
}

build_support_libraries() {
  (
    cd "$build_dir"
    if ! generated_headers_ready; then
      explain_generated_header_state
      echo "PostgreSQL iOS device support libraries require generated headers" >&2
      exit 1
    fi
    if ! support_libraries_ready; then
      make -C src/common clean >> "$make_log" 2>&1
      make -C src/port clean >> "$make_log" 2>&1
    fi
    make -C src/common \
      CC="$cc_string" \
      CFLAGS="$native_cflags" \
      libpgcommon_srv.a >> "$make_log" 2>&1
    make -C src/port \
      CC="$cc_string" \
      CFLAGS="$native_cflags" \
      libpgport_srv.a >> "$make_log" 2>&1
    if ! support_libraries_ready; then
      echo "PostgreSQL iOS device support libraries do not provide the embedded signal boundary" >&2
      exit 1
    fi
  )
}

build_timezone_objects() {
  (
    cd "$build_dir"
    make -C src/timezone \
      CC="$cc_string" \
      CFLAGS="$native_cflags" \
      localtime.o pgtz.o strftime.o >> "$make_log" 2>&1
  )
}

build_plpgsql_objects() {
  (
    cd "$build_dir"
    if plpgsql_objects_ready; then
      echo "reusing PostgreSQL iOS device PL/pgSQL objects" >&2
      return
    fi

    make -C src/pl/plpgsql/src clean >> "$make_log" 2>&1
    make -C src/pl/plpgsql/src \
      CC="$cc_string" \
      CFLAGS="$native_cflags" \
      pl_comp.o pl_exec.o pl_funcs.o pl_gram.o pl_handler.o pl_scanner.o >> "$make_log" 2>&1

    if ! plpgsql_objects_ready; then
      tail -120 "$make_log" >&2 || true
      echo "PostgreSQL iOS device PL/pgSQL objects are incomplete" >&2
      exit 1
    fi
  )
}

build_jit_objects() {
  (
    cd "$build_dir"
    if jit_objects_ready; then
      echo "reusing PostgreSQL iOS device JIT stub objects" >&2
      return
    fi

    make -C src/backend/jit \
      CC="$cc_string" \
      CFLAGS="$native_cflags" \
      jit.o >> "$make_log" 2>&1

    if ! jit_objects_ready; then
      tail -120 "$make_log" >&2 || true
      echo "PostgreSQL iOS device JIT stub objects are incomplete" >&2
      exit 1
    fi
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

build_openssl_dependency() {
  mobile_static_dependency_selected openssl || return 0
  local source_dir="$repo_root/target/oliphaunt-sources/checkouts/openssl"
  local dependency_dir="$mobile_static_dependency_root/openssl"
  local build_root="$work_root/openssl-ios-device"
  local install_root="$work_root/openssl-ios-device-install"
  local installed_archive=""
  local archive="$dependency_dir/libcrypto.a"

  if [ -f "$archive" ] && [ -d "$dependency_dir/include/openssl" ]; then
    mobile_static_dependency_archives+=("$archive")
    return 0
  fi
  [ -d "$source_dir" ] || {
    echo "OpenSSL checkout is missing: $source_dir" >&2
    exit 1
  }

  rm -rf "$build_root" "$install_root" "$dependency_dir"
  mkdir -p "$(dirname "$build_root")" "$dependency_dir/include"
  cp -a "$source_dir/." "$build_root/"
  rm -rf "$build_root/.git"
  (
    cd "$build_root"
    CFLAGS="-O2 -fPIC -miphoneos-version-min=${min_ios}" \
      ./Configure ios64-xcrun \
        no-shared no-tests no-apps no-docs no-engine no-module \
        --prefix="$install_root" \
        --openssldir="$install_root/ssl" >> "$make_log" 2>&1
    make -j"$jobs" build_generated libcrypto.a >> "$make_log" 2>&1
    make install_dev >> "$make_log" 2>&1
  )
  for candidate in "$install_root/lib/libcrypto.a" "$install_root/lib64/libcrypto.a"; do
    if [ -f "$candidate" ]; then
      installed_archive="$candidate"
      break
    fi
  done
  if [ -z "$installed_archive" ]; then
    echo "OpenSSL iOS device build did not produce libcrypto.a" >&2
    exit 1
  fi
  cp -R "$install_root/include/openssl" "$dependency_dir/include/"
  cp -p "$installed_archive" "$archive"
  mobile_static_dependency_archives+=("$archive")
}

build_uuid_dependency() {
  mobile_static_dependency_selected uuid || return 0
  local source_dir="$repo_root/src/runtimes/liboliphaunt/native/portable-uuid"
  local dependency_dir="$mobile_static_dependency_root/uuid"
  local archive="$dependency_dir/lib/libuuid.a"
  local object="$dependency_dir/portable_uuid.o"

  if [ -f "$archive" ] && [ -d "$dependency_dir/include/uuid" ]; then
    mobile_static_dependency_archives+=("$archive")
    return 0
  fi
  [ -f "$source_dir/portable_uuid.c" ] || {
    echo "portable UUID source is missing: $source_dir" >&2
    exit 1
  }

  rm -rf "$dependency_dir"
  mkdir -p "$dependency_dir/include" "$dependency_dir/lib"
  cp -R "$source_dir/include/uuid" "$dependency_dir/include/"
  "${cc[@]}" $native_cflags \
    -I"$source_dir/include" \
    -I"$build_dir/src/include" \
    -I"$build_dir/src/include/port" \
    -c "$source_dir/portable_uuid.c" \
    -o "$object"
  "$libtool_path" -static -o "$archive" "$object"
  [ -s "$archive" ] || {
    echo "portable UUID iOS device build did not produce $archive" >&2
    exit 1
  }
  mobile_static_dependency_archives+=("$archive")
}

build_mobile_static_dependencies() {
  build_openssl_dependency
  build_uuid_dependency
  build_postgis_mobile_static_dependencies
}

build_mobile_static_extension_objects() {
  local extension source source_dir source_rel object object_dir objects_file stem prefix
  local -a compile_args extension_include_args extension_cflags
  for extension in ${mobile_static_extensions[@]+"${mobile_static_extensions[@]}"}; do
    if [ "$extension" = "postgis" ]; then
      build_postgis_mobile_static_extension_objects "$extension"
      continue
    fi
    stem="$(oliphaunt_mobile_static_extension_module_stem "$extension")"
    prefix="$(oliphaunt_static_symbol_prefix "$stem")"
    source_dir="$(oliphaunt_mobile_static_extension_source_dir "$repo_root" "$build_dir" "$extension")"
    extension_include_args=()
    while IFS= read -r include_dir; do
      [ -n "$include_dir" ] || continue
      extension_include_args+=("-I$include_dir")
    done < <(oliphaunt_mobile_static_extension_include_dirs "$repo_root" "$build_dir" "$extension")
    extension_cflags=()
    while IFS= read -r cflag; do
      [ -n "$cflag" ] || continue
      extension_cflags+=("$cflag")
    done < <(oliphaunt_mobile_static_extension_cflags "$extension")
    if [ "$(oliphaunt_mobile_static_extension_kind "$extension")" = "contrib" ]; then
      (
        cd "$build_dir"
        make -C "$(oliphaunt_mobile_static_extension_source_rel "$extension")" \
          CC="$cc_string" \
          CFLAGS="$pg_extension_cflags" \
          all >> "$make_log" 2>&1 || true
      )
    fi
    object_dir="$out_dir/extensions/$stem"
    objects_file="$object_dir/objects.list"
    mkdir -p "$object_dir"
    : > "$objects_file"
    while IFS= read -r source; do
      [ -n "$source" ] || continue
      source_rel="${source#$source_dir/}"
      object="$object_dir/${source_rel%.c}.o"
      mkdir -p "$(dirname "$object")"
      mobile_static_objects+=("$object")
      printf '%s\n' "$object" >> "$objects_file"
      compile_args=(
        "${cc[@]}" $pg_extension_cflags
        -DPg_magic_func="${prefix}_Pg_magic_func" \
        -D_PG_init="${prefix}__PG_init"
      )
      if [ "${#extension_cflags[@]}" -gt 0 ]; then
        compile_args+=("${extension_cflags[@]}")
      fi
      if [ "${#extension_include_args[@]}" -gt 0 ]; then
        compile_args+=("${extension_include_args[@]}")
      fi
      compile_args+=(
        -I"$build_dir/src/include"
        -I"$build_dir/src/include/port"
        -c "$source"
        -o "$object"
      )
      "${compile_args[@]}"
    done < <(oliphaunt_mobile_static_extension_source_files "$repo_root" "$build_dir" "$extension")
    if [ ! -s "$objects_file" ]; then
      echo "mobile static extension $extension did not produce object inputs" >&2
      exit 1
    fi
    archive_mobile_static_extension_objects "$extension" "$object_dir" "$objects_file"
  done
}

archive_mobile_static_extension_objects() {
  local extension="$1"
  local object_dir="$2"
  local objects_file="$3"
  local stem archive
  local -a archive_objects
  stem="$(oliphaunt_mobile_static_extension_module_stem "$extension")"
  archive="$object_dir/liboliphaunt_extension_$stem.a"
  while IFS= read -r object; do
    [ -n "$object" ] && archive_objects+=("$object")
  done < "$objects_file"
  rm -f "$archive"
  "$libtool_path" -static -o "$archive" "${archive_objects[@]}"
  if [ ! -s "$archive" ]; then
    echo "mobile static extension $extension did not produce archive $archive" >&2
    exit 1
  fi
}

defined_c_symbols() {
  local stem="$1"
  local prefix="$2"
  local objects_file="$out_dir/extensions/$stem/objects.list"
  # shellcheck disable=SC2046
  nm -g $(cat "$objects_file") |
    awk '
      $2 == "T" {
        symbol = $3
        sub(/^_/, "", symbol)
        if (symbol == "" ||
            index(symbol, prefix "_") == 1 ||
            symbol == "Pg_magic_func" ||
            symbol == "_PG_init") {
          next
        }
        if (symbol ~ /^[A-Za-z_][A-Za-z0-9_]*$/) {
          print symbol
        }
      }
    ' prefix="$prefix" |
    LC_ALL=C sort -u
}

module_has_c_symbol() {
  local stem="$1"
  local symbol="$2"
  local objects_file="$out_dir/extensions/$stem/objects.list"
  # shellcheck disable=SC2046
  nm -g $(cat "$objects_file") | awk -v wanted="_$symbol" '$3 == wanted { found = 1 } END { exit found ? 0 : 1 }'
}

write_mobile_static_registry_source() {
  [ "${#mobile_static_extensions[@]}" -gt 0 ] || return 0
  local extension stem prefix symbols_file alias_file init_symbol symbols_expr symbol_count_expr
  {
    cat <<'HEADER'
/* Generated by Oliphaunt mobile build. Do not edit by hand. */
#include <stddef.h>
#include <stdint.h>
#include "oliphaunt.h"

HEADER
    for extension in ${mobile_static_extensions[@]+"${mobile_static_extensions[@]}"}; do
      stem="$(oliphaunt_mobile_static_extension_module_stem "$extension")"
      prefix="$(oliphaunt_static_symbol_prefix "$stem")"
      symbols_file="$out_dir/extensions/$stem/symbols.list"
      alias_file="$out_dir/extensions/$stem/symbol-aliases.list"
      defined_c_symbols "$stem" "$prefix" > "$symbols_file"
      if [ ! -s "$symbols_file" ] && ! module_has_c_symbol "$stem" "${prefix}__PG_init"; then
        echo "mobile static extension $extension did not produce exported C symbols or an init hook" >&2
        exit 1
      fi
      printf 'extern const void *%s_Pg_magic_func(void);\n' "$prefix"
      if module_has_c_symbol "$stem" "${prefix}__PG_init"; then
        printf 'extern void %s__PG_init(void);\n' "$prefix"
      fi
      while IFS= read -r symbol; do
        printf 'extern void %s(void);\n' "$symbol"
      done < "$symbols_file"
      if [ -s "$alias_file" ]; then
        while IFS=$'\t' read -r _ linked_symbol; do
          [ -n "$linked_symbol" ] || continue
          printf 'extern void %s(void);\n' "$linked_symbol"
        done < "$alias_file"
      fi
      printf '\n'
    done

    for extension in ${mobile_static_extensions[@]+"${mobile_static_extensions[@]}"}; do
      stem="$(oliphaunt_mobile_static_extension_module_stem "$extension")"
      prefix="$(oliphaunt_static_symbol_prefix "$stem")"
      symbols_file="$out_dir/extensions/$stem/symbols.list"
      alias_file="$out_dir/extensions/$stem/symbol-aliases.list"
      [ -s "$symbols_file" ] || [ -s "$alias_file" ] || continue
      printf 'static const OliphauntStaticExtensionSymbol %s_symbols[] = {\n' "$prefix"
      while IFS= read -r symbol; do
        printf '    { .name = "%s", .address = (void *)%s },\n' "$symbol" "$symbol"
      done < "$symbols_file"
      if [ -s "$alias_file" ]; then
        while IFS=$'\t' read -r sql_symbol linked_symbol; do
          [ -n "$sql_symbol" ] || continue
          [ -n "$linked_symbol" ] || continue
          printf '    { .name = "%s", .address = (void *)%s },\n' "$sql_symbol" "$linked_symbol"
        done < "$alias_file"
      fi
      printf '};\n\n'
    done

    printf 'static const OliphauntStaticExtension liboliphaunt_static_extensions[] = {\n'
    for extension in ${mobile_static_extensions[@]+"${mobile_static_extensions[@]}"}; do
      stem="$(oliphaunt_mobile_static_extension_module_stem "$extension")"
      prefix="$(oliphaunt_static_symbol_prefix "$stem")"
      symbols_file="$out_dir/extensions/$stem/symbols.list"
      alias_file="$out_dir/extensions/$stem/symbol-aliases.list"
      init_symbol="NULL"
      if module_has_c_symbol "$stem" "${prefix}__PG_init"; then
        init_symbol="${prefix}__PG_init"
      fi
      symbols_expr="NULL"
      symbol_count_expr="0"
      if [ -s "$symbols_file" ] || [ -s "$alias_file" ]; then
        symbols_expr="${prefix}_symbols"
        symbol_count_expr="sizeof(${prefix}_symbols) / sizeof(${prefix}_symbols[0])"
      fi
      cat <<ENTRY
    {
        .abi_version = OLIPHAUNT_STATIC_EXTENSION_ABI_VERSION,
        .name = "$stem",
        .magic = ${prefix}_Pg_magic_func,
        .init = $init_symbol,
        .symbols = $symbols_expr,
        .symbol_count = $symbol_count_expr,
        .reserved_flags = 0,
    },
ENTRY
    done
    cat <<'FOOTER'
};

const OliphauntStaticExtension *liboliphaunt_selected_static_extensions(size_t *count) {
    if (count != NULL) {
        *count = sizeof(liboliphaunt_static_extensions) / sizeof(liboliphaunt_static_extensions[0]);
    }
    return liboliphaunt_static_extensions;
}
FOOTER
  } > "$mobile_static_registry_source"
}

build_mobile_static_registry_object() {
  [ "${#mobile_static_extensions[@]}" -gt 0 ] || return 0
  "${cc[@]}" $native_cflags \
    -I"$repo_root/src/runtimes/liboliphaunt/native/include" \
    -c "$mobile_static_registry_source" \
    -o "$mobile_static_registry_object"
  mobile_static_objects+=("$mobile_static_registry_object")
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
  local -a postgis_link_args
  local link_arg
  while IFS= read -r link_arg; do
    [ -n "$link_arg" ] && postgis_link_args+=("$link_arg")
  done < <(oliphaunt_postgis_extra_link_args)
  (
    cd "$build_dir"
    set +u
    "${cc[@]}" -dynamiclib \
      -Wl,-install_name,@rpath/liboliphaunt.dylib \
      -o "$lib_out" \
      "${liboliphaunt_objects[@]}" \
      "${mobile_static_objects[@]}" \
      "${mobile_static_dependency_archives[@]}" \
      @"$objects_rsp" \
      src/common/libpgcommon_srv.a \
      src/port/libpgport_srv.a \
      $icu_libs \
      "${postgis_link_args[@]}" \
      -lpthread
    set -u
  )
}

usage() {
  cat >&2 <<'MSG'
usage: src/runtimes/liboliphaunt/native/bin/build-postgres18-ios-device.sh [--check-current]
MSG
}

parse_mobile_static_extensions

if [ "${OLIPHAUNT_PRINT_DESIRED_HASH:-0}" = "1" ]; then
  desired_hash
  exit 0
fi

case "$script_mode" in
  build)
    failure_phase="prepare source"
    # EXIT is observed by this outer shell even when errexit originates inside
    # a build function or subshell. The handler clears the trap before
    # returning the original status, so each failure is reported exactly once.
    trap 'report_failure "$?" "$LINENO"' EXIT
    prepare_source
    failure_phase="build ICU"
    build_icu
    failure_phase="configure PostgreSQL"
    configure_source
    if artifact_ready && (cd "$build_dir" && generated_headers_ready && backend_objects_ready && support_libraries_ready && plpgsql_objects_ready && jit_objects_ready) && [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$(desired_hash)" ]; then
      echo "$lib_out"
      exit 0
    fi
    : > "$make_log"
    failure_phase="generate PostgreSQL headers"
    build_generated_headers
    failure_phase="build PostgreSQL support libraries"
    build_support_libraries
    failure_phase="build PostgreSQL backend objects"
    build_backend_objects
    failure_phase="build PostgreSQL JIT objects"
    build_jit_objects
    failure_phase="build PostgreSQL timezone objects"
    build_timezone_objects
    failure_phase="build PL/pgSQL objects"
    build_plpgsql_objects
    failure_phase="build liboliphaunt objects"
    build_liboliphaunt_objects
    failure_phase="build mobile static dependencies"
    build_mobile_static_dependencies
    failure_phase="build mobile static extensions"
    build_mobile_static_extension_objects
    failure_phase="generate mobile static registry"
    write_mobile_static_registry_source
    build_mobile_static_registry_object
    write_objects_response_file
    failure_phase="link liboliphaunt"
    link_liboliphaunt
    failure_phase="verify liboliphaunt artifact"
    artifact_ready
    failure_phase="write completion stamp"
    desired_hash > "$stamp"
    echo "$lib_out"
    ;;
  --check-current)
    if artifact_ready && (cd "$build_dir" && generated_headers_ready && backend_objects_ready && support_libraries_ready && plpgsql_objects_ready && jit_objects_ready) && [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$(desired_hash)" ]; then
      echo "iOS device liboliphaunt dylib is current"
      exit 0
    fi
    echo "iOS device liboliphaunt dylib is missing or stale" >&2
    exit 1
    ;;
  *)
    usage
    exit 2
    ;;
esac
