CREATE INDEX IF NOT EXISTS bench_fixture_value_idx ON bench_fixture(value);
SELECT count(*) FROM bench_fixture WHERE value LIKE 'value-9%';
