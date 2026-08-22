CREATE TEMP TABLE oliphaunt_visibility (id int);
-- oliphaunt-statement
INSERT INTO oliphaunt_visibility SELECT generate_series(1, 5);
-- oliphaunt-statement
SELECT * FROM pg_visibility('oliphaunt_visibility') LIMIT 1;
-- oliphaunt-statement
SELECT * FROM pg_visibility_map('oliphaunt_visibility') LIMIT 1;
