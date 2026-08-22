-- oliphaunt-statement
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'heap_force_kill') THEN RAISE EXCEPTION 'pg_surgery function missing'; END IF; END $$;
