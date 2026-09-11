import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { RUST_BUILD_SCRIPT_SHA256 } from './rust-build-script-sha256.mts';
const [phase, root] = process.argv.slice(2);
const fixtures = [
  Buffer.alloc(0),
  Buffer.from('abc'),
  Buffer.alloc(55, 0x55),
  Buffer.alloc(56, 0x56),
  Buffer.alloc(63, 0x63),
  Buffer.alloc(64, 0x64),
  Buffer.alloc(65, 0x65),
  Buffer.alloc(65_535, 0xa5),
  Buffer.alloc(65_536, 0x5a),
  Buffer.alloc(65_537, 0xc3),
];

if (phase === 'prepare') {
  writeFileSync(
    path.join(root, 'main.rs'),
    `use std::fs;
use std::io::{self, Read};
use std::path::Path;

${RUST_BUILD_SCRIPT_SHA256}

fn main() {
    let input = std::env::args_os().nth(1).expect("input path");
    println!("{}", sha256_file(Path::new(&input)).expect("hash fixture"));
}
`,
  );

  for (const [index, bytes] of fixtures.entries())
    writeFileSync(path.join(root, 'fixture-' + index + '.bin'), bytes);
} else if (phase === 'verify') {
  for (const [index, bytes] of fixtures.entries())
    assert.equal(
      readFileSync(path.join(root, 'fixture-' + index + '.bin.sha256'), 'utf8').trim(),
      createHash('sha256').update(bytes).digest('hex'),
    );
} else throw new Error('expected prepare or verify');
