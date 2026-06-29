#!/usr/bin/env bash

oliphaunt_postgis_fail() {
  echo "PostGIS mobile static build: $*" >&2
  exit 1
}

oliphaunt_postgis_selected() {
  mobile_static_extensions_include postgis
}

oliphaunt_postgis_require_tools() {
  oliphaunt_postgis_selected || return 0
  local cmd
  for cmd in cmake rsync tar; do
    command -v "$cmd" >/dev/null 2>&1 || oliphaunt_postgis_fail "missing required command: $cmd"
  done
}

oliphaunt_postgis_dependency_archive() {
  local name="$1"
  local archive="$2"
  [ -f "$archive" ] || oliphaunt_postgis_fail "missing dependency archive for $name: $archive"
  mobile_static_dependency_archives+=("$archive")
}

oliphaunt_postgis_cmake_platform_args() {
  case "${oliphaunt_mobile_target:?missing oliphaunt mobile target}" in
    ios-simulator | ios-device)
      printf '%s\n' \
        -DCMAKE_SYSTEM_NAME=iOS \
        "-DCMAKE_OSX_SYSROOT=$sdk_path" \
        -DCMAKE_OSX_ARCHITECTURES=arm64 \
        "-DCMAKE_OSX_DEPLOYMENT_TARGET=$min_ios" \
        "-DCMAKE_C_COMPILER=$clang_path" \
        "-DCMAKE_CXX_COMPILER=${clangxx_path:-$clang_path}"
      ;;
    android-arm64 | android-x86_64)
      printf '%s\n' \
        "-DCMAKE_TOOLCHAIN_FILE=$ndk_root/build/cmake/android.toolchain.cmake" \
        "-DANDROID_ABI=$android_abi" \
        "-DANDROID_PLATFORM=android-$android_api" \
        -DANDROID_STL=c++_static
      ;;
    *)
      oliphaunt_postgis_fail "unsupported mobile target: $oliphaunt_mobile_target"
      ;;
  esac
}

oliphaunt_postgis_cmake_install() {
  local source_dir="$1"
  local build_root="$2"
  local dependency_dir="$3"
  shift 3
  local -a platform_args
  local platform_arg
  while IFS= read -r platform_arg; do
    [ -n "$platform_arg" ] && platform_args+=("$platform_arg")
  done < <(oliphaunt_postgis_cmake_platform_args)
  cmake -S "$source_dir" -B "$build_root" \
    "${platform_args[@]}" \
    -DCMAKE_INSTALL_PREFIX="$dependency_dir" \
    "$@" >> "$make_log" 2>&1
  cmake --build "$build_root" --target install -- -j"$jobs" >> "$make_log" 2>&1
}

build_postgis_jsonc_dependency() {
  oliphaunt_postgis_selected || return 0
  local source_dir="$repo_root/target/oliphaunt-sources/checkouts/json-c"
  local dependency_dir="$mobile_static_dependency_root/json-c"
  local build_root="$work_root/json-c-$oliphaunt_mobile_target-build"
  local archive="$dependency_dir/lib/libjson-c.a"
  if [ -f "$archive" ] && [ -d "$dependency_dir/include/json-c" ]; then
    oliphaunt_postgis_dependency_archive json-c "$archive"
    return 0
  fi
  [ -f "$source_dir/CMakeLists.txt" ] || oliphaunt_postgis_fail "missing JSON-C checkout: $source_dir"
  rm -rf "$build_root" "$dependency_dir"
  oliphaunt_postgis_cmake_install "$source_dir" "$build_root" "$dependency_dir" \
    -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
    -DBUILD_SHARED_LIBS=OFF \
    -DBUILD_STATIC_LIBS=ON \
    -DBUILD_APPS=OFF \
    -DBUILD_TESTING=OFF \
    -DDISABLE_WERROR=ON
  [ -f "$archive" ] || oliphaunt_postgis_fail "JSON-C build did not produce $archive"
  oliphaunt_postgis_dependency_archive json-c "$archive"
}

