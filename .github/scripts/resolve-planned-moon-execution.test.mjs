#!/usr/bin/env node
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';

import {resolveExecution} from './resolve-planned-moon-execution.mjs';

const tasks = new Map([
  ['release:package', {target: 'release:package', deps: [{target: 'sdk:package'}, {target: 'native:ios'}]}],
  ['sdk:package', {target: 'sdk:package', deps: [{target: 'sdk:compile'}]}],
  ['sdk:compile', {target: 'sdk:compile', deps: []}],
  ['native:ios', {target: 'native:ios', deps: [{target: 'source:fetch'}]}],
  ['source:fetch', {target: 'source:fetch', deps: []}],
]);

test('leaves ordinary Moon execution intact when no dependency was transferred', () => {
  assert.deepEqual(resolveExecution(['release:package'], [], tasks), {
    localDependencies: [],
    targets: ['release:package'],
    transferred: [],
  });
});

test('preserves local prerequisites while subtracting a transferred producer', () => {
  assert.deepEqual(resolveExecution(['release:package'], ['native:ios'], tasks), {
    localDependencies: ['sdk:package'],
    targets: ['release:package'],
    transferred: ['native:ios'],
  });
});

test('rejects an unrelated or transitively required transferred producer', () => {
  assert.throws(
    () => resolveExecution(['release:package'], ['source:fetch'], tasks),
    /not a direct dependency/u,
  );
  const conflicting = new Map(tasks);
  conflicting.set('sdk:package', {target: 'sdk:package', deps: [{target: 'native:ios'}]});
  assert.throws(
    () => resolveExecution(['release:package'], ['native:ios'], conflicting),
    /still required by a local prerequisite/u,
  );
});

test('fails closed when the task graph is incomplete', () => {
  assert.throws(
    () => resolveExecution(['missing:root'], [], tasks),
    /selected target missing:root is missing/u,
  );
  const incomplete = new Map(tasks);
  incomplete.delete('sdk:compile');
  assert.throws(
    () => resolveExecution(['release:package'], ['native:ios'], incomplete),
    /dependency sdk:compile is missing/u,
  );
});

test('resolves a real multi-root job with downloaded dependencies', () => {
  const result = spawnSync(process.execPath, [
    '.github/scripts/resolve-planned-moon-execution.mjs',
    'wasix-ts-sdk-package',
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      OLIPHAUNT_CI_JOB_TARGETS_JSON: JSON.stringify({
        'wasix-ts-sdk-package': [
          'release-tools:wasix-ts-sdk-package',
          'wasix-ts-integration:runtime',
        ],
      }),
      OLIPHAUNT_MOON_TRANSFERRED_DEPS_JSON: JSON.stringify([
        'liboliphaunt-wasix:runtime-portable',
        'release-tools:wasix-napi-runtime',
      ]),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^local\toliphaunt-wasix-ts:package$/mu);
  assert.match(result.stdout, /^target\twasix-ts-integration:runtime$/mu);
  assert.match(result.stdout, /^transferred\tliboliphaunt-wasix:runtime-portable$/mu);
});

test('runs one exact matrix target and rejects targets outside the plan', () => {
  const env = {
    ...process.env,
    OLIPHAUNT_CI_JOB_TARGETS_JSON: JSON.stringify({
      'liboliphaunt-native-android': [
        'liboliphaunt-native:package-runtime-android-arm64-v8a',
        'liboliphaunt-native:package-runtime-android-x86_64',
      ],
    }),
  };
  const selected = spawnSync(process.execPath, [
    '.github/scripts/resolve-planned-moon-execution.mjs',
    'liboliphaunt-native-android',
    'liboliphaunt-native:package-runtime-android-x86_64',
  ], {encoding: 'utf8', env});
  assert.equal(selected.status, 0, selected.stderr);
  assert.equal(selected.stdout.trim(), 'target\tliboliphaunt-native:package-runtime-android-x86_64');

  const rejected = spawnSync(process.execPath, [
    '.github/scripts/resolve-planned-moon-execution.mjs',
    'liboliphaunt-native-android',
    'liboliphaunt-native:package-runtime-ios-xcframework',
  ], {encoding: 'utf8', env});
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /is not planned/u);
});
