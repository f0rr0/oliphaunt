-- oliphaunt-statement
DO $$ DECLARE lex text; BEGIN SELECT array_to_string(ts_lexize('unaccent', 'Hôtel'), ',') INTO lex; IF lex <> 'Hotel' THEN RAISE EXCEPTION 'unaccent failed: %', lex; END IF; END $$;
