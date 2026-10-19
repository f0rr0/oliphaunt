-- oliphaunt-statement
DO $$ DECLARE id uuid; ts timestamptz; BEGIN SELECT uuid_generate_v7() INTO id; IF length(id::text) <> 36 THEN RAISE EXCEPTION 'uuidv7 length failed'; END IF; SELECT uuid_v7_to_timestamptz('018570bb-4a7d-7c7e-8df4-6d47afd8c8fc') INTO ts; IF ts IS NULL THEN RAISE EXCEPTION 'uuidv7 timestamp failed'; END IF; END $$;
