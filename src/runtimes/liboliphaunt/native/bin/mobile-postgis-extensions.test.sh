#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
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
oliphaunt_postgis_cmake_install() {
  local dependency_dir="$3"
  shift 3
  printf '%s\n' "$@" > "$cmake_args_file"
  mkdir -p "$dependency_dir/lib" "$dependency_dir/include" "$dependency_dir/bin"
  : > "$dependency_dir/lib/libgdal.a"
  : > "$dependency_dir/include/gdal.h"
  : > "$dependency_dir/bin/gdal-config"
  chmod +x "$dependency_dir/bin/gdal-config"
}

build_postgis_gdal_dependency
grep -Fx -- '-DBUILD_PYTHON_BINDINGS=OFF' "$cmake_args_file" >/dev/null
grep -Fx -- '-DBUILD_PYTHON_BINDINGS_OLD_VAL=OFF' "$cmake_args_file" >/dev/null

postgis_build="$test_root/postgis-build"
mkdir -p "$postgis_build/raster/rt_pg"
cat > "$postgis_build/raster/rt_pg/Makefile" <<'MAKEFILE'
PG_CPPFLAGS += \
	-Ifixture-one \
	-Ifixture-two
SHLIB_LINK_F = -lfixture

.PHONY: print-flags
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

echo "mobile PostGIS build contracts passed"
