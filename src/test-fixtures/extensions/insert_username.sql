DROP TABLE IF EXISTS oliphaunt_insert_username;
-- oliphaunt-statement
CREATE TABLE oliphaunt_insert_username (id integer, username text, expected_username text);
-- oliphaunt-statement
CREATE TRIGGER oliphaunt_insert_username_trigger BEFORE INSERT OR UPDATE ON oliphaunt_insert_username
FOR EACH ROW EXECUTE FUNCTION insert_username('username');
-- oliphaunt-statement
INSERT INTO oliphaunt_insert_username VALUES (1, 'untrusted', current_user);
-- oliphaunt-statement
UPDATE oliphaunt_insert_username SET username = 'still untrusted';
-- oliphaunt-statement
-- oliphaunt-verify
DO $oliphaunt$
BEGIN
  IF NOT EXISTS (SELECT FROM oliphaunt_insert_username WHERE username = expected_username) THEN
    RAISE EXCEPTION 'insert_username did not replace the caller-supplied username';
  END IF;
END
$oliphaunt$;
