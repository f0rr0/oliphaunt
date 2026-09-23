#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

import {
  buildTrustedPublisherPlan,
  classifyCratesIoTrustConfigs,
  classifyNpmTrustConfigs,
  createCratesIoTrustClient,
  EXPECTED_TRUSTED_PUBLISHER,
  NPM_TRUST_BATCH_SIZE,
  reconcileTrustedPublishers,
  reconcileTrustedPublishersToFile,
  reserveJsonFile,
  selectTrustedPublisherIdentities,
  writeJson,
  writeJsonFile,
} from './trusted-publisher-config.mts';

function carrier(ecosystem, name, product = 'one') {
  return {
    id: `${ecosystem}:${name}`,
    ecosystem,
    name,
    product,
    version: '1.2.3',
  };
}

function lock(carriers) {
  return {
    lockDigest: 'a'.repeat(64),
    catalogDigest: 'b'.repeat(64),
    source: { commit: 'c'.repeat(40), tree: 'd'.repeat(40) },
    products: [
      { id: 'one', version: '1.2.3' },
      { id: 'two', version: '2.0.0' },
    ],
    carriers,
  };
}

function exactNpm() {
  return {
    id: 'publisher-id',
    type: 'github',
    repository: EXPECTED_TRUSTED_PUBLISHER.repository,
    file: EXPECTED_TRUSTED_PUBLISHER.workflowFilename,
    environment: EXPECTED_TRUSTED_PUBLISHER.environment,
    permissions: [...EXPECTED_TRUSTED_PUBLISHER.npmPermissions],
  };
}

function exactCrates(name) {
  return {
    id: 1,
    crate: name,
    repository_owner: EXPECTED_TRUSTED_PUBLISHER.repositoryOwner,
    repository_name: EXPECTED_TRUSTED_PUBLISHER.repositoryName,
    workflow_filename: EXPECTED_TRUSTED_PUBLISHER.workflowFilename,
    environment: EXPECTED_TRUSTED_PUBLISHER.environment,
  };
}

const [fixtureMode, fixtureRoot, scenario] = process.argv.slice(2);
if (fixtureMode === 'pipe') {
  await writeJson({ payload: 'x'.repeat(90000), tail: 'complete' });
  process.exit(0);
}
if (fixtureMode === 'assert-pipe') {
  const output = await readFile(fixtureRoot);
  assert(output.length > 80 * 1024);
  assert.equal(output.at(-1), 0x0a);
  assert.deepEqual(JSON.parse(output.toString('utf8')), {
    payload: 'x'.repeat(90000),
    tail: 'complete',
  });
  process.exit(0);
}
if (fixtureMode === 'prepare') {
  const plan = buildTrustedPublisherPlan(lock([carrier('npm', '@oliphaunt/example')]));
  const selection = selectTrustedPublisherIdentities(plan, 'npm', 1);
  await writeFile(
    path.join(fixtureRoot, 'context.json'),
    JSON.stringify({
      plan,
      selection,
      apply: true,
      output: path.join(fixtureRoot, scenario + '.json'),
    }),
  );
  await writeFile(path.join(fixtureRoot, 'exact.json'), JSON.stringify([exactNpm()]));
  await writeFile(
    path.join(fixtureRoot, 'conflicting.json'),
    JSON.stringify([{ ...exactNpm(), repository: 'wrong/repo' }]),
  );
  if (scenario === 'rerun')
    await writeFile(path.join(fixtureRoot, scenario + '.state'), 'published');
  process.exit(0);
}
if (fixtureMode === 'assert') {
  const output = path.join(fixtureRoot, scenario + '.json');
  const log = await readFile(path.join(fixtureRoot, scenario + '.events'), 'utf8');
  assert.equal(
    log.split('\n').filter((line) => line.startsWith('github ')).length,
    ['ambiguous', 'missing'].includes(scenario) ? 1 : 0,
  );
  assert(
    !(await readdir(fixtureRoot)).some(
      (name) =>
        name.endsWith('.oliphaunt-reservation') || name.startsWith('.trusted-publisher-report.'),
    ),
  );
  if (scenario === 'missing')
    await assert.rejects(stat(output), (cause) => cause.code === 'ENOENT');
  else {
    const report = JSON.parse(await readFile(output, 'utf8'));
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.deepEqual(report.created, scenario === 'ambiguous' ? ['npm:@oliphaunt/example'] : []);
    assert.equal(report.conflicts.length, scenario === 'conflict' ? 1 : 0);
  }
  process.exit(0);
}

