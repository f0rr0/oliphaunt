-- oliphaunt-statement
CREATE EXTENSION IF NOT EXISTS pg_textsearch;

-- oliphaunt-statement
SELECT extname FROM pg_extension WHERE extname = 'pg_textsearch';
