-- oliphaunt-statement
DO $$ DECLARE d float8; BEGIN SELECT cube(array[1,2,3]) <-> cube(array[1,2,4]) INTO d; IF d <> 1 THEN RAISE EXCEPTION 'cube distance failed: %', d; END IF; END $$;
