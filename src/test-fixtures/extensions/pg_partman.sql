SELECT set_config('search_path', quote_ident(n.nspname) || ', public', false)
FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
WHERE e.extname = 'pg_partman';
-- oliphaunt-statement
CREATE TABLE public.oliphaunt_partman_events (id bigint NOT NULL, payload text)
PARTITION BY RANGE (id);
-- oliphaunt-statement
SELECT create_parent('public.oliphaunt_partman_events', 'id', '10',
  p_premake := 2, p_start_partition := '0', p_jobmon := false);
-- oliphaunt-statement
INSERT INTO public.oliphaunt_partman_events VALUES (1, 'old'), (25, 'retained');
-- oliphaunt-statement
SELECT run_maintenance('public.oliphaunt_partman_events', p_jobmon := false);
-- oliphaunt-statement
DO $$
BEGIN
  IF to_regclass('public.oliphaunt_partman_events_p40') IS NULL THEN
    RAISE EXCEPTION 'pg_partman did not premake partitions beyond the highest ID';
  END IF;
END $$;
-- oliphaunt-statement
UPDATE part_config SET retention = '10', retention_keep_table = false
WHERE parent_table = 'public.oliphaunt_partman_events';
-- oliphaunt-statement
SELECT run_maintenance('public.oliphaunt_partman_events', p_jobmon := false);
-- oliphaunt-statement
-- oliphaunt-verify
SELECT set_config('search_path', quote_ident(n.nspname) || ', public', false)
FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
WHERE e.extname = 'pg_partman';
-- oliphaunt-statement
DO $$
BEGIN
  IF to_regclass('public.oliphaunt_partman_events_p0') IS NOT NULL THEN
    RAISE EXCEPTION 'pg_partman did not remove the expired ID partition';
  END IF;
  IF (SELECT count(*) FROM public.oliphaunt_partman_events) <> 1
     OR NOT EXISTS (SELECT FROM public.oliphaunt_partman_events WHERE id = 25 AND payload = 'retained') THEN
    RAISE EXCEPTION 'pg_partman retention removed or changed the retained row';
  END IF;
  IF NOT EXISTS (SELECT FROM part_config WHERE parent_table = 'public.oliphaunt_partman_events') THEN
    RAISE EXCEPTION 'pg_partman configuration did not survive';
  END IF;
END $$;
