\set ON_ERROR_STOP on
\if :{?perf_rows}
\else
\set perf_rows 100000
\endif
\pset tuples_only on
\timing off

DROP TABLE IF EXISTS fresh_wasix_copy_out;
CREATE TABLE fresh_wasix_copy_out (
    id integer PRIMARY KEY,
    bucket integer NOT NULL,
    payload text NOT NULL
);
INSERT INTO fresh_wasix_copy_out
SELECT i, i % 1000, md5(i::text)
FROM generate_series(1, :perf_rows) AS i;

\o /dev/null
\timing on
COPY fresh_wasix_copy_out TO STDOUT WITH CSV;
\timing off
\o