build_postgis_sqlite_dependency() {
  oliphaunt_postgis_selected || return 0
  local source_dir="$repo_root/target/oliphaunt-sources/checkouts/sqlite"
  local dependency_dir="$mobile_static_dependency_root/sqlite"
  local build_root="$work_root/sqlite-$oliphaunt_mobile_target-build"
  local archive="$dependency_dir/lib/libsqlite3.a"
  if [ -f "$archive" ] && [ -f "$dependency_dir/include/sqlite3.h" ]; then
    oliphaunt_postgis_dependency_archive sqlite "$archive"
    return 0
  fi
  [ -x "$source_dir/configure" ] || oliphaunt_postgis_fail "missing SQLite checkout: $source_dir"
  rm -rf "$build_root" "$dependency_dir"
  mkdir -p "$build_root" "$dependency_dir/include" "$dependency_dir/lib"
  rsync -a --delete --exclude .git "$source_dir/" "$build_root/"
  (
    cd "$build_root"
    case "$oliphaunt_mobile_target" in
      ios-simulator | ios-device)
        CC="$cc_string" CFLAGS="$(oliphaunt_native_release_cflags -fPIC)" ./configure \
          --host=aarch64-apple-darwin \
          --disable-shared \
          --enable-static \
          --prefix="$dependency_dir" >> "$make_log" 2>&1
        make -j"$jobs" sqlite3.c >> "$make_log" 2>&1
        "${cc[@]}" $(oliphaunt_native_release_cflags -fPIC) \
          -DSQLITE_THREADSAFE=0 \
          -DSQLITE_OMIT_LOAD_EXTENSION \
          -c sqlite3.c \
          -o sqlite3.o >> "$make_log" 2>&1
        "$libtool_path" -static -o "$archive" sqlite3.o >> "$make_log" 2>&1
        ;;
      android-arm64 | android-x86_64)
        CC="$clang_path" CFLAGS="$(oliphaunt_native_release_cflags -fPIC)" ./configure \
          --host="$android_host" \
          --disable-shared \
          --enable-static \
          --prefix="$dependency_dir" >> "$make_log" 2>&1
        make -j"$jobs" sqlite3.c >> "$make_log" 2>&1
        "$clang_path" $(oliphaunt_native_release_cflags -fPIC) \
          -DSQLITE_THREADSAFE=0 \
          -DSQLITE_OMIT_LOAD_EXTENSION \
          -c sqlite3.c \
          -o sqlite3.o >> "$make_log" 2>&1
        "$llvm_ar" crs "$archive" sqlite3.o >> "$make_log" 2>&1
        "$llvm_ranlib" "$archive" >> "$make_log" 2>&1
        ;;
    esac
    cp -p sqlite3.h sqlite3ext.h "$dependency_dir/include/"
  )
  [ -f "$archive" ] || oliphaunt_postgis_fail "SQLite build did not produce $archive"
  oliphaunt_postgis_dependency_archive sqlite "$archive"
}

build_postgis_geos_dependency() {
  oliphaunt_postgis_selected || return 0
  local source_dir="$repo_root/target/oliphaunt-sources/checkouts/geos"
  local dependency_dir="$mobile_static_dependency_root/geos"
  local build_root="$work_root/geos-$oliphaunt_mobile_target-build"
  local geos_c_archive="$dependency_dir/lib/libgeos_c.a"
  local geos_archive="$dependency_dir/lib/libgeos.a"
  if [ -f "$geos_c_archive" ] && [ -f "$geos_archive" ] && [ -f "$dependency_dir/include/geos_c.h" ]; then
    oliphaunt_postgis_dependency_archive geos-c "$geos_c_archive"
    oliphaunt_postgis_dependency_archive geos "$geos_archive"
    return 0
  fi
  [ -f "$source_dir/CMakeLists.txt" ] || oliphaunt_postgis_fail "missing GEOS checkout: $source_dir"
  rm -rf "$build_root" "$dependency_dir"
  oliphaunt_postgis_cmake_install "$source_dir" "$build_root" "$dependency_dir" \
    -DBUILD_SHARED_LIBS=OFF \
    -DBUILD_TESTING=OFF \
    -DBUILD_BENCHMARKS=OFF \
    -DBUILD_GEOSOP=OFF \
    -DGEOS_BUILD_DEVELOPER=OFF
  [ -f "$geos_c_archive" ] || oliphaunt_postgis_fail "GEOS build did not produce $geos_c_archive"
  [ -f "$geos_archive" ] || oliphaunt_postgis_fail "GEOS build did not produce $geos_archive"
  oliphaunt_postgis_dependency_archive geos-c "$geos_c_archive"
  oliphaunt_postgis_dependency_archive geos "$geos_archive"
}

