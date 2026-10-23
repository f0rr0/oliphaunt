CREATE EXTENSION pg_textsearch VERSION :'old_version';
CREATE TABLE upgrade_docs(id integer PRIMARY KEY, body text NOT NULL);
INSERT INTO upgrade_docs
SELECT id,
       CASE
         WHEN id = 1 THEN 'postgres database postgres database query migration'
         WHEN id = 3 THEN 'legacyalpha legacyalpha persisted posting'
         WHEN id = 4 THEN 'deletionproof deletionproof persisted posting'
         WHEN id = 5 THEN 'legacybeta legacybeta persisted posting'
         WHEN id = 6 THEN 'deletionproof surviving persisted posting'
         WHEN id % 2 = 0 THEN 'postgres database guide'
         ELSE 'unrelated document about wildlife'
       END
FROM generate_series(1, 256) AS id;
CREATE INDEX upgrade_docs_bm25 ON upgrade_docs USING bm25(body)
  WITH (text_config = 'english');
SELECT bm25_spill_index('upgrade_docs_bm25');
DO $$
DECLARE top_id integer;
BEGIN
  SELECT id INTO top_id
  FROM upgrade_docs
  ORDER BY body <@> to_bm25query('postgres database', 'upgrade_docs_bm25')
  LIMIT 1;
  IF top_id IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'old pg_textsearch query returned unexpected top id %', top_id;
  END IF;
END $$;
