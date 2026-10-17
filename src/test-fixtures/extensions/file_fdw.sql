DROP FOREIGN TABLE IF EXISTS oliphaunt_file_version_probe;
-- oliphaunt-statement
DROP SERVER IF EXISTS oliphaunt_file_server;
-- oliphaunt-statement
CREATE SERVER oliphaunt_file_server FOREIGN DATA WRAPPER file_fdw;
-- oliphaunt-statement
DO $$
BEGIN
  EXECUTE format(
    'CREATE FOREIGN TABLE oliphaunt_file_version_probe(version integer) SERVER oliphaunt_file_server OPTIONS (filename %L, format %L)',
    current_setting('data_directory') || '/PG_VERSION', 'text'
  );
END
$$;
-- oliphaunt-statement
-- oliphaunt-verify
DO $$
DECLARE
  file_rows bigint;
  postgres_major integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_foreign_server WHERE srvname = 'oliphaunt_file_server') THEN
    RAISE EXCEPTION 'file_fdw server missing';
  END IF;
  EXECUTE format(
    'ALTER FOREIGN TABLE oliphaunt_file_version_probe OPTIONS (SET filename %L)',
    current_setting('data_directory') || '/PG_VERSION'
  );
  SELECT count(*), min(version) INTO file_rows, postgres_major FROM oliphaunt_file_version_probe;
  IF file_rows IS DISTINCT FROM 1::bigint OR postgres_major IS DISTINCT FROM 18 THEN
    RAISE EXCEPTION 'file_fdw did not read the expected database version: rows %, version %', file_rows, postgres_major;
  END IF;
END
$$;
