#!/usr/bin/env bash
# Sourced by the Windows extension builder after source/configuration generation.
# shellcheck disable=SC2154 # The sourcing build supplies build_dir and the generator callback.
windows_postgis_build_sql() {
  local directory="$build_dir/contrib/oliphaunt_external/postgis"
  local pg="$directory/postgis" sql="$directory/extensions/postgis/sql" raster="$directory/raster/rt_pg"
  local raster_sql="$directory/extensions/postgis_raster/sql"
  local topology="$directory/topology" topology_sql="$directory/extensions/postgis_topology/sql"
  local tiger_sql="$directory/extensions/postgis_tiger_geocoder/sql"
  local version pg_version
  version="$(windows_extension_generate postgis-version)"
  pg_version="$(windows_extension_generate postgres-major)"
  windows_extension_generate postgis-sql-preprocess
  perl "$directory/utils/create_upgrade.pl" "$pg/postgis.sql" >"$pg/postgis_upgrade.sql.in"
  perl "$directory/utils/create_uninstall.pl" "$pg/postgis.sql" "$pg_version" >"$pg/uninstall_postgis.sql"
  perl "$directory/utils/create_uninstall.pl" "$pg/legacy.sql" "$pg_version" >"$pg/uninstall_legacy.sql"
  perl "$directory/utils/create_spatial_ref_sys_config_dump.pl" "$directory/spatial_ref_sys.sql" >"$sql/spatial_ref_sys_config_dump.sql"
  perl "$directory/utils/create_upgrade.pl" "$sql/postgis_for_extension.sql" >"$sql/postgis_upgrade_for_extension.sql.in"
  perl "$directory/utils/create_uninstall.pl" "$raster/rtpostgis.sql" "$pg_version" >"$raster/uninstall_rtpostgis.sql"
  perl "$directory/utils/create_upgrade.pl" "$raster_sql/rtpostgis.sql" >"$raster_sql/rtpostgis_upgrade.sql.in"
  perl "$directory/utils/create_upgrade.pl" "$topology/topology.sql" >"$topology/topology_upgrade.sql.in"
  perl "$directory/utils/create_uninstall.pl" "$topology/topology.sql" "$pg_version" >"$topology/uninstall_topology.sql"
  perl "$directory/utils/create_or_replace_to_create.pl" "$tiger_sql/postgis_tiger_geocoder_pre.sql" >"$tiger_sql/postgis_tiger_geocoder.sql"
  windows_extension_generate postgis-sql-upgrade
  perl "$directory/utils/create_extension_unpackage.pl" postgis <"$sql/raster_drop_all.sql" >"$sql/raster_unpackage_body.sql"
  windows_extension_generate postgis-sql-install
  perl "$directory/utils/create_unpackaged.pl" postgis <"$sql/postgis--$version.sql" >"$sql/postgis--unpackaged--$version.sql"
  perl "$directory/utils/create_unpackaged.pl" postgis_raster <"$raster_sql/postgis_raster--$version.sql" >"$raster_sql/postgis_raster--unpackaged--$version.sql"
  perl "$directory/utils/create_unpackaged.pl" postgis_topology <"$topology/topology.sql" >"$topology_sql/postgis_topology--unpackaged--$version.sql"
  windows_extension_generate postgis-sql-unpackaged
}
