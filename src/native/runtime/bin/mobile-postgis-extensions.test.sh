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
gdal_checkout="$repo_root/target/oliphaunt-sources/checkouts/gdal"
git init --quiet "$gdal_checkout"
git -C "$gdal_checkout" -c user.name=Fixture -c user.email=fixture@example.invalid \
  commit --quiet --allow-empty -m fixture
gdal_fixture_commit="$(git -C "$gdal_checkout" rev-parse HEAD)"
: > "$mobile_static_dependency_root/proj/lib/libproj.a"

oliphaunt_postgis_selected() {
  return 0
}

cmake_args_file="$test_root/cmake-args.txt"
dependency_builds=0
oliphaunt_postgis_cmake_install() {
  local dependency_dir="$3"
  shift 3
  [ "${GDAL_SHA1SUM:-}" = "$gdal_fixture_commit" ] || {
    echo "GDAL version metadata did not use its pinned source revision" >&2
    return 1
  }
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

mkdir -p "$postgis_build/topology"
cat > "$postgis_build/topology/Makefile" <<'MAKEFILE'
PG_CPPFLAGS += -Ifixture
.PHONY: all print-flags
all:
	@exit 1
postgis_topology.o topology.sql topology_upgrade.sql uninstall_topology.sql:
	@: > $@
print-flags:
	@printf '%s\n' '$(PG_CPPFLAGS)'
MAKEFILE
oliphaunt_postgis_patch_topology_makefile "$postgis_build" "$prefix"
topology_flags="$(make -s -f "$postgis_build/topology/Makefile" print-flags)"
for expected in \
  "-DPg_magic_func=${prefix}_topology_Pg_magic_func" \
  "-D_PG_init=${prefix}_topology_PG_init" \
  "-D_PG_fini=${prefix}_topology_PG_fini"; do
  case " $topology_flags " in
    *" $expected "*) ;;
    *) echo "missing topology compile definition: $expected" >&2; exit 1 ;;
  esac
done
oliphaunt_postgis_build_topology_objects "$postgis_build"
for output in postgis_topology.o topology.sql topology_upgrade.sql uninstall_topology.sql; do
  [ -f "$postgis_build/topology/$output" ]
done

# The merged carrier must initialize all three C modules in dependency order.
cc=("${CC:-cc}")
native_cflags=""
object_dir="$test_root/objects"
mkdir -p "$object_dir"
combined_object="$(oliphaunt_postgis_build_combined_init "$postgis_build" "$prefix" "$object_dir")"
cat > "$test_root/init-test.c" <<EOF
#include <assert.h>
static int initialized;
void ${prefix}_core_PG_init(void) { assert(initialized++ == 0); }
void ${prefix}_raster_PG_init(void) { assert(initialized++ == 1); }
void ${prefix}_topology_PG_init(void) { assert(initialized++ == 2); }
extern void ${prefix}__PG_init(void);
int main(void) { ${prefix}__PG_init(); assert(initialized == 3); }
EOF
"${cc[@]}" "$test_root/init-test.c" "$combined_object" -o "$test_root/init-test"
"$test_root/init-test"

install_dir="$test_root/install"
mkdir -p "$mobile_static_dependency_root/proj/share/proj"
printf 'database\n' > "$mobile_static_dependency_root/proj/share/proj/proj.db"
for member in postgis postgis_raster postgis_topology postgis_tiger_geocoder; do
  mkdir -p "$postgis_build/extensions/$member/sql"
  printf 'module_pathname = '\''$libdir/%s-3'\''\n' "$member" > "$postgis_build/extensions/$member/$member.control"
  printf 'SELECT '\''$libdir/%s-3.6'\'';\n' "$member" > "$postgis_build/extensions/$member/sql/$member--3.6.4.sql"
done
oliphaunt_postgis_stage_runtime_sql "$postgis_build"
for member in postgis postgis_raster postgis_topology postgis_tiger_geocoder; do
  [ -s "$install_dir/share/postgresql/extension/$member.control" ]
  [ -s "$install_dir/share/postgresql/extension/$member--3.6.4.sql" ]
done
for member in postgis_raster postgis_topology; do
  grep -F '$libdir/postgis-3' "$install_dir/share/postgresql/extension/$member.control" >/dev/null
  grep -F '$libdir/postgis-3' "$install_dir/share/postgresql/extension/$member--3.6.4.sql" >/dev/null
  if grep -F "$member-3" "$install_dir/share/postgresql/extension/$member--3.6.4.sql"; then
    echo "mobile SQL retained a separate module identity" >&2
    exit 1
  fi
done

echo "mobile PostGIS build contracts passed"
