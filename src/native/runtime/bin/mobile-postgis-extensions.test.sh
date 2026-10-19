#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=/dev/null
. "$script_dir/mobile-static-extensions.sh"
# shellcheck source=/dev/null
. "$script_dir/mobile-postgis-extensions.sh"

test_root="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-mobile-postgis-test.XXXXXX")"
trap 'rm -rf "$test_root"' EXIT

repo_root="$test_root/repo"
mobile_static_dependency_root="$test_root/dependencies"
work_root="$test_root/work"
oliphaunt_mobile_target="ios-simulator"
mobile_static_dependency_archives=()

mkdir -p \
  "$repo_root/target/oliphaunt-sources/checkouts/gdal" \
  "$mobile_static_dependency_root/proj/lib"
: > "$repo_root/target/oliphaunt-sources/checkouts/gdal/CMakeLists.txt"
: > "$mobile_static_dependency_root/proj/lib/libproj.a"

oliphaunt_postgis_selected() {
  return 0
}

cmake_args_file="$test_root/cmake-args.txt"
dependency_builds=0
oliphaunt_postgis_cmake_install() {
  local dependency_dir="$3"
  shift 3
  printf '%s\n' "$@" > "$cmake_args_file"
  dependency_builds=$((dependency_builds + 1))
  mkdir -p "$dependency_dir/lib" "$dependency_dir/include" "$dependency_dir/bin" "$dependency_dir/share/gdal"
  : > "$dependency_dir/lib/libgdal.a"
  : > "$dependency_dir/include/gdal.h"
  : > "$dependency_dir/share/gdal/gdalvrt.xsd"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$dependency_dir/bin/gdal-config"
  chmod +x "$dependency_dir/bin/gdal-config"
}

build_postgis_gdal_dependency
grep -Fx -- '-DCMAKE_BUILD_TYPE=Release' "$cmake_args_file" >/dev/null
grep -Fx -- '-DBUILD_PYTHON_BINDINGS=OFF' "$cmake_args_file" >/dev/null
grep -Fx -- '-DBUILD_PYTHON_BINDINGS_OLD_VAL=OFF' "$cmake_args_file" >/dev/null
build_postgis_gdal_dependency
[ "$dependency_builds" -eq 1 ]
rm "$mobile_static_dependency_root/gdal/share/gdal/gdalvrt.xsd"
build_postgis_gdal_dependency
[ "$dependency_builds" -eq 2 ] || {
  echo "mobile GDAL cache accepted missing runtime data" >&2
  exit 1
}
resolved_gdal_archive="$(oliphaunt_mobile_static_dependency_archive_for_root "$mobile_static_dependency_root" gdal)"
[ "$resolved_gdal_archive" = "$mobile_static_dependency_root/gdal/lib/libgdal.a" ] || {
  echo "mobile packager did not resolve the staged GDAL archive" >&2
  exit 1
}

postgis_build="$test_root/postgis-build"
mkdir -p "$postgis_build/raster/rt_pg"
cat > "$postgis_build/raster/rt_pg/Makefile" <<'MAKEFILE'
PG_CPPFLAGS += \
	-Ifixture-one \
	-Ifixture-two
SHLIB_LINK_F = -lfixture

.PHONY: all print-flags sql_objs
OBJS = rtpostgis.o rtpg_gdal.o
all:
	@exit 1

$(OBJS):
	@: > $@

sql_objs:
	@: > rtpostgis.sql

print-flags:
	@printf '%s\n' '$(PG_CPPFLAGS)'
MAKEFILE

prefix="oliphaunt_static_postgis_3"
oliphaunt_postgis_patch_raster_makefile "$postgis_build" "$prefix"
raster_flags="$(make -s -f "$postgis_build/raster/rt_pg/Makefile" print-flags)"
for expected in \
  "-DPg_magic_func=${prefix}_raster_Pg_magic_func" \
  "-D_PG_init=${prefix}_raster_PG_init" \
  "-D_PG_fini=${prefix}_raster_PG_fini"; do
  case " $raster_flags " in
    *" $expected "*) ;;
    *)
      echo "missing raster compile definition: $expected" >&2
      exit 1
      ;;
  esac
done

jobs=1
make_log="$test_root/raster-make.log"
oliphaunt_postgis_build_raster_objects "$postgis_build"
[ -f "$postgis_build/raster/rt_pg/rtpostgis.o" ] &&
[ -f "$postgis_build/raster/rt_pg/rtpg_gdal.o" ] &&
[ -f "$postgis_build/raster/rt_pg/rtpostgis.sql" ] || {
  echo "mobile raster build did not produce every object and SQL input" >&2
  exit 1
}
cat >> "$postgis_build/raster/rt_pg/Makefile" <<'MAKEFILE'
oliphaunt-static-objects: failed-object.o
failed-object.o:
	@exit 1
MAKEFILE
if (oliphaunt_postgis_build_raster_objects "$postgis_build") > "$test_root/failure.log" 2>&1; then
  echo "mobile raster build accepted a partial object set" >&2
  exit 1
fi

echo "mobile PostGIS build contracts passed"
