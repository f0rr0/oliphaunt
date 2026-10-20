import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  installPartman,
  installPgmq,
  pgxsSources,
  prepareSimple,
} from './windows-extension-sources.mts';

test('PGMQ SQL packaging includes the current installation and upgrades, without unrelated files', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pgmq-windows-'));
  const source = path.join(root, 'target/oliphaunt-sources/checkouts/pgmq/pgmq-extension');
  const install = path.join(root, 'install');
  try {
    mkdirSync(path.join(source, 'sql'), { recursive: true });
    writeFileSync(path.join(source, 'pgmq.control'), "default_version = '1.13.0'\n");
    writeFileSync(path.join(source, 'sql/pgmq.sql'), '-- current SQL\n');
    writeFileSync(path.join(source, 'sql/pgmq--1.12.0--1.13.0.sql'), '-- upgrade SQL\n');
    writeFileSync(path.join(source, 'sql/unrelated.sql'), '-- foreign SQL\n');
    installPgmq({ repo: root, work: root, postgres: root, install });
    const destination = path.join(install, 'share/postgresql/extension');
    assert.deepEqual(readdirSync(destination).sort(), [
      'pgmq--1.12.0--1.13.0.sql',
      'pgmq--1.13.0.sql',
      'pgmq.control',
    ]);
    assert.equal(
      readFileSync(path.join(destination, 'pgmq--1.13.0.sql'), 'utf8'),
      '-- current SQL\n',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SQL-only pg_partman stages ordered install SQL and upgrades without workers or tools', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'partman-windows-'));
  try {
    const source = path.join(root, 'target/oliphaunt-sources/checkouts/pg_partman');
    for (const group of ['types', 'tables', 'functions', 'procedures']) {
      mkdirSync(path.join(source, 'sql', group), { recursive: true });
      writeFileSync(path.join(source, 'sql', group, 'b.sql'), `${group}-b\n`);
      writeFileSync(path.join(source, 'sql', group, 'a.sql'), `${group}-a\n`);
    }
    mkdirSync(path.join(source, 'updates'));
    writeFileSync(path.join(source, 'updates', 'pg_partman--5.4.0--5.5.0.sql'), 'upgrade\n');
    writeFileSync(path.join(source, 'updates', 'foreign.sql'), 'excluded\n');
    writeFileSync(path.join(source, 'pg_partman.control'), "default_version = '5.5.0'\n");
    const install = path.join(root, 'install');
    installPartman({ repo: root, work: root, postgres: root, install });
    const destination = path.join(install, 'share/postgresql/extension');
    assert.equal(
      readFileSync(path.join(destination, 'pg_partman--5.5.0.sql'), 'utf8'),
      ['types', 'tables', 'functions', 'procedures']
        .map((group) => `${group}-a\n${group}-b\n`)
        .join(''),
    );
    assert.deepEqual([...new Bun.Glob('**/*').scanSync({ cwd: install, onlyFiles: true })].sort(), [
      'share/postgresql/extension/pg_partman--5.4.0--5.5.0.sql',
      'share/postgresql/extension/pg_partman--5.5.0.sql',
      'share/postgresql/extension/pg_partman.control',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
