-- oliphaunt-statement
DO $$ DECLARE d float8; BEGIN SELECT earth_distance(ll_to_earth(0, 0), ll_to_earth(0, 1)) INTO d; IF d <= 0 THEN RAISE EXCEPTION 'earthdistance failed: %', d; END IF; END $$;
