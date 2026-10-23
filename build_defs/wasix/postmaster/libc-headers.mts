import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const expectedSed = String.raw`/^TYPEDEF/s/TYPEDEF \(.*\) \([^ ]*\);$/#if defined(__NEED_\2) \&\& !defined(__DEFINED_\2)\
typedef \1 \2;\
#define __DEFINED_\2\
#endif\
/
/^STRUCT/s/STRUCT * \([^ ]*\) \(.*\);$/#if defined(__NEED_struct_\1) \&\& !defined(__DEFINED_struct_\1)\
struct \1 \2;\
#define __DEFINED_struct_\1\
#endif\
/
/^UNION/s/UNION * \([^ ]*\) \(.*\);$/#if defined(__NEED_union_\1) \&\& !defined(__DEFINED_union_\1)\
union \1 \2;\
#define __DEFINED_union_\1\
#endif\
/
`;

export function muslAlltypes(script: string, templates: string[]): string {
  assert.equal(script, expectedSed, 'Canonical mkalltypes.sed semantics changed');
  return templates
    .join('')
    .replace(
      /^TYPEDEF (.*) ([^ ]*);$/gm,
      (_line, type: string, name: string) =>
        `#if defined(__NEED_${name}) && !defined(__DEFINED_${name})\ntypedef ${type} ${name};\n#define __DEFINED_${name}\n#endif\n`,
    )
    .replace(
      /^(STRUCT|UNION) * ([^ ]*) (.*);$/gm,
      (_line, kind: string, name: string, body: string) => {
        const type = kind.toLowerCase();
        return `#if defined(__NEED_${type}_${name}) && !defined(__DEFINED_${type}_${name})\n${type} ${name} ${body};\n#define __DEFINED_${type}_${name}\n#endif\n`;
      },
    );
}

export function publicLibcHeaders(files: Map<string, Buffer>, omit: string[]): Map<string, Buffer> {
  const result = new Map<string, Buffer>();
  const copy = (prefix: string, destination = '') => {
    for (const [path, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
      if (path.startsWith(prefix)) result.set(destination + path.slice(prefix.length), bytes);
    }
  };
  const text = (path: string) => {
    const bytes = files.get(path);
    assert(bytes, `Missing libc header input ${path}`);
    return bytes.toString('utf8');
  };
  const musl = 'libc-top-half/musl/';
  copy('libc-bottom-half/headers/public/');
  result.set(
    'bits/alltypes.h',
    Buffer.from(
      muslAlltypes(text(`${musl}tools/mkalltypes.sed`), [
        text(`${musl}arch/wasm32/bits/alltypes.h.in`),
        text(`${musl}include/alltypes.h.in`),
      ]),
    ),
  );
  copy(`${musl}include/`);
  copy(`${musl}arch/generic/bits/`, 'bits/');
  copy(`${musl}arch/wasm32/bits/`, 'bits/');
  for (const path of omit) result.delete(path);
  assert(
    result.has('bits/alltypes.h') && result.has('sys/mman.h') && result.has('wasix/context.h'),
    'Incomplete patched libc public headers',
  );
  return result;
}

if (import.meta.main) {
  const [specPath, output] = process.argv.slice(2);
  assert(
    specPath && output && process.argv.length === 4,
    'Expected declared header specification and output directory',
  );
  const spec = JSON.parse(readFileSync(specPath, 'utf8')) as {
    files: { relative: string; path: string }[];
    omit: string[];
  };
  const files = new Map<string, Buffer>();
  for (const file of spec.files) {
    assert(
      !files.has(file.relative) &&
        !file.relative.startsWith('/') &&
        !file.relative.split('/').some((part) => !part || part === '.' || part === '..') &&
        !file.relative.includes('\\'),
      'Invalid or duplicate libc header member',
    );
    files.set(file.relative, readFileSync(file.path));
  }
  for (const [relative, bytes] of publicLibcHeaders(files, spec.omit)) {
    const path = join(output, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes, { mode: 0o644 });
  }
}
