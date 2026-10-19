CREATE TEMP TABLE oliphaunt_tsm_rows AS SELECT i FROM generate_series(1, 20) AS i;
-- oliphaunt-statement
SELECT * FROM oliphaunt_tsm_rows TABLESAMPLE SYSTEM_ROWS(5);
