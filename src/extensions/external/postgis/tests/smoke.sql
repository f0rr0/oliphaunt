DROP TABLE IF EXISTS liboliphaunt_postgis_points;
-- oliphaunt-statement
CREATE TEMP TABLE liboliphaunt_postgis_points(id int PRIMARY KEY, geom geometry(Point, 4326));
-- oliphaunt-statement
INSERT INTO liboliphaunt_postgis_points VALUES
  (1, ST_SetSRID(ST_MakePoint(-71.060316, 48.432044), 4326)),
  (2, ST_SetSRID(ST_MakePoint(-71.061, 48.433), 4326));
-- oliphaunt-statement
CREATE INDEX liboliphaunt_postgis_points_gix ON liboliphaunt_postgis_points USING GIST (geom);
-- oliphaunt-statement
DO $$
DECLARE
  distance float8;
  srid int;
  area float8;
  polygons int;
  nearby int;
BEGIN
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
  FROM liboliphaunt_postgis_points
  WHERE ST_DWithin(
    geom::geography,
    ST_SetSRID(ST_MakePoint(-71.060316, 48.432044), 4326)::geography,
    200
  );
  IF nearby <> 2 THEN
    RAISE EXCEPTION 'postgis dwithin failed: %', nearby;
  END IF;
END $$;
-- oliphaunt-statement
DROP TABLE IF EXISTS liboliphaunt_postgis_points;