build_postgis_libxml2_dependency() {
  oliphaunt_postgis_selected || return 0
  local source_dir="$repo_root/target/oliphaunt-sources/checkouts/libxml2"
  local dependency_dir="$mobile_static_dependency_root/libxml2"
  local build_root="$work_root/libxml2-$oliphaunt_mobile_target-build"
  local archive="$dependency_dir/lib/libxml2.a"
  if [ -f "$archive" ] && [ -x "$dependency_dir/bin/xml2-config" ]; then
    oliphaunt_postgis_dependency_archive libxml2 "$archive"
    return 0
  fi
  [ -f "$source_dir/CMakeLists.txt" ] || oliphaunt_postgis_fail "missing libxml2 checkout: $source_dir"
  rm -rf "$build_root" "$dependency_dir"
  oliphaunt_postgis_cmake_install "$source_dir" "$build_root" "$dependency_dir" \
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
  [ -f "$archive" ] || oliphaunt_postgis_fail "libxml2 build did not produce $archive"
  oliphaunt_postgis_dependency_archive libxml2 "$archive"
}

build_postgis_proj_dependency() {
  oliphaunt_postgis_selected || return 0
  local source_dir="$repo_root/target/oliphaunt-sources/checkouts/proj"
  local dependency_dir="$mobile_static_dependency_root/proj"
  local sqlite_dir="$mobile_static_dependency_root/sqlite"
  local build_root="$work_root/proj-$oliphaunt_mobile_target-build"
  local archive="$dependency_dir/lib/libproj.a"
  if [ -f "$archive" ] && [ -f "$dependency_dir/share/proj/proj.db" ]; then
    oliphaunt_postgis_dependency_archive proj "$archive"
    return 0
  fi
  [ -f "$source_dir/CMakeLists.txt" ] || oliphaunt_postgis_fail "missing PROJ checkout: $source_dir"
  [ -f "$sqlite_dir/lib/libsqlite3.a" ] || oliphaunt_postgis_fail "PROJ dependency requires SQLite archive first"
  rm -rf "$build_root" "$dependency_dir"
  oliphaunt_postgis_cmake_install "$source_dir" "$build_root" "$dependency_dir" \
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
  [ -f "$archive" ] || oliphaunt_postgis_fail "PROJ build did not produce $archive"
  [ -f "$dependency_dir/share/proj/proj.db" ] || oliphaunt_postgis_fail "PROJ build did not produce proj.db"
  oliphaunt_postgis_dependency_archive proj "$archive"
}

