import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { windowsExtensionHeaders, windowsExtensionSource } from './windows_source_portability.mts';

const structs = [
  ['TpDictEntryV3', 'aligned(4)', 4, 12, 4],
  ['TpDictEntry', 'aligned(8)', 8, 16, 8],
  ['TpSegmentPosting', 'packed', 1, 14, 1],
  ['TpSkipEntryV3', 'packed', 1, 16, 1],
  ['TpSkipEntry', 'packed', 1, 20, 1],
  ['TpCtidMapEntry', 'packed', 1, 6, 1],
  ['TpExpullEntry', 'packed', 1, 7, 1],
] as const;
const header = (name: string) =>
  name === 'TpExpullEntry' ? 'src/memtable/expull.h' : 'src/segment/segment.h';
const source = (file: string) =>
  structs
    .filter(([name]) => header(name) === file)
    .map(
      ([name, attribute]) =>
        `typedef struct ${name}\n{ int value; } __attribute__((${attribute})) ${name};\n`,
    )
    .join('');
const epoch =
  '#define EPOCH_DIFF_USECS ((POSTGRES_EPOCH_JDATE - UNIX_EPOCH_JDATE) * USECS_PER_DAY)';

test('every persisted textsearch layout retains its individual packing and size/alignment guards', () => {
  for (const file of ['src/segment/segment.h', 'src/memtable/expull.h']) {
    const before = `/* unrelated π 😀 */\r\n${source(file)}typedef struct Unchanged { int value; } Unchanged;\r\n`;
    const after = windowsExtensionSource('pg_textsearch', file, before);
    for (const [name, , pack, size, alignment] of structs.filter(
      ([name]) => header(name) === file,
    )) {
      assert(
        after.includes(
          `#ifdef _MSC_VER\n#pragma pack(push, ${pack})\n#endif\ntypedef struct ${name}\n`,
        ),
      );
      assert(
        after.includes(
          `} ${name};\n#ifdef _MSC_VER\n#pragma pack(pop)\nStaticAssertDecl(sizeof(${name}) == ${size}, "${name} size");\nStaticAssertDecl(__alignof(${name}) == ${alignment}, "${name} alignment");\n#endif`,
        ),
      );
    }
    assert.equal(
      [...after.matchAll(/#pragma pack\(push,/gu)].length,
      file.includes('segment') ? 6 : 1,
    );
    assert.equal(
      [...after.matchAll(/#pragma pack\(pop\)/gu)].length,
      file.includes('segment') ? 6 : 1,
    );
    assert(after.startsWith('/* unrelated π 😀 */\r\n'));
    assert(after.endsWith('typedef struct Unchanged { int value; } Unchanged;\r\n'));
  }
});

test('textsearch export annotations preserve distinct prototypes and surrounding CRLF bytes', () => {
  for (const file of ['src/am/am.h', 'src/types/vector.h', 'src/types/query.h']) {
    const before =
      '/* λ */\r\nDatum one(PG_FUNCTION_ARGS);\r\nDatum two(PG_FUNCTION_ARGS);\r\nextern Datum untouched(void);\r\n';
    assert.equal(
      windowsExtensionSource('pg_textsearch', file, before),
      '/* λ */\r\nextern PGDLLEXPORT Datum one(PG_FUNCTION_ARGS);\r\nextern PGDLLEXPORT Datum two(PG_FUNCTION_ARGS);\r\nextern Datum untouched(void);\r\n',
    );
  }
});

test('the UUID clock adaptation retains the previous PostgreSQL epoch conversion and error handling bytes', () => {
  const before = `/* π */\r\n${epoch}\r\nint unchanged;\r\n`;
  const clock = [
    epoch,
    '#ifdef _WIN32',
    '#ifndef CLOCK_REALTIME',
    '#define CLOCK_REALTIME 0',
    '#endif',
    'static int oliphaunt_pg_uuidv7_clock_gettime(int clock_id, struct timespec *ts) {',
    '  TimestampTz unix_usecs;',
    '  if (clock_id != CLOCK_REALTIME || ts == NULL) return -1;',
    '  unix_usecs = GetCurrentTimestamp() + EPOCH_DIFF_USECS;',
    '  ts->tv_sec = (time_t) (unix_usecs / USECS_PER_SEC);',
    '  ts->tv_nsec = (long) ((unix_usecs % USECS_PER_SEC) * 1000);',
    '  return 0;',
    '}',
    '#define clock_gettime oliphaunt_pg_uuidv7_clock_gettime',
    '#endif',
  ].join('\n');
  assert.equal(
    windowsExtensionSource('pg_uuidv7', 'pg_uuidv7.c', before),
    `/* π */\r\n${clock}\r\nint unchanged;\r\n`,
  );
  for (const invalid of [
    '',
    `${epoch}\n${epoch}`,
    windowsExtensionSource('pg_uuidv7', 'pg_uuidv7.c', before),
  ])
    assert.throws(
      () => windowsExtensionSource('pg_uuidv7', 'pg_uuidv7.c', invalid),
      /anchor|already adapted/u,
    );
});

test('absent or ambiguous textsearch anchors fail instead of silently applying a partial port', () => {
  const file = 'src/segment/segment.h';
  for (const before of [
    '',
    source(file).replace('typedef struct TpDictEntryV3', 'typedef struct Renamed'),
    source(file).replace(
      'typedef struct TpDictEntryV3',
      'typedef struct TpDictEntryV3;\ntypedef struct TpDictEntryV3',
    ),
    source(file).replace('} __attribute__((aligned(4))) TpDictEntryV3;', '} TpDictEntryV3;'),
    source(file) + '} __attribute__((aligned(4))) TpDictEntryV3;',
  ])
    assert.throws(() => windowsExtensionSource('pg_textsearch', file, before), /anchor/u);
  for (const before of [
    '',
    'Datum repeated(PG_FUNCTION_ARGS);\nDatum repeated(PG_FUNCTION_ARGS);\n',
  ])
    assert.throws(
      () => windowsExtensionSource('pg_textsearch', 'src/am/am.h', before),
      /anchor|ambiguous/u,
    );
  const adapted = windowsExtensionSource('pg_textsearch', file, source(file));
  assert.throws(() => windowsExtensionSource('pg_textsearch', file, adapted), /anchor/u);
});

test('other named inputs retain Unicode, CRLF and source text without filename guessing', () => {
  const text = `/* π 😀 */\r\n${epoch}\r\nDatum untouched(PG_FUNCTION_ARGS);\r\n`;
  for (const [extension, file] of [
    ['pg_uuidv7', 'src/pg_uuidv7.c'],
    ['pg_uuidv7', 'pg_uuidv7.h'],
    ['pg_textsearch', 'src/segment/segment.c'],
    ['pg_textsearch', 'src/types/query_extra.h'],
    ['vector', 'pg_uuidv7.c'],
  ])
    assert.equal(windowsExtensionSource(extension, file, text), text);
});

test('only textsearch declares the exact legacy compatibility companions', () => {
  assert.deepEqual(windowsExtensionHeaders('pg_textsearch'), {
    'src/oliphaunt_windows_compat.h':
      '#ifdef _MSC_VER\n#ifndef __attribute__\n#define __attribute__(x)\n#endif\n#endif\n',
    'src/unistd.h':
      '#ifndef OLIPHAUNT_WINDOWS_UNISTD_H\n#define OLIPHAUNT_WINDOWS_UNISTD_H\n#endif\n',
  });
  assert.deepEqual(windowsExtensionHeaders('pg_uuidv7'), {});
  assert.deepEqual(windowsExtensionHeaders('vector'), {});
  const modified = windowsExtensionHeaders('pg_textsearch');
  modified['src/unistd.h'] = 'changed';
  assert.notEqual(windowsExtensionHeaders('pg_textsearch')['src/unistd.h'], 'changed');
});
