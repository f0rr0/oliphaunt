DROP SERVER IF EXISTS oliphaunt_file_server;
-- oliphaunt-statement
CREATE SERVER oliphaunt_file_server FOREIGN DATA WRAPPER file_fdw;
-- oliphaunt-statement
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_foreign_data_wrapper WHERE fdwname = 'file_fdw') THEN RAISE EXCEPTION 'file_fdw wrapper missing'; END IF; END $$;
