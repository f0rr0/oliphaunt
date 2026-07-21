import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from '../test/fd-backed-spawn-sync.mjs';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { currentProductVersionSync } from './release-artifact-targets.mjs';
import { ROOT } from './release-graph.mjs';

const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryDirectory(label) {
  const directory = mkdtempSync(path.join(os.tmpdir(), `oliphaunt-${label}-`));
  temporaryRoots.push(directory);
  return directory;
}

function run(script, args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
  });
}

function expectSuccess(result, label) {
  expect(
    result.status,
    `${label} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  ).toBe(0);
}

test('release-shaped native fixtures satisfy the same binary and archive contracts as publish assets', {
  timeout: 30_000,
}, () => {
  const liboliphauntAssets = temporaryDirectory('liboliphaunt-native-fixture');
  const brokerAssets = temporaryDirectory('broker-native-fixture');
  const liboliphauntVersion = currentProductVersionSync('liboliphaunt-native');
  const brokerVersion = currentProductVersionSync('oliphaunt-broker');

  expectSuccess(
    run('tools/test/create-liboliphaunt-release-fixture.mjs', [
      '--asset-dir', liboliphauntAssets,
      '--version', liboliphauntVersion,
    ]),
    'creating liboliphaunt release fixture',
  );
  expectSuccess(
    run('tools/release/check-liboliphaunt-release-assets.mjs', [
      '--asset-dir', liboliphauntAssets,
    ]),
    'validating liboliphaunt release fixture',
  );
  const packageSize = path.join(
    liboliphauntAssets,
    `liboliphaunt-${liboliphauntVersion}-package-size.tsv`,
  );
  writeFileSync(
    packageSize,
    readFileSync(packageSize, 'utf8').replace(
      /^package\ttotal\t-\t-\t\d+$/mu,
      'package\ttotal\t-\t-\t0',
    ),
    'utf8',
  );
  const stalePackageSize = run('tools/release/check-liboliphaunt-release-assets.mjs', [
    '--asset-dir', liboliphauntAssets,
  ]);
  expect(stalePackageSize.status).not.toBe(0);
  expect(stalePackageSize.stderr).toContain(
    'must byte-match oliphaunt/package-size.tsv',
  );

  expectSuccess(
    run('tools/test/create-broker-release-fixture.mjs', [
      '--asset-dir', brokerAssets,
      '--version', brokerVersion,
    ]),
    'creating broker release fixture',
  );
  expectSuccess(
    run('tools/release/check-broker-release-assets.mjs', [
      '--asset-dir', brokerAssets,
    ]),
    'validating broker release fixture',
  );
});
