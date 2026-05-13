#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
pg_version="18.3"
pg_sha256="d95663fbbf3a80f81a9d98d895266bdcb74ba274bcc04ef6d76630a72dee016f"
pg_url="https://ftp.postgresql.org/pub/source/v${pg_version}/postgresql-${pg_version}.tar.bz2"
source_manifest="$repo_root/libpglite/postgres18/source.toml"
patch_dir="$repo_root/libpglite/patches/postgresql-${pg_version}"
work_root="${LIBPGLITE_WORK_ROOT:-${PGLITE_OXIDE_NATIVE_WORK_ROOT:-$repo_root/target/libpglite-pg18}}"
source_cache="$work_root/source"
tarball="$source_cache/postgresql-${pg_version}.tar.bz2"
build_dir="$work_root/postgresql-${pg_version}"
install_dir="$work_root/install"
out_dir="$work_root/out"
embedded_modules_dir="$out_dir/modules"
shim_src="$repo_root/libpglite/src/libpglite_native.c"
shim_obj="$out_dir/libpglite_native.o"
lib_out="$out_dir/libpglite.dylib"
objects_rsp="$out_dir/libpglite_objects.rsp"
build_stamp="$build_dir/.libpglite-build.sha256"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "native PostgreSQL 18 libpglite build currently targets macOS only" >&2
  exit 2
fi

jobs="${LIBPGLITE_JOBS:-${PGLITE_OXIDE_NATIVE_JOBS:-$(sysctl -n hw.ncpu 2>/dev/null || echo 4)}}"
mkdir -p "$source_cache" "$out_dir"

verify_source_manifest() {
  grep -q "version = \"$pg_version\"" "$source_manifest" &&
    grep -q "url = \"$pg_url\"" "$source_manifest" &&
    grep -q "sha256 = \"$pg_sha256\"" "$source_manifest"
}

if ! verify_source_manifest; then
  echo "native libpglite source manifest does not match build constants: $source_manifest" >&2
  exit 1
fi

native_cc="${LIBPGLITE_CC:-${PGLITE_OXIDE_NATIVE_CC:-${CC:-cc}}}"
ccache_mode="${LIBPGLITE_CCACHE:-${PGLITE_OXIDE_NATIVE_CCACHE:-auto}}"
if [ "$ccache_mode" != "0" ] && [ "$ccache_mode" != "off" ]; then
  if [ "$ccache_mode" != "auto" ]; then
    ccache_bin="$ccache_mode"
  else
    ccache_bin="$(command -v ccache || true)"
  fi
  if [ -n "$ccache_bin" ]; then
    export CC="$ccache_bin $native_cc"
  else
    export CC="$native_cc"
  fi
else
  export CC="$native_cc"
fi

if [ ! -f "$tarball" ]; then
  curl -L --fail --silent --show-error "$pg_url" -o "$tarball"
fi

(
  cd "$source_cache"
  printf '%s  %s\n' "$pg_sha256" "postgresql-${pg_version}.tar.bz2" | shasum -a 256 -c -
)

