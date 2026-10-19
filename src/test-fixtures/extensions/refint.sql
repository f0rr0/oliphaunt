DROP TABLE IF EXISTS oliphaunt_refint_child;
-- oliphaunt-statement
DROP TABLE IF EXISTS oliphaunt_refint_parent;
-- oliphaunt-statement
CREATE TABLE oliphaunt_refint_parent (id integer PRIMARY KEY);
-- oliphaunt-statement
CREATE TABLE oliphaunt_refint_child (parent_id integer);
-- oliphaunt-statement
CREATE TRIGGER oliphaunt_refint_parent_trigger AFTER DELETE OR UPDATE ON oliphaunt_refint_parent
FOR EACH ROW EXECUTE FUNCTION check_foreign_key(1, 'cascade', 'id', 'oliphaunt_refint_child', 'parent_id');
-- oliphaunt-statement
CREATE TRIGGER oliphaunt_refint_child_trigger AFTER INSERT OR UPDATE ON oliphaunt_refint_child
FOR EACH ROW EXECUTE FUNCTION check_primary_key('parent_id', 'oliphaunt_refint_parent', 'id');
-- oliphaunt-statement
INSERT INTO oliphaunt_refint_parent VALUES (1), (2);
-- oliphaunt-statement
INSERT INTO oliphaunt_refint_child VALUES (1), (2);
-- oliphaunt-statement
DO $oliphaunt$
BEGIN
  BEGIN
    INSERT INTO oliphaunt_refint_child VALUES (3);
    RAISE EXCEPTION 'refint accepted a missing parent';
  EXCEPTION WHEN triggered_action_exception THEN
    NULL;
  END;
END
$oliphaunt$;
-- oliphaunt-statement
DELETE FROM oliphaunt_refint_parent WHERE id = 1;
-- oliphaunt-statement
-- oliphaunt-verify
DO $oliphaunt$
BEGIN
  IF (SELECT array_agg(parent_id) FROM oliphaunt_refint_child) IS DISTINCT FROM ARRAY[2] THEN
    RAISE EXCEPTION 'refint did not cascade deletion to the referencing row';
  END IF;
END
$oliphaunt$;
