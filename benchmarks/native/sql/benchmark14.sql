TRUNCATE bench_fixture_copy;
INSERT INTO bench_fixture_copy SELECT * FROM bench_fixture WHERE id % 3 = 0;
