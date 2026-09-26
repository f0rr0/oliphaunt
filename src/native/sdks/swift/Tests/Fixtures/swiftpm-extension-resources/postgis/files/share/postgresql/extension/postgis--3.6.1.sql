CREATE FUNCTION postgis_full_version() RETURNS text AS 'MODULE_PATHNAME', 'postgis_full_version' LANGUAGE C IMMUTABLE STRICT;
