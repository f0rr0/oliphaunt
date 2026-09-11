#!/usr/bin/env bash
# Sourced by the native MSVC build; native commands and logging stay in Shell.
# shellcheck disable=SC2154 # Paths and compiler callbacks belong to the sourcing build.

windows_extension_cmake() {
  local name="$1" source="$2" prefix="$3"
  shift 3
  local directory="$work_root/$name-windows-build"
  rm -rf "$directory" "$prefix"
  logged "$name-configure.log" cmake -S "$(native_path "$source")" -B "$(native_path "$directory")" -G Ninja \
    -DCMAKE_BUILD_TYPE=Release "-DCMAKE_INSTALL_PREFIX=$(native_path "$prefix")" \
    -DCMAKE_C_COMPILER=cl.exe -DCMAKE_CXX_COMPILER=cl.exe \
    -DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreadedDLL "$@"
  logged "$name-install.log" cmake --build "$(native_path "$directory")" --config Release --target install
}

windows_extension_copy() {
  local source="$1" destination="$2"
  [ -d "$source" ] || fail "missing extension source $source"
  rm -rf "$destination"
  mkdir -p "$destination"
  cp -R "$source/." "$destination/"
  rm -rf "$destination/.git"
}

windows_extension_openssl() {
  local prefix="$work_root/windows-dependencies/openssl" directory="$work_root/openssl-windows-build"
  [ ! -f "$prefix/lib/libcrypto.lib" ] || return 0
  windows_extension_copy "$external_checkout_root/openssl" "$directory"
  rm -rf "$prefix"
  (
    cd "$directory"
    logged openssl-configure.log perl Configure VC-WIN64A no-shared no-tests no-apps no-module no-asm \
      "--prefix=$(native_path "$prefix")" "--openssldir=$(native_path "$prefix/ssl")"
    logged openssl-build.log native nmake.exe /nologo build_generated libcrypto.lib
    logged openssl-install.log native nmake.exe /nologo install_sw
  )
  [ -d "$prefix/include/openssl" ] && [ -f "$prefix/lib/libcrypto.lib" ] || fail 'OpenSSL install is incomplete'
}

windows_extension_postgis_dependencies() {
  local dependency_root="$work_root/windows-dependencies/postgis" prefix directory source
  prefix="$dependency_root/sqlite"
  if [ ! -f "$prefix/lib/sqlite3.lib" ] || [ ! -f "$prefix/bin/sqlite3.exe" ]; then
    directory="$work_root/sqlite-windows-build"
    windows_extension_copy "$external_checkout_root/sqlite" "$directory"
    rm -rf "$prefix"
    (
      cd "$directory"
      logged sqlite-build.log native nmake.exe /nologo /f Makefile.msc libsqlite3.lib sqlite3.exe \
        USE_CRT_DLL=1 NO_TCL=1 LDFLAGS= 'OPTS=-DSQLITE_THREADSAFE=0 -DSQLITE_OMIT_LOAD_EXTENSION'
    )
    mkdir -p "$prefix"/{include,lib,bin}
    cp "$directory/libsqlite3.lib" "$prefix/lib/sqlite3.lib"
    cp "$directory/sqlite3.exe" "$prefix/bin/"
    cp "$directory/"{sqlite3.h,sqlite3ext.h} "$prefix/include/"
  fi
  prefix="$dependency_root/json-c"
  if ! (first_file "$prefix" json-c.lib json-c-static.lib) >/dev/null 2>&1; then
    windows_extension_cmake json-c "$external_checkout_root/json-c" "$prefix" \
      -DCMAKE_POLICY_VERSION_MINIMUM=3.5 -DBUILD_SHARED_LIBS=OFF -DBUILD_STATIC_LIBS=ON \
      -DBUILD_APPS=OFF -DBUILD_TESTING=OFF -DDISABLE_WERROR=ON
  fi
  prefix="$dependency_root/geos"
  if ! (first_file "$prefix" geos_c.lib) >/dev/null 2>&1; then
    windows_extension_cmake geos "$external_checkout_root/geos" "$prefix" \
      -DBUILD_SHARED_LIBS=OFF -DBUILD_TESTING=OFF -DBUILD_BENCHMARKS=OFF -DBUILD_GEOSOP=OFF -DGEOS_BUILD_DEVELOPER=OFF
  fi
  prefix="$dependency_root/libxml2"
  if ! (first_file "$prefix" libxml2s.lib libxml2.lib xml2.lib) >/dev/null 2>&1; then
    windows_extension_cmake libxml2 "$external_checkout_root/libxml2" "$prefix" \
      -DBUILD_SHARED_LIBS=OFF -DLIBXML2_WITH_PROGRAMS=OFF -DLIBXML2_WITH_TESTS=OFF \
      -DLIBXML2_WITH_PYTHON=OFF -DLIBXML2_WITH_THREADS=OFF -DLIBXML2_WITH_MODULES=OFF \
      -DLIBXML2_WITH_ICONV=OFF -DLIBXML2_WITH_ZLIB=OFF -DLIBXML2_WITH_LZMA=OFF -DLIBXML2_WITH_HTTP=OFF
  fi
  prefix="$dependency_root/proj"
  if ! (first_file "$prefix" proj.lib libproj.lib) >/dev/null 2>&1 || [ ! -f "$prefix/share/proj/proj.db" ]; then
    windows_extension_cmake proj "$external_checkout_root/proj" "$prefix" \
      -DBUILD_SHARED_LIBS=OFF "-DSQLite3_INCLUDE_DIR=$(native_path "$dependency_root/sqlite/include")" \
      "-DSQLite3_LIBRARY=$(native_path "$dependency_root/sqlite/lib/sqlite3.lib")" \
      "-DEXE_SQLITE3=$(native_path "$dependency_root/sqlite/bin/sqlite3.exe")" \
      -DENABLE_TIFF=OFF -DENABLE_CURL=OFF -DENABLE_EMSCRIPTEN_FETCH=OFF -DHAVE_LIBDL=OFF \
      -DBUILD_APPS=OFF -DBUILD_TESTING=OFF -DBUILD_EXAMPLES=OFF \
      -DEMBED_RESOURCE_FILES=ON -DUSE_ONLY_EMBEDDED_RESOURCE_FILES=ON
    if [ ! -f "$prefix/share/proj/proj.db" ]; then
      mkdir -p "$prefix/share/proj"
      cp "$work_root/proj-windows-build/data/proj.db" "$prefix/share/proj/proj.db"
    fi
  fi
}

