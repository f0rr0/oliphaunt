\set ON_ERROR_STOP on
\timing on
\if :{?perf_rows}
\else
\set perf_rows 100000
\endif

DROP TABLE IF EXISTS fresh_wasix_perf;
CREATE TABLE fresh_wasix_perf (
    id integer PRIMARY KEY,
    payload text NOT NULL
);

INSERT INTO fresh_wasix_perf
SELECT i, md5(i::text)
FROM generate_series(1, :perf_rows) AS i;

SELECT count(*) FROM fresh_wasix_perf;
SELECT payload FROM fresh_wasix_perf WHERE id = (:perf_rows * 3 / 4);
CREATE INDEX fresh_wasix_perf_payload_idx ON fresh_wasix_perf (payload);
SELECT count(*) FROM fresh_wasix_perf WHERE payload >= 'a' AND payload < 'b';

COPY fresh_wasix_perf TO STDOUT WITH CSV;
