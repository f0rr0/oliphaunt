import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

const gate = path.resolve(import.meta.dir, '../../.github/scripts/check-ci-gate.mts');

function run(mode: string, needs: unknown, jobs: unknown) {
  const result = Bun.spawnSync([process.execPath, '--no-install', '--no-env-file', gate, mode], {
    env: {
      NEEDS_JSON: JSON.stringify(needs),
      SELECTED_JOBS_JSON: JSON.stringify(jobs),
      REQUIRED_JOBS_JSON: JSON.stringify(jobs),
      GATE_LABEL: 'source check gate',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    status: result.exitCode,
    output: Buffer.concat([result.stdout, result.stderr]).toString(),
  };
}

test('selected gate accepts an empty plan and deduplicates successful jobs', () => {
  assert.equal(run('selected', {}, []).status, 0);
  const result = run('selected', { android: { result: 'success' }, ios: { result: 'success' } }, [
    'ios',
    'android',
    'ios',
  ]);
  assert.equal(result.status, 0);
  assert.match(result.output, /passed: android, ios/u);
});

test('both gate modes reject missing, failed, cancelled and skipped selected jobs', () => {
  for (const mode of ['selected', 'required']) {
    for (const result of ['missing', 'failure', 'cancelled', 'skipped']) {
      const observed = run(mode, result === 'missing' ? {} : { ios: { result } }, ['ios']);
      assert.notEqual(observed.status, 0);
      assert.match(observed.output, new RegExp(`ios=${result}`, 'u'));
    }
  }
});

test('CLI rejects malformed job and needs envelopes and unknown modes', () => {
  for (const jobs of ['ios', [null], [42]]) {
    const result = run('selected', {}, jobs);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /must be a JSON string array/u);
  }
  const malformedNeeds = run('required', [], ['ios']);
  assert.notEqual(malformedNeeds.status, 0);
  assert.match(malformedNeeds.output, /must be a JSON object/u);
  const unknown = run('allow-skipped', {}, []);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.output, /usage: check-ci-gate.mts/u);
});
