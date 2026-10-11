/** Independent SQL-content checks for the bounded pgTAP generator. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyPatch, expand, runPerl, uninstallRecipe } from './pgtap_sql.mts';

test('compatibility patch context must match once', () => {
  const patch = '--- sql/pgtap.sql\n+++ sql/pgtap.sql\n@@ -2,2 +2,1 @@\n keep\n-remove\n';
  assert.equal(applyPatch('begin\nkeep\nremove\nend\n', patch), 'begin\nkeep\nend\n');
  assert.throws(() => applyPatch('keep\nremove\nkeep\nremove\n', patch), /missing or ambiguous/);
  assert.throws(() => applyPatch('begin\nchanged\nremove\n', patch), /missing or ambiguous/);
  assert.equal(applyPatch('begin\nkeep\nremove\nend', patch), 'begin\nkeep\nend');
});

test('compatibility patches cannot change other files or use malformed hunks', () => {
  assert.throws(() => applyPatch('x\n', '--- other.sql\n+++ other.sql\n'), /only/);
  assert.throws(
    () => applyPatch('x\n', '--- sql/pgtap.sql\n+++ sql/pgtap.sql\n@@ -1,2 +1,1 @@\n-x\n+y\n'),
    /counts/,
  );
});

test('target OS and SQL version are explicit', () => {
  assert.equal(expand('__OS__ __VERSION__ MODULE_PATHNAME', 'linux', '1.3.5'), 'linux 1.3 pgtap');
  assert.equal(expand('MODULE_PATHNAME', 'linux', '1.3.5', '$libdir/pgtap'), '$libdir/pgtap');
  assert.equal(expand('MODULE_PATHNAME', 'linux', '1.3.5', '$& $$'), '$& $$');
  assert.throws(() => expand('__OS__', '../linux', '1.3.5'), /OS/);
  assert.throws(() => expand('__OS__', 'linux\n', '1.3.5'), /OS/);
  assert.throws(() => expand('__VERSION__', 'linux', 'latest'), /version/);
  assert.throws(() => expand('__VERSION__', 'linux', '1.3.5\n'), /version/);
});

test('changed upstream installation semantics fail closed', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'oliphaunt-pgtap-makefile-'));
  try {
    const makefile = path.join(directory, 'Makefile');
    writeFileSync(makefile, 'sql/pgtap.sql: changed-generation\n');
    assert.throws(() => uninstallRecipe(makefile), /upstream-byte parity qualification/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('generator output rejects invalid UTF8 and preserves a UTF8 BOM', () => {
  // The declared Bun executable supplies controlled stdout bytes; this test
  // needs no additional Perl installation or upstream source inputs.
  assert.throws(() =>
    runPerl(process.execPath, [], ['-e', 'process.stdout.write(Buffer.from([0xff]))'], ''),
  );
  assert.equal(
    runPerl(
      process.execPath,
      [],
      ['-e', 'process.stdout.write(Buffer.from([0xef, 0xbb, 0xbf, 0x61]))'],
      '',
    ),
    '\ufeffa',
  );
});
