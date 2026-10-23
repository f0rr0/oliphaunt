-- oliphaunt-statement
DO $$ BEGIN IF id_encode(1001) IS DISTINCT FROM 'jNl' THEN RAISE EXCEPTION 'pg_hashids encode failed'; END IF; IF id_decode_once('jNl') IS DISTINCT FROM 1001 THEN RAISE EXCEPTION 'pg_hashids decode failed'; END IF; END $$;
