import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateAgeSql } from './prepare-source.mts';

test('AGE install SQL preserves dependency order and the target graphid ABI', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'age-sql-'));
  try {
    mkdirSync(path.join(root, 'sql'));
    writeFileSync(path.join(root, 'age.control'), "default_version = '1.8.0'\n");
    writeFileSync(path.join(root, 'sql/sql_files'), 'types\nfunctions\n');
    const types = 'CREATE TYPE graphid (\n  PASSEDBYVALUE,\n  INTERNALLENGTH = 8\n);\n';
    const functions = 'CREATE FUNCTION example(graphid) RETURNS graphid;\n';
    writeFileSync(path.join(root, 'sql/types.sql'), types);
    writeFileSync(path.join(root, 'sql/functions.sql'), functions);
    assert.equal(generateAgeSql(root), 'age--1.8.0.sql');
    const read = () => readFileSync(path.join(root, 'age--1.8.0.sql'), 'utf8');
    assert.equal(read(), types + functions);
    generateAgeSql(root, 4);
    assert(!/^ {2}PASSEDBYVALUE,$/m.test(read()));
    assert(read().endsWith(functions));
    generateAgeSql(root, 8);
    assert.equal(read(), types + functions);
    writeFileSync(path.join(root, 'sql/sql_files'), '../outside');
    assert.throws(() => generateAgeSql(root), /invalid AGE SQL input list/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
