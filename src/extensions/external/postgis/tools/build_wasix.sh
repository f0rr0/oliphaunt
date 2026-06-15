#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null)}"
ROOT="${OLIPHAUNT_WASIX_BUILD_ROOT:-$REPO_ROOT/src/runtimes/liboliphaunt/wasix/assets/build}"
. "$ROOT/wasix_third_party.sh"
. "$ROOT/source_lane.sh"

REPO_ROOT="$(oliphaunt_wasix_repo_root "$ROOT")"
SOURCE_LANE="$(oliphaunt_wasix_source_lane)"
JOBS="${JOBS:-4}"
oliphaunt_wasix_run_extension_build_in_docker_if_needed \
  "$ROOT" \
  "$REPO_ROOT" \
  "$SOURCE_LANE" \
  "src/extensions/external/postgis/tools/build_wasix.sh"

POSTGIS_SOURCE_DIR="${POSTGIS_SOURCE_DIR:-$(oliphaunt_wasix_extension_source_dir "$REPO_ROOT" postgis)}"
GENERATED_ROOT="$(oliphaunt_wasix_generated_root "$REPO_ROOT")"
export CONTAINER_GENERATED_ROOT="${CONTAINER_GENERATED_ROOT:-$GENERATED_ROOT}"
BUILD_DIR="${BUILD_DIR:-$(oliphaunt_wasix_default_build_dir "$SOURCE_LANE")}"
PGSRC="${PGSRC:-$(SOURCE_CACHE="${SOURCE_CACHE:-$REPO_ROOT/target/liboliphaunt-pg18/source}" "$ROOT/prepare_postgres_source.sh")}"
POSTGIS_BUILD_DIR="${POSTGIS_BUILD_DIR:-$(oliphaunt_wasix_extension_build_dir "$BUILD_DIR" postgis)}"
oliphaunt_wasix_export_extension_dependency_prefixes "$ROOT" "$REPO_ROOT" postgis
postgis_configure_flags=()
while IFS= read -r flag; do
  [ -n "$flag" ] && postgis_configure_flags+=("$flag")
done < <(oliphaunt_wasix_extension_wasix_configure_flags "$REPO_ROOT" postgis)

if [ ! -f "$POSTGIS_SOURCE_DIR/configure.ac" ]; then
  echo "missing PostGIS source checkout at $POSTGIS_SOURCE_DIR; run assets fetch/source-spine first" >&2
  exit 1
fi
if [ ! -f "$BUILD_DIR/config.status" ]; then
  echo "missing WASIX PostgreSQL build at $BUILD_DIR; run docker_oliphaunt.sh first" >&2
  exit 1
fi

. "$ROOT/docker_wasix_env.sh"
. "$ROOT/profile_flags.sh"
oliphaunt_wasix_apply_wasix_profile build

source_commit="$(oliphaunt_wasix_source_commit "$POSTGIS_SOURCE_DIR")"
script_sha256="$(oliphaunt_wasix_script_sha256 "$0")"
helper_sha256="$(oliphaunt_wasix_script_sha256 "$ROOT/wasix_third_party.sh")"
dependency_stamp_block="$(oliphaunt_wasix_extension_dependency_stamp_block "$REPO_ROOT" postgis)"
wasixcc_version="$(wasixcc --version 2>/dev/null)"
wasixcc_version="${wasixcc_version%%$'\n'*}"
stamp="source=$source_commit
script=$script_sha256
helper=$helper_sha256
$dependency_stamp_block
profile=$(oliphaunt_wasix_wasix_profile_signature)
wasixcc=$wasixcc_version
configure=$(oliphaunt_wasix_extension_configure_signature "$REPO_ROOT" postgis)
link=postgis-plus-selected-support-side-module-v2"

if [ -f "$POSTGIS_BUILD_DIR/.oliphaunt-wasix-postgis-build" ] &&
   oliphaunt_wasix_extension_build_outputs_exist "$REPO_ROOT" postgis "$POSTGIS_BUILD_DIR" --quiet &&
   [ "$(cat "$POSTGIS_BUILD_DIR/.oliphaunt-wasix-postgis-build")" = "$stamp" ]; then
  echo "$POSTGIS_BUILD_DIR"
  exit 0
