import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { zipArchive } from '../packaging/testdata/zip-fixture.mts';
import {
  configuredRecipeGraph,
  nativeConfiguredRecipeGraph,
} from '../release/native-configured-inputs.mts';
import {
  acquireConfiguredCiBasis,
  assertConfiguredCiSource,
  type ConfiguredCiBasis,
  type ConfiguredCiRequest,
  captureConfiguredCiRequest,
  configuredCiSourceChanges,
  configuredCiWorkflowInventory,
  selectConfiguredCiRequests,
  verifyConfiguredCiDecision,
  verifyConfiguredCiResults,
  writeConfiguredCiSuccessReceipt,
} from './configured-scope.mts';

const configuration = 'a'.repeat(64);
const source = { commit: '1'.repeat(40), tree: '2'.repeat(40) };
const github = {
  repository: 'test/repo',
  workflow: 'Native Bazel qualification',
  workflowPath: '.github/workflows/bazel.yml',
  runId: 123,
  runAttempt: 1,
  job: 'portable',
};
const request = (id: string, files: string[], requires: string[] = []): ConfiguredCiRequest => ({
  schema: 'oliphaunt-ci-request-v1',
  id,
  job: id.split('/')[0],
  mode: 'full',
  status: 'success',
  source,
  github,
  requires,
  projection: {
    roots: [{ label: '//pkg:root', configuration }],
    files: [...files].sort(),
    trees: [],
    directories: [],
    analysisInputs: ['pkg/BUILD'],
  },
});
const rows = [
  request('linux/producer', ['shared.rs', 'linux.rs']),
  request('mac/consumer', ['mac.rs'], ['linux/producer']),
  request('docs/site', ['docs.mdx']),
];
const inventory = rows.map(({ id, job, requires }) => ({ id, job, requires }));
const basis: ConfiguredCiBasis = {
  schema: 'oliphaunt-ci-basis-v1',
  source,
  github,
  controllerInputs: ['tools/ci/configured-scope.mts'],
  requests: rows,
};
const modified = (name: string) => ({
  path: name,
  kind: 'modified',
  oldMode: '100644',
  newMode: '100644',
});
const select = (
  changes: ReturnType<typeof modified>[],
  override: Partial<Parameters<typeof selectConfiguredCiRequests>[0]> = {},
) => selectConfiguredCiRequests({ source, requests: inventory, basis, changes, ...override });

test('one, shared, many and unused source changes select only configured requests and transport', () => {
  assert.deepEqual(select([modified('docs.mdx')]).selected_requests, ['docs/site']);
  assert.deepEqual(select([modified('shared.rs')]).selected_requests, ['linux/producer']);
  assert.deepEqual(select([modified('mac.rs')]).selected_requests, [
    'linux/producer',
    'mac/consumer',
  ]);
  assert.deepEqual(select([modified('mac.rs')]).capture_requests, ['linux/producer']);
  assert.deepEqual(select([modified('unused.md')]).selected_requests, []);
  assert.deepEqual(select([modified('mac.rs'), modified('docs.mdx')]).selected_requests, [
    'docs/site',
    'linux/producer',
    'mac/consumer',
  ]);
});

test('unknown basis, structural edits and filesystem membership changes always select full', () => {
  for (const change of [
    modified('pkg/BUILD.bazel'),
    modified('defs/a.bzl'),
    modified('MODULE.bazel.lock'),
    modified('.github/workflows/bazel.yml'),
    modified('.gitattributes'),
    modified('src/docs/.gitignore'),
    { ...modified('new.md'), kind: 'A', oldMode: '000000' },
    { ...modified('old.md'), kind: 'D', newMode: '000000' },
    { ...modified('script.sh'), newMode: '100755' },
    { ...modified('link'), oldMode: '120000', newMode: '120000' },
    modified('tools/ci/configured-scope.mts'),
  ])
    assert.equal(select([change]).mode, 'full');
  for (const invalid of [
    undefined,
    { ...basis, requests: rows.slice(1) },
    { ...basis, requests: [{ ...rows[0], projection: undefined }, ...rows.slice(1)] },
  ])
    assert.equal(select([], { basis: invalid as ConfiguredCiBasis }).mode, 'full');
  assert.equal(
    select([modified('.github/workflows/bazel.yml')], {
      requests: [...inventory, { id: 'new/request', job: 'new', requires: [] }],
    }).mode,
    'full',
  );
  assert.equal(select([], { full: true }).mode, 'full');
});

