DROP TABLE IF EXISTS oliphaunt_vector;
-- oliphaunt-statement
CREATE TABLE oliphaunt_vector (id int PRIMARY KEY, embedding vector(3));
-- oliphaunt-statement
INSERT INTO oliphaunt_vector VALUES (1, '[1,2,3]');
-- oliphaunt-statement
DROP TABLE IF EXISTS oliphaunt_vector_indexed;
-- oliphaunt-statement
CREATE TABLE oliphaunt_vector_indexed (id int PRIMARY KEY, embedding vector(3));
-- oliphaunt-statement
INSERT INTO oliphaunt_vector_indexed SELECT i, ARRAY[i, i, i]::vector FROM generate_series(1, 64) i;
-- oliphaunt-statement
CREATE INDEX ON oliphaunt_vector_indexed USING hnsw (embedding vector_l2_ops);
-- oliphaunt-statement
DELETE FROM oliphaunt_vector_indexed WHERE id = 32;
-- oliphaunt-statement
VACUUM oliphaunt_vector_indexed;
-- oliphaunt-statement
INSERT INTO oliphaunt_vector_indexed VALUES (32, '[32,32,32]');
-- oliphaunt-statement
-- oliphaunt-verify
DO $$ DECLARE d float8; BEGIN SELECT embedding <-> '[1,2,4]'::vector INTO d FROM oliphaunt_vector WHERE id = 1; IF d IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'vector distance failed: %', d; END IF; END $$;

-- oliphaunt-statement
DO $$
DECLARE nearest int;
BEGIN
  PERFORM set_config('enable_seqscan', 'off', true);
  SELECT id INTO nearest FROM oliphaunt_vector_indexed ORDER BY embedding <-> '[32,32,32]'::vector LIMIT 1;
  IF nearest IS DISTINCT FROM 32 THEN
    RAISE EXCEPTION 'vector HNSW search after vacuum/insert failed: %', nearest;
  END IF;
END $$;
