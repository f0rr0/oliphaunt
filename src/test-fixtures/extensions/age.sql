LOAD 'age';
-- oliphaunt-statement
SET search_path = ag_catalog, public;
-- oliphaunt-statement
DO $oliphaunt$
BEGIN
  IF EXISTS (SELECT FROM ag_catalog.ag_graph WHERE name = 'oliphaunt_age') THEN
    PERFORM ag_catalog.drop_graph('oliphaunt_age', true);
  END IF;
END
$oliphaunt$;
-- oliphaunt-statement
SELECT ag_catalog.create_graph('oliphaunt_age');
-- oliphaunt-statement
SELECT * FROM ag_catalog.cypher('oliphaunt_age', $$
  CREATE (:Person {name: 'Alice'})-[:KNOWS]->(:Person {name: 'Bob'})
$$) AS (v ag_catalog.agtype);
-- oliphaunt-statement
-- Populate the traversal cache, then invalidate it in a rolled-back transaction.
SELECT * FROM ag_catalog.cypher('oliphaunt_age', $$
  MATCH (a)-[:KNOWS*1..2]->(b) RETURN a.name, b.name
$$) AS (a ag_catalog.agtype, b ag_catalog.agtype);
-- oliphaunt-statement
BEGIN;
SELECT * FROM ag_catalog.cypher('oliphaunt_age', $$
  MATCH ()-[r:KNOWS]->() DELETE r
$$) AS (v ag_catalog.agtype);
SELECT * FROM ag_catalog.cypher('oliphaunt_age', $$
  MATCH (a)-[:KNOWS*1..2]->(b) RETURN a.name, b.name
$$) AS (a ag_catalog.agtype, b ag_catalog.agtype);
ROLLBACK;
-- oliphaunt-statement
-- oliphaunt-verify
DO $oliphaunt$
DECLARE
  names text[];
BEGIN
  -- LOAD and search_path are session state: repeat them after restart/restore.
  LOAD 'age';
  SET LOCAL search_path = ag_catalog, public;
  SELECT array_agg(a::text || '->' || b::text ORDER BY a::text, b::text)
  INTO names
  FROM ag_catalog.cypher('oliphaunt_age', $$
    MATCH (a)-[:KNOWS*1..2]->(b) RETURN a.name, b.name
  $$) AS (a ag_catalog.agtype, b ag_catalog.agtype);
  IF names IS DISTINCT FROM ARRAY['Alice->Bob'] THEN
    RAISE EXCEPTION 'AGE variable-length traversal failed: %', names;
  END IF;
END
$oliphaunt$;
