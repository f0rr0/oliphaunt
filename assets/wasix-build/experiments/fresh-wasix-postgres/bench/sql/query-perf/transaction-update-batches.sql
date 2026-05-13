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

DROP TABLE IF EXISTS fresh_wasix_tx_update;
CREATE TABLE fresh_wasix_tx_update (
    id integer PRIMARY KEY,
    bucket integer NOT NULL,
    payload text NOT NULL
);
INSERT INTO fresh_wasix_tx_update
SELECT i, i % 1000, md5(i::text)
FROM generate_series(1, :perf_rows) AS i;
CREATE INDEX fresh_wasix_tx_update_bucket_idx
    ON fresh_wasix_tx_update (bucket);
ANALYZE fresh_wasix_tx_update;

\timing on
BEGIN;
UPDATE fresh_wasix_tx_update
SET bucket = bucket + 10
WHERE id BETWEEN 1 AND (:transaction_rows / 4);
UPDATE fresh_wasix_tx_update
SET bucket = bucket + 10
WHERE id BETWEEN (:transaction_rows / 4 + 1) AND (:transaction_rows / 2);
UPDATE fresh_wasix_tx_update
SET bucket = bucket + 10
WHERE id BETWEEN (:transaction_rows / 2 + 1) AND (:transaction_rows * 3 / 4);
UPDATE fresh_wasix_tx_update
SET bucket = bucket + 10
WHERE id BETWEEN (:transaction_rows * 3 / 4 + 1) AND :transaction_rows;
COMMIT;
\timing off

SELECT count(*) FROM fresh_wasix_tx_update
WHERE id <= :transaction_rows AND bucket >= 10;
