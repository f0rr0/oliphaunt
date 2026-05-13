\set ON_ERROR_STOP on
\if :{?perf_rows}
\else
\set perf_rows 100000
\endif
\pset tuples_only on
\timing off

DROP TABLE IF EXISTS fresh_wasix_indexed_read;
CREATE TABLE fresh_wasix_indexed_read (
    id integer PRIMARY KEY,
    bucket integer NOT NULL,
    payload text NOT NULL
);
INSERT INTO fresh_wasix_indexed_read
SELECT i, i % 1000, md5(i::text)
FROM generate_series(1, :perf_rows) AS i;
CREATE INDEX fresh_wasix_indexed_read_bucket_idx
    ON fresh_wasix_indexed_read (bucket);
CREATE INDEX fresh_wasix_indexed_read_payload_idx
    ON fresh_wasix_indexed_read (payload);
ANALYZE fresh_wasix_indexed_read;

\timing on
SELECT count(*) FROM fresh_wasix_indexed_read
WHERE bucket BETWEEN 100 AND 199;
SELECT payload FROM fresh_wasix_indexed_read
WHERE id = (:perf_rows * 3 / 4);
SELECT count(*) FROM fresh_wasix_indexed_read
WHERE payload >= 'a' AND payload < 'b';
\timing off
