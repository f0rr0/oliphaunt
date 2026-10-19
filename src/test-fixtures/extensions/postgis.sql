CREATE EXTENSION IF NOT EXISTS postgis_raster;
-- oliphaunt-statement
CREATE EXTENSION IF NOT EXISTS postgis_topology;
-- oliphaunt-statement
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;
-- oliphaunt-statement
CREATE EXTENSION IF NOT EXISTS postgis_tiger_geocoder;
-- oliphaunt-statement
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM topology.topology WHERE name = 'oliphaunt_postgis_topology') THEN
    PERFORM topology.DropTopology('oliphaunt_postgis_topology');
  END IF;
  PERFORM topology.CreateTopology('oliphaunt_postgis_topology', 4326);
  PERFORM topology.ST_AddIsoNode('oliphaunt_postgis_topology', NULL, ST_SetSRID(ST_MakePoint(1, 1), 4326));
END $$;
-- oliphaunt-statement
DROP TABLE IF EXISTS oliphaunt_postgis_points;
-- oliphaunt-statement
CREATE TABLE oliphaunt_postgis_points(id int PRIMARY KEY, geom geometry(Point, 4326));
-- oliphaunt-statement
INSERT INTO oliphaunt_postgis_points VALUES
  (1, ST_SetSRID(ST_MakePoint(-71.060316, 48.432044), 4326)),
  (2, ST_SetSRID(ST_MakePoint(-71.061, 48.433), 4326));
-- oliphaunt-statement
CREATE INDEX oliphaunt_postgis_points_gix ON oliphaunt_postgis_points USING GIST (geom);
-- oliphaunt-statement
-- oliphaunt-verify
DO $$
DECLARE
  distance float8;
  srid int;
  area float8;
  polygons int;
  nearby int;
  gdal_drivers int;
  raster_roundtrip raster;
  raster_value float8;
  topology_nodes int;
  normalized tiger.norm_addy;
BEGIN
  SELECT count(*) INTO topology_nodes FROM oliphaunt_postgis_topology.node
  WHERE ST_Equals(geom, ST_SetSRID(ST_MakePoint(1, 1), 4326));
  IF topology_nodes <> 1 OR EXISTS (SELECT 1 FROM topology.ValidateTopology('oliphaunt_postgis_topology')) THEN
    RAISE EXCEPTION 'postgis topology persistence or validation failed: % nodes', topology_nodes;
  END IF;
  -- Tiger resolves its internal functions and types through the session search path.
  SET LOCAL search_path = public, tiger;
  normalized := tiger.normalize_address('1 Devonshire Place, Boston, MA 02109');
  IF normalized.address IS DISTINCT FROM 1 OR normalized.streetname IS DISTINCT FROM 'Devonshire'
    OR normalized.streettypeabbrev IS DISTINCT FROM 'Pl' OR normalized.location IS DISTINCT FROM 'Boston'
    OR normalized.stateabbrev IS DISTINCT FROM 'MA' OR normalized.zip IS DISTINCT FROM '02109'
    OR normalized.parsed IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'postgis tiger address normalization failed: %', normalized;
  END IF;
  SET LOCAL postgis.gdal_enabled_drivers = 'GTiff';
  SELECT ST_Distance(ST_GeomFromText('POINT(0 0)'), ST_GeomFromText('POINT(3 4)')) INTO distance;
  IF distance <> 5 THEN
    RAISE EXCEPTION 'postgis geometry distance failed: %', distance;
  END IF;
  IF ST_AsText(ST_Buffer(ST_GeomFromText('POINT(0 0)'), 1, 'quad_segs=1')) IS NULL THEN
    RAISE EXCEPTION 'postgis buffer failed';
  END IF;
  IF NOT ST_Within(
    ST_GeomFromText('POINT(0.5 0.5)'),
    ST_GeomFromText('POLYGON((0 0,0 1,1 1,1 0,0 0))')
  ) THEN
    RAISE EXCEPTION 'postgis within failed';
  END IF;
  SELECT ST_SRID(ST_Transform(ST_SetSRID(ST_MakePoint(-71.060316, 48.432044), 4326), 3857)) INTO srid;
  IF srid <> 3857 THEN
    RAISE EXCEPTION 'postgis transform failed: %', srid;
  END IF;
  SELECT ST_Area(ST_Transform(ST_SetSRID(ST_MakePolygon(ST_GeomFromText('LINESTRING(-71.1776848522251 42.3902896512902,-71.1776843766797 42.3903701743239,-71.1775844305465 42.3903829478009,-71.1775825927231 42.3902893647987,-71.1776848522251 42.3902896512902)')), 4326), 26986)) INTO area;
  IF area <= 0 THEN
    RAISE EXCEPTION 'postgis projected area failed: %', area;
  END IF;
  SELECT ST_NumGeometries(ST_Polygonize(ARRAY[
    ST_GeomFromText('LINESTRING(0 0, 1 0)'),
    ST_GeomFromText('LINESTRING(1 0, 1 1)'),
    ST_GeomFromText('LINESTRING(1 1, 0 1)'),
    ST_GeomFromText('LINESTRING(0 1, 0 0)')
  ])) INTO polygons;
  IF polygons <> 1 THEN
    RAISE EXCEPTION 'postgis polygonize failed: %', polygons;
  END IF;
  SELECT count(*) INTO nearby
  FROM oliphaunt_postgis_points
  WHERE ST_DWithin(
    geom::geography,
    ST_SetSRID(ST_MakePoint(-71.060316, 48.432044), 4326)::geography,
    200
  );
  IF nearby <> 2 THEN
    RAISE EXCEPTION 'postgis dwithin failed: %', nearby;
  END IF;
  SELECT count(*) INTO gdal_drivers
  FROM ST_GDALDrivers()
  WHERE short_name = 'GTiff' AND can_read AND can_write;
  IF gdal_drivers <> 1 THEN
    RAISE EXCEPTION 'postgis raster GeoTIFF driver is unavailable';
  END IF;
  SELECT ST_FromGDALRaster(
    ST_AsGDALRaster(
      ST_AddBand(
        ST_MakeEmptyRaster(2, 2, 0, 0, 1, -1, 0, 0, 4326),
        '8BUI'::text,
        7::double precision,
        0::double precision
      ),
      'GTiff'
    )
  ) INTO raster_roundtrip;
  SELECT ST_Value(raster_roundtrip, 1, 1, 1) INTO raster_value;
  IF raster_value IS DISTINCT FROM 7 OR ST_SRID(raster_roundtrip) IS DISTINCT FROM 4326
    OR ST_Width(raster_roundtrip) IS DISTINCT FROM 2 OR ST_Height(raster_roundtrip) IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'postgis raster GDAL round-trip failed: value %, srid %',
      raster_value,
      ST_SRID(raster_roundtrip);
  END IF;
END $$;
