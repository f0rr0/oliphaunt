CREATE TEMP TABLE oliphaunt_intarray (tags int[]);
-- oliphaunt-statement
INSERT INTO oliphaunt_intarray VALUES (ARRAY[1, 2, 5]), (ARRAY[3, 4]);
-- oliphaunt-statement
DO $$ DECLARE n int; BEGIN SELECT count(*) INTO n FROM oliphaunt_intarray WHERE tags && ARRAY[2, 9]; IF n <> 1 THEN RAISE EXCEPTION 'intarray overlap failed: %', n; END IF; SELECT count(*) INTO n FROM oliphaunt_intarray WHERE tags @@ '1 & (2|3)'::query_int; IF n <> 1 THEN RAISE EXCEPTION 'intarray query_int failed: %', n; END IF; END $$;
