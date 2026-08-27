#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';

function fail(message) {
  throw new Error(message);
}

function read(path) {
  return readFileSync(path, 'utf8');
}

const canonicalPath = 'src/shared/rust-query-core/query_core.rs';
const canonical = read(canonicalPath);
if (!canonical.trim()) {
  fail(`${canonicalPath} must not be empty`);
}

for (const mirror of [
  'src/sdks/rust/src/query_core.rs',
  'src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/query_core.rs',
]) {
  if (existsSync(mirror)) {
    fail(`${mirror} must be release-staged, not committed beside ${canonicalPath}`);
  }
}

const references = [
  [
    'src/sdks/rust/build.rs',
    [
      '../../shared/rust-query-core/query_core.rs',
      'src/query_core.rs',
      'OLIPHAUNT_QUERY_CORE_RS',
    ],
  ],
  [
    'src/bindings/wasix-rust/crates/oliphaunt-wasix/build.rs',
    [
      '../../../../../src/shared/rust-query-core/query_core.rs',
      'src/oliphaunt/query_core.rs',
      'OLIPHAUNT_QUERY_CORE_RS',
    ],
  ],
  [
    'tools/release/prepare-rust-release-source.mjs',
    ['src/shared/rust-query-core/query_core.rs', 'src/query_core.rs'],
  ],
  [
    'tools/release/package_oliphaunt_wasix_sdk_crate.mjs',
    ['src/shared/rust-query-core/query_core.rs', 'src/oliphaunt/query_core.rs'],
  ],
  [
    'src/sdks/rust/tools/check-sdk.sh',
    ['src/shared/rust-query-core/query_core.rs', 'src/query_core.rs'],
  ],
  [
    'src/bindings/wasix-rust/tools/check-package.sh',
    ['src/shared/rust-query-core/query_core.rs', 'src/oliphaunt/query_core.rs'],
  ],
  [
    'tools/release/check-staged-artifacts.mjs',
    [
      'src/shared/rust-query-core/query_core.rs',
      'src/query_core.rs',
      'src/oliphaunt/query_core.rs',
    ],
  ],
];

for (const [path, required] of references) {
  const source = read(path);
  for (const token of required) {
    if (!source.includes(token)) {
      fail(`${path} must reference ${token}`);
    }
  }
}

console.log('shared Rust query core source and package wiring are canonical');
