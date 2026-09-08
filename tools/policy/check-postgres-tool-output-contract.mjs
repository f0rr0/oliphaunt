#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const contractPath = 'src/shared/postgres-tool-output-contract/contract.json';
const expectedContract = {
  schema: 'oliphaunt-postgres-tool-output-contract-v1',
  capturedOutputLimitBytes: 67_108_864,
  scope: 'stdout-and-stderr-aggregate-per-process',
  belowLimit: 'preserve-exact-bytes',
  overflow: 'fail-closed-without-returning-partial-output',
  streamingEscapeHatch: 'required-for-larger-valid-output',
};

const contract = JSON.parse(await read(contractPath));
assert.deepEqual(contract, expectedContract, `${contractPath} has an unsupported shape or value`);

const implementations = [
  {
    path: 'src/bindings/wasix-ts/host/patches/0021-wasmer-js-stream-direct-pgwire.patch',
    pattern: /^\+const TOOL_OUTPUT_LIMIT_BYTES: usize = ([\d_]+);$/mu,
  },
  {
    path: 'src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/tools.rs',
    pattern: /^const POSTGRES_TOOL_OUTPUT_CAPTURE_LIMIT_BYTES: usize = ([\d_]+);$/mu,
  },
  {
    path: 'src/runtimes/liboliphaunt/native/crates/tools/src/lib.rs',
    pattern: /^const CAPTURED_OUTPUT_LIMIT_BYTES: usize = ([\d_]+);$/mu,
  },
  {
    path: 'src/runtimes/liboliphaunt/native/tools-npm/index.js',
    pattern: /^const CAPTURED_OUTPUT_LIMIT_BYTES = ([\d_]+);$/mu,
  },
];

for (const implementation of implementations) {
  const source = await read(implementation.path);
  const match = source.match(implementation.pattern);
  assert.ok(match, `${implementation.path} does not declare the shared capture limit`);
  const limit = Number(match[1].replaceAll('_', ''));
  assert.equal(
    limit,
    contract.capturedOutputLimitBytes,
    `${implementation.path} diverges from ${contractPath}`,
  );
}

console.log(
  `PostgreSQL tool output contract: ${implementations.length} implementations agree on ${contract.capturedOutputLimitBytes} bytes`,
);

function read(path) {
  return readFile(resolve(repositoryRoot, path), 'utf8');
}