fi

{
  rm -rf "$POSTGIS_BUILD_DIR"
  mkdir -p "$(dirname "$POSTGIS_BUILD_DIR")"
  oliphaunt_wasix_copy_source_clean "$POSTGIS_SOURCE_DIR" "$POSTGIS_BUILD_DIR"

  geos_config="$POSTGIS_BUILD_DIR/oliphaunt-geos-config"
  cat >"$geos_config" <<EOF
#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  --clibs)
    echo "-L$GEOS_PREFIX/lib -lgeos_c -lgeos -lc++ -lc++abi -lunwind"
    ;;
  --libs)
    echo "-L$GEOS_PREFIX/lib -lgeos -lc++ -lc++abi -lunwind"
    ;;
  *)
    exec "$GEOS_PREFIX/bin/geos-config" "\$@"
    ;;
esac
EOF
  chmod +x "$geos_config"

  pkg_config="$POSTGIS_BUILD_DIR/oliphaunt-pkg-config"
  cat >"$pkg_config" <<EOF
#!/usr/bin/env bash
set -euo pipefail
if [ "\${@: -1}" = "proj" ]; then
  case " \$* " in
    *" --exists "*)
      exit 0
      ;;
    *" --modversion "*)
      echo "9.8.1"
      exit 0
      ;;
    *" --cflags "*)
      echo "-I$PROJ_PREFIX/include"
      exit 0
      ;;
    *" --libs "*)
      echo "-L$PROJ_PREFIX/lib -lproj -L$SQLITE_PREFIX/lib -lsqlite3 -lc++ -lc++abi -lunwind"
      exit 0
      ;;
  esac
fi
exec /usr/bin/pkg-config "\$@"
EOF
  chmod +x "$pkg_config"

  pg_config="$POSTGIS_BUILD_DIR/oliphaunt-pg-config"
  cat >"$pg_config" <<EOF
#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  --includedir|--pkgincludedir)
    echo "$PGSRC/src/interfaces/libpq -I$PGSRC/src/include -I$BUILD_DIR/src/include"
    ;;
  --libdir)
    echo "$BUILD_DIR/src/interfaces/libpq -lpq -L$BUILD_DIR/src/common -lpgcommon -L$BUILD_DIR/src/port -lpgport"
    ;;
  *)
    exec "$ROOT/pg_config_wasix.sh" "\$@"
    ;;
esac
EOF
  chmod +x "$pg_config"

  export PATH="$POSTGIS_BUILD_DIR:$PATH"
  export PKG_CONFIG="$pkg_config"
  export PKG_CONFIG_ALLOW_CROSS=1
  export PKG_CONFIG_LIBDIR="$JSONC_PREFIX/lib/pkgconfig:$PROJ_PREFIX/lib/pkgconfig:$SQLITE_PREFIX/lib/pkgconfig"
  export PKG_CONFIG_PATH="$PKG_CONFIG_LIBDIR"
  export JSONC_CFLAGS="-I$JSONC_PREFIX/include -I$JSONC_PREFIX/include/json-c"
  export JSONC_LIBS="-L$JSONC_PREFIX/lib -ljson-c"
  export BUILD_DIR
  export PGSRC
  export OLIPHAUNT_WASM_SOURCE_LANE="$SOURCE_LANE"
  export CONTAINER_GENERATED_ROOT
  export CC=wasixcc
  export CXX=wasixcc++
  export AR=wasixar
  export RANLIB=wasixranlib
  export CPPFLAGS="-I$BUILD_DIR/src/include -I$PGSRC/src/include -I$PGSRC/src/include/port/wasix-dl -I$LIBICONV_PREFIX/include"
  export CFLAGS="$OLIPHAUNT_WASM_PROFILE_CFLAGS -fPIC -fvisibility=hidden -Wno-unused-command-line-argument"
  export CXXFLAGS="$OLIPHAUNT_WASM_PROFILE_CFLAGS -fPIC -fvisibility=hidden -fvisibility-inlines-hidden -Wno-unused-command-line-argument"
  export LDFLAGS="-L$LIBICONV_PREFIX/lib -L$SQLITE_PREFIX/lib -liconv -lcharset -lsqlite3 -lc++ -lc++abi -lunwind"
  export ac_cv_lib_pq_PQserverVersion=yes

  cd "$POSTGIS_BUILD_DIR"
  ./autogen.sh
  oliphaunt_wasix_apply_wasix_profile configure
  ./configure \
    --build="$(build-aux/config.guess)" \
    --host=wasm32-wasi \
    --with-pgconfig="$pg_config" \
    --with-libiconv="$LIBICONV_PREFIX" \
    --with-geosconfig="$geos_config" \
    --with-xml2config="$LIBXML2_PREFIX/bin/xml2-config" \
    "${postgis_configure_flags[@]}"

  cat >postgis/oliphaunt_postgis_deps_stubs.c <<'EOF'
