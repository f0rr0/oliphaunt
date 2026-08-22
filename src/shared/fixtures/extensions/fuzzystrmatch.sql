-- oliphaunt-statement
DO $$ BEGIN IF levenshtein('kitten', 'sitting') <> 3 THEN RAISE EXCEPTION 'levenshtein failed'; END IF; IF soundex('kitten') <> 'K350' THEN RAISE EXCEPTION 'soundex failed'; END IF; END $$;
