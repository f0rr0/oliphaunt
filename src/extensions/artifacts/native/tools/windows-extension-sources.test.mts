import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installPgmq, patchTextsearch } from './windows-extension-sources.mts';

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

test('Windows packing applies to each exact textsearch struct, including V3 predecessors', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'textsearch-windows-'));
  const structs = [
    ['segment/segment.h', 'TpDictEntryV3', 'aligned(4)', 4],
    ['segment/segment.h', 'TpDictEntry', 'aligned(8)', 8],
    ['segment/segment.h', 'TpSegmentPosting', 'packed', 1],
    ['segment/segment.h', 'TpSkipEntryV3', 'packed', 1],
    ['segment/segment.h', 'TpSkipEntry', 'packed', 1],
    ['segment/segment.h', 'TpCtidMapEntry', 'packed', 1],
    ['memtable/expull.h', 'TpExpullEntry', 'packed', 1],
  ] as const;
  try {
    for (const file of [
      'segment/segment.h',
      'memtable/expull.h',
      'am/am.h',
      'types/vector.h',
      'types/query.h',
    ]) {
      const target = path.join(root, 'src', file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(
        target,
        structs
          .filter(([header]) => header === file)
          .map(
            ([, name, attribute]) =>
              `typedef struct ${name}\n{ int value; } __attribute__((${attribute})) ${name};\n`,
          )
          .join('') || 'Datum example(PG_FUNCTION_ARGS);\n',
      );
    }
    patchTextsearch(root);
    for (const [file, name, , pack] of structs) {
      const text = readFileSync(path.join(root, 'src', file), 'utf8');
      assert(text.includes(`#pragma pack(push, ${pack})\n#endif\ntypedef struct ${name}\n`), name);
      assert(text.includes(`} ${name};\n#ifdef _MSC_VER\n#pragma pack(pop)\n`), name);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
