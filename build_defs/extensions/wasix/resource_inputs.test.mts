import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertDeclaredWasixResource } from '../wasix_carriers.mts';

test('empty delivered upgrade SQL stays valid while missing, nonregular and unsafe inputs fail', () => {
  const root = mkdtempSync(path.join(process.env.TEST_TMPDIR ?? os.tmpdir(), 'wasix-resource-'));
  try {
    const source = path.join(root, 'pg_ivm--1.12--1.13.sql');
    writeFileSync(source, '');
    assertDeclaredWasixResource({
      source,
      destination: 'share/postgresql/extension/pg_ivm--1.12--1.13.sql',
    });
    for (const destination of [
      'lib/postgresql/pg_ivm.so',
      'share/postgresql/extension/pg_ivm.control',
      'share/postgresql/tsearch_data/dict.rules',
      'share/postgresql/contrib/data.sql',
    ])
      assert.throws(
        () => assertDeclaredWasixResource({ source, destination }),
        /must be nonempty/u,
      );
    assert.throws(
      () =>
        assertDeclaredWasixResource({
          source: path.join(root, 'missing.sql'),
          destination: 'share/postgresql/extension/missing.sql',
        }),
      /ENOENT/u,
    );
    const directory = path.join(root, 'directory.sql');
    mkdirSync(directory);
    assert.throws(
      () =>
        assertDeclaredWasixResource({
          source: directory,
          destination: 'share/postgresql/extension/directory.sql',
        }),
      /regular file/u,
    );
    for (const destination of [
      'share/postgresql/extension/../escape.sql',
      '/share/postgresql/extension/absolute.sql',
      'share/postgresql//empty.sql',
    ])
      assert.throws(
        () => assertDeclaredWasixResource({ source, destination }),
        /unsafe member destination/u,
      );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
