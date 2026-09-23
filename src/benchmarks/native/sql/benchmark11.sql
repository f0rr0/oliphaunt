SELECT avg(id), percentile_cont(0.9) WITHIN GROUP (ORDER BY id) FROM bench_fixture;
