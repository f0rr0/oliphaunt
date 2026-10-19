import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pgxsSources, prepareSimple } from './windows-extension-sources.mts';

test('Windows textsearch compiles upstream layout checks and installs the upgrade chain', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'textsearch-windows-'));
  const postgres = path.join(root, 'postgres');
  const checkout = path.join(root, 'target/oliphaunt-sources/checkouts/pg_textsearch');
  const files = {
    Makefile: 'OBJS = src/mod.o src/layout_check.o\n',
    'pg_textsearch.control': "default_version = '1.5.1'\n",
    'sql/pg_textsearch--1.5.1.sql': 'SELECT 1;\n',
    'sql/pg_textsearch--0.6.1--1.0.0.sql': 'SELECT 2;\n',
    'sql/pg_textsearch--1.5.0--1.5.1.sql': 'SELECT 3;\n',
    'src/mod.c': '#include <unistd.h>\n',
    'src/layout_check.c': 'StaticAssertDecl(sizeof(TpExpullEntry) == 7, "layout");\n',
  };
  try {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(checkout, file)), { recursive: true });
      writeFileSync(path.join(checkout, file), text);
    }
    mkdirSync(path.join(postgres, 'contrib'), { recursive: true });
    writeFileSync(path.join(postgres, 'contrib/meson.build'), '');
    prepareSimple({ repo: root, work: root, postgres, install: root }, 'pg_textsearch');
    const output = path.join(postgres, 'contrib/oliphaunt_external/pg_textsearch');
    for (const [file, text] of Object.entries(files)) {
      assert.equal(readFileSync(path.join(output, file), 'utf8'), text);
    }
    const meson = readFileSync(path.join(output, 'meson.build'), 'utf8');
    for (const file of Object.keys(files).filter((file) => file !== 'Makefile'))
      assert(meson.includes(`'${file}'`), `${file} must be built or installed`);
    assert(meson.includes('/DPG_TEXTSEARCH_VERSION="1.5.1"'));
    assert(!meson.includes('/FI'));
    assert(readFileSync(path.join(output, 'src/unistd.h'), 'utf8').includes('PostgreSQL'));
    writeFileSync(path.join(checkout, 'Makefile'), 'OBJS = $(shell echo untracked.o)\n');
    assert.throws(() => pgxsSources(checkout), /unsupported PGXS object expression/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
