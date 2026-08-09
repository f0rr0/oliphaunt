#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$ROOT/wasix_third_party.sh"

REPO_ROOT="$(oliphaunt_wasix_repo_root "$ROOT")"
GDAL_SOURCE_DIR="${GDAL_SOURCE_DIR:-$REPO_ROOT/target/oliphaunt-sources/checkouts/gdal}"
GENERATED_ROOT="$(oliphaunt_wasix_generated_root "$REPO_ROOT")"
GDAL_PREFIX="${GDAL_PREFIX:-$GENERATED_ROOT/work/gdal-wasix}"
GDAL_BUILD_DIR="${GDAL_BUILD_DIR:-$GENERATED_ROOT/work/gdal-wasix-build}"
GEOS_PREFIX="${GEOS_PREFIX:-$("$ROOT/build_wasix_geos.sh")}"
JSONC_PREFIX="${JSONC_PREFIX:-$("$ROOT/build_wasix_jsonc.sh")}"
LIBXML2_PREFIX="${LIBXML2_PREFIX:-$("$ROOT/build_wasix_libxml2.sh")}"
LIBICONV_PREFIX="${LIBICONV_PREFIX:-$("$ROOT/build_wasix_libiconv.sh")}"
PROJ_PREFIX="${PROJ_PREFIX:-$("$ROOT/build_wasix_proj.sh")}"
SQLITE_PREFIX="${SQLITE_PREFIX:-$("$ROOT/build_wasix_sqlite.sh")}"
JOBS="${JOBS:-4}"

if [ ! -f "$GDAL_SOURCE_DIR/CMakeLists.txt" ]; then
  echo "missing GDAL source checkout at $GDAL_SOURCE_DIR; run assets fetch/source-spine first" >&2
  exit 1
fi

. "$ROOT/docker_wasix_env.sh"
. "$ROOT/profile_flags.sh"
oliphaunt_wasix_apply_wasix_profile build

source_commit="$(oliphaunt_wasix_source_commit "$GDAL_SOURCE_DIR")"
script_sha256="$(oliphaunt_wasix_script_sha256 "$0")"
helper_sha256="$(oliphaunt_wasix_script_sha256 "$ROOT/wasix_third_party.sh")"
compat_header="$ROOT/wasix_shim/gdal_wasix_compat.h"
compat_sha256="$(oliphaunt_wasix_script_sha256 "$compat_header")"
dependency_stamps="$(
  for row in \
    "$GEOS_PREFIX/.oliphaunt-wasix-geos-build" \
    "$JSONC_PREFIX/.oliphaunt-wasix-json-c-build" \
    "$LIBICONV_PREFIX/.oliphaunt-wasix-libiconv-build" \
    "$LIBXML2_PREFIX/.oliphaunt-wasix-libxml2-build" \
    "$PROJ_PREFIX/.oliphaunt-wasix-proj-build" \
    "$SQLITE_PREFIX/.oliphaunt-wasix-sqlite-build"
  do
    printf '%s=%s\n' "$(basename "$row")" "$(cat "$row")"
  done
)"
wasixcc_version="$(wasixcc --version 2>/dev/null)"
wasixcc_version="${wasixcc_version%%$'\n'*}"
stamp="source=$source_commit
script=$script_sha256
helper=$helper_sha256
compat=$compat_sha256
$dependency_stamps
profile=$(oliphaunt_wasix_wasix_profile_signature)
wasixcc=$wasixcc_version
cmake=static-core-vrt-gtiff-internal-codecs-no-apps-no-optional-drivers"

if [ -f "$GDAL_PREFIX/.oliphaunt-wasix-gdal-build" ] &&
   [ -f "$GDAL_PREFIX/include/gdal.h" ] &&
   [ -f "$GDAL_PREFIX/lib/libgdal.a" ] &&
   [ -x "$GDAL_PREFIX/bin/gdal-config" ] &&
   [ "$(cat "$GDAL_PREFIX/.oliphaunt-wasix-gdal-build")" = "$stamp" ]; then
  echo "$GDAL_PREFIX"
  exit 0
fi