build_postgis_libiconv_dependency() {
  oliphaunt_postgis_selected || return 0
  case "$oliphaunt_mobile_target" in
    android-arm64 | android-x86_64) ;;
    *) return 0 ;;
  esac
  local dependency_dir="$mobile_static_dependency_root/libiconv"
  local build_root="$work_root/libiconv-$oliphaunt_mobile_target-build"
  local source_dir="$repo_root/target/oliphaunt-sources/checkouts/libiconv"
  local source_tar="$work_root/source/libiconv-1.19.tar.gz"
  local archive="$dependency_dir/lib/libiconv.a"
  local charset_archive="$dependency_dir/lib/libcharset.a"
  if [ -f "$archive" ] && [ -f "$charset_archive" ] && [ -f "$dependency_dir/include/iconv.h" ]; then
    oliphaunt_postgis_dependency_archive libiconv "$archive"
    oliphaunt_postgis_dependency_archive libcharset "$charset_archive"
    return 0
  fi
  rm -rf "$build_root" "$dependency_dir"
  mkdir -p "$build_root" "$dependency_dir"
  if [ -f "$source_dir/configure" ]; then
    rsync -a --delete --exclude .git "$source_dir/" "$build_root/"
  else
    mkdir -p "$(dirname "$source_tar")"
    if [ ! -f "$source_tar" ]; then
      curl -L --fail --silent --show-error \
        --retry 8 --retry-all-errors --retry-delay 5 --connect-timeout 20 \
        https://ftpmirror.gnu.org/libiconv/libiconv-1.19.tar.gz \
        -o "$source_tar"
    fi
    printf '%s  %s\n' \
      "88dd96a8c0464eca144fc791ae60cd31cd8ee78321e67397e25fc095c4a19aa6" \
      "$source_tar" | shasum -a 256 -c - >> "$make_log" 2>&1
    tar -xzf "$source_tar" -C "$build_root" --strip-components=1
  fi
  (
    cd "$build_root"
    CC="$clang_path" AR="$llvm_ar" RANLIB="$llvm_ranlib" \
      ./configure \
        --host="$android_host" \
        --disable-shared \
        --enable-static \
        --prefix="$dependency_dir" >> "$make_log" 2>&1
    make -j"$jobs" >> "$make_log" 2>&1
    make install >> "$make_log" 2>&1
  )
  [ -f "$archive" ] || oliphaunt_postgis_fail "libiconv build did not produce $archive"
  [ -f "$charset_archive" ] || oliphaunt_postgis_fail "libiconv build did not produce $charset_archive"
  oliphaunt_postgis_dependency_archive libiconv "$archive"
  oliphaunt_postgis_dependency_archive libcharset "$charset_archive"
}

build_postgis_mobile_static_dependencies() {
  oliphaunt_postgis_selected || return 0
  oliphaunt_postgis_require_tools
  build_postgis_jsonc_dependency
  build_postgis_sqlite_dependency
  build_postgis_geos_dependency
  build_postgis_libxml2_dependency
  build_postgis_proj_dependency
  build_postgis_libiconv_dependency
}

oliphaunt_postgis_host_alias() {
  case "$oliphaunt_mobile_target" in
    ios-simulator | ios-device) printf '%s\n' aarch64-apple-darwin ;;
    android-arm64 | android-x86_64) printf '%s\n' "$android_host" ;;
    *) oliphaunt_postgis_fail "unsupported mobile target: $oliphaunt_mobile_target" ;;
  esac
}

oliphaunt_postgis_extra_ldflags() {
  case "$oliphaunt_mobile_target" in
    ios-simulator | ios-device)
      printf '%s\n' "-isysroot $sdk_path -L$mobile_static_dependency_root/geos/lib -L$mobile_static_dependency_root/proj/lib -L$mobile_static_dependency_root/sqlite/lib -L$mobile_static_dependency_root/json-c/lib -L$mobile_static_dependency_root/libxml2/lib -lc++"
      ;;
    android-arm64 | android-x86_64)
      printf '%s\n' "-L$mobile_static_dependency_root/geos/lib -L$mobile_static_dependency_root/proj/lib -L$mobile_static_dependency_root/sqlite/lib -L$mobile_static_dependency_root/json-c/lib -L$mobile_static_dependency_root/libxml2/lib -L$mobile_static_dependency_root/libiconv/lib -L$toolchain_dir/sysroot/usr/lib/$android_host -lc++_static -lc++abi"
      ;;
  esac
}

oliphaunt_postgis_geos_config_libs() {
  case "$oliphaunt_mobile_target" in
    ios-simulator | ios-device) printf '%s\n' "-L$mobile_static_dependency_root/geos/lib -lgeos_c -lgeos -lc++" ;;
    android-arm64 | android-x86_64) printf '%s\n' "-L$mobile_static_dependency_root/geos/lib -lgeos_c -lgeos -lc++_static -lc++abi" ;;
  esac
}