/*
 * WASIX C++ dependency objects can emit process/TLS lifecycle hooks that are
 * normally supplied by a full C++ runtime. The selected PostGIS dependency side
 * module is process-owned and lives for the duration of the embedded runtime,
 * so there is no separate thread-local destructor lifecycle to register here.
 */
__attribute__((visibility("hidden"))) void _ZTH5errno(void) {}

__attribute__((visibility("hidden"))) int __cxa_thread_atexit_impl(
    void (*destructor)(void *),
    void *object,
    void *dso_symbol)
{
  (void)destructor;
  (void)object;
  (void)dso_symbol;
  return 0;
}
EOF
  wasixcc $CFLAGS -c \
    postgis/oliphaunt_postgis_deps_stubs.c \
    -o postgis/oliphaunt_postgis_deps_stubs.o

  wasm_ld="$WASIX_HOME/llvm/bin/wasm-ld"
  wasix_sysroot_lib="$WASIX_HOME/sysroot/sysroot-exnref-ehpic/lib/wasm32-wasi"
  postgis_deps_module="$POSTGIS_BUILD_DIR/postgis/liboliphaunt_postgis_deps.so"
  "$wasm_ld" \
    --shared \
    --shared-memory \
    --experimental-pic \
    --unresolved-symbols=import-dynamic \
    --extra-features=atomics,bulk-memory,mutable-globals \
    --export=__wasm_call_ctors \
    --export-if-defined=__wasm_apply_data_relocs \
    --export-all \
    --no-gc-sections \
    "$POSTGIS_BUILD_DIR/postgis/oliphaunt_postgis_deps_stubs.o" \
    --whole-archive \
    "$GEOS_PREFIX/lib/libgeos_c.a" \
    "$GEOS_PREFIX/lib/libgeos.a" \
    "$PROJ_PREFIX/lib/libproj.a" \
    "$SQLITE_PREFIX/lib/libsqlite3.a" \
    "$JSONC_PREFIX/lib/libjson-c.a" \
    "$LIBXML2_PREFIX/lib/libxml2.a" \
    "$LIBICONV_PREFIX/lib/libiconv.a" \
    "$wasix_sysroot_lib/libc++.a" \
    "$wasix_sysroot_lib/libc++abi.a" \
    "$wasix_sysroot_lib/libunwind.a" \
    --no-whole-archive \
    "$wasix_sysroot_lib/libm.a" \
    "$wasix_sysroot_lib/libc.a" \
    "$wasix_sysroot_lib/libclang_rt.builtins-wasm32.a" \
    -o "$postgis_deps_module"

  export OLIPHAUNT_POSTGIS_STATIC_ARCHIVES="$GEOS_PREFIX/lib/libgeos_c.a $GEOS_PREFIX/lib/libgeos.a $PROJ_PREFIX/lib/libproj.a $SQLITE_PREFIX/lib/libsqlite3.a $JSONC_PREFIX/lib/libjson-c.a $LIBXML2_PREFIX/lib/libxml2.a $LIBICONV_PREFIX/lib/libiconv.a $LIBICONV_PREFIX/lib/libcharset.a $wasix_sysroot_lib/libc++.a $wasix_sysroot_lib/libc++abi.a $wasix_sysroot_lib/libunwind.a $wasix_sysroot_lib/libm.a $wasix_sysroot_lib/libc.a $wasix_sysroot_lib/libclang_rt.builtins-wasm32.a"
  perl -0pi -e '
    s|^OBJS=\$\(PG_OBJS\)$|OBJS=\$(PG_OBJS) oliphaunt_postgis_deps_stubs.o $ENV{OLIPHAUNT_POSTGIS_STATIC_ARCHIVES}|m;
    s|^FLATGEOBUF_LIB = .*$|FLATGEOBUF_LIB = ../deps/flatgeobuf/flatgeobuf_c.o ../deps/flatgeobuf/geometrywriter.o ../deps/flatgeobuf/geometryreader.o ../deps/flatgeobuf/packedrtree.o -lc++|m;
    s|^(SHLIB_LINK := .*)$|$1 -lc|m;
    s|^(LDFLAGS = .*)$|$1 -lc|m;
  ' postgis/Makefile
  perl -0pi -e '
    s|^(CXXFLAGS =.*)$|$1 -fvisibility=hidden -fvisibility-inlines-hidden|m;
  ' deps/flatgeobuf/Makefile

  oliphaunt_wasix_apply_wasix_profile build
  make -s -j"$JOBS" -C liblwgeom liblwgeom.la
  make -s -j"$JOBS" -C libpgcommon libpgcommon.a
  make -s -j"$JOBS" -C postgis all
  postgis_objects=()
  while IFS= read -r object; do
    [ -n "$object" ] && postgis_objects+=("$object")
  done < <(find "$POSTGIS_BUILD_DIR/postgis" -maxdepth 1 -name '*.o' ! -name 'oliphaunt_errno_tls_init_stub.o' | sort)
  "$wasm_ld" \
    --shared \
    --shared-memory \
    --experimental-pic \
    --unresolved-symbols=import-dynamic \
    --extra-features=atomics,bulk-memory,mutable-globals \
    --export=__wasm_call_ctors \
    --export-if-defined=__wasm_apply_data_relocs \
    --export-all \
    --no-gc-sections \
    "${postgis_objects[@]}" \
    "$POSTGIS_BUILD_DIR/deps/flatgeobuf/flatgeobuf_c.o" \
    "$POSTGIS_BUILD_DIR/deps/flatgeobuf/geometrywriter.o" \
    "$POSTGIS_BUILD_DIR/deps/flatgeobuf/geometryreader.o" \
    "$POSTGIS_BUILD_DIR/deps/flatgeobuf/packedrtree.o" \
    "$POSTGIS_BUILD_DIR/libpgcommon/libpgcommon.a" \
    "$POSTGIS_BUILD_DIR/liblwgeom/.libs/liblwgeom.a" \
    --Bdynamic \
    -L"$POSTGIS_BUILD_DIR/postgis" \
    -loliphaunt_postgis_deps \
    -rpath '$ORIGIN' \
    -o "$POSTGIS_BUILD_DIR/postgis/postgis-3.so"
  # PostGIS core upgrade SQL still includes raster-unpackage stubs even when
  # raster support is disabled. Generate those SQL inputs as a best-effort
  # prerequisite before packaging PostGIS. Keep this serial: the
  # PostGIS SQL Makefiles use generated .tmp files and have incomplete
  # parallel dependency edges.
  make -s -j1 raster-sql || true
  make -s -j1 -C raster/rt_pg sql_objs
  make -s -j1 -C extensions postgis_extension_helper.sql
  make -s -j1 -C extensions/postgis postgis.control all
  mkdir -p "$POSTGIS_BUILD_DIR/share"
  rm -rf "$POSTGIS_BUILD_DIR/share/proj"
  cp -R "$PROJ_PREFIX/share/proj" "$POSTGIS_BUILD_DIR/share/proj"
} >&2

oliphaunt_wasix_extension_build_outputs_exist "$REPO_ROOT" postgis "$POSTGIS_BUILD_DIR"
printf '%s\n' "$stamp" > "$POSTGIS_BUILD_DIR/.oliphaunt-wasix-postgis-build"
echo "$POSTGIS_BUILD_DIR"
