#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  githubOutputForAttestationSubjectShards,
  lockedAttestationSubjectShards,
  lockedAttestationSubjects,
} from './locked-attestation-subjects.mts';
import { compareText, ROOT } from './release-graph.mts';

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

test('the workflow uses exact full-selection subjects for every attestation batch', async () => {
  const workflow = Bun.YAML.parse(
    await readFile(path.join(ROOT, '.github/workflows/release.yml'), 'utf8'),
  );
  const steps = workflow.jobs.publish.steps;
  const resolver = steps.find((step) => step.id === 'release_attestation_subjects');
  assert.match(resolver.env.PRODUCTS_JSON, /release_plan\)\.products_json/);
  assert.match(resolver.run, /--products-json "\$PRODUCTS_JSON"/);
  const actions = steps.filter((step) => step.uses?.startsWith('actions/attest-build-provenance@'));
  assert.equal(actions.length, 2);
  for (const [index, action] of actions.entries()) {
    assert.equal(
      action.with['subject-path'],
      '${{ steps.release_attestation_subjects.outputs.paths_' + (index + 1) + ' }}',
    );
    assert.equal(
      action.if,
      '${{ steps.release_attestation_subjects.outputs.nonempty_' + (index + 1) + " == 'true' }}",
    );
  }
  const receipt = steps.find((step) => step.id === 'freeze_github_evidence');
  assert.equal(
    receipt.env.RELEASE_ATTESTATION_BUNDLE_1,
    '${{ steps.attest_release_1.outputs.bundle-path }}',
  );
  assert.equal(
    receipt.env.RELEASE_ATTESTATION_BUNDLE_2,
    '${{ steps.attest_release_2.outputs.bundle-path }}',
  );
});

async function fixture(productCounts) {
  const root = path.join(
    ROOT,
    'target',
    'release',
    `locked-attestation-subjects-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  const productArtifacts = [];
  for (const [product, count] of Object.entries(productCounts)) {
    for (let index = 0; index < count; index += 1) {
      const id = `subject-${index + 1}`;
      const role = index % 2 === 0 ? 'github-release-asset' : 'github-release-metadata';
      const file = path.join(root, product, 'release-assets', `${id}.bin`);
      const bytes = Buffer.from(`${product}:${id}\n`);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, bytes);
      productArtifacts.push({
        product,
        id,
        role,
        path: path.relative(ROOT, file).split(path.sep).join('/'),
        sha256: digest(bytes),
        size: bytes.length,
      });
    }
  }
  return {
    lock: {
      products: Object.keys(productCounts).map((id) => ({ id })),
      productArtifacts,
    },
    root,
  };
}

test('a single external-extension selection excludes every downloaded unselected extension subject', async () => {
  const { lock, root } = await fixture({
    'extension-pgvector': 2,
    'extension-postgis': 2,
  });
  try {
    const subjects = lockedAttestationSubjects(lock, ['extension-pgvector']);
    assert.equal(subjects.length, 2);
    assert.ok(subjects.every((subject) => subject.includes('/extension-pgvector/')));
    assert.ok(subjects.every((subject) => !subject.includes('/extension-postgis/')));

    await writeFile(path.resolve(ROOT, subjects[0]), 'tampered\n');
    assert.throws(
      () => lockedAttestationSubjects(lock, ['extension-pgvector']),
      /bytes do not match the publication lock/u,
    );
    assert.throws(
      () => lockedAttestationSubjects(lock, ['extension-pgvector', 'extension-pgvector']),
      /unique string list/u,
    );
    assert.throws(
      () => lockedAttestationSubjects(lock, ['extension-unknown']),
      /absent from the publication lock/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('two deterministic balanced shards form the exact disjoint selected subject union', async () => {
  const { lock, root } = await fixture({
    'extension-pgvector': 5,
    'extension-postgis': 4,
    'extension-unselected': 3,
  });
  try {
    const products = ['extension-postgis', 'extension-pgvector'];
    const exact = lockedAttestationSubjects(lock, products);
    const shards = lockedAttestationSubjectShards(lock, products);

    assert.deepEqual(lockedAttestationSubjectShards(lock, products), shards);
    assert.equal(shards.length, 2);
    assert.ok(shards.every((shard) => shard.length <= 1_024));
    assert.ok(Math.abs(shards[0].length - shards[1].length) <= 1);
    assert.deepEqual(shards.flat().sort(compareText), exact);
    assert.equal(new Set(shards.flat()).size, exact.length);
    assert.ok(shards[0].every((subject) => !new Set(shards[1]).has(subject)));
    assert.ok(shards.flat().every((subject) => !subject.includes('/extension-unselected/')));

    assert.throws(
      () => lockedAttestationSubjectShards(lock, products, { maxSubjectsPerShard: 4 }),
      /exceed 2 attestation shards at the 4-subject per-bundle limit/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a one-subject partial release skips the empty shard through explicit count and nonempty outputs', async () => {
  const { lock, root } = await fixture({ 'extension-single': 1 });
  try {
    const exact = lockedAttestationSubjects(lock, ['extension-single']);
    const shards = lockedAttestationSubjectShards(lock, ['extension-single']);
    assert.deepEqual(shards, [exact, []]);

    const output = githubOutputForAttestationSubjectShards(shards);
    assert.match(output, /^total_count=1$/mu);
    assert.match(output, /^count_1=1$/mu);
    assert.match(output, /^nonempty_1=true$/mu);
    assert.match(output, /^count_2=0$/mu);
    assert.match(output, /^nonempty_2=false$/mu);
    assert.equal(output.split(exact[0]).length - 1, 1);
    assert.throws(
      () => githubOutputForAttestationSubjectShards([[exact[0]], [exact[0]]]),
      /unique safe paths/u,
    );
    const delimiterCollision = githubOutputForAttestationSubjectShards([
      ['OLIPHAUNT_RELEASE_ATTESTATION_SUBJECTS_1'],
      [],
    ]);
    assert.match(delimiterCollision, /^paths_1<<OLIPHAUNT_RELEASE_ATTESTATION_SUBJECTS_1_END$/mu);
    assert.throws(
      () =>
        githubOutputForAttestationSubjectShards([
          Array.from({ length: 1_025 }, (_, index) => `subject-${index}`),
          [],
        ]),
      /1024-subject per-bundle limit/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('mixed products cover every frozen GitHub asset and skip products with empty asset sets', async () => {
  const counts = {
    'database-resources': 3,
    'postgres-tools-native': 2,
    'postgres-tools-wasix': 2,
    'oliphaunt-swift': 1,
    'oliphaunt-rust': 0,
  };
  const { lock, root } = await fixture(counts);
  try {
    const products = Object.keys(counts);
    const shards = lockedAttestationSubjectShards(lock, products);
    assert.deepEqual(
      shards.flat().sort(compareText),
      lock.productArtifacts.map((a) => a.path).sort(compareText),
    );
    assert.deepEqual(lockedAttestationSubjectShards(lock, ['oliphaunt-rust']), [[], []]);
    assert.match(githubOutputForAttestationSubjectShards([[], []]), /^total_count=0$/mu);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
