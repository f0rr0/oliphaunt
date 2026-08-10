-- oliphaunt-statement
CREATE EXTENSION IF NOT EXISTS pgmq;

-- oliphaunt-statement
SELECT pgmq.create('oliphaunt_smoke');

-- oliphaunt-statement
SELECT pgmq.send('oliphaunt_smoke', '{"source":"oliphaunt","target":"pgmq"}'::jsonb);

-- oliphaunt-statement
DO $oliphaunt$
DECLARE
  received pgmq.message_record;
BEGIN
  SELECT *
  INTO received
  FROM pgmq.read('oliphaunt_smoke', 30, 1);

  IF received.message IS DISTINCT FROM '{"source":"oliphaunt","target":"pgmq"}'::jsonb THEN
    RAISE EXCEPTION 'PGMQ smoke received %, expected the queued Oliphaunt payload', received.message;
  END IF;

  IF NOT pgmq.archive('oliphaunt_smoke', received.msg_id) THEN
    RAISE EXCEPTION 'PGMQ smoke could not archive message %', received.msg_id;
  END IF;
END
$oliphaunt$;

-- oliphaunt-statement
SELECT pgmq.drop_queue('oliphaunt_smoke');
