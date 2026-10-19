DO $$
DECLARE
  actual_body text;
  actual_count bigint;
  top_id integer;
  probe record;
BEGIN
  SELECT count(*) INTO actual_count FROM upgrade_docs;
  IF actual_count IS DISTINCT FROM 256 THEN
    RAISE EXCEPTION 'upgraded table contains % rows, expected 256', actual_count;
  END IF;

  SELECT body INTO actual_body FROM upgrade_docs WHERE id = 2;
  IF actual_body IS DISTINCT FROM 'mutationproof mutationproof updated persisted row' THEN
    RAISE EXCEPTION 'updated row 2 has unexpected body %', actual_body;
  END IF;
  IF EXISTS (SELECT 1 FROM upgrade_docs WHERE id = 4) THEN
    RAISE EXCEPTION 'deleted row 4 is still visible';
  END IF;

  FOR probe IN SELECT * FROM (VALUES
    ('postgres database', 1), ('legacyalpha', 3), ('legacybeta', 5),
    ('mutationproof', 2), ('upgrade sentinel', 1000), ('deletionproof', 6)
  ) AS expected(term, id)
  LOOP
    SELECT id INTO top_id
    FROM upgrade_docs
    ORDER BY body <@> to_bm25query(probe.term, 'upgrade_docs_bm25')
    LIMIT 1;
    IF top_id IS DISTINCT FROM probe.id THEN
      RAISE EXCEPTION 'upgraded query % returned id %, expected %', probe.term, top_id, probe.id;
    END IF;
  END LOOP;
END $$;
