DROP TABLE IF EXISTS bench_fixture;
CREATE TABLE bench_fixture(id integer PRIMARY KEY, value text);
INSERT INTO bench_fixture SELECT i, 'value-' || i::text FROM generate_series(1, 1000) AS i;