oliphaunt_postgis_pkg_config_script() {
  local path="$1"
  local proj_cxx_libs
  case "$oliphaunt_mobile_target" in
    ios-simulator | ios-device) proj_cxx_libs="-lc++" ;;
    android-arm64 | android-x86_64) proj_cxx_libs="-lc++_static -lc++abi" ;;
  esac
  cat > "$path" <<EOF
#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  --atleast-pkgconfig-version) exit 0 ;;
esac
pkg=""
for arg in "\$@"; do
  case "\$arg" in --*) ;; *) pkg="\$arg" ;; esac
done
case "\$pkg" in
  proj)
    case " \$* " in
      *" --exists "*) exit 0 ;;
      *" --modversion "*) echo "9.8.1"; exit 0 ;;
      *" --cflags "*) echo "-I$mobile_static_dependency_root/proj/include"; exit 0 ;;
      *" --libs "*) echo "-L$mobile_static_dependency_root/proj/lib -lproj -L$mobile_static_dependency_root/sqlite/lib -lsqlite3 $proj_cxx_libs"; exit 0 ;;
    esac
    ;;
  json-c)
    case " \$* " in
      *" --exists "*) exit 0 ;;
      *" --modversion "*) echo "0.18"; exit 0 ;;
      *" --cflags "*) echo "-I$mobile_static_dependency_root/json-c/include -I$mobile_static_dependency_root/json-c/include/json-c"; exit 0 ;;
      *" --libs "*) echo "-L$mobile_static_dependency_root/json-c/lib -ljson-c"; exit 0 ;;
    esac
    ;;
esac
exit 1
EOF
  chmod +x "$path"
}

oliphaunt_postgis_pg_config_script() {
  local path="$1"
  cat > "$path" <<EOF
#!/usr/bin/env bash
set -euo pipefail
pg_build="$build_dir"
case "\${1:-}" in
  --includedir)
    echo "\$pg_build/src/interfaces/libpq -I\$pg_build/src/include"
    ;;
  --pkgincludedir|--includedir-server)
    echo "\$pg_build/src/include"
    ;;
  --pgxs)
    echo "\$pg_build/src/makefiles/pgxs.mk"
    ;;
  --pkglibdir|--libdir)
    echo "\$pg_build/src/interfaces/libpq"
    ;;
  --bindir)
    echo "$work_root/postgis-fake-postgres-bin"
    ;;
  --sharedir|--docdir|--mandir|--localedir|--sysconfdir)
    echo "$work_root/postgis-fake-postgres-share"
    ;;
  --version)
    echo "PostgreSQL 18.4"
    ;;
  --cc)
    echo "$cc_string"
    ;;
  --cflags|--cppflags|--ldflags|--libs)
    echo ""
    ;;
  *)
    echo "unsupported pg_config argument: \${1:-}" >&2
    exit 1
    ;;
esac
EOF
  chmod +x "$path"
}

oliphaunt_postgis_geos_config_script() {
  local path="$1"
  local geos_libs
  geos_libs="$(oliphaunt_postgis_geos_config_libs)"
  cat > "$path" <<EOF
#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  --clibs|--libs)
    echo "$geos_libs"
    ;;
  --cflags)
    echo "-I$mobile_static_dependency_root/geos/include"
    ;;
  --version)
    echo "3.14.0dev"
    ;;
  *)
    exec "$mobile_static_dependency_root/geos/bin/geos-config" "\$@"
    ;;
esac
EOF
  chmod +x "$path"
}

oliphaunt_postgis_copy_archive_objects() {
  local archive="$1"
  local name="$2"
  local object_dir="$3"
  local objects_file="$4"
  local extract_dir="$object_dir/extracted/$name"
  rm -rf "$extract_dir"
  mkdir -p "$extract_dir"
  (
    cd "$extract_dir"
    case "$oliphaunt_mobile_target" in
      android-arm64 | android-x86_64) "$llvm_ar" x "$archive" ;;
      *) ar -x "$archive" ;;
    esac
  )
  local object
  while IFS= read -r object; do
    [ -n "$object" ] || continue
    printf '%s\n' "$object" >> "$objects_file"
    mobile_static_objects+=("$object")
  done < <(find "$extract_dir" -type f -name '*.o' -print | LC_ALL=C sort)
}

