CREATE TEMP TABLE oliphaunt_citext (value citext);
-- oliphaunt-statement
INSERT INTO oliphaunt_citext VALUES ('Postgres');
-- oliphaunt-statement
DO $$ DECLARE n int; BEGIN SELECT count(*) INTO n FROM oliphaunt_citext WHERE value = 'postgres'; IF n <> 1 THEN RAISE EXCEPTION 'citext comparison failed: %', n; END IF; END $$;
