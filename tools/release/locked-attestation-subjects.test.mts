#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  githubOutputForAttestationSubjects,
  lockedAttestationSubjects,
} from './locked-attestation-subjects.mts';
import { compareText, ROOT } from './release-graph.mts';

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

test('the workflow attests the complete selected release with one provenance bundle', async () => {
  const workflow = Bun.YAML.parse(
    await readFile(path.join(ROOT, '.github/workflows/release.yml'), 'utf8'),
  );
  const steps = workflow.jobs.publish.steps;
  const resolver = steps.find((step) => step.id === 'release_provenance_subjects');
  assert.match(resolver.env.PRODUCTS_JSON, /release_plan\)\.products_json/);
  assert.match(resolver.run, /--products-json "\$PRODUCTS_JSON"/);
  const actions = steps.filter((step) => step.uses?.startsWith('actions/attest-build-provenance@'));
  assert.equal(actions.length, 1);
  assert.equal(
    actions[0].with['subject-path'],
    '${{ steps.release_provenance_subjects.outputs.subject_paths }}',
  );
  assert.equal(
    actions[0].if,
    "${{ steps.release_provenance_subjects.outputs.has_subjects == 'true' }}",
  );
  const receipt = steps.find((step) => step.id === 'freeze_github_evidence');
  assert.equal(
    receipt.env.RELEASE_PROVENANCE_BUNDLE,
    '${{ steps.release_provenance.outputs.bundle-path }}',
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

test('GitHub outputs describe the subject set and skip an empty release', () => {
  const subjects = ['target/first.bin', 'target/second.bin'];
  const output = githubOutputForAttestationSubjects(subjects);
  assert.match(output, /^subject_count=2$/mu);
  assert.match(output, /^has_subjects=true$/mu);
  for (const subject of subjects) assert.equal(output.split(subject).length - 1, 1);
  assert.match(githubOutputForAttestationSubjects([]), /^has_subjects=false$/mu);
  assert.throws(
    () => githubOutputForAttestationSubjects([subjects[0], subjects[0]]),
    /unique safe paths/u,
  );
  assert.match(
    githubOutputForAttestationSubjects(['OLIPHAUNT_RELEASE_PROVENANCE_SUBJECTS']),
    /^subject_paths<<OLIPHAUNT_RELEASE_PROVENANCE_SUBJECTS_END$/mu,
  );
  assert.throws(
    () =>
      githubOutputForAttestationSubjects(
        Array.from({ length: 1025 }, (_, index) => `subject-${index}`),
      ),
    /1024-subject attestation limit/u,
  );
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
    const subjects = lockedAttestationSubjects(lock, products);
    assert.deepEqual(
      subjects.sort(compareText),
      lock.productArtifacts.map((a) => a.path).sort(compareText),
    );
    assert.deepEqual(lockedAttestationSubjects(lock, ['oliphaunt-rust']), []);
    assert.match(githubOutputForAttestationSubjects([]), /^subject_count=0$/mu);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
