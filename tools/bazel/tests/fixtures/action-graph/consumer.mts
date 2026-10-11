import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('the final fixture package installs and executes with its promised value', () => {
  const product = process.env.TEST_TARGET?.match(/:(alpha|beta|gamma)_test$/)?.[1];
  assert.ok(product, 'fixture test requires a declared Bazel target identity');
  const directory = 'tools/bazel/tests/fixtures/action-graph';
  const envelope = JSON.parse(readFileSync(`${directory}/${product}_archive.json`, 'utf8'));
  assert.deepEqual(Object.keys(envelope).sort(), ['executable', 'legal', 'product', 'version']);
  assert.equal(envelope.product, "fixture-" + product);
  assert.match(envelope.version, /^\d+[.]\d+[.]\d+$/);
  assert.match(envelope.legal, /^Fixture license, revision \d+[.]\n$/);
  const scratch = mkdtempSync(path.join(process.env.TEST_TMPDIR ?? tmpdir(), 'physical-consumer-'));
  try {
    const binary = path.join(scratch, 'consumer-bin');
    writeFileSync(binary, Buffer.from(envelope.executable, 'base64'));
    chmodSync(binary, 0o700);
    const observed = execFileSync(binary, { encoding: 'utf8' });
    assert.equal(observed, readFileSync(`${directory}/${product}.expected`, 'utf8'));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
