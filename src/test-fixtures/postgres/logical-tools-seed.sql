CREATE EXTENSION IF NOT EXISTS pgtap;
CREATE SEQUENCE logical_items_seq START WITH 40;
CREATE TABLE logical_items (
  id integer PRIMARY KEY DEFAULT nextval('logical_items_seq'),
  value text NOT NULL,
  lookup text NOT NULL
);
CREATE INDEX logical_items_value_idx ON logical_items (value);
CREATE VIEW logical_item_values AS SELECT value FROM logical_items;
COPY logical_items (id, value, lookup) FROM stdin;
40	alpha	CaseFold
41	beta	second
42	gamma	third
\.
SELECT setval('logical_items_seq', 42, true);
CREATE TABLE "Quoted Table" ("Quoted Column" text NOT NULL);
INSERT INTO "Quoted Table" VALUES ('quoted-value');
