\set ON_ERROR_STOP on

SELECT 1 AS one;

DROP TABLE IF EXISTS fresh_wasix_smoke;
CREATE TABLE fresh_wasix_smoke (
    id integer PRIMARY KEY,
    payload text NOT NULL
);

INSERT INTO fresh_wasix_smoke VALUES
    (1, 'alpha'),
    (2, 'beta'),
    (3, 'gamma');

SELECT count(*) AS inserted_rows FROM fresh_wasix_smoke;
UPDATE fresh_wasix_smoke SET payload = payload || '-updated' WHERE id = 2;
DELETE FROM fresh_wasix_smoke WHERE id = 3;

BEGIN;
INSERT INTO fresh_wasix_smoke VALUES (4, 'rolled-back');
ROLLBACK;

SELECT count(*) AS durable_rows FROM fresh_wasix_smoke;

PREPARE fresh_wasix_lookup(integer) AS
    SELECT payload FROM fresh_wasix_smoke WHERE id = $1;
EXECUTE fresh_wasix_lookup(2);

COPY fresh_wasix_smoke TO STDOUT WITH CSV;
