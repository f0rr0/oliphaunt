ALTER TEXT SEARCH DICTIONARY xsyn (RULES = 'xsyn_sample', KEEPORIG = true, MATCHORIG = true, KEEPSYNONYMS = true, MATCHSYNONYMS = false);
-- oliphaunt-statement
DO $$ DECLARE lex text; BEGIN SELECT array_to_string(ts_lexize('xsyn', 'supernova'), ',') INTO lex; IF lex IS NULL OR lex !~ 'sn' THEN RAISE EXCEPTION 'dict_xsyn lexize failed: %', lex; END IF; END $$;
