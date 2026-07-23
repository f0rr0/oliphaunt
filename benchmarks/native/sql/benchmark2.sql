INSERT INTO bench_fixture SELECT i, 'extra-' || i::text FROM generate_series(1001, 2000) AS i;