patch_series_hash() {
  shasum -a 256 "$patch_dir"/*.patch | shasum -a 256 | awk '{print $1}'
}

desired_patch_hash="$(patch_series_hash)"
desired_build_hash="$(printf '%s\n%s\n' "$desired_patch_hash" "$CC" | shasum -a 256 | awk '{print $1}')"
current_build_hash=""
if [ -f "$build_stamp" ]; then
  current_build_hash="$(cat "$build_stamp")"
fi

if [ -d "$build_dir" ] && [ "$current_build_hash" != "$desired_build_hash" ]; then
  rm -rf "$build_dir"
fi

if [ ! -d "$build_dir" ]; then
  tar -xjf "$tarball" -C "$work_root"
fi

cd "$build_dir"

patches_applied() {
  grep -q 'PGLiteEmbeddedIO' src/include/libpq/libpq-be.h &&
    grep -q 'pglite_io' src/backend/libpq/be-secure.c &&
    grep -q 'pglite_embedded_main' src/backend/tcop/postgres.c &&
    grep -q 'PGLITE_EMBEDDED' src/include/tcop/tcopprot.h &&
    grep -q 'pglite_embedded_proc_exit' src/include/storage/ipc.h &&
    grep -q 'original_cwd' src/backend/tcop/postgres.c
}

if ! patches_applied; then
  for patch_file in "$patch_dir"/*.patch; do
    patch -p1 < "$patch_file"
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
  ./configure \
    --prefix="$install_dir" \
    --without-readline \
    --without-icu \
    --without-llvm \
    --without-pam \
    --with-openssl=no \
    --without-zlib \
    --disable-nls
fi

native_cflags="-O2 -g -fPIC -DPGLITE_EMBEDDED"
normal_module_be_dllibs="-bundle_loader $install_dir/bin/postgres"
embedded_module_be_dllibs="-bundle_loader $lib_out -Wl,-rpath,$out_dir"

runtime_installed() {
  [ -x "$install_dir/bin/initdb" ] &&
    [ -x "$install_dir/bin/postgres" ] &&
    [ -f "$install_dir/share/postgresql/postgresql.conf.sample" ]
}

module_depends_on_libpglite() {
  local module="$1"
  [ -f "$module" ] || return 1
  case "$(otool -L "$module" 2>/dev/null || true)" in
    *"@rpath/libpglite.dylib"*) return 0 ;;
    *) return 1 ;;
  esac
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
  if nm -m "$module" 2>/dev/null | grep -Eq '_(hash_create|hash_search) \(from libSystem\)'; then
    echo "embedded module bound PostgreSQL hash symbols to libSystem: $module" >&2
    exit 1
  fi
}

build_embedded_plpgsql_module() {
  local module="$embedded_modules_dir/plpgsql.dylib"
  if module_depends_on_libpglite "$module"; then
    return
  fi
  make -C src/pl/plpgsql/src clean
  make -C src/pl/plpgsql/src \
    CC="$CC" \
    BE_DLLLIBS="$embedded_module_be_dllibs" \
    all
  mkdir -p "$embedded_modules_dir"
  cp -p src/pl/plpgsql/src/plpgsql.dylib "$module"
  if ! module_depends_on_libpglite "$module"; then
    echo "embedded plpgsql is not linked against libpglite: $module" >&2
    exit 1
  fi
  audit_embedded_module "$module"
}

build_native_extension_artifacts() {
  if [ "${LIBPGLITE_BUILD_EXTENSIONS:-${PGLITE_OXIDE_NATIVE_BUILD_EXTENSIONS:-1}}" = "0" ]; then
    return
  fi

  rm -f "$embedded_modules_dir/age.dylib" "$embedded_modules_dir/pg_hashids.dylib"

  local contrib_extensions=(
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
  local extension
  for extension in "${contrib_extensions[@]}"; do
    make -C "contrib/$extension" clean
    make -C "contrib/$extension" \
      CC="$CC" \
      BE_DLLLIBS="$normal_module_be_dllibs" \
      install
    make -C "contrib/$extension" clean
    make -C "contrib/$extension" \
      CC="$CC" \
      BE_DLLLIBS="$embedded_module_be_dllibs" \
      all
    copy_embedded_modules_from_dir "contrib/$extension"
  done

  local external_extensions=(
    pg_ivm
    pg_uuidv7
    pgtap
    pgvector
    pg_textsearch
  )
  local checkout
  for extension in "${external_extensions[@]}"; do
    checkout="$repo_root/assets/checkouts/$extension"
    if [ ! -d "$checkout" ]; then
      echo "native extension checkout is missing: $checkout" >&2
      exit 1
    fi
    make -C "$checkout" \
      PG_CONFIG="$install_dir/bin/pg_config" \
      clean
    make -C "$checkout" \
      PG_CONFIG="$install_dir/bin/pg_config" \
      CC="$CC" \
      BE_DLLLIBS="$normal_module_be_dllibs" \
      OPTFLAGS="" \
      install
    make -C "$checkout" \
      PG_CONFIG="$install_dir/bin/pg_config" \
      clean
    make -C "$checkout" \
      PG_CONFIG="$install_dir/bin/pg_config" \
      CC="$CC" \
      BE_DLLLIBS="$embedded_module_be_dllibs" \
      OPTFLAGS="" \
      all
    copy_embedded_modules_from_dir "$checkout"
  done

  for module in "$embedded_modules_dir"/*.dylib; do
    [ -e "$module" ] || continue
    audit_embedded_module "$module"
  done
}

# Build and install a normal PostgreSQL tree first. initdb needs the matching
# sibling postgres binary and the installed share/lib tree needs core modules
# such as dict_snowball and plpgsql. Keep this separate from the embedded/PIC
# object pass so the runtime tools stay normal PostgreSQL while backend modules
# use embedded-friendly Darwin symbol lookup.
if ! runtime_installed; then
  make -j"$jobs" CC="$CC"
  make install CC="$CC"
fi

if module_depends_on_libpglite "$install_dir/lib/postgresql/plpgsql.dylib"; then
  install_normal_plpgsql_module
fi

regenerate_backend_headers() {
  rm -f src/include/nodes/header-stamp src/include/utils/header-stamp
  make -C src/backend generated-headers CC="$CC"
}

validate_native_objects() {
  for required in \
    src/backend/tcop/postgres.o \
    src/backend/libpq/be-secure.o \
    src/backend/libpq/pqcomm.o
  do
    if [ ! -f "$required" ]; then
      echo "native backend object build did not produce $required" >&2
      exit 1
    fi
  done
  for objfile in src/backend/*/objfiles.txt; do
    if [ ! -s "$objfile" ]; then
      echo "native backend object list is missing or empty: $objfile" >&2
      exit 1
    fi
  done
  nm -g src/backend/tcop/postgres.o | grep -q '_pglite_embedded_main'
}

$CC -O2 -g -fPIC \
  -I"$repo_root/libpglite/include" \
  -c "$shim_src" \
  -o "$shim_obj"

# Rebuild backend objects for the dylib with PIC and PGLITE_EMBEDDED.  The
# final postgres executable is not the artifact here; object files are.
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

make -C src/timezone CC="$CC" CFLAGS="$native_cflags" localtime.o pgtz.o strftime.o

{
  cat src/backend/*/objfiles.txt
  printf 'src/timezone/localtime.o src/timezone/pgtz.o src/timezone/strftime.o\n'
} | tr '[:space:]' '\n' | sed '/^$/d' > "$objects_rsp"

$CC -dynamiclib -undefined dynamic_lookup \
  -Wl,-install_name,@rpath/libpglite.dylib \
  -o "$lib_out" \
  "$shim_obj" \
  @"$objects_rsp" \
  src/common/libpgcommon_srv.a \
  src/port/libpgport_srv.a \
  -lpthread

build_embedded_plpgsql_module
build_native_extension_artifacts

echo "$lib_out"
echo "Set LIBPGLITE_OXIDE_LIBPGLITE=$lib_out"
echo "Set LIBPGLITE_OXIDE_INITDB=$install_dir/bin/initdb"
echo "Set LIBPGLITE_OXIDE_POSTGRES=$install_dir/bin/postgres"
