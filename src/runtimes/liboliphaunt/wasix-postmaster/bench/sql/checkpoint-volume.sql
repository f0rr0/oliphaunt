\set ON_ERROR_STOP on

BEGIN;

UPDATE oliphaunt_checkpoint_volume
   SET value = value + 1,
       payload = md5(id::text || ':' || (value + 1)::text) ||
                 repeat('w', 480);

INSERT INTO oliphaunt_checkpoint_volume (id, value, payload)
SELECT id, 1, md5(id::text || ':1') || repeat('n', 480)
FROM generate_series(200001, 300000) AS ids(id);

COMMIT;
CHECKPOINT;