test('recursive recorded trees affect content while directory observations describe unchanged membership', () => {
  const treeBasis = structuredClone(basis);
  treeBasis.requests[0].projection!.trees = ['catalog'];
  treeBasis.requests[1].projection!.directories = ['catalog'];
  assert.deepEqual(
    select([modified('catalog/entry.toml')], { basis: treeBasis }).selected_requests,
    ['linux/producer'],
  );
  treeBasis.requests[2].projection!.trees = [''];
  assert.deepEqual(select([modified('anywhere.md')], { basis: treeBasis }).selected_requests, [
    'docs/site',
  ]);
});

test('seeded content mutations match an independent request-input and transport oracle', () => {
  let seed = 881;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const scenarios = new Set<string>();
  for (let scenario = 0; scenario < 128; scenario++) {
    const changed = ['shared.rs', 'linux.rs', 'mac.rs', 'docs.mdx', 'unused.md'].filter(
      () => (next() >>> 16) % 2,
    );
    scenarios.add(JSON.stringify(changed));
    const expected = new Set(
      rows
        .filter((row) => changed.some((file) => row.projection!.files.includes(file)))
        .map((row) => row.id),
    );
    if (expected.has('mac/consumer')) expected.add('linux/producer');
    assert.deepEqual(select(changed.map(modified)).selected_requests, [...expected].sort());
  }
  assert(scenarios.size >= 24, 'seeded cases must exercise varied change subsets');
});

test('aggregate binds every selected receipt to source, run, job, transport and full Required', () => {
  const plan = select([modified('mac.rs')]);
  const receipts = rows
    .slice(0, 2)
    .map((row) => ({ ...row, mode: 'source' as const, projection: undefined }));
  verifyConfiguredCiResults(plan, receipts, 'skipped', github, inventory);
  for (const mutation of [
    (row: ConfiguredCiRequest) => {
      row.github.runId++;
    },
    (row: ConfiguredCiRequest) => {
      row.source.commit = '9'.repeat(40);
    },
    (row: ConfiguredCiRequest) => {
      row.job = 'wrong';
    },
    (row: ConfiguredCiRequest) => {
      row.requires = [];
    },
  ]) {
    const corrupt = structuredClone(receipts);
    mutation(corrupt[1]);
    assert.throws(() => verifyConfiguredCiResults(plan, corrupt, 'skipped', github, inventory));
  }
  assert.throws(() =>
    verifyConfiguredCiResults(plan, receipts.slice(0, 1), 'skipped', github, inventory),
  );
  const full = select([], { full: true });
  assert.throws(() => verifyConfiguredCiResults(full, rows, 'skipped', github, inventory));
  verifyConfiguredCiResults(full, rows, 'success', github, inventory);
});

test('verification recomputes omissions instead of trusting a shortened plan', () => {
  const changes = [modified('mac.rs')];
  const plan = select(changes);
  const args = { source, requests: inventory, basis, changes };
  verifyConfiguredCiDecision(plan, args);
  for (const field of ['selected_requests', 'selected_jobs', 'capture_requests'] as const) {
    const corrupt = structuredClone(plan);
    corrupt[field] = [];
    assert.throws(() => verifyConfiguredCiDecision(corrupt, args), /omissions/u);
  }
  assert.throws(
    () => verifyConfiguredCiDecision(plan, { ...args, basis: undefined }),
    /omissions/u,
  );
});

