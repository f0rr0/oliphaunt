\set ON_ERROR_STOP on
\if :{?perf_rows}
\else
\set perf_rows 100000
\endif
\pset tuples_only on
\timing off

DROP TABLE IF EXISTS fresh_wasix_indexed_insert;
CREATE TABLE fresh_wasix_indexed_insert (
    id integer PRIMARY KEY,
    bucket integer NOT NULL,
    payload text NOT NULL
);
CREATE INDEX fresh_wasix_indexed_insert_bucket_idx
    ON fresh_wasix_indexed_insert (bucket);
CREATE INDEX fresh_wasix_indexed_insert_payload_idx
    ON fresh_wasix_indexed_insert (payload);

\timing on
INSERT INTO fresh_wasix_indexed_insert
SELECT i, i % 1000, md5(i::text)
FROM generate_series(1, :perf_rows) AS i;
\timing off

SELECT count(*) FROM fresh_wasix_indexed_insert;
