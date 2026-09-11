import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { zipArchive } from '../packaging/testdata/zip-fixture.mts';

const [mode, root, scenario] = process.argv.slice(2);
const sha = 'a'.repeat(40);
if (mode === 'prepare') {
  for (const id of [77, 88]) {
    const products = scenario === 'uncovered' && id === 77 ? ['other-product'] : ['oliphaunt-js'];
    const candidate = {
      schemaVersion: 2,
      sha,
      runId: String(id),
      runAttempt: 3,
      repository: 'f0rr0/oliphaunt',
      workflow: 'CI',
      ref: 'refs/heads/main',
      eventName: id === 88 ? 'workflow_dispatch' : 'push',
      affectedPlan: {
        digest: `sha256:${'1'.repeat(64)}`,
        jobs: ['affected'],
        projects: [],
        extensionPackageProducts: [],
        wasixReleaseRegressionRequired: false,
        qualification: {
          mode: 'selected-products',
          baseSha: null,
          headSha: sha,
          products,
          tasks: ['oliphaunt-js:package'],
        },
      },
      evidenceRequirements: { wasixReleaseRegression: false, artifacts: [] },
      evidence: { wasixReleaseRegression: null },
    };
    writeFileSync(
      path.join(root, `${id}.zip`),
      zipArchive([
        { name: 'oliphaunt-release-candidate.json', data: Buffer.from(JSON.stringify(candidate)) },
      ]),
    );
  }
} else if (mode === 'dispatch') {
  const body = JSON.parse(readFileSync(path.join(root, 'dispatch.json'), 'utf8'));
  assert.equal(body.ref, 'main');
  assert.equal(body.inputs.release_products_json, '["oliphaunt-js"]');
  assert(body.inputs.qualification_request.startsWith(sha));
} else if (mode === 'output') {
  const values = Object.fromEntries(
    readFileSync(path.join(root, 'output'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => {
        const index = line.indexOf('=');
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
  assert.equal(values.run_id, '77');
  assert.equal(values.run_attempt, '3');
  assert.deepEqual(JSON.parse(values.artifact_metadata_json), [
    { digest: `sha256:${'1'.repeat(64)}`, id: 901, name: 'required-artifact', size: 123 },
  ]);
  assert.deepEqual(
    JSON.parse(values.gate_artifact_metadata_json),
    scenario === 'gate'
      ? [{ digest: `sha256:${'2'.repeat(64)}`, id: 903, name: 'gate-artifact', size: 456 }]
      : [],
  );
} else throw Error('expected prepare, dispatch or output');
