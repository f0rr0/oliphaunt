DELETE FROM bench_fixture WHERE id > 1500;
INSERT INTO bench_fixture SELECT i, 'refill-' || i::text FROM generate_series(2001, 2500) AS i;
