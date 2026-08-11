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
\timing off

DROP TABLE IF EXISTS fresh_wasix_indexed_point_loop;
CREATE TABLE fresh_wasix_indexed_point_loop (
    id integer PRIMARY KEY,
    bucket integer NOT NULL,
    payload text NOT NULL
);
INSERT INTO fresh_wasix_indexed_point_loop
SELECT i, i % 1000, md5(i::text)
FROM generate_series(1, :perf_rows) AS i;
ANALYZE fresh_wasix_indexed_point_loop;

CREATE OR REPLACE FUNCTION fresh_wasix_indexed_point_loop_run(loop_count integer, row_count integer)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
    i integer;
    key integer;
    total bigint := 0;
    value text;
BEGIN
    FOR i IN 1..loop_count LOOP
        key := (((i::bigint * 7919) % row_count) + 1)::integer;
        SELECT payload INTO value
        FROM fresh_wasix_indexed_point_loop
        WHERE id = key;
        total := total + length(value);
    END LOOP;
    RETURN total;
END;
$$;

\timing on
SELECT fresh_wasix_indexed_point_loop_run(:transaction_rows, :perf_rows);
\timing off
