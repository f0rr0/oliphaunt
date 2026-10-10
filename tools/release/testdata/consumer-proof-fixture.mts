import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { createDeterministicZip } from '../../packaging/archive-directory.mts';
import { frozenConsumerPlan } from '../frozen-consumer.mts';
import { aggregateConsumerResults, consumerDigest } from '../publication-consumer-proof.mts';

// Process-backed publication tests supply a complete synthetic GitHub read surface.
// Production admission has no environment switch that bypasses these checks.
export async function syntheticConsumerProof(root, lock) {
  const plan = frozenConsumerPlan(lock);
  const producer = { controllerSHA: 'a'.repeat(40), runId: 991, runAttempt: 1 };
  const result = {
    lockDigest: lock.lockDigest,
    casePlanDigest: consumerDigest(plan),
    testConfigurationDigest: plan.testConfigurationDigest,
    cases: plan.cases.map((test) => ({
      ...test,
      status: 'success',
      resolutionDigest: 'b'.repeat(64),
      resolvedInputs: [
        { identity: test.id, source: 'synthetic fixture', integrity: `sha256:${'b'.repeat(64)}` },
      ],
      toolchain: 'synthetic consumer toolchain',
      logReference: `${test.target}/fixture.log`,
      producer: { ...producer, jobName: `Frozen consumers (${test.target})` },
    })),
  };
  const proof = aggregateConsumerResults(plan, [result], producer);
  const file = path.join(root, 'publication-consumer-proof.json');
  writeFileSync(file, JSON.stringify(proof));
  const { mkdirSync } = await import('node:fs');
  const artifact = path.join(root, 'consumer-proof-artifact');
  mkdirSync(artifact);
  writeFileSync(path.join(artifact, path.basename(file)), JSON.stringify(proof));
  const bytes = await createDeterministicZip(artifact);
  return `
process.env.GITHUB_REPOSITORY = 'f0rr0/oliphaunt';
process.env.PUBLICATION_CONSUMER_PROOF_PATH = ${JSON.stringify(file)};
process.env.PUBLICATION_CONSUMER_PROOF_ARTIFACT_ID = '992';
const beforeProofFetch = globalThis.fetch;
globalThis.fetch = async (input, options = {}) => {
  const location = new URL(String(input));
  if (location.hostname === 'api.github.com') {
    if (options.method && options.method !== 'GET') throw new Error('unexpected GitHub write in consumer proof fixture');
    if (location.pathname.endsWith('/actions/artifacts/992/zip')) return new Response(Uint8Array.from(${JSON.stringify([...bytes])}));
    if (location.pathname.endsWith('/actions/artifacts/992')) return Response.json({ id: 992, name: 'oliphaunt-publication-consumer-proof', expired: false, workflow_run: { id: 991 } });
    if (location.pathname.endsWith('/actions/runs/991')) return Response.json({ id: 991, head_sha: ${JSON.stringify(producer.controllerSHA)}, head_branch: 'main', path: '.github/workflows/release.yml', event: 'workflow_dispatch', repository: { full_name: 'f0rr0/oliphaunt' }, head_repository: { full_name: 'f0rr0/oliphaunt' } });
    if (location.pathname.endsWith('/actions/runs/991/attempts/1/jobs')) return Response.json({ jobs: ${JSON.stringify([{ name: 'Publication ready', conclusion: 'success' }, ...[...new Set(plan.cases.map((test) => test.target))].map((target) => ({ name: `Frozen consumers (${target})`, conclusion: 'success' }))])} });
  }
  return beforeProofFetch(input, options);
};
`;
}
