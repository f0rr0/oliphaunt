CREATE TEMP TABLE oliphaunt_hstore (attrs hstore);
-- oliphaunt-statement
INSERT INTO oliphaunt_hstore VALUES ('a=>1,b=>2'::hstore);
-- oliphaunt-statement
DO $$ DECLARE v text; BEGIN SELECT attrs -> 'b' INTO v FROM oliphaunt_hstore; IF v <> '2' THEN RAISE EXCEPTION 'hstore lookup failed: %', v; END IF; END $$;
