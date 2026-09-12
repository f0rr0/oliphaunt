#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveExecution } from './resolve-planned-moon-execution.mts';

const tasks = new Map([
  [
    'release:package',
    {
      target: 'release:package',
      deps: [
        { target: 'sdk:package', cacheStrategy: 'hash' },
        { target: 'native:ios', cacheStrategy: 'hash' },
        { target: 'sdk:cargo-sources', cacheStrategy: 'hash' },
      ],
    },
  ],
  ['sdk:package', { target: 'sdk:package', deps: [{ target: 'sdk:compile' }] }],
  ['sdk:compile', { target: 'sdk:compile', deps: [] }],
  ['native:ios', { target: 'native:ios', deps: [{ target: 'source:fetch' }] }],
  ['source:fetch', { target: 'source:fetch', deps: [] }],
  [
    'sdk:cargo-sources',
    { target: 'sdk:cargo-sources', command: 'noop', deps: [], options: { internal: true } },
  ],
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
  conflicting.set('sdk:package', { target: 'sdk:package', deps: [{ target: 'native:ios' }] });
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

test('rejects cycles between selected roots instead of running an arbitrary order', () => {
  const cyclic = new Map(tasks);
  cyclic.set('sdk:package', { deps: ['release:package'] });
  assert.throws(
    () => resolveExecution(['sdk:package', 'release:package'], ['native:ios'], cyclic),
    /dependency cycle/u,
  );
});
