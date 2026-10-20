-- Exercise both entry points without requiring a logical replication slot.
-- Invalid snapshot names must be rejected before any filesystem access.
-- oliphaunt-verify
DO $oliphaunt$
BEGIN
  BEGIN
    PERFORM pg_get_logical_snapshot_meta('../invalid');
    RAISE EXCEPTION 'pg_logicalinspect accepted an invalid snapshot name';
  EXCEPTION WHEN internal_error THEN
    IF SQLERRM <> 'invalid snapshot file name "../invalid"' THEN
      RAISE;
    END IF;
  END;
  BEGIN
    PERFORM pg_get_logical_snapshot_info('../invalid');
    RAISE EXCEPTION 'pg_logicalinspect accepted an invalid snapshot name';
  EXCEPTION WHEN internal_error THEN
    IF SQLERRM <> 'invalid snapshot file name "../invalid"' THEN
      RAISE;
    END IF;
  END;
END
$oliphaunt$;
