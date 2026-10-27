-- Temporary table inserts do not produce the heap WAL this smoke inspects.
CREATE TABLE oliphaunt_walinspect (value text);
-- oliphaunt-statement
DO $$
DECLARE before_lsn pg_lsn := pg_current_wal_insert_lsn();
BEGIN
  INSERT INTO oliphaunt_walinspect SELECT 'row ' || i::text FROM generate_series(1, 5) AS i;
  -- Inspection reads flushed WAL, including when the caller wraps this smoke in BEGIN.
  PERFORM pg_logical_emit_message(false, 'oliphaunt-walinspect', 'flush', true);
  IF NOT EXISTS (
    SELECT 1 FROM pg_get_wal_block_info(before_lsn, pg_current_wal_flush_lsn())
    WHERE relfilenode = pg_relation_filenode('oliphaunt_walinspect'::regclass)
      AND reldatabase = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND resource_manager = 'Heap' AND block_data IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'pg_walinspect did not read the logged table block';
  END IF;
END $$;
-- oliphaunt-statement
DROP TABLE oliphaunt_walinspect;
