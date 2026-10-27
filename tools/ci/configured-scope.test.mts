import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { zipArchive } from '../packaging/testdata/zip-fixture.mts';
import { nativeBuildMetadata } from '../release/native-build-qualification.mts';
import {
  configuredRecipeGraph,
  nativeConfiguredRecipeGraph,
} from '../release/native-configured-inputs.mts';
import { projectNativeCurrentArtifacts } from '../release/native-extension-final-inputs.mts';
import {
  acquireConfiguredCiBasis,
  assertConfiguredCiSource,
  type ConfiguredCiBasis,
  type ConfiguredCiRequest,
  captureConfiguredCiRequest,
  configuredCiSourceChanges,
  configuredCiWorkflowInventory,
  joinConfiguredCiProjections,
  selectConfiguredCiRequests,
  verifyConfiguredCiDecision,
  verifyConfiguredCiResults,
  writeConfiguredCiSuccessReceipt,
} from './configured-scope.mts';
import { isNativeImportSourceLabel } from './native-import-projection.mts';

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

test('current imported roots inherit only their configured producer source scope and transitive inputs', () => {
  const proof = (name: string) => ({
    root: `//wasix:${name}`,
    configuration,
    evidenceDigest: `sha256:${'b'.repeat(64)}`,
    invocationId: 'current-combined-wasix-build',
    output: `bazel-out/wasix/bin/${name}.crate`,
  });
  const core = proof('core'),
    tools = proof('tools'),
    addon = proof('addon');
  const producer = request('wasix/combined', ['core.rs', 'addon.rs', 'server.rs', 'tools.rs']);
  producer.projection!.roots = [core, tools, addon].map(({ root: label, configuration }) => ({
    label,
    configuration,
  }));
  producer.projection!.analysisInputs = ['shared/recipe.mts'];
  producer.projection!.trees = ['acquired'];
  producer.projection!.directories = ['observed'];
  producer.projection!.nativeOutputs = [addon, core, tools].map((row) => ({
    ...row,
    files: [`${row.root.split(':')[1]}.rs`],
  }));
  const runtime = request('wasix-host/runtime', ['runtime.rs'], [producer.id]);
  runtime.projection!.importedRoots = [core];
  const napi = request('wasix-host/napi', ['addon.rs', 'napi.rs'], [producer.id]);
  napi.projection!.importedRoots = [core];
  const toolConsumer = request('wasix-host/tools', ['tool-consumer.rs'], [producer.id]);
  toolConsumer.projection!.importedRoots = [tools];
  const downstream = request('installed/runtime', ['installed.rs']);
  const runtimeProof = {
    ...proof('runtime'),
    evidenceDigest: `sha256:${'c'.repeat(64)}`,
    invocationId: 'runtime-build',
  };
  runtime.projection!.roots.push({ label: runtimeProof.root, configuration });
  runtime.projection!.nativeOutputs = [
    { ...runtimeProof, files: ['runtime.rs'], importedRoots: [core] },
  ];
  downstream.projection!.importedRoots = [runtimeProof];
  const requests = [producer, runtime, napi, toolConsumer, downstream];
  const identities = requests.map(({ id, job, requires }) => ({ id, job, requires }));
  const currentBasis = { ...basis, requests };
  const selected = (file: string) =>
    select([modified(file)], { requests: identities, basis: currentBasis });
  assert.deepEqual(selected('addon.rs').selected_requests, ['wasix-host/napi', 'wasix/combined']);
  assert.deepEqual(selected('server.rs').selected_requests, ['wasix/combined']);
  assert.deepEqual(selected('napi.rs').selected_requests, ['wasix-host/napi', 'wasix/combined']);
  assert.deepEqual(selected('core.rs').selected_requests, [
    'installed/runtime',
    'wasix-host/napi',
    'wasix-host/runtime',
    'wasix/combined',
  ]);
  assert.deepEqual(selected('tools.rs').selected_requests, ['wasix-host/tools', 'wasix/combined']);
  const joined = joinConfiguredCiProjections(requests, source);
  const installed = joined.find((row) => row.id === downstream.id)!.projection!;
  assert.deepEqual(installed.files, ['core.rs', 'installed.rs', 'runtime.rs']);
  assert.deepEqual(installed.trees, ['acquired']);
  assert.deepEqual(installed.directories, ['observed']);
  assert(installed.analysisInputs.includes('shared/recipe.mts'));
  assert(!installed.files.includes('addon.rs'));
  assert.deepEqual(downstream.requires, []);
  assert.deepEqual(downstream.projection!.files, ['installed.rs'], 'retained basis stays local');
});

