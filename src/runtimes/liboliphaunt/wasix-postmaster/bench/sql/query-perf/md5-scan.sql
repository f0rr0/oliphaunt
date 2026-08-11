\set ON_ERROR_STOP on
\if :{?perf_rows}
\else
\set perf_rows 100000
\endif
\pset tuples_only on
\timing off

\timing on
SELECT count(md5(i::text))
FROM generate_series(1, :perf_rows) AS i;
\timing off
