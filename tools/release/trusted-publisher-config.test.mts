#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
  writeJsonFile,
} from './trusted-publisher-config.mts';

const MODULE_URL = new URL('trusted-publisher-config.mts', import.meta.url).href;

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

test("awaited JSON output remains complete through a pipe beyond Bun's 64 KiB console boundary", async () => {
  const script = [
    `const { writeJson } = await import(${JSON.stringify(MODULE_URL)});`,
    'await writeJson({ payload: "x".repeat(90_000), tail: "complete" });',
  ].join('\n');
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--eval', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('close', (status, signal) =>
      resolve({
        signal,
        status,
        stderr: Buffer.concat(stderr).toString('utf8'),
        stdout: Buffer.concat(stdout),
      }),
    );
  });
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.length > 80 * 1024);
  assert.equal(result.stdout.at(-1), 0x0a);
  assert.deepEqual(JSON.parse(result.stdout.toString('utf8')), {
    payload: 'x'.repeat(90_000),
    tail: 'complete',
  });
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

test('npm Shell owns authentication, blocks conflicts, and reconciles one mutation without replay', {
  skip: process.platform !== 'linux',
}, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oliphaunt-npm-trust-shell-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const npm = path.join(root, 'npm');
  const sleep = path.join(root, 'sleep');
  await writeFile(sleep, '#!/usr/bin/env bash\n[ "$1" = 2 ]\n');
  await writeFile(
    npm,
    String.raw`#!/usr/bin/env bash
set -eu
if [ "$1" = --version ]; then echo 11.15.0; exit; fi
[ "$1" = trust ]
printf '%s %s %s\n' "$2" "$3" "$NPM_CONFIG_FETCH_RETRIES" >> "$TEST_EVENTS"
if [ "$2" = list ]; then
  [ "$#" = 6 ] && [ "$4" = --json ] && [ "$5" = --registry ] && [ "$6" = https://registry.npmjs.org/ ]
  [ "$NPM_CONFIG_FETCH_RETRIES" = 3 ]
  if [ -t 1 ]; then [ -t 0 ]; echo 'discard this authentication display'; exit; fi
  if [ "$TEST_SCENARIO" = conflict ]; then echo "$TEST_CONFLICT"; exit; fi
  if [ -f "$TEST_STATE" ]; then echo "$TEST_EXACT"; else echo '[]'; fi
elif [ "$2" = github ]; then
  [ -t 0 ] && [ -t 1 ]
  [ "$NPM_CONFIG_FETCH_RETRIES" = 0 ]
  [ "$*" = 'trust github @oliphaunt/example --file release.yml --repo f0rr0/oliphaunt --env release-publish --allow-publish --yes --json --registry https://registry.npmjs.org/' ]
  if [ "$TEST_SCENARIO" != missing ]; then touch "$TEST_STATE"; fi
  exit 7
else exit 91; fi
`,
  );
  await chmod(npm, 0o755);
  await chmod(sleep, 0o755);
  const plan = buildTrustedPublisherPlan(lock([carrier('npm', '@oliphaunt/example')]));
  const selection = selectTrustedPublisherIdentities(plan, 'npm', 1);
  const shell = path.resolve(import.meta.dirname, 'trusted-publisher-config.sh');
  for (const scenario of ['ambiguous', 'rerun', 'conflict', 'missing']) {
    const output = path.join(root, scenario + '.json');
    const events = path.join(root, scenario + '.events');
    const state = path.join(root, scenario + '.state');
    if (scenario === 'rerun') await writeFile(state, 'published');
    await writeFile(
      path.join(root, 'context.json'),
      JSON.stringify({ plan, selection, apply: true, output }),
    );
    const env = {
      ...process.env,
      PATH: root + path.delimiter + process.env.PATH,
      TEST_EVENTS: events,
      TEST_STATE: state,
      TEST_SCENARIO: scenario,
      TEST_EXACT: JSON.stringify([exactNpm()]),
      TEST_CONFLICT: JSON.stringify([{ ...exactNpm(), repository: 'wrong/repo' }]),
      TEST_SHELL: shell,
      TEST_ROOT: root,
    };
    const command = 'bash "$TEST_SHELL" --npm "$TEST_ROOT"';
    const run = () =>
      spawnSync('script', ['--return', '--quiet', '--command', command, '/dev/null'], {
        encoding: 'utf8',
        env,
        timeout: 15000,
      });
    const result = run();
    assert.equal(
      result.status,
      scenario === 'conflict' ? 1 : scenario === 'missing' ? 2 : 0,
      result.stdout + result.stderr,
    );
    const log = await readFile(events, 'utf8');
    assert.equal(
      log.split('\n').filter((line) => line.startsWith('github ')).length,
      ['ambiguous', 'missing'].includes(scenario) ? 1 : 0,
    );
    assert.ok(
      !(await readdir(root)).some(
        (name) =>
          name.endsWith('.oliphaunt-reservation') || name.startsWith('.trusted-publisher-report.'),
      ),
    );
    if (scenario === 'missing') {
      await assert.rejects(stat(output), (cause) => cause.code === 'ENOENT');
      continue;
    }
    const report = JSON.parse(await readFile(output, 'utf8'));
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.deepEqual(report.created, scenario === 'ambiguous' ? ['npm:@oliphaunt/example'] : []);
    assert.equal(report.conflicts.length, scenario === 'conflict' ? 1 : 0);
    const before = await readFile(output, 'utf8');
    assert.notEqual(run().status, 0);
    assert.equal(await readFile(output, 'utf8'), before);
    assert.equal(
      await readFile(events, 'utf8'),
      log,
      'output collision must precede every npm command',
    );
  }
});
