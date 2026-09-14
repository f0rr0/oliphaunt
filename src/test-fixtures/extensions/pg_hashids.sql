-- oliphaunt-statement
DO $$ BEGIN IF id_encode(1001) <> 'jNl' THEN RAISE EXCEPTION 'pg_hashids encode failed'; END IF; IF id_decode_once('jNl') <> 1001 THEN RAISE EXCEPTION 'pg_hashids decode failed'; END IF; END $$;
