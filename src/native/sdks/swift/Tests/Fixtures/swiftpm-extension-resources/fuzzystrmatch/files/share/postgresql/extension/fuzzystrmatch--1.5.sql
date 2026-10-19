CREATE FUNCTION fuzzystrmatch_in(cstring) RETURNS fuzzystrmatch AS 'MODULE_PATHNAME', 'fuzzystrmatch_in' LANGUAGE C IMMUTABLE STRICT;
