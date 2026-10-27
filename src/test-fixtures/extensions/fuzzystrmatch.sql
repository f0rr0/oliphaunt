-- oliphaunt-statement
DO $$ BEGIN IF levenshtein('kitten', 'sitting') IS DISTINCT FROM 3 THEN RAISE EXCEPTION 'levenshtein failed'; END IF; IF soundex('kitten') IS DISTINCT FROM 'K350' THEN RAISE EXCEPTION 'soundex failed'; END IF; END $$;
