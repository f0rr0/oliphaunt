\set ON_ERROR_STOP on
\if :{?perf_rows}
\else
\set perf_rows 100000
\endif
\if :{?transaction_rows}
\else
\set transaction_rows :perf_rows
\endif
\pset tuples_only on
\timing on

SELECT sum(length(t.payload))
FROM generate_series(1, :transaction_rows) AS g(i)
JOIN LATERAL (
    SELECT payload
    FROM fresh_wasix_indexed_read_hot
    WHERE id = ((g.i * 7919) % :perf_rows) + 1
) AS t ON true;

SELECT sum(t.id)
FROM generate_series(1, (:transaction_rows / 10)) AS g(i)
JOIN LATERAL (
    SELECT id
    FROM fresh_wasix_indexed_read_hot
    WHERE bucket = ((g.i * 37) % 1000)
    LIMIT 1
) AS t ON true;

SELECT count(*)
FROM fresh_wasix_indexed_read_hot
WHERE payload >= 'a' AND payload < 'b';
\timing off