test('derives exact npm/Cargo identities and bounded npm batches from the lock', () => {
  const npm = Array.from({ length: NPM_TRUST_BATCH_SIZE + 1 }, (_, index) =>
    carrier('npm', `@oliphaunt/package-${String(index).padStart(2, '0')}`),
  );
  const plan = buildTrustedPublisherPlan(lock([carrier('cargo', 'oliphaunt-one'), ...npm]));
  assert.deepEqual(plan.counts, {
    cargo: 1,
    npm: NPM_TRUST_BATCH_SIZE + 1,
    total: NPM_TRUST_BATCH_SIZE + 2,
  });
  assert.equal(plan.npmBatches.length, 2);
  assert.deepEqual(
    plan.npmBatches.map(({ count }) => count),
    [NPM_TRUST_BATCH_SIZE, 1],
  );
  assert.equal(plan.expected.workflowFilename, 'release.yml');
  assert.equal(plan.expected.environment, 'release-publish');

  assert.throws(() => selectTrustedPublisherIdentities(plan, 'npm'), /requires --batch/u);
  assert.equal(selectTrustedPublisherIdentities(plan, 'npm', 2).identities.length, 1);
  assert.equal(selectTrustedPublisherIdentities(plan, 'cargo').identities.length, 1);
  assert.throws(() => selectTrustedPublisherIdentities(plan, 'cargo', 1), /used only for npm/u);
});

test('rejects unknown or duplicate product selection', () => {
  const value = lock([carrier('cargo', 'oliphaunt-one')]);
  assert.throws(
    () => buildTrustedPublisherPlan(value, { products: ['missing'] }),
    /absent from the exact lock/u,
  );
  assert.throws(
    () => buildTrustedPublisherPlan(value, { products: ['one', 'one'] }),
    /unique string list/u,
  );
});

test('classifies only the exact npm publish permission and caller identity as trusted', () => {
  assert.deepEqual(classifyNpmTrustConfigs([]), { state: 'missing' });
  assert.deepEqual(classifyNpmTrustConfigs([exactNpm()]), { state: 'exact' });
  assert.equal(classifyNpmTrustConfigs([{ ...exactNpm(), file: 'wrong.yml' }]).state, 'conflict');
  assert.equal(
    classifyNpmTrustConfigs([
      {
        ...exactNpm(),
        permissions: ['createPackage', 'createStagedPackage'],
      },
    ]).state,
    'conflict',
  );
  assert.equal(classifyNpmTrustConfigs([exactNpm(), exactNpm()]).state, 'conflict');
});

test('classifies crates.io configuration strictly and treats extras as conflicts', () => {
  assert.deepEqual(classifyCratesIoTrustConfigs([], 'oliphaunt-one'), { state: 'missing' });
  assert.deepEqual(classifyCratesIoTrustConfigs([exactCrates('oliphaunt-one')], 'oliphaunt-one'), {
    state: 'exact',
  });
  assert.equal(
    classifyCratesIoTrustConfigs(
      [
        {
          ...exactCrates('oliphaunt-one'),
          environment: null,
        },
      ],
      'oliphaunt-one',
    ).state,
    'conflict',
  );
  assert.equal(
    classifyCratesIoTrustConfigs(
      [
        exactCrates('oliphaunt-one'),
        { ...exactCrates('oliphaunt-one'), id: 2, repository_name: 'other' },
      ],
      'oliphaunt-one',
    ).state,
    'conflict',
  );
});

