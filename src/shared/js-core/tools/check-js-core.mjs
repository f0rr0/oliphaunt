#!/usr/bin/env node
import { readFileSync } from 'node:fs';

function fail(message) {
  throw new Error(message);
}

function read(path) {
  return readFileSync(path, 'utf8');
}

const mirrors = [
  ['src/shared/js-core/src/protocol.ts', 'src/sdks/js/src/protocol.ts'],
  ['src/shared/js-core/src/protocol.ts', 'src/sdks/react-native/src/protocol.ts'],
  ['src/shared/js-core/src/query.ts', 'src/sdks/js/src/query.ts'],
  ['src/shared/js-core/src/query.ts', 'src/sdks/react-native/src/query.ts'],
];

for (const [canonicalPath, mirrorPath] of mirrors) {
  const canonical = read(canonicalPath);
  const mirror = read(mirrorPath);
  if (canonical !== mirror) {
    fail(`${mirrorPath} is not a fresh mirror of ${canonicalPath}`);
  }
}

console.log('shared JavaScript core mirrors are fresh');
