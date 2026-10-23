/* PostGIS's three compiled SQL members share one static registry member. */
extern void oliphaunt_static_postgis_3_core_PG_init(void);
extern void oliphaunt_static_postgis_3_raster_PG_init(void);
extern void oliphaunt_static_postgis_3_topology_PG_init(void);

void oliphaunt_static_postgis_3__PG_init(void) {
  oliphaunt_static_postgis_3_core_PG_init();
  oliphaunt_static_postgis_3_raster_PG_init();
  oliphaunt_static_postgis_3_topology_PG_init();
}