test('file reports are atomically created as mode 0600, complete, and never overwritten', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oliphaunt-trust-report-'));
  try {
    const output = path.join(directory, 'npm-audit.json');
    const report = {
      payload: 'x'.repeat(90_000),
      tail: 'complete',
    };
    assert.equal(await writeJsonFile(report, output), output);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    const bytes = await readFile(output, 'utf8');
    assert.ok(Buffer.byteLength(bytes) > 80 * 1024);
    assert.equal(bytes.at(-1), '\n');
    assert.deepEqual(JSON.parse(bytes), report);
    await assert.rejects(
      () => writeJsonFile({ replaced: true }, output),
      /refusing to overwrite existing --output file/u,
    );
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), report);
    assert.deepEqual(await readdir(directory), ['npm-audit.json']);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('reservation never exposes the final path before a complete commit', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oliphaunt-trust-atomic-'));
  try {
    const output = path.join(directory, 'pending.json');
    const reserved = await reserveJsonFile(output);
    await assert.rejects(
      () => stat(output),
      (cause) => cause.code === 'ENOENT',
    );
    const during = await readdir(directory);
    assert.ok(during.some((entry) => entry.endsWith('.oliphaunt-reservation')));
    assert.ok(during.some((entry) => entry.includes('.tmp-')));
    assert.ok(!during.includes('pending.json'));
    assert.ok(!during.some((entry) => entry.includes('.probe-')));
    await reserved.abort();
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('report reservation fails before every registry call', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oliphaunt-trust-reservation-'));
  try {
    const existing = path.join(directory, 'existing.json');
    await writeJsonFile({ existing: true }, existing);
    const plan = buildTrustedPublisherPlan(lock([carrier('npm', '@oliphaunt/example')]));
    let calls = 0;
    const options = {
      plan,
      ecosystem: 'npm',
      batch: 1,
      apply: true,
      client: {
        authorizeAudit() {
          calls += 1;
        },
        async list() {
          calls += 1;
          return [];
        },
        async create() {
          calls += 1;
        },
      },
      sleepImpl: async () => {},
    };
    await assert.rejects(
      () =>
        reconcileTrustedPublishersToFile({
          ...options,
          outputFile: existing,
        }),
      /refusing to overwrite existing --output file/u,
    );
    await assert.rejects(
      () =>
        reconcileTrustedPublishersToFile({
          ...options,
          outputFile: path.join(directory, 'missing-parent', 'report.json'),
        }),
      /could not reserve --output file/u,
    );
    assert.equal(calls, 0, 'output reservation must precede registry calls');
    assert.deepEqual(await readdir(directory), ['existing.json']);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('crates.io client uses scoped bearer auth, exact payload, and no delete path', async () => {
  const calls = [];
  const client = createCratesIoTrustClient({
    token: 'configuration-secret',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      if (init.method === 'GET') {
        return new Response(
          JSON.stringify({
            github_configs: [exactCrates('oliphaunt-one')],
            meta: { total: 1, next_page: null },
          }),
        );
      }
      return new Response(JSON.stringify({ github_config: exactCrates('oliphaunt-one') }));
    },
    sleepImpl: async () => {},
  });
  assert.deepEqual(await client.list('oliphaunt-one'), [exactCrates('oliphaunt-one')]);
  await client.create('oliphaunt-one');
  const getUrl = new URL(calls[0].url);
  assert.equal(
    getUrl.origin + getUrl.pathname,
    'https://crates.io/api/v1/trusted_publishing/github_configs',
  );
  assert.equal(getUrl.searchParams.get('crate'), 'oliphaunt-one');
  assert.equal(
    new Headers(calls[0].init.headers).get('authorization'),
    'Bearer configuration-secret',
  );
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    github_config: {
      crate: 'oliphaunt-one',
      repository_owner: 'f0rr0',
      repository_name: 'oliphaunt',
      workflow_filename: 'release.yml',
      environment: 'release-publish',
    },
  });
  assert.ok(calls.every(({ init }) => init.method !== 'DELETE'));
});

test('crates.io read audit retries bounded retryable responses but create is not replayed', async () => {
  let reads = 0;
  const sleeps = [];
  const client = createCratesIoTrustClient({
    token: 'configuration-secret',
    fetchImpl: async (_url, init) => {
      if (init.method === 'POST') return new Response('unavailable', { status: 503 });
      reads += 1;
      if (reads === 1)
        return new Response('busy', { status: 503, headers: { 'Retry-After': '0' } });
      return new Response(
        JSON.stringify({ github_configs: [], meta: { total: 0, next_page: null } }),
      );
    },
    sleepImpl: async (milliseconds) => sleeps.push(milliseconds),
  });
  assert.deepEqual(await client.list('oliphaunt-one'), []);
  assert.equal(reads, 2);
  assert.deepEqual(sleeps, [0]);
  await assert.rejects(() => client.create('oliphaunt-one'), /HTTP 503/u);
});

test('apply is pre-audited, idempotent, and verified after each missing configuration', async () => {
  const plan = buildTrustedPublisherPlan(
    lock([carrier('cargo', 'oliphaunt-one'), carrier('cargo', 'oliphaunt-two')]),
  );
  const state = new Map([
    ['oliphaunt-one', [exactCrates('oliphaunt-one')]],
    ['oliphaunt-two', []],
  ]);
  const creates = [];
  const sleeps = [];
  const events = [];
  const client = {
    async list(name) {
      events.push(`list:${name}`);
      return structuredClone(state.get(name));
    },
    async create(name) {
      events.push(`create:${name}`);
      creates.push(name);
      state.set(name, [exactCrates(name)]);
    },
  };
  const report = await reconcileTrustedPublishers({
    plan,
    ecosystem: 'cargo',
    apply: true,
    client,
    sleepImpl: async (milliseconds) => {
      sleeps.push(milliseconds);
      events.push(`sleep:${milliseconds}`);
    },
  });
  assert.equal(report.mode, 'apply');
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.conflicts, []);
  assert.deepEqual(report.created, ['cargo:oliphaunt-two']);
  assert.deepEqual(creates, ['oliphaunt-two']);
  assert.equal(sleeps.length, 6);
  assert.deepEqual(events.slice(0, 5), [
    'list:oliphaunt-one',
    'sleep:250',
    'list:oliphaunt-two',
    'sleep:250',
    'create:oliphaunt-two',
  ]);

  const second = await reconcileTrustedPublishers({
    plan,
    ecosystem: 'cargo',
    apply: true,
    client,
    sleepImpl: async () => {},
  });
  assert.deepEqual(second.created, []);
  assert.deepEqual(creates, ['oliphaunt-two']);
});

