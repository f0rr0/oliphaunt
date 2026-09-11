#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--version') {
  console.log(
    'oliphaunt-wasix-postmaster-compiler fixture oliphaunt.wasix-postmaster.linear-memory.wasm32-max256m-u64-static4g-guard2g.v1',
  );
} else {
  const verify = args[0] === 'verify-aot';
  const input = verify ? args[1] : args.at(-1);
  const outputIndex = args.indexOf('-o');
  assert(
    verify ? args.length === 3 : outputIndex >= 0 && args[outputIndex + 1],
    'compiler requires -o OUTPUT MODULE',
  );
  const digest = createHash('sha256').update(readFileSync(input!)).digest();
  const expected = Buffer.concat([Buffer.from('fake-product-aot\0'), digest]);
  if (verify) {
    assert.deepEqual(readFileSync(args[2]), expected, 'fake product AOT identity differs');
    console.log(digest.toString('hex'));
  } else {
    assert(
      ['--llvm', '--enable-exceptions', '--enable-threads'].every((flag) => args.includes(flag)),
      'compiler requires LLVM, exceptions, and threads',
    );
    writeFileSync(args[outputIndex + 1], expected);
  }
}
