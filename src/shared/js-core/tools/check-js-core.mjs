#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

function fail(message) {
  throw new Error(message);
}

function read(path) {
  return readFileSync(path, 'utf8');
}

const mirrors = [
  ['src/shared/js-core/src/protocol.ts', 'src/sdks/js/src/protocol.ts'],
  ['src/shared/js-core/src/protocol.ts', 'src/sdks/react-native/src/protocol.ts'],
  ['src/shared/js-core/src/protocol.ts', 'src/bindings/wasix-ts/src/protocol.ts'],
  ['src/shared/js-core/src/query.ts', 'src/sdks/js/src/query.ts'],
  ['src/shared/js-core/src/query.ts', 'src/sdks/react-native/src/query.ts'],
  ['src/shared/js-core/src/query.ts', 'src/bindings/wasix-ts/src/query.ts'],
];

const args = new Set(process.argv.slice(2));
const write = args.delete('--write');
if (args.size > 0) fail(`unknown argument(s): ${[...args].join(', ')}`);

function generatedMirror(canonicalPath, canonical) {
  return (
    `// @generated from ${canonicalPath}. Do not edit this mirror; ` +
    'run `node src/shared/js-core/tools/check-js-core.mjs --write`.\n' +
    canonical
  );
}

for (const [canonicalPath, mirrorPath] of mirrors) {
  const canonical = read(canonicalPath);
  const expected = generatedMirror(canonicalPath, canonical);
  const mirror = read(mirrorPath);
  if (write && mirror !== expected) {
    writeFileSync(mirrorPath, expected);
  } else if (!write && mirror !== expected) {
    fail(`${mirrorPath} is not a fresh mirror of ${canonicalPath}`);
  }
}

console.log(write ? 'shared JavaScript core mirrors are synchronized' : 'shared JavaScript core mirrors are fresh');
