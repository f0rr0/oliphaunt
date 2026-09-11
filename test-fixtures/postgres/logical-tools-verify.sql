SELECT
  (SELECT count(*) FROM logical_items) AS rows,
  (SELECT sum(id) FROM logical_items) AS sum,
  (SELECT last_value FROM logical_items_seq) AS sequence_last_value,
  (SELECT "Quoted Column" FROM "Quoted Table") AS quoted_value,
  (SELECT count(*) FROM logical_items WHERE lower(lookup) = 'casefold') AS normalized_matches,
  (pgtap_version() IS NOT NULL) AS extension_loaded;
