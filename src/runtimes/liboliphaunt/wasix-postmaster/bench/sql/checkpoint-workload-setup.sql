\set ON_ERROR_STOP on

BEGIN;

CREATE TABLE oliphaunt_checkpoint_accounts (
  client_id integer NOT NULL,
  slot integer NOT NULL,
  balance bigint NOT NULL DEFAULT 0,
  payload text NOT NULL,
  PRIMARY KEY (client_id, slot)
) WITH (fillfactor = 80);

INSERT INTO oliphaunt_checkpoint_accounts (client_id, slot, payload)
SELECT client_id, slot,
       md5(client_id::text || ':' || slot::text) || repeat('a', 480)
FROM generate_series(1, :connections::integer) AS clients(client_id)
CROSS JOIN generate_series(0, 65535) AS slots(slot);

CREATE TABLE oliphaunt_checkpoint_append (
  client_id integer NOT NULL,
  sequence bigint NOT NULL,
  ordinal integer NOT NULL,
  payload text NOT NULL,
  PRIMARY KEY (client_id, sequence, ordinal)
);

CREATE TABLE oliphaunt_checkpoint_volume (
  id integer PRIMARY KEY,
  value bigint NOT NULL,
  payload text NOT NULL
) WITH (fillfactor = 80);

INSERT INTO oliphaunt_checkpoint_volume (id, value, payload)
SELECT id, 0, md5(id::text) || repeat('v', 480)
FROM generate_series(1, 200000) AS ids(id);

CREATE FUNCTION oliphaunt_checkpoint_transaction(
  p_client_id integer,
  p_sequence bigint
) RETURNS TABLE (
  update_count bigint,
  insert_count bigint,
  read_count bigint,
  insert_lsn pg_lsn
) LANGUAGE sql VOLATILE AS $function$
  WITH updated AS (
    UPDATE oliphaunt_checkpoint_accounts AS accounts
       SET balance = accounts.balance + 1,
           payload = md5(
             p_client_id::text || ':' || p_sequence::text || ':' ||
             accounts.slot::text
           ) || repeat('u', 480)
      FROM generate_series(1, 48) AS offsets(slot_offset)
     WHERE accounts.client_id = p_client_id
       AND accounts.slot =
           mod(p_sequence * 48 + offsets.slot_offset, 65536)::integer
    RETURNING 1
  ), appended AS (
    INSERT INTO oliphaunt_checkpoint_append (
      client_id, sequence, ordinal, payload
    )
    SELECT p_client_id, p_sequence, ordinal,
           md5(
             p_client_id::text || ':' || p_sequence::text || ':' ||
             ordinal::text
           ) || repeat('i', 480)
    FROM generate_series(1, 16) AS ordinals(ordinal)
    RETURNING 1
  ), observed AS (
    SELECT 1
    FROM oliphaunt_checkpoint_accounts
    WHERE client_id = p_client_id
    ORDER BY slot
    LIMIT 8
  )
  SELECT (SELECT count(*) FROM updated),
         (SELECT count(*) FROM appended),
         (SELECT count(*) FROM observed),
         pg_current_wal_insert_lsn()
$function$;

COMMIT;
CHECKPOINT;
