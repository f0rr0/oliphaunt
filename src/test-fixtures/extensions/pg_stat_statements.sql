-- Reset and collect fresh counters on creation, restart, and backup restore.
-- This fails if the library was loaded after shared-memory startup.
-- oliphaunt-verify
SELECT pg_stat_statements_reset();
-- oliphaunt-statement
-- oliphaunt-verify
SELECT sum(value) FROM generate_series(1, 3) AS oliphaunt_pgss_probe(value);
-- oliphaunt-statement
-- oliphaunt-verify
DO $oliphaunt$
BEGIN
  IF NOT EXISTS (
    SELECT FROM pg_stat_statements
    WHERE query LIKE 'SELECT sum(value) FROM generate_series%oliphaunt_pgss_probe%'
      AND dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND queryid <> 0 AND calls >= 1 AND rows = calls
  ) THEN
    RAISE EXCEPTION 'pg_stat_statements did not record a completed query';
  END IF;
END
$oliphaunt$;
