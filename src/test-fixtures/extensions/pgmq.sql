DO $proof$
BEGIN
  IF EXISTS (SELECT FROM pgmq.meta WHERE queue_name = 'oliphaunt_queue') THEN
    PERFORM pgmq.drop_queue('oliphaunt_queue');
  END IF;
END
$proof$;
-- oliphaunt-statement
SELECT pgmq.create('oliphaunt_queue');
-- oliphaunt-statement
SELECT pgmq.send('oliphaunt_queue', '{"payload":"persistent"}'::jsonb);
-- oliphaunt-statement
DO $proof$
DECLARE
  message record;
BEGIN
  SELECT * INTO STRICT message FROM pgmq.read('oliphaunt_queue', 30, 1);
  IF message.message <> '{"payload":"persistent"}'::jsonb OR message.read_ct <> 1 THEN
    RAISE EXCEPTION 'PGMQ read lost payload or delivery count';
  END IF;
  IF EXISTS (SELECT FROM pgmq.read('oliphaunt_queue', 30, 1)) THEN
    RAISE EXCEPTION 'PGMQ visibility timeout did not hide the leased message';
  END IF;
  IF NOT pgmq.archive('oliphaunt_queue', message.msg_id) THEN
    RAISE EXCEPTION 'PGMQ archive failed';
  END IF;
  IF (SELECT count(*) FROM pgmq.a_oliphaunt_queue) <> 1 THEN
    RAISE EXCEPTION 'PGMQ archive lost the message';
  END IF;
END
$proof$;
-- oliphaunt-statement
SELECT pgmq.send('oliphaunt_queue', '{"payload":"delete"}'::jsonb);
-- oliphaunt-statement
DO $proof$
DECLARE
  message record;
BEGIN
  SELECT * INTO STRICT message FROM pgmq.pop('oliphaunt_queue');
  IF message.message <> '{"payload":"delete"}'::jsonb THEN
    RAISE EXCEPTION 'PGMQ pop returned the wrong message';
  END IF;
  IF EXISTS (SELECT FROM pgmq.read('oliphaunt_queue', 30, 1)) THEN
    RAISE EXCEPTION 'PGMQ pop did not remove the message';
  END IF;
END
$proof$;
-- oliphaunt-statement
SELECT pgmq.create('oliphaunt_drop_queue');
-- oliphaunt-statement
SELECT pgmq.drop_queue('oliphaunt_drop_queue');
-- oliphaunt-statement
SELECT pgmq.send('oliphaunt_queue', '{"payload":"restart-and-restore"}'::jsonb);
-- oliphaunt-statement
-- oliphaunt-verify
DO $proof$
BEGIN
  IF (SELECT count(*) FROM pgmq.q_oliphaunt_queue) <> 1 OR
      NOT EXISTS (SELECT FROM pgmq.q_oliphaunt_queue
                  WHERE message = '{"payload":"restart-and-restore"}'::jsonb) THEN
    RAISE EXCEPTION 'PGMQ persistent queue message did not survive';
  END IF;
  IF (SELECT count(*) FROM pgmq.a_oliphaunt_queue) <> 1 OR
      NOT EXISTS (SELECT FROM pgmq.a_oliphaunt_queue
                  WHERE message = '{"payload":"persistent"}'::jsonb) THEN
    RAISE EXCEPTION 'PGMQ archived message did not survive';
  END IF;
END
$proof$;
