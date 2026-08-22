CREATE TEMP TABLE oliphaunt_amcheck (id int PRIMARY KEY, value text);
-- oliphaunt-statement
INSERT INTO oliphaunt_amcheck SELECT i, 'v' || i::text FROM generate_series(1, 8) AS i;
-- oliphaunt-statement
SELECT bt_index_check('oliphaunt_amcheck_pkey'::regclass);
