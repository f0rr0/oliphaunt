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
DO $$ DECLARE n int; BEGIN SELECT count(*) INTO n FROM oliphaunt_ivm_summary; IF n <> 2 THEN RAISE EXCEPTION 'pg_ivm initial count failed: %', n; END IF; END $$;
