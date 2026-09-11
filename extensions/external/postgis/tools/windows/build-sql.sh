#!/usr/bin/env bash
# Sourced by the Windows extension builder after source/configuration generation.
# shellcheck disable=SC2154 # The sourcing build supplies build_dir and the generator callback.
windows_postgis_build_sql() {
  local directory="$build_dir/contrib/oliphaunt_external/postgis"
  local pg="$directory/postgis" sql="$directory/extensions/postgis/sql" raster="$directory/raster/rt_pg"
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
  windows_extension_generate postgis-sql-upgrade
  perl "$directory/utils/create_extension_unpackage.pl" postgis <"$sql/raster_drop_all.sql" >"$sql/raster_unpackage_body.sql"
  windows_extension_generate postgis-sql-install
  perl "$directory/utils/create_unpackaged.pl" postgis <"$sql/postgis--$version.sql" >"$sql/postgis--unpackaged--$version.sql"
  windows_extension_generate postgis-sql-unpackaged
}
