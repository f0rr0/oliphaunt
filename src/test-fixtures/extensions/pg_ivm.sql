DROP TABLE IF EXISTS oliphaunt_ivm_restored;
-- oliphaunt-statement
DROP TABLE IF EXISTS oliphaunt_ivm_summary;
-- oliphaunt-statement
DROP TABLE IF EXISTS oliphaunt_ivm_orders;
-- oliphaunt-statement
CREATE TABLE oliphaunt_ivm_orders (id int, amount int);
-- oliphaunt-statement
INSERT INTO oliphaunt_ivm_orders VALUES (1, 10), (2, 20);
-- oliphaunt-statement
SELECT pgivm.create_immv('oliphaunt_ivm_summary', $$ SELECT id, amount FROM oliphaunt_ivm_orders $$);
-- oliphaunt-statement
-- Recreate metadata for an existing populated relation, as after pg_dump.
CREATE TABLE oliphaunt_ivm_restored AS SELECT id, amount FROM oliphaunt_ivm_orders;
-- oliphaunt-statement
SELECT pgivm.restore_immv('oliphaunt_ivm_restored', $$ SELECT id, amount FROM oliphaunt_ivm_orders $$);
-- oliphaunt-statement
-- oliphaunt-verify
DO $$
DECLARE n int; populated boolean;
BEGIN
  SELECT count(*) INTO n FROM oliphaunt_ivm_summary;
  IF n <> 2 THEN RAISE EXCEPTION 'pg_ivm count failed: %', n; END IF;
  UPDATE oliphaunt_ivm_orders SET amount = 11 WHERE id = 1;
  SELECT amount INTO n FROM oliphaunt_ivm_summary WHERE id = 1;
  IF n IS DISTINCT FROM 11 THEN RAISE EXCEPTION 'pg_ivm maintenance failed: %', n; END IF;
  UPDATE oliphaunt_ivm_orders SET amount = 10 WHERE id = 1;
  SELECT ispopulated INTO populated FROM pgivm.pg_ivm_immv
    WHERE immvrelid = 'oliphaunt_ivm_restored'::regclass;
  IF populated IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'pg_ivm restored relation lost populated state';
  END IF;
  -- Before 1.17 this refresh added duplicate maintenance triggers after restore.
  PERFORM pgivm.refresh_immv('oliphaunt_ivm_restored');
  INSERT INTO oliphaunt_ivm_orders VALUES (99, 30);
  SELECT count(*) INTO n FROM oliphaunt_ivm_restored WHERE id = 99;
  IF n <> 1 THEN RAISE EXCEPTION 'pg_ivm restored maintenance duplicated rows: %', n; END IF;
  DELETE FROM oliphaunt_ivm_orders WHERE id = 99;
END $$;
