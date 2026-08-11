\set ON_ERROR_STOP on
\if :{?perf_rows}
\else
\set perf_rows 100000
\endif
\pset tuples_only on
\timing off

SELECT pg_stat_reset_shared('wal');
SELECT pg_stat_reset_shared('io');

DROP TABLE IF EXISTS fresh_wasix_wal_insert_stats;
CREATE TABLE fresh_wasix_wal_insert_stats (
    id integer PRIMARY KEY,
    bucket integer NOT NULL,
    payload text NOT NULL
);

\timing on
BEGIN;
INSERT INTO fresh_wasix_wal_insert_stats
SELECT i, i % 1000, md5(i::text)
FROM generate_series(1, :perf_rows) AS i;
COMMIT;
\timing off

SELECT pg_stat_force_next_flush();

SELECT
    wal_records,
    wal_fpi,
    wal_bytes,
    wal_buffers_full,
    stats_reset
FROM pg_stat_wal;

SELECT
    backend_type,
    object,
    context,
    writes,
    write_bytes,
    write_time,
    fsyncs,
    fsync_time
FROM pg_stat_io
WHERE writes <> 0
   OR write_bytes <> 0
   OR fsyncs <> 0
ORDER BY object, backend_type, context;