{
  rm -rf "$GDAL_BUILD_DIR" "$GDAL_PREFIX"
  mkdir -p "$GDAL_BUILD_DIR" "$(dirname "$GDAL_PREFIX")"
  OLIPHAUNT_WASIX_CMAKE_C_FLAGS_EXTRA="-include $compat_header" \
  OLIPHAUNT_WASIX_CMAKE_CXX_FLAGS_EXTRA="-include $compat_header" \
  oliphaunt_wasix_static_cmake_build \
    "$GDAL_SOURCE_DIR" \
    "$GDAL_BUILD_DIR" \
    "$GDAL_PREFIX" \
    -DBASH_COMPLETIONS_DIR= \
    -DBUILD_SHARED_LIBS=OFF \
    -DBUILD_APPS=OFF \
    -DBUILD_CSHARP_BINDINGS=OFF \
    -DBUILD_JAVA_BINDINGS=OFF \
    -DBUILD_PYTHON_BINDINGS=OFF \
    -DBUILD_TESTING=OFF \
    -DGDAL_BUILD_OPTIONAL_DRIVERS=OFF \
    -DGDAL_OBJECT_LIBRARIES_POSITION_INDEPENDENT_CODE=ON \
    -DOGR_BUILD_OPTIONAL_DRIVERS=OFF \
    -DGDAL_ENABLE_DRIVER_GTIFF=ON \
    -DGDAL_ENABLE_DRIVER_VRT=ON \
    -DOGR_ENABLE_DRIVER_GEOJSON=ON \
    -DOGR_ENABLE_DRIVER_SHAPE=ON \
    -DGDAL_USE_EXTERNAL_LIBS=OFF \
    -DGDAL_USE_INTERNAL_LIBS=ON \
    -DGDAL_USE_OPENMP=OFF \
    -DHAVE_DLFCN_H=0 \
    -DHAVE_DL_ITERATE_PHDR=0 \
    -DHAVE_SCHED_GETAFFINITY=0 \
    -DGDAL_USE_CURL=OFF \
    -DGDAL_USE_OPENSSL=OFF \
    -DGDAL_USE_GEOS=ON \
    -DGEOS_INCLUDE_DIR="$GEOS_PREFIX/include" \
    -DGEOS_LIBRARY="$GEOS_PREFIX/lib/libgeos_c.a" \
    -DGDAL_USE_JSONC=ON \
    -DGDAL_USE_JSONC_INTERNAL=OFF \
    -DJSONC_INCLUDE_DIR="$JSONC_PREFIX/include/json-c" \
    -DJSONC_LIBRARY="$JSONC_PREFIX/lib/libjson-c.a" \
    -DGDAL_USE_LIBXML2=ON \
    -DLIBXML2_INCLUDE_DIR="$LIBXML2_PREFIX/include/libxml2" \
    -DLIBXML2_LIBRARY="$LIBXML2_PREFIX/lib/libxml2.a" \
    -DGDAL_USE_ICONV=ON \
    -DIconv_INCLUDE_DIR="$LIBICONV_PREFIX/include" \
    -DIconv_LIBRARY="$LIBICONV_PREFIX/lib/libiconv.a" \
    -DGDAL_USE_PROJ=ON \
    -DPROJ_INCLUDE_DIR="$PROJ_PREFIX/include" \
    -DPROJ_LIBRARY="$PROJ_PREFIX/lib/libproj.a" \
    -DGDAL_USE_SQLITE3=ON \
    -DSQLite3_INCLUDE_DIR="$SQLITE_PREFIX/include" \
    -DSQLite3_LIBRARY="$SQLITE_PREFIX/lib/libsqlite3.a" \
    -DACCEPT_MISSING_SQLITE3_MUTEX_ALLOC=ON
} >&2

test -f "$GDAL_PREFIX/include/gdal.h"
test -f "$GDAL_PREFIX/include/ogr_api.h"
test -f "$GDAL_PREFIX/lib/libgdal.a"
test -x "$GDAL_PREFIX/bin/gdal-config"
printf '%s\n' "$stamp" > "$GDAL_PREFIX/.oliphaunt-wasix-gdal-build"
echo "$GDAL_PREFIX"
