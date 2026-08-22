-- oliphaunt-statement
DO $$ BEGIN IF '7(+-)1'::seg::text <> '6 .. 8' THEN RAISE EXCEPTION 'seg cast failed'; END IF; END $$;
