DO $$
DECLARE top_id integer;
BEGIN
  SELECT id INTO top_id
  FROM upgrade_docs
  ORDER BY body <@> to_bm25query('postgres database', 'upgrade_docs_bm25')
  LIMIT 1;
  IF top_id IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'pre-upgrade query with the current library returned unexpected top id %', top_id;
  END IF;
END $$;
ALTER EXTENSION pg_textsearch UPDATE;
INSERT INTO upgrade_docs VALUES
  (1000, 'upgrade sentinel upgrade sentinel upgrade sentinel migration proof');
UPDATE upgrade_docs
SET body = 'mutationproof mutationproof updated persisted row'
WHERE id = 2;
DELETE FROM upgrade_docs WHERE id = 4;
SELECT bm25_force_merge('upgrade_docs_bm25');
