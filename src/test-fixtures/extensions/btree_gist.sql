CREATE TEMP TABLE oliphaunt_btree_gist (id int);
-- oliphaunt-statement
CREATE INDEX oliphaunt_btree_gist_idx ON oliphaunt_btree_gist USING gist (id);
-- oliphaunt-statement
INSERT INTO oliphaunt_btree_gist SELECT generate_series(1, 10);
-- oliphaunt-statement
DO $$ DECLARE n int; BEGIN SELECT count(*) INTO n FROM oliphaunt_btree_gist WHERE id = 5; IF n <> 1 THEN RAISE EXCEPTION 'btree_gist lookup failed: %', n; END IF; END $$;
