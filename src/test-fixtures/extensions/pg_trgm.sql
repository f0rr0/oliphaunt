-- oliphaunt-statement
DO $$ DECLARE score float8; BEGIN SELECT similarity('postgres', 'postgrex') INTO score; IF score <= 0 THEN RAISE EXCEPTION 'pg_trgm similarity failed: %', score; END IF; END $$;
