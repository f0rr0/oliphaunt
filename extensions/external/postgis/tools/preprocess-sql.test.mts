import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { preprocessSql } from './preprocess-sql.mts';

test('Windows PostGIS SQL preserves comments, expands included versions, and selects supported SQL', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'postgis-sql-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'input.sql');
  writeFileSync(
    join(root, 'defines.h'),
    "#ifndef GUARD\n#define GUARD\n#define PG 180\n#define VERSION '3.6.3'\n#endif\n",
  );
  writeFileSync(
    source,
    '#include "defines.h"\n#include "defines.h"\n/*\n#define IGNORED 1\n*/\n#if PG >= 180\nSELECT VERSION;\n#elif PG < 180\nwrong\n#else\nwrong\n#endif\n#ifdef IGNORED\nwrong\n#endif\n#undef PG\n#ifndef PG\nSELECT 1;\n#endif\n',
  );
  assert.equal(preprocessSql(source), "/*\n#define IGNORED 1\n*/\nSELECT '3.6.3';\nSELECT 1;\n");
  for (const [text, diagnostic] of [
    ['#include "input.sql"\n', /recursive SQL include/],
    ['#include "absent"\n', /could not resolve/],
    ['#if 1\n', /unterminated/],
    ['#else\n', /orphan/],
    ['#if function()\n', /unsupported SQL condition/],
  ] as const) {
    writeFileSync(source, text);
    assert.throws(() => preprocessSql(source), diagnostic);
  }
});
