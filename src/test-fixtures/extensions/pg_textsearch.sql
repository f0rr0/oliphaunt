-- A nonempty English index must resolve PostgreSQL's Snowball runtime-support
-- module and stopword data. An empty index does not load the dictionary and
-- therefore cannot prove the packaged runtime closure.
DROP TABLE IF EXISTS oliphaunt_pg_textsearch_english;
-- oliphaunt-statement
CREATE TABLE oliphaunt_pg_textsearch_english (
  id bigint PRIMARY KEY,
  body text NOT NULL
);
-- oliphaunt-statement
INSERT INTO oliphaunt_pg_textsearch_english (id, body) VALUES
  (1, 'PostgreSQL databases support reliable runners'),
  (2, 'An unrelated document about walking'),
  (3, 'legacyalpha legacyalpha persisted posting'),
  (4, 'deletionproof deletionproof persisted posting'),
  (5, 'legacybeta legacybeta persisted posting'),
  (6, 'deletionproof surviving persisted posting');
-- oliphaunt-statement
CREATE INDEX oliphaunt_pg_textsearch_english_bm25
  ON oliphaunt_pg_textsearch_english
  USING bm25 (body)
  WITH (text_config = 'pg_catalog.english');
-- oliphaunt-statement
SELECT bm25_spill_index('oliphaunt_pg_textsearch_english_bm25');
-- oliphaunt-statement
UPDATE oliphaunt_pg_textsearch_english
SET body = 'mutationproof mutationproof updated persisted row'
WHERE id = 2;
-- oliphaunt-statement
DELETE FROM oliphaunt_pg_textsearch_english WHERE id = 4;
-- oliphaunt-statement
INSERT INTO oliphaunt_pg_textsearch_english VALUES
  (7, 'freshposting freshposting inserted after spill');
-- oliphaunt-statement
SELECT bm25_force_merge('oliphaunt_pg_textsearch_english_bm25');
-- oliphaunt-statement
-- oliphaunt-verify
DO $oliphaunt$
DECLARE
  hit bigint;
  probe record;
BEGIN
  SELECT id
  INTO hit
  FROM oliphaunt_pg_textsearch_english
  ORDER BY body <@> to_bm25query(
    'running database',
    'oliphaunt_pg_textsearch_english_bm25'
  )
  LIMIT 1;
  IF hit IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'pg_textsearch English BM25 smoke returned id %, expected 1', hit;
  END IF;
  IF (SELECT count(*) FROM oliphaunt_pg_textsearch_english) <> 6 THEN
    RAISE EXCEPTION 'pg_textsearch mutation changed the expected row count';
  END IF;
  FOR probe IN SELECT * FROM (VALUES
    ('mutationproof', 2), ('legacyalpha', 3), ('legacybeta', 5),
    ('deletionproof', 6), ('freshposting', 7)
  ) AS expected(term, id)
  LOOP
    SELECT id INTO hit
    FROM oliphaunt_pg_textsearch_english
    ORDER BY body <@> to_bm25query(probe.term, 'oliphaunt_pg_textsearch_english_bm25')
    LIMIT 1;
    IF hit IS DISTINCT FROM probe.id THEN
      RAISE EXCEPTION 'pg_textsearch query % returned id %, expected %', probe.term, hit, probe.id;
    END IF;
  END LOOP;
  -- This also runs after restart and restore, before recreating any index.
  INSERT INTO oliphaunt_pg_textsearch_english VALUES (8, 'reopenproof reopenproof fresh write');
  PERFORM bm25_force_merge('oliphaunt_pg_textsearch_english_bm25');
  SELECT id INTO hit
  FROM oliphaunt_pg_textsearch_english
  ORDER BY body <@> to_bm25query('reopenproof', 'oliphaunt_pg_textsearch_english_bm25')
  LIMIT 1;
  IF hit IS DISTINCT FROM 8 THEN
    RAISE EXCEPTION 'pg_textsearch fresh write returned id %, expected 8', hit;
  END IF;
  DELETE FROM oliphaunt_pg_textsearch_english WHERE id = 8;
END
$oliphaunt$;
