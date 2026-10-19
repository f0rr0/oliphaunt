CREATE TEMP TABLE oliphaunt_lo (id int, data oid);
-- oliphaunt-statement
CREATE TRIGGER oliphaunt_lo_manage BEFORE UPDATE OR DELETE ON oliphaunt_lo FOR EACH ROW EXECUTE FUNCTION lo_manage(data);
-- oliphaunt-statement
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'oliphaunt_lo_manage') THEN RAISE EXCEPTION 'lo trigger missing'; END IF; END $$;
