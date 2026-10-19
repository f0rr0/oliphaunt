CREATE TEMP TABLE oliphaunt_walinspect (value text);
-- oliphaunt-statement
CREATE TEMP TABLE oliphaunt_walinspect_lsn AS SELECT pg_current_wal_lsn() AS before_lsn;
-- oliphaunt-statement
INSERT INTO oliphaunt_walinspect SELECT 'row ' || i::text FROM generate_series(1, 5) AS i;
-- oliphaunt-statement
SELECT * FROM pg_get_wal_block_info((SELECT before_lsn FROM oliphaunt_walinspect_lsn), pg_current_wal_lsn()) ORDER BY start_lsn, block_id LIMIT 20;
