CREATE TEMP TABLE oliphaunt_fsm (id int, value text);
-- oliphaunt-statement
INSERT INTO oliphaunt_fsm SELECT i, repeat('x', 200) FROM generate_series(1, 20) AS i;
-- oliphaunt-statement
DELETE FROM oliphaunt_fsm WHERE id % 2 = 0;
-- oliphaunt-statement
SELECT * FROM pg_freespace('oliphaunt_fsm') LIMIT 1;