windows_extension_generate() {
  local phase="$1"
  shift
  bun "$repo_root/extensions/artifacts/native/tools/windows-extension-sources.mts" "$phase" \
    --repo "$repo_root" --work "$work_root" --postgres "$build_dir" --install "$install_dir" "$@"
}

windows_extension_prepare() {
  [ "$build_extensions" != 0 ] || return 0
  local name
  if selected pgcrypto; then
    windows_extension_openssl
    windows_extension_generate simple --extension pgcrypto
  fi
  for name in uuid-ossp pg_hashids pg_ivm pg_uuidv7 pg_textsearch vector; do
    if selected "$name"; then windows_extension_generate simple --extension "$name"; fi
  done
  if selected postgis; then
    (
      export SOURCE_DATE_EPOCH
      source "$repo_root/extensions/external/postgis/tools/reproducible-time.sh"
      SOURCE_DATE_EPOCH="$(oliphaunt_postgis_source_date_epoch "$repo_root")"
      windows_extension_postgis_dependencies
      windows_extension_generate postgis-config
      source "$repo_root/extensions/external/postgis/tools/windows/build-sql.sh"
      windows_postgis_build_sql
      windows_extension_postgis_flatgeobuf
      windows_extension_generate postgis-meson
    )
  fi
}

windows_extension_postgis_flatgeobuf() {
  local postgis="$build_dir/contrib/oliphaunt_external/postgis"
  local prefix="$work_root/windows-dependencies/postgis/flatgeobuf"
  [ ! -f "$prefix/lib/flatgeobuf.lib" ] || return 0
  local directory="$work_root/postgis-flatgeobuf-windows-build" source object
  local objects=()
  rm -rf "$directory" "$prefix"
  mkdir -p "$directory" "$prefix/lib"
  for source in flatgeobuf_c geometrywriter geometryreader packedrtree; do
    object="$directory/$source.obj"
    logged "flatgeobuf-$source.log" native cl.exe /nologo /O2 /MD /EHsc /D_CRT_SECURE_NO_WARNINGS /Dflatbuffers=postgis_flatbuffers \
      "/FI$(native_path "$postgis/oliphaunt_flatgeobuf_windows_compat.h")" \
      "/I$(native_path "$postgis/liblwgeom")" "/I$(native_path "$postgis/deps/flatgeobuf")" \
      "/I$(native_path "$postgis/deps/flatgeobuf/include")" "/I$(native_path "$work_root/windows-dependencies/postgis/proj/include")" \
      /c "$(native_path "$postgis/deps/flatgeobuf/$source.cpp")" "/Fo$(native_path "$object")"
    objects+=("$(native_path "$object")")
  done
  logged flatgeobuf-library.log native lib.exe /nologo "/OUT:$(native_path "$prefix/lib/flatgeobuf.lib")" "${objects[@]}"
}

windows_extension_install() {
  selected pgtap || return 0
  local directory="$work_root/pgtap-windows" destination="$install_dir/share/postgresql/extension"
  windows_extension_generate pgtap
  perl "$directory/compat/gencore" 0 "$directory/sql/pgtap-static.sql" >"$directory/sql/pgtap-core.sql"
  perl "$directory/compat/gencore" 1 "$directory/sql/pgtap-static.sql" >"$directory/sql/pgtap-schema.sql"
  perl -e 'for (grep { /^CREATE /} reverse <>) { chomp; s/CREATE (OR REPLACE )?/DROP /; s/DROP (FUNCTION|VIEW|TYPE) /DROP $1 IF EXISTS /; s/ (DEFAULT|=)[ ]+[a-zA-Z0-9]+//g; print "$_;\n" }' "$directory/sql/pgtap.sql" >"$directory/sql/uninstall_pgtap.sql"
  windows_extension_generate pgtap-install
  mkdir -p "$destination"
  cp "$directory/pgtap.control" "$directory/sql/"pgtap*.sql "$directory/sql/uninstall_pgtap.sql" "$destination/"
}
