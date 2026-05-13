\set ON_ERROR_STOP on
\if :{?perf_rows}
\else
\set perf_rows 100000
\endif
\if :{?update_rows}
\else
\set update_rows :perf_rows
\endif
\pset tuples_only on
\timing off

DROP TABLE IF EXISTS fresh_wasix_indexed_update;
CREATE TABLE fresh_wasix_indexed_update (
    id integer PRIMARY KEY,
    bucket integer NOT NULL,
    payload text NOT NULL
);
INSERT INTO fresh_wasix_indexed_update
SELECT i, i % 1000, md5(i::text)
FROM generate_series(1, :perf_rows) AS i;
CREATE INDEX fresh_wasix_indexed_update_bucket_idx
    ON fresh_wasix_indexed_update (bucket);
CREATE INDEX fresh_wasix_indexed_update_payload_idx
    ON fresh_wasix_indexed_update (payload);
ANALYZE fresh_wasix_indexed_update;

\timing on
UPDATE fresh_wasix_indexed_update
SET
    bucket = bucket + 1,
    payload = md5((id + :perf_rows)::text)
WHERE id <= :update_rows;
\timing off

SELECT count(*) FROM fresh_wasix_indexed_update
WHERE id <= :update_rows AND bucket > 0;
