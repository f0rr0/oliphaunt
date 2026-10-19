import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDeterministicZip } from '../packaging/archive-directory.mts';
import { frozenConsumerPlan } from './frozen-consumer.mts';
import {
  aggregateConsumerResults,
  CONSUMER_PROOF_ARTIFACT,
  consumerDigest,
  requirePublicationConsumerProof,
  validateConsumerProof,
} from './publication-consumer-proof.mts';

function fixture() {
  const lock = {
    lockDigest: 'a'.repeat(64),
    products: [{ id: 'fixture', version: '1.0.0', publishTargets: ['npm'] }],
    carriers: [
      {
        id: 'npm:@oliphaunt/fixture',
        name: '@oliphaunt/fixture',
        ecosystem: 'npm',
        version: '1.0.0',
        product: 'fixture',
        target: 'linux-x64-gnu',
      },
    ],
  };
  const plan = frozenConsumerPlan(lock);
  const producer = { controllerSHA: 'c'.repeat(40), runId: 99, runAttempt: 2 };
  const cases = plan.cases.map((entry) => ({
    ...entry,
    status: 'success',
    resolutionDigest: 'd'.repeat(64),
    resolvedInputs: [
      {
        identity: '@oliphaunt/fixture@1.0.0',
        source: 'frozen-npm-registry',
        integrity: `sha256:${'d'.repeat(64)}`,
      },
    ],
    toolchain: 'npm 11.18.0',
    logReference: 'linux-x64-gnu.json.logs/case-0',
    producer: { ...producer, runAttempt: 1, jobName: 'Frozen consumers (linux-x64-gnu)' },
  }));
  const result = {
    lockDigest: lock.lockDigest,
    casePlanDigest: consumerDigest(plan),
    testConfigurationDigest: plan.testConfigurationDigest,
    cases,
  };
  return {
    lock,
    plan,
    producer,
    result,
    proof: aggregateConsumerResults(plan, [result], producer),
  };
}

test('readiness fails closed on incomplete, failed, duplicate or unexpected cases', () => {
  const { plan, producer, result } = fixture();
  for (const cases of [
    [],
    [{ ...result.cases[0], status: 'failure' }],
    [{ ...result.cases[0], status: 'skipped' }],
    [result.cases[0], result.cases[0]],
    [{ ...result.cases[0], id: 'unexpected' }],
  ])
    expect(() => aggregateConsumerResults(plan, [{ ...result, cases }], producer)).toThrow();
  expect(() =>
    aggregateConsumerResults(plan, [{ ...result, lockDigest: 'b'.repeat(64) }], producer),
  ).toThrow('different bytes');
  expect(() =>
    aggregateConsumerResults(
      plan,
      [{ ...result, testConfigurationDigest: 'b'.repeat(64) }],
      producer,
    ),
  ).toThrow('test configuration');
});

test('consumer proof binds the case plan, toolchain, execution level and producing attempt', () => {
  const { lock, plan, proof } = fixture();
  expect(validateConsumerProof(lock, plan, proof)).toBe(proof);
  expect(() =>
    validateConsumerProof(lock, plan, { ...proof, casePlanDigest: 'b'.repeat(64) }),
  ).toThrow('current consumer proof');
  for (const change of [
    { executionLevel: 'execute' },
    { toolchain: '' },
    { resolvedInputs: [] },
    { resolvedInputs: [{ identity: 'unhashed', source: 'candidate', integrity: '' }] },
    { producer: { ...proof.cases[0].producer, runId: 123 } },
    { logReference: '' },
  ]) {
    expect(() =>
      validateConsumerProof(lock, plan, { ...proof, cases: [{ ...proof.cases[0], ...change }] }),
    ).toThrow();
  }
});

test('admission verifies immutable GitHub bytes and each actual job attempt', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'consumer-proof-'));
  try {
    const { lock, proof } = fixture();
    const file = path.join(root, 'publication-consumer-proof.json');
    const artifactRoot = path.join(root, 'artifact');
    mkdirSync(artifactRoot);
    writeFileSync(file, JSON.stringify(proof));
    writeFileSync(path.join(artifactRoot, path.basename(file)), JSON.stringify(proof));
    const zip = await createDeterministicZip(artifactRoot);
    const calls = [];
    const environment = {
      GITHUB_REPOSITORY: 'f0rr0/oliphaunt',
      PUBLICATION_CONSUMER_PROOF_PATH: file,
      PUBLICATION_CONSUMER_PROOF_ARTIFACT_ID: '321',
    };
    const read = async (endpoint) =>
      endpoint.includes('/artifacts/')
        ? {
            id: Number(environment.PUBLICATION_CONSUMER_PROOF_ARTIFACT_ID),
            name: CONSUMER_PROOF_ARTIFACT,
            expired: false,
            workflow_run: { id: 99 },
          }
        : {
            id: 99,
            head_sha: proof.producer.controllerSHA,
            head_branch: 'main',
            path: '.github/workflows/release.yml',
            event: 'workflow_dispatch',
            repository: { full_name: 'f0rr0/oliphaunt' },
            head_repository: { full_name: 'f0rr0/oliphaunt' },
          };
    const list = async (endpoint) => {
      calls.push(endpoint);
      return endpoint.includes('/attempts/2/')
        ? [{ name: 'Publication ready', conclusion: 'success' }]
        : [{ name: 'Frozen consumers (linux-x64-gnu)', conclusion: 'success' }];
    };
    const download = async () => new Response(zip);
    const admission = await requirePublicationConsumerProof(lock, {
      environment,
      read,
      list,
      download,
    });
    expect(admission.lockDigest).toBe(lock.lockDigest);
    expect(calls.some((endpoint) => endpoint.includes('/attempts/1/'))).toBe(true);
    environment.PUBLICATION_CONSUMER_PROOF_ARTIFACT_ID = '322';
    await expect(
      requirePublicationConsumerProof(lock, { environment, read, list: async () => [], download }),
    ).rejects.toThrow('readiness job');
    environment.PUBLICATION_CONSUMER_PROOF_ARTIFACT_ID = '323';
    await expect(
      requirePublicationConsumerProof(lock, {
        environment,
        read: async () => ({ ...(await read('run')), head_branch: 'other' }),
        list,
        download,
      }),
    ).rejects.toThrow('untrusted');
    environment.PUBLICATION_CONSUMER_PROOF_ARTIFACT_ID = '324';
    writeFileSync(
      path.join(artifactRoot, path.basename(file)),
      JSON.stringify({ ...proof, producer: { ...proof.producer, runAttempt: 3 } }),
    );
    const changed = await createDeterministicZip(artifactRoot);
    await expect(
      requirePublicationConsumerProof(lock, {
        environment,
        read,
        list,
        download: async () => new Response(changed),
      }),
    ).rejects.toThrow('differs');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