test('an applied trusted-publisher mutation with a lost response reconciles without replay', async () => {
  const plan = buildTrustedPublisherPlan(lock([carrier('cargo', 'oliphaunt-one')]));
  let present = false;
  let creates = 0;
  const report = await reconcileTrustedPublishers({
    plan,
    ecosystem: 'cargo',
    apply: true,
    client: {
      async list() {
        return present ? [exactCrates('oliphaunt-one')] : [];
      },
      async create() {
        creates += 1;
        present = true;
        throw new Error('response timed out after the registry applied the configuration');
      },
    },
    sleepImpl: async () => {},
  });
  assert.equal(creates, 1);
  assert.deepEqual(report.created, ['cargo:oliphaunt-one']);
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.conflicts, []);
});

test('any conflicting configuration blocks every mutation in the selected batch', async () => {
  const plan = buildTrustedPublisherPlan(
    lock([carrier('cargo', 'oliphaunt-one'), carrier('cargo', 'oliphaunt-two')]),
  );
  let creates = 0;
  const client = {
    async list(name) {
      return name === 'oliphaunt-one'
        ? []
        : [{ ...exactCrates(name), workflow_filename: 'wrong.yml' }];
    },
    async create() {
      creates += 1;
    },
  };
  const report = await reconcileTrustedPublishers({
    plan,
    ecosystem: 'cargo',
    apply: true,
    client,
    sleepImpl: async () => {},
  });
  assert.equal(report.mode, 'apply-blocked');
  assert.equal(report.conflicts.length, 1);
  assert.equal(creates, 0);
});
