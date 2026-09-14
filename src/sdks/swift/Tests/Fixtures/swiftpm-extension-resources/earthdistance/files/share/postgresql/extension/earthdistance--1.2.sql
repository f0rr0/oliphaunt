CREATE FUNCTION geo_distance(point, point) RETURNS float8 AS 'MODULE_PATHNAME', 'geo_distance' LANGUAGE C IMMUTABLE STRICT;
