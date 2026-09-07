#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderGeneratedArtifacts } from '../../src/shared/postgres-protocol-transport-contract/generate.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const contract = JSON.parse(await readFile(
  resolve(root, 'src/shared/postgres-protocol-transport-contract/contract.json'), 'utf8',
));
assert.equal(contract.schema, 'oliphaunt-wasix-postgres-protocol-transport-contract-v1');
assert.deepEqual(contract.modes.map(({ value }) => value), [0, 1, 2, 3]);
assert.deepEqual(contract.copyStates.map(({ value }) => value), [0, 1, 2, 3]);
assert.equal(contract.bufferedOutput.limitBytes, 64 * 1024 * 1024);
assert.equal(contract.streamedOutput.callbackChunkMaxBytes, 64 * 1024);
assert.equal(contract.flush.wasmResult, 'i32');
for (const [path, expected] of Object.entries(renderGeneratedArtifacts(contract))) {
  assert.equal(await readFile(resolve(root, path), 'utf8'), expected,
    path + ' is stale; run node src/shared/postgres-protocol-transport-contract/generate.mjs');
}
// The companion compiled bridge ABI test exercises bounds, failure stickiness,
// reset, mode transitions and signed flush behavior. Do not depend on research
// probes or on matching their source text to qualify this contract.
console.log('PostgreSQL protocol transport schema and generated views: PASS');
