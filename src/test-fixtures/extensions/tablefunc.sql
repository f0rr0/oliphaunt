DO $$ DECLARE n int; BEGIN SELECT count(*) INTO n FROM normal_rand(10, 5, 3); IF n <> 10 THEN RAISE EXCEPTION 'normal_rand failed: %', n; END IF; END $$;
-- oliphaunt-statement
SELECT * FROM crosstab('SELECT 1, 1, 10 UNION ALL SELECT 1, 2, 20') AS ct(rowid int, c1 int, c2 int);
