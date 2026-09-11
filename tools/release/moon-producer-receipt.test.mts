import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { producerHashes } from '../../.github/scripts/moon-producer-receipt.mts';

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
