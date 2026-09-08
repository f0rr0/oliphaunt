#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { isolatedGitHubTestEnvironment } from '../test/isolated-github-test-environment.mts';

const SCRIPT = path.resolve('.github/scripts/require-workflow-success.sh');
const SHA = 'a'.repeat(40);
const WORKFLOW_HELPER_PROCESS_TIMEOUT_MS = 15_000;

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-workflow-waiter-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const bin = path.join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const sleep = path.join(bin, 'sleep');
  writeFileSync(sleep, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  chmodSync(sleep, 0o755);
  const output = path.join(root, 'output');
  writeFileSync(output, '');
  return { bin, log: path.join(root, 'log'), output, root, state: path.join(root, 'state') };
}

function invoke(
  f,
  mode,
  args = ['CI', SHA, '10', '--job', 'Qualified', '--artifact', 'required-artifact'],
) {
  return spawnSync('bash', [SCRIPT, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: isolatedGitHubTestEnvironment({
      PATH: `${f.bin}${path.delimiter}${process.env.PATH}`,
      NODE_OPTIONS: `--import=${path.resolve('tools/test/require-workflow-success-github-fixture.mts')}`,
      FAKE_LOG: f.log,
      FAKE_RELEASE: args[0] === 'Release' ? '1' : '',
      FAKE_MODE: mode,
      FAKE_STATE: f.state,
      GH_REPO: 'f0rr0/oliphaunt',
      GH_TOKEN: 'test-token',
      GITHUB_OUTPUT: f.output,
      OLIPHAUNT_GITHUB_READ_BASE_DELAY_MS: '0',
      OLIPHAUNT_GITHUB_READ_DEADLINE_MS: '1000',
      OLIPHAUNT_GITHUB_READ_MAX_ATTEMPTS: '1',
      OLIPHAUNT_GITHUB_READ_MAX_DELAY_MS: '0',
    }),
    timeout: WORKFLOW_HELPER_PROCESS_TIMEOUT_MS,
  });
}

test('a transient exact-SHA run-inventory failure does not abort the long-lived workflow waiter', (t) => {
  const f = fixture(t);
  const result = invoke(f, 'transient');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /waiter remains active/u);
  assert.match(result.stdout, /selected CI run 77/u);
  assert.equal(
    readFileSync(f.output, 'utf8'),
    `run_id=77\nrun_attempt=3\nartifact_metadata_json=${JSON.stringify([
      {
        digest: `sha256:${'1'.repeat(64)}`,
        id: 901,
        name: 'required-artifact',
        size: 123,
      },
    ])}\ngate_artifact_metadata_json=[]\n`,
  );
  assert.equal(readFileSync(f.state, 'utf8'), '2');
});

test('permanent authentication failures abort immediately with a distinct status', (t) => {
  const f = fixture(t);
  const result = invoke(f, 'permanent');
  assert.equal(result.status, 64);
  assert.match(result.stderr, /permanent GitHub read failure/u);
  assert.equal(readFileSync(f.state, 'utf8'), '1');
});

test('exact-SHA REST pagination discovers a qualifying run beyond the first 100 newer failures', (t) => {
  const f = fixture(t);
  const result = invoke(f, 'beyond-first-page');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /selected CI run 77/u);
  const log = readFileSync(f.log, 'utf8');
  assert.match(log, /actions\/workflows\/9\/runs/u);
  assert.equal(readFileSync(f.state, 'utf8'), '2');
});

