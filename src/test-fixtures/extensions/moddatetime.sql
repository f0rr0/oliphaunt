DROP TABLE IF EXISTS oliphaunt_moddatetime;
-- oliphaunt-statement
CREATE TABLE oliphaunt_moddatetime (id integer, modified_at timestamptz);
-- oliphaunt-statement
CREATE TRIGGER oliphaunt_moddatetime_trigger BEFORE UPDATE ON oliphaunt_moddatetime
FOR EACH ROW EXECUTE FUNCTION moddatetime('modified_at');
-- oliphaunt-statement
INSERT INTO oliphaunt_moddatetime VALUES (1, '2000-01-01 00:00:00+00');
-- oliphaunt-statement
UPDATE oliphaunt_moddatetime SET id = 2;
-- oliphaunt-statement
-- oliphaunt-verify
DO $oliphaunt$
BEGIN
  IF NOT EXISTS (SELECT FROM oliphaunt_moddatetime WHERE id = 2 AND modified_at > '2000-01-01 00:00:00+00') THEN
    RAISE EXCEPTION 'moddatetime did not update the modification timestamp';
  END IF;
END
$oliphaunt$;
