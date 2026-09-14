CREATE TEMP TABLE oliphaunt_bloom (id int, value int);
-- oliphaunt-statement
CREATE INDEX oliphaunt_bloom_idx ON oliphaunt_bloom USING bloom (id, value);
-- oliphaunt-statement
INSERT INTO oliphaunt_bloom SELECT i, i % 3 FROM generate_series(1, 20) AS i;
-- oliphaunt-statement
DO $$ DECLARE n int; BEGIN SELECT count(*) INTO n FROM oliphaunt_bloom WHERE id = 7 AND value = 1; IF n <> 1 THEN RAISE EXCEPTION 'bloom lookup failed: %', n; END IF; END $$;
