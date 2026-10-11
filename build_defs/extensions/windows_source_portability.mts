/** Exact source adaptations shared with the existing native MSVC producer. */
import assert from 'node:assert/strict';

const textsearchStructs = [
  ['src/segment/segment.h', 'TpDictEntryV3', 'aligned(4)', 4, 12, 4],
  ['src/segment/segment.h', 'TpDictEntry', 'aligned(8)', 8, 16, 8],
  ['src/segment/segment.h', 'TpSegmentPosting', 'packed', 1, 14, 1],
  ['src/segment/segment.h', 'TpSkipEntryV3', 'packed', 1, 16, 1],
  ['src/segment/segment.h', 'TpSkipEntry', 'packed', 1, 20, 1],
  ['src/segment/segment.h', 'TpCtidMapEntry', 'packed', 1, 6, 1],
  ['src/memtable/expull.h', 'TpExpullEntry', 'packed', 1, 7, 1],
] as const;
const textsearchExports = ['src/am/am.h', 'src/types/vector.h', 'src/types/query.h'];
const uuidEpoch =
  '#define EPOCH_DIFF_USECS ((POSTGRES_EPOCH_JDATE - UNIX_EPOCH_JDATE) * USECS_PER_DAY)';
const uuidClock = `${uuidEpoch}\n#ifdef _WIN32\n#ifndef CLOCK_REALTIME\n#define CLOCK_REALTIME 0\n#endif\nstatic int oliphaunt_pg_uuidv7_clock_gettime(int clock_id, struct timespec *ts) {\n  TimestampTz unix_usecs;\n  if (clock_id != CLOCK_REALTIME || ts == NULL) return -1;\n  unix_usecs = GetCurrentTimestamp() + EPOCH_DIFF_USECS;\n  ts->tv_sec = (time_t) (unix_usecs / USECS_PER_SEC);\n  ts->tv_nsec = (long) ((unix_usecs % USECS_PER_SEC) * 1000);\n  return 0;\n}\n#define clock_gettime oliphaunt_pg_uuidv7_clock_gettime\n#endif`;

function replaceOne(text: string, before: string | RegExp, after: string, file: string) {
  const count =
    typeof before === 'string'
      ? text.split(before).length - 1
      : [...text.matchAll(new RegExp(before.source, before.flags.replaceAll('g', '') + 'g'))]
          .length;
  assert.equal(count, 1, `expected one Windows source patch anchor in ${file}, found ${count}`);
  return text.replace(before, after);
}

/** Generated companions are declared separately from unchanged source inputs. */
export function windowsExtensionHeaders(extension: string): Record<string, string> {
  if (extension !== 'pg_textsearch') return {};
  return {
    'src/oliphaunt_windows_compat.h':
      '#ifdef _MSC_VER\n#ifndef __attribute__\n#define __attribute__(x)\n#endif\n#endif\n',
    'src/unistd.h':
      '#ifndef OLIPHAUNT_WINDOWS_UNISTD_H\n#define OLIPHAUNT_WINDOWS_UNISTD_H\n#endif\n',
  };
}

/** Transform only the reviewed named files; retain every other source byte. */
export function windowsExtensionSource(extension: string, file: string, text: string): string {
  if (extension === 'pg_uuidv7' && file === 'pg_uuidv7.c') {
    assert(!text.includes('oliphaunt_pg_uuidv7_clock_gettime'), `${file} is already adapted`);
    return replaceOne(text, uuidEpoch, uuidClock, file);
  }
  if (extension !== 'pg_textsearch') return text;
  for (const [header, name, attribute, pack, size, alignment] of textsearchStructs) {
    if (file !== header) continue;
    text = replaceOne(
      text,
      new RegExp(`typedef struct ${name}\\b`),
      `#ifdef _MSC_VER\n#pragma pack(push, ${pack})\n#endif\ntypedef struct ${name}`,
      file,
    );
    text = replaceOne(
      text,
      `} __attribute__((${attribute})) ${name};`,
      `} ${name};\n#ifdef _MSC_VER\n#pragma pack(pop)\nStaticAssertDecl(sizeof(${name}) == ${size}, "${name} size");\nStaticAssertDecl(__alignof(${name}) == ${alignment}, "${name} alignment");\n#endif`,
      file,
    );
  }
  if (textsearchExports.includes(file)) {
    const declarations = [...text.matchAll(/^Datum (\w+)\(PG_FUNCTION_ARGS\);/gm)];
    assert(declarations.length, `missing Windows source patch anchor in ${file}`);
    assert.equal(
      new Set(declarations.map((match) => match[1])).size,
      declarations.length,
      `ambiguous Windows function declarations in ${file}`,
    );
    text = text.replace(
      /^Datum (\w+)\(PG_FUNCTION_ARGS\);/gm,
      'extern PGDLLEXPORT Datum $1(PG_FUNCTION_ARGS);',
    );
  }
  return text;
}
