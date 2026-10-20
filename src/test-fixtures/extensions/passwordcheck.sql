-- oliphaunt-verify
LOAD 'passwordcheck';

-- oliphaunt-statement
-- oliphaunt-verify
DO $oliphaunt$
BEGIN
  CREATE ROLE oliphaunt_passwordcheck_probe;
  BEGIN
    ALTER ROLE oliphaunt_passwordcheck_probe PASSWORD 'short';
    RAISE EXCEPTION 'passwordcheck accepted a short password';
  EXCEPTION WHEN invalid_parameter_value THEN
    IF SQLERRM <> 'password is too short' THEN
      RAISE;
    END IF;
  END;
  ALTER ROLE oliphaunt_passwordcheck_probe PASSWORD 'a_nice_long_password';
  DROP ROLE oliphaunt_passwordcheck_probe;
END
$oliphaunt$;
