-- oliphaunt-statement
DO $$ DECLARE lex text; BEGIN SELECT array_to_string(ts_lexize('intdict', '40865854'), ',') INTO lex; IF lex <> '408658' THEN RAISE EXCEPTION 'dict_int lexize failed: %', lex; END IF; END $$;
