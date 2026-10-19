DROP TABLE IF EXISTS oliphaunt_autoinc;
-- oliphaunt-statement
DROP SEQUENCE IF EXISTS oliphaunt_autoinc_sequence;
-- oliphaunt-statement
CREATE SEQUENCE oliphaunt_autoinc_sequence START 11;
-- oliphaunt-statement
CREATE TABLE oliphaunt_autoinc (id integer, value text);
-- oliphaunt-statement
CREATE TRIGGER oliphaunt_autoinc_trigger BEFORE INSERT ON oliphaunt_autoinc
FOR EACH ROW EXECUTE FUNCTION autoinc('id', 'oliphaunt_autoinc_sequence');
-- oliphaunt-statement
INSERT INTO oliphaunt_autoinc VALUES (NULL, 'generated'), (50, 'preserved');
-- oliphaunt-statement
-- oliphaunt-verify
DO $oliphaunt$
BEGIN
  IF (SELECT array_agg(id ORDER BY id) FROM oliphaunt_autoinc) IS DISTINCT FROM ARRAY[11, 50] THEN
    RAISE EXCEPTION 'autoinc did not generate a missing id and preserve an explicit id';
  END IF;
END
$oliphaunt$;