oliphaunt_postgis_stage_object() {
  local source="$1"
  local prefix_dir="$2"
  local object_dir="$3"
  local objects_file="$4"
  local target="$object_dir/$prefix_dir/$(basename "$source")"
  mkdir -p "$(dirname "$target")"
  cp -p "$source" "$target"
  printf '%s\n' "$target" >> "$objects_file"
  mobile_static_objects+=("$target")
}

oliphaunt_postgis_stage_runtime_sql() {
  local postgis_build="$1"
  mkdir -p "$install_dir/share/postgresql/extension" "$install_dir/share/postgresql/proj"
  cp -p "$postgis_build/extensions/postgis/postgis.control" \
    "$install_dir/share/postgresql/extension/postgis.control"
  cp -p "$postgis_build/extensions/postgis/sql/"*.sql \
    "$install_dir/share/postgresql/extension/"
  cp -p "$mobile_static_dependency_root/proj/share/proj/proj.db" \
    "$install_dir/share/postgresql/proj/proj.db"
}

oliphaunt_postgis_patch_extension_makefile() {
  local postgis_build="$1"
  local prefix="$2"
  local makefile="$postgis_build/postgis/Makefile"
  [ -f "$makefile" ] || oliphaunt_postgis_fail "PostGIS extension Makefile is missing: $makefile"
  OLIPHAUNT_POSTGIS_PG_MAGIC_SYMBOL="${prefix}_Pg_magic_func" \
  OLIPHAUNT_POSTGIS_PG_INIT_SYMBOL="${prefix}__PG_init" \
  OLIPHAUNT_POSTGIS_DIFFERENCE_SYMBOL="${prefix}_difference" \
  OLIPHAUNT_POSTGIS_PG_FINFO_DIFFERENCE_SYMBOL="${prefix}_pg_finfo_difference" \
    perl -0pi -e '
      my $defs =
        " -DPg_magic_func=$ENV{OLIPHAUNT_POSTGIS_PG_MAGIC_SYMBOL}" .
        " -D_PG_init=$ENV{OLIPHAUNT_POSTGIS_PG_INIT_SYMBOL}" .
        " -Ddifference=$ENV{OLIPHAUNT_POSTGIS_DIFFERENCE_SYMBOL}" .
        " -Dpg_finfo_difference=$ENV{OLIPHAUNT_POSTGIS_PG_FINFO_DIFFERENCE_SYMBOL}";
      my $updated = s|^(PG_CPPFLAGS \+= .*)$|$1$defs|m;
      die "could not patch PostGIS PG_CPPFLAGS\n" unless $updated;
    ' "$makefile"
}

oliphaunt_postgis_write_static_symbol_aliases() {
  local path="$1"
  local prefix="$2"
  {
    printf 'difference\t%s_difference\n' "$prefix"
    printf 'pg_finfo_difference\tpg_finfo_%s_difference\n' "$prefix"
  } > "$path"
}

oliphaunt_postgis_verify_prefixed_module_symbol() {
  local stem="$1"
  local prefix="$2"
  if ! module_has_c_symbol "$stem" "${prefix}_Pg_magic_func"; then
    oliphaunt_postgis_fail "PostGIS did not export prefixed Pg_magic_func symbol for $stem"
  fi
}

oliphaunt_postgis_verify_prefixed_legacy_symbols() {
  local stem="$1"
  local prefix="$2"
  if ! module_has_c_symbol "$stem" "${prefix}_difference"; then
    oliphaunt_postgis_fail "PostGIS did not export prefixed legacy difference symbol for $stem"
  fi
  if ! module_has_c_symbol "$stem" "pg_finfo_${prefix}_difference"; then
    oliphaunt_postgis_fail "PostGIS did not export prefixed legacy pg_finfo_difference symbol for $stem"
  fi
}

