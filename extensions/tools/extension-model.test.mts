import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  evidenceMatrix,
  evidenceTable,
  observedWasixModes,
  sourceDigest,
  sourceDigestInputs,
} from './extension-evidence.mts';
import { discoverCatalog, extensionProjections, readJson } from './extension-projections.mts';

const identity = { commit: '1'.repeat(40), tree: '2'.repeat(40) };
const catalog = { extensions: [{ id: 'vector', 'sql-name': 'vector' }] };
const matrix = () => Bun.TOML.parse(evidenceMatrix(catalog));
function run() {
  return {
    path: 'extensions/evidence/runs/current.json',
    run: {
      schema: 'oliphaunt-extension-evidence-v1',
      id: 'current',
      evidenceTier: 'wasix-full-lifecycle-v1',
      status: 'passed',
      sourceDigest: sourceDigest(),
      sourceDigestInputs: sourceDigestInputs(),
      sourceCommit: identity.commit,
      sourceTree: identity.tree,
      observedAt: '2026-09-08T00:00:00Z',
      collector: 'test',
      github: {
        repository: 'test/repo',
        workflow: 'CI',
        job: 'extensions',
        runId: 1,
        runAttempt: 1,
      },
      results: [
        {
          extension: 'vector',
          sqlName: 'vector',
          postgresMajor: 18,
          artifactFamily: 'wasix-runtime',
          platformTarget: 'portable',
          runtimeModeStatuses: {
            direct: 'passed',
            server: 'passed',
            restart: 'passed',
            'backup-restore': 'passed',
          },
        },
      ],
    },
  };
}

test('only observed passing results for the current source commit qualify', () => {
  const passing = run();
  const original = JSON.stringify(passing);
  assert.equal(
    evidenceTable(catalog, matrix(), [passing], identity, true).claims[0][
      'latest-accepted-evidence'
    ].length,
    1,
  );
  assert.equal(JSON.stringify(passing), original);
  for (const mutate of [
    (run: any) => {
      run.sourceDigest = `sha256:${'0'.repeat(64)}`;
    },
    (run: any) => {
      run.sourceCommit = '3'.repeat(40);
    },
    (run: any) => {
      run.sourceTree = '4'.repeat(40);
    },
    (run: any) => {
      run.results[0].runtimeModeStatuses['backup-restore'] = 'failed';
    },
    (run: any) => {
      run.status = 'failed';
    },
  ]) {
    const stale = structuredClone(passing);
    mutate(stale.run);
    assert(
      evidenceTable(catalog, matrix(), [stale], identity).claims[0]['missing-current-evidence']
        .length,
    );
    assert.throws(
      () => evidenceTable(catalog, matrix(), [stale], identity, true),
      /lacks current CI evidence/,
    );
  }
  const duplicate = structuredClone(passing);
  duplicate.run.results.push(duplicate.run.results[0]);
  assert.throws(
    () => evidenceTable(catalog, matrix(), [duplicate], identity),
    /duplicate evidence result/,
  );
  const mismatched = structuredClone(passing);
  mismatched.run.results[0].sqlName = 'postgis';
  assert.throws(() => evidenceTable(catalog, matrix(), [mismatched], identity), /SQL name differs/);
});

test('recording needs all five successful runtime observations', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'oliphaunt-evidence-'));
  try {
    for (const mode of ['direct', 'server', 'restart', 'materialization'])
      writeFileSync(`${directory}/vector.${mode}`, 'passed\n');
    assert.throws(() => observedWasixModes(directory, 'vector'));
    writeFileSync(`${directory}/vector.backup-restore`, 'failed\n');
    assert.throws(() => observedWasixModes(directory, 'vector'), /successful observation/);
    writeFileSync(`${directory}/vector.backup-restore`, 'passed\n');
    assert.equal(Object.keys(observedWasixModes(directory, 'vector')).length, 5);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('extension projections retain dependency and runtime data while deriving mobile versions', () => {
  const source = discoverCatalog();
  const metadata = readJson('extensions/generated/sdk/extensions.json');
  const releases = metadata.extensions.map((row: any) => ({
    sqlName: row['sql-name'],
    product: row['artifact-product'],
    versioning: row['runtime-bound'] ? 'runtime-bound' : 'independent',
    compatibility: { nativeRuntimeProduct: row['release-product'] },
    cargoPackage: row['cargo-package'],
    npmPackage: row['npm-package'],
    mavenGroup: row['maven-group'],
    mavenArtifact: row['maven-artifact'],
  }));
  const outputs = extensionProjections(source, releases);
  assert.deepEqual(JSON.parse(outputs.get('extensions/generated/sdk/extensions.json')!), metadata);
  const extension = source.extensions.find((row: any) => row.id === 'pg_textsearch');
  extension.control['default-version'] = '9.8.7';
  const updated = extensionProjections(source, releases).get(
    'extensions/generated/mobile/static-extensions.tsv',
  )!;
  assert(updated.includes('-DPG_TEXTSEARCH_VERSION="9.8.7"'));
  assert(!updated.includes('@EXTVERSION@'));
});
