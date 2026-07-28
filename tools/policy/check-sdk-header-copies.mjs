#!/usr/bin/env bun

import {readFileSync} from 'node:fs';

const canonicalPath = 'src/runtimes/liboliphaunt/native/include/oliphaunt.h';
const copies = [
  'src/sdks/kotlin/oliphaunt/src/androidMain/cpp/include/oliphaunt.h',
  'src/sdks/swift/Sources/COliphaunt/include/oliphaunt.h',
  'src/sdks/react-native/android/src/main/cpp/include/oliphaunt.h',
];

const canonical = readFileSync(canonicalPath);
const stale = copies.filter(copy => !readFileSync(copy).equals(canonical));

if (stale.length > 0) {
  for (const copy of stale) {
    console.error(`${copy} must be byte-identical to ${canonicalPath}`);
  }
  process.exit(1);
}

console.log(`C ABI header copies verified (${copies.length} package copies).`);
