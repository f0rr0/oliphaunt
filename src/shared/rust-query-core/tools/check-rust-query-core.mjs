#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';

function fail(message) {
  throw new Error(message);
}

const canonicalPath = 'src/shared/rust-query-core/query_core.rs';
const canonical = readFileSync(canonicalPath, 'utf8');
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

console.log('shared Rust query core source is canonical and has no committed mirrors');
