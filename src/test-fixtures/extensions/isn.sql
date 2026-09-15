-- oliphaunt-statement
DO $$ BEGIN IF isbn('978-0-393-04002-9')::text <> '0-393-04002-X' THEN RAISE EXCEPTION 'isbn failed'; END IF; IF isbn13('0901690546')::text <> '978-0-901690-54-8' THEN RAISE EXCEPTION 'isbn13 failed'; END IF; IF issn('1436-4522')::text <> '1436-4522' THEN RAISE EXCEPTION 'issn failed'; END IF; END $$;