test('an explicitly selected run still fails closed on an exact-SHA mismatch', (t) => {
  const f = fixture(t);
  const result = invoke(f, 'wrong-sha', [
    'CI',
    SHA,
    '0',
    '--run-id',
    '77',
    '--job',
    'Qualified',
    '--artifact',
    'required-artifact',
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /belongs to .* not/u);
  assert.equal(readFileSync(f.output, 'utf8'), '');
});

test('SHA comparison remains case-insensitive', (t) => {
  const f = fixture(t);
  const result = invoke(f, 'upper-sha', [
    'CI',
    SHA,
    '0',
    '--run-id',
    '77',
    '--job',
    'Qualified',
    '--artifact',
    'required-artifact',
  ]);
  assert.equal(result.status, 0, result.stderr);
});

test('successful named jobs cannot authorize a non-terminal or failed workflow run', (t) => {
  for (const mode of ['in-progress-run', 'failed-run']) {
    const f = fixture(t);
    const result = invoke(f, mode, [
      'CI',
      SHA,
      '0',
      '--run-id',
      '77',
      '--job',
      'Qualified',
      '--artifact',
      'required-artifact',
    ]);
    assert.equal(result.status, 1, `${mode}: ${result.stderr}`);
    assert.match(result.stderr, /not completed\/success/u);
    assert.equal(readFileSync(f.output, 'utf8'), '');
  }
});

test('artifact gates require exactly one non-expired artifact identity', (t) => {
  for (const mode of ['duplicate-artifact', 'expired-artifact']) {
    const f = fixture(t);
    const result = invoke(f, mode, [
      'CI',
      SHA,
      '0',
      '--run-id',
      '77',
      '--job',
      'Qualified',
      '--artifact',
      'required-artifact',
    ]);
    assert.equal(result.status, 1, `${mode}: ${result.stderr}`);
    assert.match(result.stderr, /exactly one non-expired artifact/u);
    assert.equal(readFileSync(f.output, 'utf8'), '');
  }
});

test('gate-only artifacts authorize a run without contaminating transfer metadata', (t) => {
  const f = fixture(t);
  const args = [
    'CI',
    SHA,
    '0',
    '--artifact',
    'required-artifact',
    '--gate-artifact',
    'gate-artifact',
  ];
  const result = invoke(f, '', args);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(f.output, 'utf8'),
    `run_id=77\nrun_attempt=3\nartifact_metadata_json=${JSON.stringify([
      {
        digest: `sha256:${'1'.repeat(64)}`,
        id: 901,
        name: 'required-artifact',
        size: 123,
      },
    ])}\ngate_artifact_metadata_json=${JSON.stringify([
      {
        digest: `sha256:${'2'.repeat(64)}`,
        id: 903,
        name: 'gate-artifact',
        size: 456,
      },
    ])}\n`,
  );

  const missing = fixture(t);
  const missingResult = invoke(missing, 'missing-gate-artifact', args);
  assert.equal(missingResult.status, 1, missingResult.stderr);
  assert.match(missingResult.stderr, /gate-artifact.*found 0/u);
  assert.equal(readFileSync(missing.output, 'utf8'), '');
});

test('transfer and gate artifact identities must be globally unique', (t) => {
  const f = fixture(t);
  const result = invoke(f, '', [
    'CI',
    SHA,
    '0',
    '--artifact',
    'required-artifact',
    '--gate-artifact',
    'required-artifact',
  ]);
  assert.equal(result.status, 64, result.stderr);
  assert.match(result.stderr, /artifact identity list is malformed/u);
  assert.equal(readFileSync(f.output, 'utf8'), '');
});

test('malformed artifact metadata is a permanent protocol failure, not a retryable absence', (t) => {
  const f = fixture(t);
  const result = invoke(f, 'malformed-artifact-metadata');
  assert.equal(result.status, 64, result.stderr);
  assert.match(result.stderr, /artifact inventory contains malformed metadata/u);
  assert.match(result.stderr, /permanent GitHub read failure/u);
  assert.equal(readFileSync(f.state, 'utf8'), '1');
  assert.equal(readFileSync(f.output, 'utf8'), '');
});

test('job gates require exactly one successful named job identity', (t) => {
  const f = fixture(t);
  const result = invoke(f, 'duplicate-job', [
    'CI',
    SHA,
    '0',
    '--run-id',
    '77',
    '--job',
    'Qualified',
    '--artifact',
    'required-artifact',
  ]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Qualified=count-2/u);
  assert.equal(readFileSync(f.output, 'utf8'), '');
});

test('release recovery admits a failed publication only with a successful candidate and exact artifacts', {
  timeout: 30_000,
}, (t) => {
  for (const mode of [
    'failed-run',
    'failed-candidate',
    'in-progress-run',
    'duplicate-job',
    'expired-artifact',
    'wrong-sha',
  ]) {
    const f = fixture(t);
    const result = invoke(f, mode, [
      'Release',
      SHA,
      '0',
      '--run-id',
      '77',
      '--release-candidate',
      '--artifact',
      'required-artifact',
    ]);
    assert.equal(result.status, mode === 'failed-run' ? 0 : 1, mode + ': ' + result.stderr);
    if (mode !== 'failed-run') assert.equal(readFileSync(f.output, 'utf8'), '');
  }
  const f = fixture(t);
  assert.equal(
    invoke(f, 'failed-run', ['CI', SHA, '0', '--run-id', '77', '--release-candidate']).status,
    2,
  );
});

test('metadata formatting preserves permanent and transient HTTP failure statuses', (t) => {
  for (const [mode, status] of [
    ['metadata-auth', 64],
    ['metadata-transient', 75],
  ]) {
    const f = fixture(t);
    const result = invoke(f, mode, ['CI', SHA, '0', '--run-id', '77', '--job', 'Qualified']);
    assert.equal(result.status, status, result.stderr);
    assert.equal(readFileSync(f.output, 'utf8'), '');
  }
});
