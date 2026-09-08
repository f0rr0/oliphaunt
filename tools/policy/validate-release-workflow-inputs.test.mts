#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dir, '../..');
const SCRIPT = path.join(ROOT, '.github/scripts/validate-release-workflow-inputs.sh');
const SHA = '84d90b9853530ab72e48a1aa6fb616aaed7a0dc6';
const BASH = process.env.OLIPHAUNT_TEST_BASH
  ? path.resolve(ROOT, process.env.OLIPHAUNT_TEST_BASH)
  : process.platform === 'darwin'
    ? '/bin/bash'
    : 'bash';

function validate({
  operation = 'prepare-release-pr',
  releaseCommit = '',
  approvalRunId = '',
  workflowSha = SHA,
  workflowRef = 'refs/heads/main',
} = {}) {
  const result = spawnSync(BASH, [SCRIPT], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_REF: workflowRef,
      GITHUB_SHA: workflowSha,
      RELEASE_OPERATION: operation,
      RELEASE_COMMIT: releaseCommit,
      RELEASE_APPROVAL_RUN_ID: approvalRunId,
    },
  });
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
  };
}

test('accepts every supported root operation with its implicit workflow commit', () => {
  for (const operation of ['prepare-release-pr', 'publish']) {
    const result = validate({ operation });
    assert.equal(result.status, 0, `${operation}: ${result.output}`);
  }
});

test('accepts a supplied exact release commit assertion without case sensitivity', () => {
  for (const releaseCommit of [SHA, SHA.toUpperCase()]) {
    const result = validate({ releaseCommit });
    assert.equal(result.status, 0, result.output);
  }
});

test('rejects malformed and stale release commit assertions before every operation', () => {
  for (const [operation, releaseCommit] of [
    ['prepare-release-pr', '84d90b9'],
    ['publish', '1111111111111111111111111111111111111111'],
  ]) {
    const result = validate({ operation, releaseCommit });
    assert.notEqual(result.status, 0, `${operation} unexpectedly accepted ${releaseCommit}`);
    assert.match(
      result.output,
      /release_commit must (?:be a full 40-character commit SHA|equal the exact workflow SHA)/u,
    );
  }
});

test('publish operations admit a pinned source for subsequent controller and approval verification', () => {
  for (const operation of ['publish']) {
    const result = validate({ operation, releaseCommit: '1'.repeat(40), approvalRunId: '123' });
    assert.equal(result.status, 0, result.output);
  }
});

test('release operations are main-only', () => {
  const rootOnTag = validate({
    operation: 'publish',
    approvalRunId: '33989155433',
    workflowRef: `refs/tags/oliphaunt-release-transport/${SHA}`,
  });
  assert.notEqual(rootOnTag.status, 0, rootOnTag.output);
  assert.match(rootOnTag.output, /release operations must execute from refs\/heads\/main/u);
});

test('recovery accepts only an explicit positive approval run', () => {
  for (const operation of ['publish']) {
    for (const approvalRunId of ['0', 'latest', '12.5']) {
      const result = validate({ operation, approvalRunId });
      assert.notEqual(result.status, 0, `${operation} unexpectedly accepted ${approvalRunId}`);
      assert.match(result.output, /approval_run_id is valid only/u);
    }
  }
  for (const operation of ['prepare-release-pr']) {
    const result = validate({ operation, approvalRunId: '33989155433' });
    assert.notEqual(result.status, 0, `${operation} unexpectedly accepted approval_run_id`);
    assert.match(result.output, /approval_run_id is valid only/u);
  }
});

test('rejects unsupported operations and malformed workflow identities', () => {
  const unsupported = validate({ operation: 'delete-everything' });
  assert.notEqual(unsupported.status, 0, unsupported.output);
  assert.match(unsupported.output, /Unsupported release operation/u);

  const malformedSha = validate({ workflowSha: '84d90b9' });
  assert.notEqual(malformedSha.status, 0, malformedSha.output);
  assert.match(malformedSha.output, /GITHUB_SHA must be a full 40-character commit SHA/u);
});

test('release workflow CI gates run after the action that installs Bun', () => {
  const workflow = Bun.YAML.parse(
    readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8'),
  );
  let gates = 0;
  for (const [job, { steps = [] }] of Object.entries(workflow.jobs)) {
    const setup = steps.findIndex((step) => step.uses === './.github/actions/setup-moon');
    for (const [index, step] of steps.entries()) {
      if (!step.run?.includes('.github/scripts/require-workflow-success.sh')) continue;
      gates++;
      assert.ok(setup >= 0 && setup < index, `${job}: ${step.name} requires Bun from setup-moon`);
    }
  }
  assert.ok(gates >= 2, 'bootstrap and publish gates must be inspected');
});

test('both npm publication jobs can generate required provenance', () => {
  const workflow = Bun.YAML.parse(
    readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8'),
  );
  for (const job of ['publish', 'publish-bootstrap']) {
    assert.equal(
      workflow.jobs[job].permissions['id-token'],
      'write',
      `${job} requires OIDC for npm --provenance even with token authentication`,
    );
  }
});
