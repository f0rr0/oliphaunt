/** Exact source adaptations shared with the existing native MSVC producer. */
import assert from 'node:assert/strict';

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
    'src/unistd.h': '/* Provided by PostgreSQL on Windows. */\n',
  };
}

/** Transform only the reviewed named files; retain every other source byte. */
export function windowsExtensionSource(extension: string, file: string, text: string): string {
  if (extension === 'postgis') {
    if (/^(?:postgis|libpgcommon|liblwgeom)\/.*\.[ch]$/u.test(file)) {
      if (file.endsWith('.c')) {
        // These cross-unit definitions need an out-of-line body under MSVC.
        text = text.replace(
          /\/\*[\s\S]*?\*\/|\/\/(?:\\\r?\n|[^\r\n])*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|^([ \t]*(?:extern[ \t]+)?)inline[ \t]+(?![ \t]*static\b)/gm,
          (match, prefix: string | undefined) => (prefix === undefined ? match : prefix),
        );
      }
      text = text.replace(
        /^[ \t]*(?!(?:extern\s+)?PGDLLEXPORT\s+)(?:extern\s+)?Datum\s+(\w+)\s*\(PG_FUNCTION_ARGS\);\r?$/gm,
        'extern PGDLLEXPORT Datum $1(PG_FUNCTION_ARGS);',
      );
    }
    if (file === 'postgis/postgis_legacy.c') {
      text = replaceOne(
        text,
        /^([ \t]*)Datum[ \t]+funcname[ \t]*\(PG_FUNCTION_ARGS\);[ \t]*\\\r?$/gm,
        '$1extern PGDLLEXPORT Datum funcname(PG_FUNCTION_ARGS); \\',
        file,
      );
    }
    if (file === 'deps/flatgeobuf/geometryreader.cpp') {
      for (const variables of [
        ['x', 'y', 'z', 'm'],
        ['xv', 'yv', 'zv', 'mv'],
      ]) {
        text = replaceOne(
          text,
          `pt = (POINT4D) { ${variables.join(', ')} };`,
          ['x', 'y', 'z', 'm']
            .map((field, index) => `pt.${field} = ${variables[index]};`)
            .join('\n'),
          file,
        );
      }
    }
    return text;
  }
  if (extension === 'pg_uuidv7' && file === 'pg_uuidv7.c') {
    assert(!text.includes('oliphaunt_pg_uuidv7_clock_gettime'), `${file} is already adapted`);
    return replaceOne(text, uuidEpoch, uuidClock, file);
  }
  return text;
}