build_postgis_mobile_static_extension_objects() {
  local extension="$1"
  [ "$extension" = "postgis" ] || return 1

  local stem prefix source_dir postgis_build object_dir objects_file alias_file archive scripts_dir
  stem="$(oliphaunt_mobile_static_extension_module_stem "$extension")"
  prefix="$(oliphaunt_static_symbol_prefix "$stem")"
  source_dir="$repo_root/target/oliphaunt-sources/checkouts/postgis"
  postgis_build="$work_root/postgis-$oliphaunt_mobile_target"
  object_dir="$out_dir/extensions/$stem"
  objects_file="$object_dir/objects.list"
  alias_file="$object_dir/symbol-aliases.list"
  archive="$object_dir/liboliphaunt_extension_$stem.a"
  scripts_dir="$work_root/postgis-$oliphaunt_mobile_target-scripts"

  if [ -f "$archive" ] && [ -s "$objects_file" ] && [ -s "$alias_file" ] && [ -f "$install_dir/share/postgresql/extension/postgis.control" ]; then
    local object
    while IFS= read -r object; do
      [ -f "$object" ] || oliphaunt_postgis_fail "missing staged PostGIS object listed in $objects_file: $object"
      mobile_static_objects+=("$object")
    done < "$objects_file"
    return 0
  fi

  [ -f "$source_dir/configure.ac" ] || oliphaunt_postgis_fail "missing PostGIS checkout: $source_dir"
  rm -rf "$postgis_build" "$object_dir" "$scripts_dir"
  mkdir -p "$postgis_build" "$object_dir" "$scripts_dir" \
    "$work_root/postgis-fake-postgres-bin" "$work_root/postgis-fake-postgres-share"
  : > "$work_root/postgis-fake-postgres-bin/postgres"
  chmod +x "$work_root/postgis-fake-postgres-bin/postgres"
  rsync -a --delete --exclude .git "$source_dir/" "$postgis_build/"

  local pg_config geos_config pkg_config host_alias ldflags
  pg_config="$scripts_dir/pg_config"
  geos_config="$scripts_dir/geos-config"
  pkg_config="$scripts_dir/pkg-config"
  host_alias="$(oliphaunt_postgis_host_alias)"
  ldflags="$(oliphaunt_postgis_extra_ldflags)"
  oliphaunt_postgis_pg_config_script "$pg_config"
  oliphaunt_postgis_geos_config_script "$geos_config"
  oliphaunt_postgis_pkg_config_script "$pkg_config"

  local postgis_cflags postgis_cppflags
  postgis_cflags="$native_cflags"
  postgis_cppflags="-I$build_dir/src/include -I$build_dir/src/include/port -I$build_dir/src/interfaces/libpq -I$mobile_static_dependency_root/libxml2/include/libxml2 -I$mobile_static_dependency_root/proj/include -I$mobile_static_dependency_root/json-c/include -I$mobile_static_dependency_root/json-c/include/json-c"
  case "$oliphaunt_mobile_target" in
    android-arm64 | android-x86_64)
    postgis_cflags="$postgis_cflags -D_GNU_SOURCE"
    postgis_cppflags="-D_GNU_SOURCE -I$mobile_static_dependency_root/libiconv/include $postgis_cppflags"
      ;;
  esac

  local -a configure_args
  configure_args=(
    --host="$host_alias"
    --with-pgconfig="$pg_config"
    --with-geosconfig="$geos_config"
    --with-xml2config="$mobile_static_dependency_root/libxml2/bin/xml2-config"
    --without-protobuf
    --without-raster
    --without-topology
    --without-sfcgal
    --without-address-standardizer
    --without-tiger
    --disable-nls
  )
  case "$oliphaunt_mobile_target" in
    android-arm64 | android-x86_64)
      configure_args+=(--with-libiconv="$mobile_static_dependency_root/libiconv")
      ;;
  esac

  (
    cd "$postgis_build"
    export PATH="$scripts_dir:$PATH"
    export PKG_CONFIG="$pkg_config"
    export PKG_CONFIG_ALLOW_CROSS=1
    export PKG_CONFIG_LIBDIR="$mobile_static_dependency_root/json-c/lib/pkgconfig:$mobile_static_dependency_root/proj/lib/pkgconfig:$mobile_static_dependency_root/sqlite/lib/pkgconfig"
    export PKG_CONFIG_PATH="$PKG_CONFIG_LIBDIR"
    export JSONC_CFLAGS="-I$mobile_static_dependency_root/json-c/include -I$mobile_static_dependency_root/json-c/include/json-c"
    export JSONC_LIBS="-L$mobile_static_dependency_root/json-c/lib -ljson-c"
    export CC="$cc_string"
    export CXX="$cc_string"
    export CFLAGS="$postgis_cflags"
    export CXXFLAGS="$postgis_cflags"
    export CPPFLAGS="$postgis_cppflags"
    export LDFLAGS="$ldflags"
    export ac_cv_lib_pq_PQserverVersion=yes
    ./autogen.sh >> "$make_log" 2>&1
    local build_alias
    build_alias="$(build-aux/config.guess)"
    ./configure --build="$build_alias" "${configure_args[@]}" >> "$make_log" 2>&1
    oliphaunt_postgis_patch_extension_makefile "$postgis_build" "$prefix"
    make -j"$jobs" -C liblwgeom liblwgeom.la >> "$make_log" 2>&1
    make -j"$jobs" -C libpgcommon libpgcommon.a >> "$make_log" 2>&1
    make -j"$jobs" -C deps/flatgeobuf all >> "$make_log" 2>&1
    make -j"$jobs" -C postgis all >> "$make_log" 2>&1 || true
    make -j1 raster-sql >> "$make_log" 2>&1 || true
    make -j1 -C raster/rt_pg sql_objs >> "$make_log" 2>&1
    make -j1 -C extensions postgis_extension_helper.sql >> "$make_log" 2>&1
    make -j1 -C extensions/postgis postgis.control all >> "$make_log" 2>&1
  )

  : > "$objects_file"
  oliphaunt_postgis_write_static_symbol_aliases "$alias_file" "$prefix"
  local object
  while IFS= read -r object; do
    [ -n "$object" ] || continue
    oliphaunt_postgis_stage_object "$object" postgis "$object_dir" "$objects_file"
  done < <(find "$postgis_build/postgis" -maxdepth 1 -type f -name '*.o' -print | LC_ALL=C sort)
  for object in \
    "$postgis_build/deps/flatgeobuf/flatgeobuf_c.o" \
    "$postgis_build/deps/flatgeobuf/geometrywriter.o" \
    "$postgis_build/deps/flatgeobuf/geometryreader.o" \
    "$postgis_build/deps/flatgeobuf/packedrtree.o"
  do
    [ -f "$object" ] || oliphaunt_postgis_fail "PostGIS FlatGeobuf object is missing: $object"
    oliphaunt_postgis_stage_object "$object" flatgeobuf "$object_dir" "$objects_file"
  done
  oliphaunt_postgis_copy_archive_objects "$postgis_build/liblwgeom/.libs/liblwgeom.a" liblwgeom "$object_dir" "$objects_file"
  oliphaunt_postgis_copy_archive_objects "$postgis_build/libpgcommon/libpgcommon.a" libpgcommon "$object_dir" "$objects_file"
  [ -s "$objects_file" ] || oliphaunt_postgis_fail "PostGIS did not produce object inputs"
  oliphaunt_postgis_verify_prefixed_module_symbol "$stem" "$prefix"
  oliphaunt_postgis_verify_prefixed_legacy_symbols "$stem" "$prefix"
  oliphaunt_postgis_stage_runtime_sql "$postgis_build"
  archive_mobile_static_extension_objects "$extension" "$object_dir" "$objects_file"
}

oliphaunt_postgis_extra_link_args() {
  oliphaunt_postgis_selected || return 0
  case "$oliphaunt_mobile_target" in
    ios-simulator | ios-device)
      printf '%s\n' -lc++
      ;;
    android-arm64 | android-x86_64)
      printf '%s\n' \
        "$toolchain_dir/sysroot/usr/lib/$android_host/libc++_static.a" \
        "$toolchain_dir/sysroot/usr/lib/$android_host/libc++abi.a"
      ;;
  esac
}