test('native lineage fails closed for absent, ambiguous, older-source and different original producer proofs', () => {
  const proof = {
    root: '//pkg:root',
    configuration,
    evidenceDigest: `sha256:${'b'.repeat(64)}`,
    invocationId: 'current-build',
    output: 'bazel-out/cfg/bin/core.crate',
  };
  const producer = request('wasix/producer', ['core.rs']);
  producer.projection!.nativeOutputs = [{ ...proof, files: ['core.rs'] }];
  const consumer = request('host/consumer', ['consumer.rs']);
  consumer.projection!.importedRoots = [proof];
  const requests = [producer, consumer];
  const identities = requests.map(({ id, job, requires }) => ({ id, job, requires }));
  for (const field of [
    'evidenceDigest',
    'invocationId',
    'output',
    'root',
    'configuration',
  ] as const) {
    const corrupt = structuredClone(requests);
    const importProof = corrupt[1].projection!.importedRoots![0];
    importProof[field] =
      field === 'evidenceDigest'
        ? `sha256:${'c'.repeat(64)}`
        : field === 'configuration'
          ? 'd'.repeat(64)
          : `${importProof[field]}-other`;
    assert.throws(() => joinConfiguredCiProjections(corrupt, source), /exact original producer/u);
    assert.equal(
      select([modified('core.rs')], {
        requests: identities,
        basis: { ...basis, requests: corrupt },
      }).mode,
      'full',
    );
  }
  const absent = structuredClone(requests);
  delete absent[0].projection!.nativeOutputs;
  assert.throws(() => joinConfiguredCiProjections(absent, source), /exact original producer/u);
  const duplicate = { ...structuredClone(producer), id: 'duplicate/producer', job: 'duplicate' };
  assert.throws(
    () => joinConfiguredCiProjections([...requests, duplicate], source),
    /exact original producer/u,
  );
  const older = structuredClone(requests);
  older[0].source.commit = '9'.repeat(40);
  assert.throws(() => joinConfiguredCiProjections(older, source), /producer source differs/u);
  const unrelated = structuredClone(requests);
  unrelated[0].projection!.roots = [{ label: '//different:root', configuration }];
  assert.throws(() => joinConfiguredCiProjections(unrelated, source), /outside this request/u);
});