function graph() {
  const rule = (name: string, deps: string[] = []) => ({
    configurationId: 1,
    target: {
      rule: {
        name,
        configuredRuleInput: deps.map((label) => ({
          label,
          configurationId: label.endsWith('.rs') ? 0 : 1,
        })),
      },
    },
  });
  return {
    configurations: [{ id: 1, checksum: configuration }],
    results: [
      rule('//one:root', ['//shared:library']),
      rule('//two:root', ['//shared:library']),
      rule('//shared:library', ['//shared:input.rs']),
      { configurationId: 0, target: { sourceFile: { name: '//shared:input.rs' } } },
    ],
  };
}
test('union traversal preserves all shared DAG labels/packages and Native per-root proof', () => {
  const roots = ['//one:root', '//two:root'].map((label) => ({ label, configuration }));
  const ordinary = configuredRecipeGraph(graph(), roots, true);
  const native = nativeConfiguredRecipeGraph(graph(), roots);
  assert.deepEqual(ordinary.labels, native.labels);
  assert.deepEqual(ordinary.packages, native.packages);
  assert.deepEqual(ordinary.roots, []);
  assert.equal(native.roots.length, 2);
  const external = graph();
  external.results[0].target.rule!.name = '@@icu+//:smoke';
  assert.equal(
    configuredRecipeGraph(external, [{ label: '@@icu+//:smoke', configuration }], true).labels[0],
    '//shared:input.rs',
  );
  assert.throws(() =>
    nativeConfiguredRecipeGraph(external, [{ label: '@@icu+//:smoke', configuration }]),
  );
  const cycle = graph();
  cycle.results[2].target.rule!.configuredRuleInput = [{ label: '//one:root', configurationId: 1 }];
  assert.throws(() => configuredRecipeGraph(cycle, roots, true), /cycle/u);
  assert.throws(
    () => configuredRecipeGraph(graph(), [{ label: '//missing:root', configuration }], true),
    /missing/u,
  );
});

test('actual executable workflow inventory covers every 33 request context and authentic handoffs', () => {
  const workflow = Bun.YAML.parse(
    readFileSync(new URL('../../.github/workflows/bazel.yml', import.meta.url), 'utf8'),
  );
  const actual = configuredCiWorkflowInventory(workflow);
  assert.equal(actual.requests.length, 33);
  assert.equal(new Set(actual.requests.map((row) => row.id)).size, 33);
  assert.equal(
    actual.requests.find((row) => row.id === 'release-families/checksums')!.requires.length,
    14,
  );
  assert.equal(actual.requests.filter((row) => row.requires.length).length, 7);
  assert(actual.requests.some((row) => row.id === 'linux/x86_64/android-packages'));
  assert(!actual.requests.some((row) => row.id === 'linux/aarch64/android-packages'));
});

