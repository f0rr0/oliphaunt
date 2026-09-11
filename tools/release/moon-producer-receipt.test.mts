import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  producerHashes,
  producerTypescriptVersion,
} from '../../.github/scripts/moon-producer-receipt.mts';

test('producer compiler identity resolves from its isolated workspace dependencies', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'moon-producer-toolchain-'));
  try {
    const owner = path.join(root, 'sdks', 'query');
    const compiler = path.join(owner, 'node_modules', 'typescript');
    mkdirSync(compiler, { recursive: true });
    writeFileSync(path.join(owner, 'package.json'), '{"name":"query"}');
    writeFileSync(path.join(compiler, 'package.json'), '{"name":"typescript","version":"6.0.3"}');
    assert.equal(producerTypescriptVersion(owner), '6.0.3');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('producer receipts require complete Moon ancestry and retain actual cache behavior', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'moon-producer-receipt-'));
  try {
    mkdirSync(path.join(root, 'hashes'));
    const producer = 'a'.repeat(64),
      dependency = 'b'.repeat(64);
    const report = {
      actions: [
        {
          node: { action: 'run-task', params: { target: 'sdk:package' } },
          status: 'passed',
          operations: [{ meta: { type: 'hash-generation', hash: producer } }],
        },
      ],
    };
    const manifest = (hash, target, deps) =>
      writeFileSync(
        path.join(root, 'hashes', `${hash}.json`),
        JSON.stringify([{ target, deps, toolchains: ['bun'] }]),
      );
    manifest(producer, 'sdk:package', { 'sdk:build': dependency });
    manifest(dependency, 'sdk:build', {});
    const fresh = producerHashes(report, root, 'sdk:package');
    assert.equal(fresh.eligible, true);
    assert.equal(fresh.cacheHit, false);
    assert.equal(fresh.hashes.length, 2);
    report.actions[0].status = 'cached';
    assert.equal(producerHashes(report, root, 'sdk:package').cacheHit, true);
    manifest(producer, 'sdk:package', { 'sdk:build': 'passthrough' });
    assert.match(producerHashes(report, root, 'sdk:package').reason, /incomplete producer hash/);
    report.actions[0].operations = [];
    assert.match(producerHashes(report, root, 'sdk:package').reason, /hashing is disabled/);
    report.actions[0].status = 'failed';
    assert.match(producerHashes(report, root, 'sdk:package').reason, /did not complete/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
