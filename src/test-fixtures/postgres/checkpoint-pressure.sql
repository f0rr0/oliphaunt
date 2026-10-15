-- Run with max_wal_size=64MB and min_wal_size=32MB. Each batch writes
-- approximately 16MB of uncompressed TOAST data in one transaction.
DO $$
DECLARE
    initial_checkpoint pg_lsn;
BEGIN
    CREATE TABLE IF NOT EXISTS checkpoint_pressure(payload text);
    ALTER TABLE checkpoint_pressure ALTER COLUMN payload SET STORAGE EXTERNAL;
    SELECT checkpoint_lsn INTO initial_checkpoint FROM pg_control_checkpoint();
    FOR batch IN 1..5 LOOP
        INSERT INTO checkpoint_pressure
        SELECT repeat(md5(value::text), 2048) FROM generate_series(1, 256) AS value;
        IF (SELECT checkpoint_lsn FROM pg_control_checkpoint()) <> initial_checkpoint THEN
            RAISE EXCEPTION 'WAL pressure checkpoint ran inside the transaction';
        END IF;
    END LOOP;
END
$$;