async function gitFixture(
  run: (root: string, outputBase: string, identity: typeof source) => Promise<void>,
) {
  const base = mkdtempSync(path.join(tmpdir(), 'configured-ci-'));
  const root = path.join(base, 'source');
  const outputBase = path.join(base, 'output');
  const put = (name: string, value: string) => {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), value);
  };
  mkdirSync(root);
  mkdirSync(path.join(outputBase, 'external'), { recursive: true });
  put(
    'tools/release/qualified-release-replay.sh',
    readFileSync(new URL('../release/qualified-release-replay.sh', import.meta.url), 'utf8'),
  );
  put('MODULE.bazel.lock', '{"lockFileVersion":28,"moduleExtensions":{}}');
  put('.bazelversion', '8.8.1\n');
  put('shared/input.rs', 'pub fn input() {}');
  put('one/BUILD', '#root');
  put('two/BUILD', '#root');
  put('shared/BUILD', '#input');
  put('unused.md', 'docs');
  put(
    '.github/workflows/bazel.yml',
    readFileSync(new URL('../../.github/workflows/bazel.yml', import.meta.url), 'utf8'),
  );
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'fixture',
    ],
    { cwd: root },
  );
  const current = () => ({
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root, encoding: 'utf8' }).trim(),
  });
  writeFileSync(
    path.join(outputBase, 'MODULE.bazel.lock'),
    '{"lockFileVersion":28,"moduleExtensions":{}}',
  );
  try {
    await run(root, outputBase, current());
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

test('shared capture uses existing configured/recipe views without query, binds real Git and source guard', async () => {
  await gitFixture(async (root, outputBase, actualSource) => {
    const executionRoot = path.join(outputBase, 'execroot/_main');
    const outputDirectory = path.join(outputBase, 'receipts/full');
    const file = await captureConfiguredCiRequest({
      id: 'linux/packages',
      job: 'linux',
      source: actualSource,
      github,
      outputDirectory,
      workspaceRoot: root,
      configuration: [],
      startup: [],
      requestedTargets: ['//one:root', '//two:root'],
      completedRoots: ['//one:root', '//two:root'].map((label) => ({ label, configuration })),
      executionRoot,
      configuredGraph: graph(),
      recipeQueries: [
        {
          packages: ['//one', '//two', '//shared'],
          labels: ['@@//one:BUILD', '@//two:BUILD', '//shared:BUILD'],
        },
      ],
    });
    const captured = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(captured.projection.files, ['shared/input.rs']);
    assert.deepEqual(captured.projection.analysisInputs, [
      'one/BUILD',
      'shared/BUILD',
      'two/BUILD',
    ]);
    assert.deepEqual(captured.source, actualSource);
    writeFileSync(path.join(root, 'unused.md'), 'edited');
    assert.throws(() => assertConfiguredCiSource(root, actualSource));
    assert.throws(() =>
      writeConfiguredCiSuccessReceipt({
        id: 'linux/packages',
        job: 'linux',
        source: actualSource,
        github,
        outputDirectory: path.join(outputBase, 'source'),
        workspaceRoot: root,
      }),
    );
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '--quiet',
        '-m',
        'doc edit',
      ],
      { cwd: root },
    );
    const now = {
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
        cwd: root,
        encoding: 'utf8',
      }).trim(),
    };
    assert.deepEqual(configuredCiSourceChanges(root, actualSource, now), [modified('unused.md')]);
  });
});

