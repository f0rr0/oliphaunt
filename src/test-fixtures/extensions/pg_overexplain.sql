-- oliphaunt-verify
LOAD 'pg_overexplain';

-- oliphaunt-statement
-- oliphaunt-verify
DO $oliphaunt$
DECLARE
  document jsonb;
BEGIN
  EXECUTE 'EXPLAIN (DEBUG, RANGE_TABLE, FORMAT JSON, COSTS OFF) SELECT oid FROM pg_class WHERE relname = ''pg_class'''
    INTO document;
  IF (document->0->'Plan' ? 'Plan Node ID') IS DISTINCT FROM true
      OR COALESCE(jsonb_array_length(document->0->'Range Table'), 0) < 1 THEN
    RAISE EXCEPTION 'pg_overexplain did not include plan IDs and the range table: %', document;
  END IF;
END
$oliphaunt$;
