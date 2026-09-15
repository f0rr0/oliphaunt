import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  discoverCompletedBootstrap,
  installCompletedBootstrap,
  isCompletedMainRelease,
} from '../../.github/scripts/download-completed-bootstrap.mts';
import {
  appendBootstrapCheckpoint,
  buildBootstrapLedger,
  loadBootstrapLedger,
} from './bootstrap-ledger.mts';

const repo = 'f0rr0/oliphaunt';
const lock = {
  lockDigest: 'a'.repeat(64),
  catalogDigest: 'b'.repeat(64),
  packageEnvelopeDigest: 'c'.repeat(64),
  source: { commit: '1'.repeat(40), tree: '2'.repeat(40) },
  products: [{ id: 'alpha' }],
  carriers: [
    {
      id: 'cargo:alpha',
      product: 'alpha',
      ecosystem: 'cargo',
      name: 'alpha',
      version: '1.0.0',
      role: 'platform-leaf',
      target: 'linux',
      publishOrder: 0,
      artifacts: [{ path: 'target/alpha.crate', sha256: 'd'.repeat(64), size: 42 }],
    },
  ],
};
const run = {
  id: 123,
  status: 'completed',
  conclusion: 'success',
  event: 'workflow_dispatch',
  head_branch: 'main',
  path: '.github/workflows/release.yml',
  repository: { full_name: repo },
  head_repository: { full_name: repo },
  head_sha: '3'.repeat(40),
};

test('completed bootstrap discovery requires canonical successful main workflow origin', () => {
  assert.equal(isCompletedMainRelease(run, repo), true);
  for (const change of [
    { conclusion: 'failure' },
    { status: 'in_progress' },
    { event: 'pull_request' },
    { head_branch: 'other' },
    { path: '.github/workflows/other.yml' },
    { repository: { full_name: 'fork/oliphaunt' } },
    { head_repository: { full_name: 'fork/oliphaunt' } },
    { head_sha: 'main' },
    { id: -1 },
  ])
    assert.equal(isCompletedMainRelease({ ...run, ...change }, repo), false);
});

test('new publisher reuses a completed older bootstrap, rejecting incomplete, corrupt, and wrong evidence', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'completed-bootstrap-'));
  const destination = path.join(root, 'ledger');
  let mode = 'complete';

  const artifact = {
    id: 456,
    name: 'oliphaunt-bootstrap-ledger',
    expired: false,
    digest: 'sha256:' + 'e'.repeat(64),
    size_in_bytes: 42,
  };
  const dependencies = {
    list: (endpoint) => (endpoint.includes('/artifacts') ? [artifact] : [run]),
    download: (observed, envelope, directory) => {
      assert.equal(observed.id, run.id);
      assert.equal(envelope.id, artifact.id);
      const input = structuredClone(lock);
      if (mode === 'wrong-lock') input.lockDigest = 'f'.repeat(64);
      if (mode === 'wrong-source') input.source.commit = '9'.repeat(40);
      appendBootstrapCheckpoint(directory, input, ['alpha'], []);
      if (mode !== 'incomplete') {
        const publication = buildBootstrapLedger(input, ['alpha']).publications[0];
        appendBootstrapCheckpoint(
          directory,
          input,
          ['alpha'],
          [
            {
              id: publication.id,
              product: publication.product,
              ecosystem: publication.ecosystem,
              name: publication.name,
              version: publication.version,
              lockedArtifacts: publication.artifacts,
              registryProof: {
                ...publication.registryExpectation,
                url: 'https://crates.io/api/v1/crates/alpha/1.0.0',
              },
            },
          ],
        );
      }
      if (mode === 'corrupt') {
        const file = path.join(directory, readdirSync(directory).sort()[1]);
        const checkpoint = JSON.parse(readFileSync(file, 'utf8'));
        checkpoint.receipts[0].registryProof.digest = 'f'.repeat(64);
        writeFileSync(file, JSON.stringify(checkpoint));
      }
      if (mode === 'extra') writeFileSync(path.join(directory, 'unexpected'), 'bytes');
    },
  };
  async function restore() {
    const stage = path.join(root, 'stage');
    try {
      const selected = await discoverCompletedBootstrap({ repo, lock, stage }, dependencies);
      return installCompletedBootstrap({
        run: selected,
        stage,
        lock,
        destination,
        environment: {
          OLIPHAUNT_PUBLICATION_CONTROLLER_JSON: JSON.stringify({
            source: lock.source.commit,
            controller: mode === 'source' ? '0'.repeat(40) : selected.head_sha,
            mode: 'changes',
          }),
        },
      });
    } finally {
      rmSync(stage, { force: true, recursive: true });
    }
  }
  try {
    assert.equal(await restore(), run.id);

    const before = loadBootstrapLedger(destination, lock, ['alpha'], {
      requireComplete: true,
    }).checkpointDigest;
    for (const [value, pattern] of [
      ['incomplete', /incomplete/u],
      ['corrupt', /digest mismatch/u],
      ['wrong-lock', /no completed main bootstrap/u],
      ['wrong-source', /not bound/u],
      ['source', /matching proof/u],
      ['extra', /only checkpoint/u],
    ]) {
      mode = value;
      await assert.rejects(() => restore(), pattern);
      assert.equal(
        loadBootstrapLedger(destination, lock, ['alpha'], { requireComplete: true })
          .checkpointDigest,
        before,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
