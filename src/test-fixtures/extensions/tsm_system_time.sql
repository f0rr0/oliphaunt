CREATE TEMP TABLE oliphaunt_tsm_time AS SELECT i FROM generate_series(1, 20) AS i;
-- oliphaunt-statement
SELECT * FROM oliphaunt_tsm_time TABLESAMPLE SYSTEM_TIME(50);
