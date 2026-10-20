-- The fixed-argument WASIX path must agree with PostgreSQL's generic path.
DO $probe$
DECLARE
  value jsonb;
  row record;
BEGIN
  ASSERT jsonb_build_object() = '{}'::jsonb;
  ASSERT jsonb_build_object('a', '1'::text, 'b', NULL::text) =
         jsonb_build_object(VARIADIC ARRAY['a', '1', 'b', NULL]::text[]);
  ASSERT jsonb_build_object('a', NULL, 'b', 42) = '{"a": null, "b": 42}'::jsonb;
  ASSERT jsonb_build_object(VARIADIC NULL::text[]) IS NULL;
  ASSERT jsonb_build_object(VARIADIC '{{1,4},{2,5},{3,6}}'::int[][]) =
         '{"1": 4, "2": 5, "3": 6}'::jsonb;

  BEGIN
    PERFORM jsonb_build_object(NULL::text, 1);
    RAISE EXCEPTION 'null key was accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    NULL;
  END;
  BEGIN
    PERFORM jsonb_build_object('key');
    RAISE EXCEPTION 'odd argument count was accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    NULL;
  END;

  PREPARE jsonb_cache_probe(text, int) AS
    SELECT jsonb_build_object('constant', 'value', 'parameter', $1,
                              'number', $2, 'null', NULL);
  EXECUTE 'EXECUTE jsonb_cache_probe(''first'', 1)' INTO value;
  ASSERT value = '{"constant": "value", "parameter": "first", "number": 1, "null": null}'::jsonb;
  EXECUTE 'EXECUTE jsonb_cache_probe(''second'', 2)' INTO value;
  ASSERT value = '{"constant": "value", "parameter": "second", "number": 2, "null": null}'::jsonb;
  DEALLOCATE jsonb_cache_probe;

  CREATE TYPE jsonb_cache_type AS ENUM ('one');
  CREATE FUNCTION jsonb_cache_cast(jsonb_cache_type) RETURNS json
    LANGUAGE SQL IMMUTABLE STRICT RETURN json_build_object('cast', $1::text);
  CREATE CAST (jsonb_cache_type AS json) WITH FUNCTION jsonb_cache_cast(jsonb_cache_type);
  CREATE FUNCTION jsonb_cache_drop_cast(int, jsonb_cache_type) RETURNS jsonb_cache_type
    LANGUAGE plpgsql VOLATILE AS $cast$
    BEGIN
      IF $1 = 2 THEN
        EXECUTE 'DROP CAST (jsonb_cache_type AS json)';
      END IF;
      RETURN $2;
    END
    $cast$;
  FOR row IN SELECT g, jsonb_build_object('v', jsonb_cache_drop_cast(g, 'one')) AS value
             FROM generate_series(1, 2) AS g ORDER BY g LOOP
    ASSERT row.value = CASE row.g WHEN 1 THEN '{"v": {"cast": "one"}}'::jsonb
                                  ELSE '{"v": "one"}'::jsonb END;
  END LOOP;
  DROP FUNCTION jsonb_cache_drop_cast(int, jsonb_cache_type);
  DROP FUNCTION jsonb_cache_cast(jsonb_cache_type);
  DROP TYPE jsonb_cache_type;
END
$probe$;
