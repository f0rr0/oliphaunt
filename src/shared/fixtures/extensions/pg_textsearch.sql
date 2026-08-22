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
  (2, 'An unrelated document about walking');
-- oliphaunt-statement
CREATE INDEX oliphaunt_pg_textsearch_english_bm25
  ON oliphaunt_pg_textsearch_english
  USING bm25 (body)
  WITH (text_config = 'pg_catalog.english');
-- oliphaunt-statement
DO $oliphaunt$
DECLARE
  hit bigint;
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
END
$oliphaunt$;
