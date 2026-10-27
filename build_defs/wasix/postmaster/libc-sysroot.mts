import assert from 'node:assert/strict';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const [specPath, output] = process.argv.slice(2);
assert(
  specPath && output && process.argv.length === 4,
  'Expected declared sysroot specification and output',
);
const spec = JSON.parse(readFileSync(specPath, 'utf8')) as {
  base: { relative: string; path: string }[];
  headers: string;
  libc: string;
  mman: string;
};
const seen = new Set<string>();
for (const file of spec.base) {
  assert(
    !seen.has(file.relative) &&
      !file.relative.startsWith('/') &&
      !file.relative.split('/').some((part) => !part || part === '.' || part === '..') &&
      !file.relative.includes('\\'),
    'Invalid or duplicate base sysroot member',
  );
  seen.add(file.relative);
  const path = join(output, file.relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, readFileSync(file.path));
  chmodSync(path, statSync(file.path).mode & 0o777);
}
assert(
  seen.has('include/stdio.h') && seen.has('lib/wasm32-wasi/crt1.o'),
  'Incomplete selected base sysroot',
);
function headers(relative = '') {
  for (const name of readdirSync(join(spec.headers, relative)).sort()) {
    const path = relative ? `${relative}/${name}` : name;
    const source = join(spec.headers, path);
    const stat = lstatSync(source);
    if (stat.isDirectory()) headers(path);
    else {
      // Bazel stages declared TreeArtifact children as sandbox leaf symlinks.
      // The header producer writes regular files; do not recurse through links.
      assert(statSync(source).isFile(), 'Generated libc header is not regular');
      const destination = join(output, 'include', path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, readFileSync(source));
      chmodSync(destination, 0o644);
    }
  }
}
headers();
for (const [name, source] of [
  ['libc.a', spec.libc],
  ['libwasi-emulated-mman.a', spec.mman],
]) {
  const destination = join(output, 'lib/wasm32-wasi', name);
  writeFileSync(destination, readFileSync(source));
  chmodSync(destination, 0o644);
}
