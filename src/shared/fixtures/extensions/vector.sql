DROP TABLE IF EXISTS oliphaunt_vector;
-- oliphaunt-statement
CREATE TABLE oliphaunt_vector (id int PRIMARY KEY, embedding vector(3));
-- oliphaunt-statement
INSERT INTO oliphaunt_vector VALUES (1, '[1,2,3]');
-- oliphaunt-statement
DO $$ DECLARE d float8; BEGIN SELECT embedding <-> '[1,2,4]'::vector INTO d FROM oliphaunt_vector WHERE id = 1; IF d <> 1 THEN RAISE EXCEPTION 'vector distance failed: %', d; END IF; END $$;
