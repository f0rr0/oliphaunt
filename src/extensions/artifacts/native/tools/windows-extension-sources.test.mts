import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { patchTextsearch } from './windows-extension-sources.mts';

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
