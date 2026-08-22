CREATE TEMP TABLE oliphaunt_btree_gin (id int);
-- oliphaunt-statement
CREATE INDEX oliphaunt_btree_gin_idx ON oliphaunt_btree_gin USING gin (id);
-- oliphaunt-statement
INSERT INTO oliphaunt_btree_gin SELECT generate_series(1, 10);
-- oliphaunt-statement
DO $$ DECLARE n int; BEGIN SELECT count(*) INTO n FROM oliphaunt_btree_gin WHERE id = 5; IF n <> 1 THEN RAISE EXCEPTION 'btree_gin lookup failed: %', n; END IF; END $$;
