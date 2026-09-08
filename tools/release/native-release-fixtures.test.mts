import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { currentProductVersionSync } from '../../src/shared/product-metadata/release-artifact-targets.mts';
import { ROOT } from '../../src/shared/product-metadata/release-graph.mts';

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
    run('tools/test/create-liboliphaunt-release-fixture.mts', [
      '--asset-dir',
      liboliphauntAssets,
      '--version',
      liboliphauntVersion,
    ]),
    'creating liboliphaunt release fixture',
  );
  expectSuccess(
    run('src/runtimes/liboliphaunt/native/tools/check-release-assets.mts', [
      '--asset-dir',
      liboliphauntAssets,
    ]),
    'validating liboliphaunt release fixture',
  );
  expectSuccess(
    run('tools/test/create-broker-release-fixture.mts', [
      '--asset-dir',
      brokerAssets,
      '--version',
      brokerVersion,
    ]),
    'creating broker release fixture',
  );
  expectSuccess(
    run('src/runtimes/broker/tools/check-release-assets.mts', ['--asset-dir', brokerAssets]),
    'validating broker release fixture',
  );
});