test('CLI full fallback and source verification preserve complete Required and reject omitted work', async () => {
  await gitFixture(async (root, outputBase, actualSource) => {
    const entry = new URL('./configured-scope.mts', import.meta.url).pathname;
    const env = {
      ...process.env,
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REPOSITORY: github.repository,
      GITHUB_RUN_ID: String(github.runId),
      GITHUB_RUN_ATTEMPT: '1',
      GITHUB_JOB: 'source-ci',
    };
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [entry, ...args], { cwd: root, env, encoding: 'utf8' });
    const fullFile = path.join(outputBase, 'full.json');
    const full = run('plan', '--full', '--output', fullFile);
    assert.equal(full.status, 0, full.stderr);
    assert.equal(JSON.parse(readFileSync(fullFile, 'utf8')).selected_requests.length, 33);
    assert.notEqual(
      run(
        'verify',
        '--plan',
        fullFile,
        '--requests-dir',
        path.join(outputBase, 'empty'),
        '--required-result',
        'skipped',
        '--basis-output',
        path.join(outputBase, 'forbidden.json'),
      ).status,
      0,
    );
    const actualInventory = configuredCiWorkflowInventory(
      Bun.YAML.parse(readFileSync(path.join(root, '.github/workflows/bazel.yml'), 'utf8')),
    ).requests;
    const selectedId = 'portable/linux-x64/packages';
    const oldBasis: ConfiguredCiBasis = {
      ...basis,
      source: actualSource,
      requests: actualInventory.map((row) => ({
        ...request(row.id, row.id === selectedId ? ['shared/input.rs'] : []),
        ...row,
        source: actualSource,
      })),
    };
    writeFileSync(path.join(root, 'shared/input.rs'), 'pub fn updated() {}');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '--quiet',
        '-m',
        'source edit',
      ],
      { cwd: root },
    );
    const now = {
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
        cwd: root,
        encoding: 'utf8',
      }).trim(),
    };
    const decision = selectConfiguredCiRequests({
      source: now,
      requests: actualInventory,
      basis: oldBasis,
      changes: configuredCiSourceChanges(root, actualSource, now),
    });
    assert.deepEqual(decision.selected_requests, [selectedId]);
    const file = path.join(outputBase, 'source-plan.json');
    const bytes = Buffer.from(`${JSON.stringify(oldBasis)}\n`);
    const plan = { ...decision, basisDigest: createHash('sha256').update(bytes).digest('hex') };
    writeFileSync(`${file}.basis.json`, bytes);
    writeFileSync(file, JSON.stringify(plan));
    const requestsDir = path.join(outputBase, 'receipts');
    writeConfiguredCiSuccessReceipt({
      ...actualInventory.find((row) => row.id === selectedId)!,
      source: now,
      github,
      outputDirectory: requestsDir,
      workspaceRoot: root,
    });
    const verify = () =>
      run('verify', '--plan', file, '--requests-dir', requestsDir, '--required-result', 'skipped');
    const valid = verify();
    assert.equal(valid.status, 0, valid.stderr);
    writeFileSync(file, JSON.stringify({ ...plan, selected_requests: [], selected_jobs: [] }));
    const omitted = verify();
    assert.notEqual(omitted.status, 0);
    assert.match(omitted.stderr, /omissions/u);
  });
});

test('basis acquisition admits only the exact completed main Required artifact and its immutable bytes', async () => {
  await gitFixture(async (root, _outputBase, actualSource) => {
    const actual = {
      ...basis,
      source: actualSource,
      requests: rows.map((row) => ({ ...row, source: actualSource })),
    };
    const run = {
      id: github.runId,
      run_attempt: 1,
      status: 'completed',
      conclusion: 'success',
      event: 'push',
      head_branch: 'main',
      head_sha: actualSource.commit,
      path: '.github/workflows/bazel.yml',
    };
    const bytes = zipArchive([{ name: 'basis.json', data: JSON.stringify(actual) }]);
    const artifact = {
      id: 77,
      name: 'native-ci-basis',
      expired: false,
      workflow_run: { id: run.id, head_branch: 'main' },
      size_in_bytes: bytes.length,
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    };
    const io = {
      read: async () => run,
      pages: async (endpoint: string) =>
        endpoint.includes('/artifacts?')
          ? [artifact]
          : [{ name: 'Required', conclusion: 'success' }],
      download: async () => new Response(bytes),
    };
    assert.deepEqual(await acquireConfiguredCiBasis(root, github.repository, io as any), actual);
    assert.equal(
      await acquireConfiguredCiBasis(root, github.repository, {
        ...io,
        pages: async () => [],
      } as any),
      undefined,
    );
    for (const mutation of [
      {
        ...io,
        pages: async (endpoint: string) =>
          endpoint.includes('/artifacts?')
            ? [artifact]
            : [{ name: 'Required', conclusion: 'skipped' }],
      },
      {
        ...io,
        pages: async (endpoint: string) =>
          endpoint.includes('/artifacts?')
            ? [{ ...artifact, digest: `sha256:${'0'.repeat(64)}` }]
            : [{ name: 'Required', conclusion: 'success' }],
      },
      { ...io, read: async () => ({ ...run, head_sha: '9'.repeat(40) }) },
    ])
      await assert.rejects(acquireConfiguredCiBasis(root, github.repository, mutation as any));
  });
});
