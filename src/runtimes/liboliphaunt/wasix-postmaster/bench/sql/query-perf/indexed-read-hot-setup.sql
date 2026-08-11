\set ON_ERROR_STOP on
\if :{?perf_rows}
\else
\set perf_rows 100000
\endif
\pset tuples_only on
\timing off

DROP TABLE IF EXISTS fresh_wasix_indexed_read_hot;
CREATE TABLE fresh_wasix_indexed_read_hot (
    id integer PRIMARY KEY,
    bucket integer NOT NULL,
    payload text NOT NULL
);
INSERT INTO fresh_wasix_indexed_read_hot
SELECT i, i % 1000, md5(i::text)
FROM generate_series(1, :perf_rows) AS i;
CREATE INDEX fresh_wasix_indexed_read_hot_bucket_idx
    ON fresh_wasix_indexed_read_hot (bucket);
CREATE INDEX fresh_wasix_indexed_read_hot_payload_idx
    ON fresh_wasix_indexed_read_hot (payload);
ANALYZE fresh_wasix_indexed_read_hot;
