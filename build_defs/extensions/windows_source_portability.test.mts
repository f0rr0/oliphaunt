import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { windowsExtensionHeaders, windowsExtensionSource } from './windows_source_portability.mts';

const epoch =
  '#define EPOCH_DIFF_USECS ((POSTGRES_EPOCH_JDATE - UNIX_EPOCH_JDATE) * USECS_PER_DAY)';

test('textsearch 1.5.1 retains upstream MSVC layouts and exports without source patches', () => {
  const sources = {
    'src/segment/segment.h':
      '#ifdef _MSC_VER\n#pragma pack(push, 1)\n#endif\ntypedef struct TpSegmentPosting\n{ ItemPointerData ctid; } TP_PACKED TpSegmentPosting;\n#ifdef _MSC_VER\n#pragma pack(pop)\n#endif\n',
    'src/memtable/expull.h':
      '#ifdef _MSC_VER\n#pragma pack(push, 1)\n#endif\ntypedef struct TpExpullEntry\n{ uint32 doc_id; uint16 frequency; uint8 fieldnorm; } TP_PACKED TpExpullEntry;\n#ifdef _MSC_VER\n#pragma pack(pop)\n#endif\n',
    'src/segment/format.h':
      'typedef struct TpDictEntryV3\n{ uint32 skip_index_offset; } pg_attribute_aligned(4) TpDictEntryV3;\n',
    'src/layout_check.c': 'StaticAssertDecl(sizeof(TpExpullEntry) == 7, "TpExpullEntry size");\n',
    'src/types/vector.h': 'PGDLLEXPORT Datum tpvector_in(PG_FUNCTION_ARGS);\n',
    'src/types/query.h': 'PGDLLEXPORT Datum tpquery_in(PG_FUNCTION_ARGS);\n',
  };
  for (const [file, text] of Object.entries(sources)) {
    const before = `/* upstream π 😀 */\r\n${text.replaceAll('\n', '\r\n')}`;
    assert.equal(windowsExtensionSource('pg_textsearch', file, before), before);
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

test('textsearch only declares the PostgreSQL unistd companion', () => {
  assert.deepEqual(windowsExtensionHeaders('pg_textsearch'), {
    'src/unistd.h': '/* Provided by PostgreSQL on Windows. */\n',
  });
  assert.deepEqual(windowsExtensionHeaders('pg_uuidv7'), {});
  assert.deepEqual(windowsExtensionHeaders('vector'), {});
  const modified = windowsExtensionHeaders('pg_textsearch');
  modified['src/unistd.h'] = 'changed';
  assert.notEqual(windowsExtensionHeaders('pg_textsearch')['src/unistd.h'], 'changed');
});

test('PostGIS external C inline definitions retain bodies, static linkage and non-code bytes', () => {
  const unchanged = [
    '/* inline int one(void) { return 1; } */',
    '/* comment\ninline int two(void) { return 2; }\n*/',
    '// comment \\\r\ninline int three(void) { return 3; }',
    'const char *text = "inline int four(void) { return 4; }";',
    'const char *continued = "line \\\r\ninline text";',
    "int quote = '\\'';",
    'static inline int local(void) { return 5; }',
    'inline static int reverse(void) { return 6; }',
    'inline\t  static int spaced(void) { return 7; }',
  ].join('\r\n');
  const before = `${unchanged}\r\ninline bool external(const BOX2DF *a)\r\n{ return a->xmin != 0; }\r\nextern inline\tvoid other(BOX2DF *a) { a->xmin = 1; }\r\n`;
  const after = `${unchanged}\r\nbool external(const BOX2DF *a)\r\n{ return a->xmin != 0; }\r\nextern void other(BOX2DF *a) { a->xmin = 1; }\r\n`;
  for (const directory of ['postgis', 'libpgcommon', 'liblwgeom']) {
    assert.equal(windowsExtensionSource('postgis', `${directory}/unit.c`, before), after);
    assert.equal(windowsExtensionSource('postgis', `${directory}/unit.h`, before), before);
  }
  assert.equal(windowsExtensionSource('postgis', 'deps/unit.c', before), before);
  assert.equal(windowsExtensionSource('vector', 'postgis/unit.c', before), before);
});

test('PostGIS preserves the existing DLL export and POINT4D source adaptations', () => {
  const declaration =
    '/* π */\r\n  Datum one(PG_FUNCTION_ARGS);\r\nextern PGDLLEXPORT Datum done(PG_FUNCTION_ARGS);\r\nextern Datum unrelated(void);\r\n';
  for (const directory of ['postgis', 'libpgcommon', 'liblwgeom']) {
    assert.equal(
      windowsExtensionSource('postgis', `${directory}/unit.h`, declaration),
      '/* π */\r\nextern PGDLLEXPORT Datum one(PG_FUNCTION_ARGS);\nextern PGDLLEXPORT Datum done(PG_FUNCTION_ARGS);\r\nextern Datum unrelated(void);\r\n',
    );
  }
  const legacy = '\tDatum funcname(PG_FUNCTION_ARGS); \\\r\n';
  assert.equal(
    windowsExtensionSource('postgis', 'postgis/postgis_legacy.c', legacy),
    '\textern PGDLLEXPORT Datum funcname(PG_FUNCTION_ARGS); \\\n',
  );
  const geometry = 'pt = (POINT4D) { x, y, z, m };\npt = (POINT4D) { xv, yv, zv, mv };\n';
  assert.equal(
    windowsExtensionSource('postgis', 'deps/flatgeobuf/geometryreader.cpp', geometry),
    'pt.x = x;\npt.y = y;\npt.z = z;\npt.m = m;\npt.x = xv;\npt.y = yv;\npt.z = zv;\npt.m = mv;\n',
  );
  assert.equal(windowsExtensionSource('postgis', 'deps/unrelated.h', declaration), declaration);
  for (const invalid of ['', geometry + geometry])
    assert.throws(
      () => windowsExtensionSource('postgis', 'deps/flatgeobuf/geometryreader.cpp', invalid),
      /anchor/u,
    );
  for (const invalid of ['', legacy + legacy])
    assert.throws(
      () => windowsExtensionSource('postgis', 'postgis/postgis_legacy.c', invalid),
      /anchor/u,
    );
  assert.deepEqual(windowsExtensionHeaders('postgis'), {});
});
