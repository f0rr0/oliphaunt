SELECT value, count(*) FROM bench_fixture GROUP BY value ORDER BY count(*) DESC, value LIMIT 50;
