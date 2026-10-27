-- oliphaunt-statement
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'heap_force_kill') THEN RAISE EXCEPTION 'pg_surgery function missing'; END IF; END $$;
-- oliphaunt-statement
CREATE TEMP TABLE oliphaunt_pg_surgery_probe(value integer);
-- oliphaunt-statement
INSERT INTO oliphaunt_pg_surgery_probe VALUES (1), (2);
-- oliphaunt-statement
DO $$
DECLARE
  target_tid tid;
BEGIN
  SELECT ctid INTO STRICT target_tid FROM oliphaunt_pg_surgery_probe WHERE value = 1;
  PERFORM heap_force_freeze('oliphaunt_pg_surgery_probe'::regclass, ARRAY[target_tid]::tid[]);
  IF (SELECT xmin::text FROM oliphaunt_pg_surgery_probe WHERE value = 1) IS DISTINCT FROM '2' THEN
    RAISE EXCEPTION 'pg_surgery did not freeze the temporary tuple';
  END IF;
  PERFORM heap_force_kill('oliphaunt_pg_surgery_probe'::regclass, ARRAY[target_tid]::tid[]);
  IF (SELECT count(*) FROM oliphaunt_pg_surgery_probe) IS DISTINCT FROM 1::bigint
    OR (SELECT sum(value) FROM oliphaunt_pg_surgery_probe) IS DISTINCT FROM 2::bigint THEN
    RAISE EXCEPTION 'pg_surgery did not retain only the expected temporary tuple';
  END IF;
END
$$;