test('authored full-only requests never intersect source changes or leak through transport closure', () => {
  const publicSource = request('families/public-source', ['sdk.rs']);
  const producer = request('producer/runtime', ['runtime.rs']);
  const aggregate = {
    ...request('families/aggregate', ['sdk.rs'], [publicSource.id, producer.id].sort()),
    fullOnly: true,
  };
  const requests = [publicSource, producer, aggregate];
  const identities = requests.map(({ id, job, requires, fullOnly }) => ({
    id,
    job,
    requires,
    ...(fullOnly ? { fullOnly } : {}),
  }));
  const currentBasis = { ...basis, requests };
  const args = { requests: identities, basis: currentBasis };
  const sourcePlan = select([modified('sdk.rs')], args);
  assert.equal(sourcePlan.mode, 'source');
  assert.deepEqual(sourcePlan.selected_requests, [publicSource.id]);
  assert.deepEqual(sourcePlan.capture_requests, []);
  assert.deepEqual(
    select([], { ...args, full: true }).selected_requests,
    requests.map((row) => row.id).sort(),
  );
  const dependent = structuredClone(requests);
  dependent[0].requires = [aggregate.id];
  dependent[2].requires = [producer.id];
  const dependentIdentities = identities.map((row) =>
    row.id === publicSource.id
      ? { ...row, requires: [aggregate.id] }
      : row.id === aggregate.id
        ? { ...row, requires: [producer.id] }
        : row,
  );
  assert.equal(
    select([modified('sdk.rs')], {
      requests: dependentIdentities,
      basis: { ...basis, requests: dependent },
    }).mode,
    'full',
  );
  const changedPolicy = identities.map((row) =>
    row.id === aggregate.id ? { ...row, fullOnly: false } : row,
  );
  assert.equal(
    select([modified('sdk.rs')], { requests: changedPolicy, basis: currentBasis }).mode,
    'full',
  );
  const explicitFalse = structuredClone(requests);
  explicitFalse[0].fullOnly = false;
  assert.equal(
    select([modified('sdk.rs')], { ...args, basis: { ...basis, requests: explicitFalse } }).mode,
    'source',
  );
  assert.throws(
    () =>
      verifyConfiguredCiResults(
        { ...sourcePlan, selected_requests: [aggregate.id] },
        [{ ...aggregate, mode: 'source', projection: undefined }],
        'skipped',
        github,
        identities,
      ),
    /full-only/u,
  );
  const workflow = {
    env: {},
    jobs: {
      families: {
        steps: [
          { env: { CI_REQUEST_ID: 'families/public-source' } },
          { env: { CI_REQUEST_ID: 'families/aggregate', CI_FULL_ONLY: 'true' } },
        ],
      },
    },
  };
  assert.deepEqual(configuredCiWorkflowInventory(workflow).requests, [
    { id: 'families/aggregate', job: 'families', requires: [], fullOnly: true },
    { id: 'families/public-source', job: 'families', requires: [] },
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
  const currentGithub = { ...github, runAttempt: 2 };
  const receipts = rows.slice(0, 2).map((row, index) => ({
    ...row,
    github: { ...row.github, runAttempt: index + 1 },
    mode: 'source' as const,
    projection: undefined,
  }));
  verifyConfiguredCiResults(plan, receipts, 'skipped', currentGithub, inventory);
  for (const mutation of [
    (row: ConfiguredCiRequest) => {
      row.github.runId++;
    },
    (row: ConfiguredCiRequest) => {
      row.github.runAttempt = 0;
    },
    (row: ConfiguredCiRequest) => {
      row.github.runAttempt = 3;
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
    assert.throws(() =>
      verifyConfiguredCiResults(plan, corrupt, 'skipped', currentGithub, inventory),
    );
  }
  assert.throws(() =>
    verifyConfiguredCiResults(plan, receipts.slice(0, 1), 'skipped', currentGithub, inventory),
  );
  const full = select([], { full: true });
  assert.throws(() => verifyConfiguredCiResults(full, rows, 'skipped', currentGithub, inventory));
  verifyConfiguredCiResults(full, rows, 'success', currentGithub, inventory);
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
  const imported =
    '@@_main+metadata+oliphaunt_metadata//:native-current-artifacts/runtime/archive.tgz';
  const sdk = '@@apple_sdk+//include:SDK.h';
  const withForeignSources = graph();
  for (const label of [imported, sdk]) {
    withForeignSources.results[2].target.rule!.configuredRuleInput.push({
      label,
      configurationId: 0,
    });
    withForeignSources.results.push({
      configurationId: 0,
      target: { sourceFile: { name: label } },
    });
  }
  const sliced = configuredRecipeGraph(
    withForeignSources,
    roots,
    true,
    (name) => name.startsWith('//') || isNativeImportSourceLabel(name),
  );
  assert.deepEqual(sliced.roots, [], 'default root recipe shape remains unchanged');
  assert.deepEqual(
    sliced.sourceRoots,
    roots.map((root) => ({ ...root, labels: ['//shared:input.rs', imported] })),
  );
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

test('actual executable workflow inventory covers every 35 request context and authentic handoffs', () => {
  const workflow = Bun.YAML.parse(
    readFileSync(new URL('../../.github/workflows/bazel.yml', import.meta.url), 'utf8'),
  );
  const actual = configuredCiWorkflowInventory(workflow);
  assert.equal(actual.requests.length, 35);
  assert.equal(new Set(actual.requests.map((row) => row.id)).size, 35);
  const appleIds = [
    'portable/macos-arm64/apple-packages',
    'portable/macos-arm64/abi-ios_device_arm64',
    'portable/macos-arm64/abi-ios_simulator_arm64',
    'portable/macos-arm64/abi-apple_package_macos_arm64',
  ];
  assert.deepEqual(
    actual.requests.filter((row) => row.job === 'apple-packages').map((row) => row.id),
    [...appleIds].sort(),
  );
  for (const id of ['packages', 'native-carriers']) {
    const native = actual.requests.find((row) => row.id === `portable/macos-arm64/${id}`);
    assert(native);
    assert.equal(native.job, 'portable/macos-arm64');
  }
  const full = selectConfiguredCiRequests({ source, requests: actual.requests, changes: [] });
  assert.equal(full.selected_requests.length, 35);
  assert.equal(full.selected_jobs.length, 18);
  assert.equal(full.capture_requests.length, 15);
  for (const id of [...appleIds, 'react-native/installed-consumer']) {
    const selected = selectConfiguredCiRequests({
      source,
      requests: actual.requests,
      basis: {
        ...basis,
        requests: actual.requests.map((row) => ({
          ...request(row.id, row.id === id ? ['apple-change'] : []),
          ...row,
        })),
      },
      changes: [modified('apple-change')],
    });
    assert.deepEqual(
      selected.selected_jobs,
      id === 'react-native/installed-consumer'
        ? ['apple-packages', 'react-native']
        : ['apple-packages'],
    );
    assert.deepEqual(
      selected.selected_requests,
      id === 'react-native/installed-consumer' ? [appleIds[0], id] : [id],
    );
  }
  assert.equal(
    actual.requests.find((row) => row.id === 'release-families/checksums')!.fullOnly,
    true,
  );
  assert.deepEqual(
    actual.requests.find((row) => row.id === 'release-families/public-source')!.requires,
    [],
  );
  assert.equal(
    actual.requests.find((row) => row.id === 'release-families/checksums')!.requires.length,
    13,
  );
  assert.equal(actual.requests.filter((row) => row.requires.length).length, 12);
  assert.deepEqual(
    actual.requests.find((row) => row.id === 'wasix-windows-aot/v8-carriers')!.requires,
    ['wasix-modules/portable-llvm'],
  );
  assert.deepEqual(actual.requests.find((row) => row.id === 'wasix/tools-sdk-browser')!.requires, [
    'wasix-modules/portable-llvm',
    'wasix-windows-aot/v8-carriers',
  ]);
  assert(!actual.requests.some((row) => /^portable\/[^/]+\/napi$/u.test(row.id)));
  for (const platform of ['linux-arm64', 'macos-arm64', 'windows-x64']) {
    const napi = actual.requests.find((row) => row.id === `wasix-host/${platform}/napi`);
    assert(napi, `missing imported NAPI request for ${platform}`);
    assert.equal(napi.job, `wasix-host/${platform}`);
    assert.deepEqual(napi.requires, ['wasix/tools-sdk-browser']);
    assert(
      actual.requests
        .find((row) => row.id === 'release-families/checksums')!
        .requires.includes(napi.id),
    );
  }
  const napiId = 'wasix-host/linux-arm64/napi';
  const napiPlan = selectConfiguredCiRequests({
    source,
    requests: actual.requests,
    basis: {
      ...basis,
      requests: actual.requests.map((row) => ({
        ...request(row.id, row.id === napiId ? ['napi.rs'] : []),
        ...row,
      })),
    },
    changes: [modified('napi.rs')],
  });
  assert.deepEqual(napiPlan.selected_requests, [
    napiId,
    'wasix-modules/portable-llvm',
    'wasix-windows-aot/v8-carriers',
    'wasix/tools-sdk-browser',
  ]);
  assert.deepEqual(napiPlan.selected_jobs, [
    'wasix',
    'wasix-host/linux-arm64',
    'wasix-modules',
    'wasix-windows-aot',
  ]);
  assert.deepEqual(napiPlan.capture_requests, [
    'wasix-modules/portable-llvm',
    'wasix-windows-aot/v8-carriers',
    'wasix/tools-sdk-browser',
  ]);
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
  put('one/core.rs', 'pub fn core() {}');
  put('two/addon.rs', 'pub fn addon() {}');
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
  const originalSnapshot = process.env.OLIPHAUNT_NATIVE_PUBLICATION_INPUTS;
  const originalFullOnly = process.env.CI_FULL_ONLY;
  delete process.env.OLIPHAUNT_NATIVE_PUBLICATION_INPUTS;
  delete process.env.CI_FULL_ONLY;
  try {
    await run(root, outputBase, current());
  } finally {
    if (originalSnapshot === undefined) delete process.env.OLIPHAUNT_NATIVE_PUBLICATION_INPUTS;
    else process.env.OLIPHAUNT_NATIVE_PUBLICATION_INPUTS = originalSnapshot;
    if (originalFullOnly === undefined) delete process.env.CI_FULL_ONLY;
    else process.env.CI_FULL_ONLY = originalFullOnly;
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

test('capture awaits caller-owned queries and writes no receipt after cancellation', async () => {
  await gitFixture(async (root, outputBase, actualSource) => {
    const captureRequest = {
      id: 'linux/packages',
      job: 'linux',
      source: actualSource,
      github,
      outputDirectory: path.join(outputBase, 'receipts/owned'),
      workspaceRoot: root,
      configuration: [],
      startup: [],
      requestedTargets: ['//one:root', '//two:root'],
      completedRoots: ['//one:root', '//two:root'].map((label) => ({ label, configuration })),
      executionRoot: path.join(outputBase, 'execroot/_main'),
    };
    const recipes = {
      packages: ['//one', '//two', '//shared'],
      labels: ['//one:BUILD', '//two:BUILD', '//shared:BUILD'],
    };
    const queries: string[] = [];
    const file = await captureConfiguredCiRequest(captureRequest, {
      async bazel(args, stdout) {
        await Promise.resolve();
        queries.push(args[0]);
        writeFileSync(
          stdout,
          args[0] === 'cquery' ? JSON.stringify(graph()) : recipes.labels.join('\n'),
          { flag: 'wx' },
        );
      },
      assertRunning() {},
    });
    assert.deepEqual(queries, ['cquery', 'query']);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).projection.files, ['shared/input.rs']);
    assert.deepEqual(readdirSync(captureRequest.outputDirectory).sort(), [
      'analysis-buildfiles.query',
      'analysis-deps.query',
      'ci-request.json',
    ]);

    for (const phase of ['query', 'recorded-inputs']) {
      let interrupted = false;
      const outputDirectory = path.join(outputBase, 'receipts', phase);
      const pending = captureConfiguredCiRequest(
        {
          ...captureRequest,
          outputDirectory,
          ...(phase === 'recorded-inputs'
            ? { configuredGraph: graph(), recipeQueries: [recipes] }
            : {}),
        },
        {
          async bazel(args, stdout) {
            assert.equal(phase, 'query');
            assert.equal(args[0], 'cquery');
            await Promise.resolve();
            writeFileSync(stdout, JSON.stringify(graph()), { flag: 'wx' });
            interrupted = true;
          },
          assertRunning() {
            if (interrupted) throw new Error('fixture interrupted');
          },
        },
      );
      // The supplied views reach the collector's real asynchronous file reads before returning.
      if (phase === 'recorded-inputs') interrupted = true;
      await assert.rejects(pending, /fixture interrupted/u);
      assert.deepEqual(
        readdirSync(outputDirectory),
        phase === 'query' ? ['analysis-deps.query'] : [],
      );
    }
  });
});

test('native capture binds original packet bytes to root-local source Files and reached imports', async () => {
  await gitFixture(async (root, outputBase, actualSource) => {
    const executionRoot = path.join(outputBase, 'execroot/_main');
    const output = 'bazel-out/wasix/bin/one/fixture-runtime-1.0.0.tar.gz';
    const partsOutput = 'bazel-out/wasix/bin/one/cargo-parts/fixture-runtime';
    const original = path.join(executionRoot, output);
    mkdirSync(path.dirname(original), { recursive: true });
    mkdirSync(path.join(executionRoot, partsOutput, 'nested'), { recursive: true });
    const bytes = Buffer.from('controlled original public runtime');
    writeFileSync(original, bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const shipping = {
      label: '//one:root',
      package: {
        product: 'fixture-runtime',
        version: '1.0.0',
        ecosystem: 'github',
        name: 'fixture-runtime-1.0.0.tar.gz',
        configuration: 'portable',
        role: 'github-release-asset',
        outputs: [
          { path: output, owner: '//one:archive' },
          { path: partsOutput, owner: '//one:archive' },
        ],
      },
    };
    const evidence = {
      schema: 'oliphaunt-native-build-evidence-v1',
      source: actualSource,
      github,
      cohorts: [
        {
          executionRoot,
          roots: [shipping],
          rootConfigurations: [{ label: shipping.label, configuration }],
          aquery: {
            pathFragments: output.split('/').map((label, index) => ({
              id: index + 1,
              label,
              ...(index ? { parentId: index } : {}),
            })),
            artifacts: [{ id: 1, pathFragmentId: output.split('/').length }],
            targets: [{ id: 1, label: '//one:archive' }],
            configuration: [{ id: 1, checksum: configuration }],
            actions: [
              {
                targetId: 1,
                configurationId: 1,
                mnemonic: 'FileWrite',
                actionKey: 'controlled-archive',
                outputIds: [1],
                primaryOutputId: 1,
              },
            ],
          },
          buildEvents: [
            {
              id: { started: {} },
              started: {
                uuid: 'controlled-current-invocation',
                buildToolVersion: '8.8.1',
                command: 'build',
              },
            },
            { id: { workspace: {} }, workspaceInfo: { localExecRoot: executionRoot } },
            { id: { configuration: { id: configuration } }, configuration: { mnemonic: 'wasix' } },
            {
              id: { namedSet: { id: 'output' } },
              namedSetOfFiles: {
                files: [{ name: output, digest: sha256, length: String(bytes.length) }],
              },
            },
            {
              id: {
                targetCompleted: { label: shipping.label, configuration: { id: configuration } },
              },
              completed: {
                success: true,
                outputGroup: [{ name: 'default', fileSets: [{ id: 'output' }] }],
              },
            },
            {
              id: { buildFinished: {} },
              finished: { overallSuccess: true, exitCode: { name: 'SUCCESS' } },
            },
            {
              id: { buildMetadata: {} },
              buildMetadata: { metadata: nativeBuildMetadata(actualSource, github) },
            },
            { id: { buildMetrics: {} }, lastMessage: true, buildMetrics: {} },
          ],
          inputs: [],
          outputs: [
            {
              path: output,
              members: [{ path: '', type: 'file', mode: 0o644, size: bytes.length, sha256 }],
            },
            {
              path: partsOutput,
              members: [
                { path: '', type: 'directory', mode: 0o755 },
                { path: 'nested', type: 'directory', mode: 0o755 },
              ],
            },
          ],
        },
      ],
    };
    const nativeEvidence = path.join(outputBase, 'native-build-evidence.json');
    const packet = Buffer.from(`${JSON.stringify(evidence)}\n`);
    writeFileSync(nativeEvidence, packet);
    const repository = 'oliphaunt_metadata';
    writeFileSync(
      path.join(outputBase, 'external', `@${repository}.marker`),
      `${'f'.repeat(64)}\n`,
    );
    const rule = (name: string, labels: string[]) => ({
      configurationId: 1,
      target: {
        rule: {
          name,
          configuredRuleInput: labels.map((label) => ({
            label,
            configurationId: label.endsWith('.rs') ? 0 : 1,
          })),
        },
      },
    });
    const sourceFile = (name: string) => ({ configurationId: 0, target: { sourceFile: { name } } });
    const aliasRule = `@@${repository}//:rule_alias`;
    const raw = {
      configurations: [{ id: 1, checksum: configuration }],
      results: [
        rule('//one:root', ['//one:core.rs']),
        rule('//two:root', ['//two:addon.rs', aliasRule]),
        rule(aliasRule, []),
        sourceFile('//one:core.rs'),
        sourceFile('//two:addon.rs'),
      ],
    };
    const capture = (id: string, configuredGraph = raw, extra = {}) =>
      captureConfiguredCiRequest({
        id,
        job: id.split('/')[0],
        source: actualSource,
        github,
        outputDirectory: path.join(outputBase, 'receipts', id),
        workspaceRoot: root,
        configuration: [],
        startup: [],
        requestedTargets: ['//one:root', '//two:root'],
        completedRoots: ['//one:root', '//two:root'].map((label) => ({ label, configuration })),
        executionRoot,
        configuredGraph,
        recipeQueries: [
          {
            packages: ['//one', '//two', `@@${repository}//`],
            labels: ['//one:BUILD', '//two:BUILD'],
          },
        ],
        ...extra,
      });
    const producer = JSON.parse(
      readFileSync(await capture('producer/current', raw, { nativeEvidence }), 'utf8'),
    );
    assert.equal(
      producer.projection.importedRoots,
      undefined,
      'reached rule aliases are not imported Files',
    );
    assert.equal(producer.projection.nativeOutputs.length, 1);
    const retained = producer.projection.nativeOutputs[0];
    assert.equal(retained.output, output, 'empty companion trees have no imported File lineage');
    assert.deepEqual(retained.files, ['one/core.rs']);
    assert.equal(
      retained.evidenceDigest,
      `sha256:${createHash('sha256').update(packet).digest('hex')}`,
    );
    assert.equal(retained.invocationId, 'controlled-current-invocation');
    assert.deepEqual(producer.projection.files, ['one/core.rs', 'two/addon.rs']);
    const { files: _files, importedRoots: _imports, ...proof } = retained;
    const snapshot = {
      source: actualSource,
      nativeCurrentArtifacts: [
        {
          product: 'fixture-runtime',
          version: '1.0.0',
          artifact: 'github-release:fixture-runtime-1.0.0.tar.gz',
          configuration: 'portable',
          source: actualSource,
          file: { path: original, size: bytes.length, sha256, producer: proof },
        },
      ],
    };
    const aliases = projectNativeCurrentArtifacts(
      snapshot.nativeCurrentArtifacts,
      actualSource,
    ).files;
    assert.equal(aliases.length, 1);
    const alias = aliases[0];
    const importedFile = path.join(executionRoot, 'external', repository, alias.path);
    mkdirSync(path.dirname(importedFile), { recursive: true });
    writeFileSync(importedFile, bytes);
    const importedLabel = `@@${repository}//:${alias.path}`;
    const consumerGraph = structuredClone(raw);
    consumerGraph.results[1].target.rule!.configuredRuleInput.push({
      label: importedLabel,
      configurationId: 0,
    });
    consumerGraph.results.push(sourceFile(importedLabel));
    const snapshotFile = path.join(outputBase, 'publication-inputs.json');
    writeFileSync(snapshotFile, JSON.stringify(snapshot));
    process.env.OLIPHAUNT_NATIVE_PUBLICATION_INPUTS = snapshotFile;
    const consumer = JSON.parse(
      readFileSync(await capture('consumer/current', consumerGraph), 'utf8'),
    );
    assert.deepEqual(consumer.projection.importedRoots, [proof]);
    assert.equal(
      consumer.projection.nativeOutputs,
      undefined,
      'ordinary capture has no native producer authority',
    );
    assert.equal(joinConfiguredCiProjections([producer, consumer], actualSource).length, 2);
    delete process.env.OLIPHAUNT_NATIVE_PUBLICATION_INPUTS;
    await assert.rejects(capture('consumer/missing-snapshot', consumerGraph), /original producer/u);
    const populatedParts = structuredClone(evidence);
    const partBytes = Buffer.from('controlled Cargo payload part');
    const partSha256 = createHash('sha256').update(partBytes).digest('hex');
    const partPath = 'nested/fixture-runtime-part-001-1.0.0.crate';
    writeFileSync(path.join(executionRoot, partsOutput, partPath), partBytes);
    populatedParts.cohorts[0].outputs[1].members.push({
      path: partPath,
      type: 'file',
      mode: 0o644,
      size: partBytes.length,
      sha256: partSha256,
    });
    const populatedNamedOutput = populatedParts.cohorts[0].buildEvents.find(
      (event) => 'namedSetOfFiles' in event,
    ) as { namedSetOfFiles: { files: unknown[] } } | undefined;
    assert(populatedNamedOutput);
    writeFileSync(nativeEvidence, JSON.stringify(populatedParts));
    await assert.rejects(
      capture('producer/missing-completed-part', raw, { nativeEvidence }),
      /absent from its completion/u,
    );
    populatedNamedOutput.namedSetOfFiles.files.push({
      name: `${partsOutput}/${partPath}`,
      digest: partSha256,
      length: String(partBytes.length),
    });
    writeFileSync(nativeEvidence, JSON.stringify(populatedParts));
    const populatedProducer = JSON.parse(
      readFileSync(await capture('producer/populated-parts', raw, { nativeEvidence }), 'utf8'),
    );
    assert.deepEqual(
      populatedProducer.projection.nativeOutputs.map((value: { output: string }) => value.output),
      [partsOutput, output],
    );
    rmSync(path.join(executionRoot, partsOutput, partPath));
    const noFiles = structuredClone(evidence);
    noFiles.cohorts[0].roots[0].package.outputs = [shipping.package.outputs[1]];
    noFiles.cohorts[0].outputs = [evidence.cohorts[0].outputs[1]];
    writeFileSync(nativeEvidence, JSON.stringify(noFiles));
    await assert.rejects(
      capture('producer/no-delivered-files', raw, { nativeEvidence }),
      /CI original native root .*one:root.* has no completed File.*cargo-parts\/fixture-runtime/u,
    );
    noFiles.cohorts[0].roots[0].label = '//two:root';
    noFiles.cohorts[0].roots.unshift(shipping);
    noFiles.cohorts[0].rootConfigurations.push({ label: '//two:root', configuration });
    noFiles.cohorts[0].outputs = evidence.cohorts[0].outputs;
    noFiles.cohorts[0].buildEvents.splice(5, 0, {
      id: { targetCompleted: { label: '//two:root', configuration: { id: configuration } } },
      completed: {
        success: true,
        outputGroup: [{ name: 'default', fileSets: [{ id: 'output' }] }],
      },
    });
    writeFileSync(nativeEvidence, JSON.stringify(noFiles));
    await assert.rejects(
      capture('producer/empty-root-with-valid-sibling', raw, { nativeEvidence }),
      /CI original native root .*two:root.* has no completed File.*cargo-parts\/fixture-runtime/u,
    );
    const missingCapture = structuredClone(evidence);
    missingCapture.cohorts[0].outputs = [evidence.cohorts[0].outputs[0]];
    writeFileSync(nativeEvidence, JSON.stringify(missingCapture));
    await assert.rejects(
      capture('producer/missing-companion-capture', raw, { nativeEvidence }),
      /capture is missing or ambiguous/u,
    );
    const missingOutput = structuredClone(evidence);
    const namedOutput = missingOutput.cohorts[0].buildEvents.find(
      (event) => 'namedSetOfFiles' in event,
    ) as { namedSetOfFiles: { files: unknown[] } } | undefined;
    assert(namedOutput);
    namedOutput.namedSetOfFiles.files = [];
    writeFileSync(nativeEvidence, JSON.stringify(missingOutput));
    await assert.rejects(
      capture('producer/missing-completed-output', raw, { nativeEvidence }),
      /absent from its completion/u,
    );
    writeFileSync(nativeEvidence, packet);
    await assert.rejects(
      capture('producer/unrelated-root', raw, {
        nativeEvidence,
        requestedTargets: ['//two:root'],
        completedRoots: [{ label: '//two:root', configuration }],
      }),
      /outside this request/u,
    );
    evidence.github = { ...github, job: 'different-producer' };
    writeFileSync(nativeEvidence, JSON.stringify(evidence));
    await assert.rejects(
      capture('producer/different-context', raw, { nativeEvidence }),
      /context differs/u,
    );
  });
});

test('capture preserves large exact query arguments and complete output without truncation', async () => {
  await gitFixture(async (root, outputBase) => {
    const labels = Array.from({ length: 640 }, (_, i) => `//package_${'x'.repeat(64)}_${i}:root`);
    const buildLabels = labels.map((label) => `${label.slice(0, label.indexOf(':'))}:BUILD`);
    for (const label of buildLabels) {
      const file = path.join(root, label.slice(2).replace(':', '/'));
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, '# source recipe fixture\n');
    }
    const actualGraph = {
      configurations: [{ id: 1, checksum: configuration }],
      results: [
        ...labels.map((name, i) => ({
          configurationId: 1,
          target: {
            rule: {
              name,
              configuredRuleInput:
                i === 0 ? [{ label: '//shared:input.rs', configurationId: 0 }] : [],
            },
          },
        })),
        { configurationId: 0, target: { sourceFile: { name: '//shared:input.rs' } } },
      ],
    };
    const graphFile = path.join(outputBase, 'graph.json');
    const callsFile = path.join(outputBase, 'calls.json');
    const modeFile = path.join(outputBase, 'mode.txt');
    const driver = path.join(outputBase, 'query-driver.mts');
    writeFileSync(graphFile, JSON.stringify(actualGraph));
    writeFileSync(modeFile, 'large');
    writeFileSync(
      driver,
      `
import { readFileSync, writeFileSync, writeSync, existsSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.join(' ').length >= 32767) throw new Error('Windows command-line limit');
if (!args[1]?.startsWith('--query_file=')) throw new Error('missing query file transport');
const expression = readFileSync(args[1].slice('--query_file='.length), 'utf8');
const file = ${JSON.stringify(callsFile)};
const calls = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
calls.push({ args, expression });
writeFileSync(file, JSON.stringify(calls));
if (args[0] === 'cquery') {
  const mode = readFileSync(${JSON.stringify(modeFile)}, 'utf8');
  if (mode === 'large') {
    const chunk = Buffer.alloc(1024 * 1024, 32);
    for (let remaining = 129 * chunk.length; remaining > 0;)
      remaining -= writeSync(1, chunk, 0, Math.min(remaining, chunk.length));
  }
  writeSync(1, mode === 'malformed' ? '{' : readFileSync(${JSON.stringify(graphFile)}));
  if (mode === 'nonzero') process.exit(7);
}
else if (args[0] === 'query') console.log(${JSON.stringify([...buildLabels, '//shared:BUILD'].join('\n'))});
else throw new Error('unexpected additional Bazel command');
`,
    );
    const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const launcher = path.join(root, 'tools/dev/bazel.sh');
    mkdirSync(path.dirname(launcher), { recursive: true });
    writeFileSync(
      launcher,
      `#!/usr/bin/env bash\nexec ${shellQuote(process.execPath)} --no-install --no-env-file ${shellQuote(driver)} "$@"\n`,
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
        'large queries',
      ],
      { cwd: root },
    );
    const actualSource = {
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
        cwd: root,
        encoding: 'utf8',
      }).trim(),
    };
    const outputDirectory = path.join(outputBase, 'receipts/full');
    const configurationFlags = [
      '--platforms=//native:windows',
      '--host_platform=//native:windows',
      '--lockfile_mode=error',
    ];
    const captureRequest = {
      id: 'portable/windows-x64/packages',
      job: 'portable/windows-x64',
      source: actualSource,
      github,
      outputDirectory,
      workspaceRoot: root,
      configuration: configurationFlags,
      startup: [],
      requestedTargets: labels.toReversed(),
      completedRoots: labels.map((label) => ({ label, configuration })),
      executionRoot: path.join(outputBase, 'execroot/_main'),
    };
    const file = await captureConfiguredCiRequest(captureRequest);
    const expression = (values: string[]) =>
      `set(${[...new Set(values)]
        .sort()
        .map((value) => JSON.stringify(value))
        .join(' ')})`;
    const calls = JSON.parse(readFileSync(callsFile, 'utf8'));
    assert.deepEqual(calls, [
      {
        args: [
          'cquery',
          `--query_file=${path.join(outputDirectory, 'analysis-deps.query')}`,
          ...configurationFlags,
          '--lockfile_mode=update',
          '--output=jsonproto',
          '--consistent_labels',
          '--transitions=lite',
          '--proto:include_configurations',
          '--proto:output_rule_attrs=',
        ],
        expression: `deps(${expression(labels)})`,
      },
      {
        args: [
          'query',
          `--query_file=${path.join(outputDirectory, 'analysis-buildfiles.query')}`,
          '--lockfile_mode=error',
          '--consistent_labels',
          '--output=label',
        ],
        expression: `buildfiles(${expression([...labels, '//shared:input.rs'])})`,
      },
    ]);
    for (const call of calls) {
      assert(call.expression.length > 32767, 'fixture must exceed the Windows command limit');
      assert(call.args.join(' ').length < 32767, 'both subprocess commands must remain bounded');
    }
    const captured = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(captured.projection.files, ['shared/input.rs']);
    assert.deepEqual(
      captured.projection.analysisInputs,
      [...buildLabels, '//shared:BUILD'].map((label) => label.slice(2).replace(':', '/')).sort(),
    );
    assert.deepEqual(
      captured.projection.roots,
      labels.map((label) => ({ label, configuration })),
    );
    assert.deepEqual(captured.source, actualSource);
    assert.deepEqual(readdirSync(outputDirectory).sort(), [
      'analysis-buildfiles.query',
      'analysis-deps.query',
      'ci-request.json',
    ]);
    for (const mode of ['nonzero', 'malformed']) {
      writeFileSync(modeFile, mode);
      const failed = path.join(outputBase, 'receipts', mode);
      await assert.rejects(
        captureConfiguredCiRequest({ ...captureRequest, outputDirectory: failed }),
        mode === 'nonzero' ? /CI cquery failed \(7\)/u : SyntaxError,
      );
      assert.deepEqual(
        readdirSync(failed),
        ['analysis-deps.query'],
        'failed query must retain neither a temporary output nor a success receipt',
      );
    }
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
    assert.equal(JSON.parse(readFileSync(fullFile, 'utf8')).selected_requests.length, 35);
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
      github: { ...github, runAttempt: 2 },
      requests: rows.map((row, index) => ({
        ...row,
        source: actualSource,
        github: { ...row.github, runAttempt: index === 1 ? 2 : 1 },
      })),
    };
    const run = {
      id: github.runId,
      run_attempt: 2,
      status: 'completed',
      conclusion: 'success',
      event: 'push',
      head_branch: 'main',
      head_sha: actualSource.commit,
      path: '.github/workflows/bazel.yml',
    };
    const required = {
      name: 'Required',
      status: 'completed',
      conclusion: 'success',
      run_attempt: 2,
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
        endpoint.includes('/artifacts?') ? [artifact] : [required],
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
          endpoint.includes('/artifacts?') ? [artifact] : [{ ...required, run_attempt: 1 }],
      },
      {
        ...io,
        pages: async (endpoint: string) =>
          endpoint.includes('/artifacts?')
            ? [artifact]
            : [
                { ...required, run_attempt: 1 },
                { ...required, conclusion: 'failure' },
              ],
      },
      {
        ...io,
        pages: async (endpoint: string) =>
          endpoint.includes('/artifacts?') ? [artifact] : [{ ...required, conclusion: 'skipped' }],
      },
      {
        ...io,
        pages: async (endpoint: string) =>
          endpoint.includes('/artifacts?')
            ? [{ ...artifact, digest: `sha256:${'0'.repeat(64)}` }]
            : [required],
      },
      { ...io, read: async () => ({ ...run, head_sha: '9'.repeat(40) }) },
    ])
      await assert.rejects(acquireConfiguredCiBasis(root, github.repository, mutation as any));
    for (const mutate of [
      (value: ConfiguredCiBasis) => {
        value.github.runAttempt = 1;
      },
      (value: ConfiguredCiBasis) => {
        value.requests[0].github.runAttempt = 3;
      },
    ]) {
      const corrupted = structuredClone(actual);
      mutate(corrupted);
      const contents = zipArchive([{ name: 'basis.json', data: JSON.stringify(corrupted) }]);
      await assert.rejects(
        acquireConfiguredCiBasis(root, github.repository, {
          ...io,
          pages: async (endpoint: string) =>
            endpoint.includes('/artifacts?')
              ? [
                  {
                    ...artifact,
                    size_in_bytes: contents.length,
                    digest: `sha256:${createHash('sha256').update(contents).digest('hex')}`,
                  },
                ]
              : [required],
          download: async () => new Response(contents),
        } as any),
      );
    }
  });
});
