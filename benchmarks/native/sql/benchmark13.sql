CREATE TABLE IF NOT EXISTS bench_fixture_copy AS SELECT * FROM bench_fixture WHERE false;
INSERT INTO bench_fixture_copy SELECT * FROM bench_fixture;
