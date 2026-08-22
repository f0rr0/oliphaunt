CREATE TEMP TABLE oliphaunt_ltree (path ltree);
-- oliphaunt-statement
INSERT INTO oliphaunt_ltree VALUES ('Top.Science.Astronomy'), ('Top.Collections.Pictures');
-- oliphaunt-statement
DO $$ DECLARE n int; BEGIN SELECT count(*) INTO n FROM oliphaunt_ltree WHERE path <@ 'Top.Science'; IF n <> 1 THEN RAISE EXCEPTION 'ltree ancestor query failed: %', n; END IF; END $$;
