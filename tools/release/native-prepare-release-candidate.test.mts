import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ManifestPlugin } from 'release-please/build/src/plugin.js';
import { mergeUpdates } from 'release-please/build/src/updaters/composite.js';
import { Version } from 'release-please/build/src/version.js';
import { projectCargoWorkspace, renderToml } from '../../build_defs/languages/cargo-metadata.mts';
import { sourceManifest } from '../../build_defs/languages/source-package.mts';
import { readCommitHistory, readCommitPaths } from './commit-paths.mts';
import { applyCandidate } from './prepare-release-candidate.mts';
import { loadProducts, productCompatibilityVersion, ROOT } from './release-graph.mts';
import { syncLockfile } from './sync-release-pr.mts';
import {
  fixtureCompletionChecker,
  generateHistoryCandidate,
  generateProductCandidateForGraph,
  historyProducts,
  historyShared,
  historyVersionUpdates,
  nativeHistoryOptions,
} from './testdata/prepare-release-candidate-fixtures.mts';

const graph = { products: loadProducts('native-prepare-release-candidate.test') };
const native = 'src/native/runtime';
const wasix = 'src/wasix/runtime';
const first = 'a'.repeat(40);
const second = 'b'.repeat(40);
const head = 'c'.repeat(40);
function generateProductCandidate(...args) {
  return generateProductCandidateForGraph(graph, ...args);
}
function nativeProductOptions(necessary) {
  // The controller's already-verified decision is the injected fixture precondition.
  return {
    nativeNecessaryProducts: necessary,
    buildBound: new Map(Object.keys(graph.products).map((id) => [id, new Set<string>()])),
    nativeObservation: {
      coverage: { completeProductInventory: true },
      products: Object.entries(graph.products).map(([id, metadata]) => ({
        product: { id },
        construction: [
          {
            leafInputPaths: [
              `${metadata.path}/src/implementation`,
              `${metadata.path}/source.toml`,
              `${metadata.path}/ios/OliphauntAdapter.swift`,
              `${metadata.path}/crates/oliphaunt-build/src/lib.rs`,
            ],
            analysisInputPaths: [],
          },
        ],
      })),
    },
    observeNativePlan: async () => {},
  };
}
test('native necessary scope uses actual captured leaves, including zero and patch intent without ownership expansion', async () => {
  for (const selected of [[], ['alpha'], ['alpha', 'beta', 'gamma']]) {
    const plans = [];
    const candidates = await generateHistoryCandidate(
      [
        {
          sha: head,
          message: 'feat: old shared ownership and unselected source intent',
          files: [historyShared, 'actual/shipping/beta.c'],
        },
        { sha: first, message: 'fix: already delivered', files: [historyShared] },
      ],
      {
        controllerOptions: nativeHistoryOptions(selected, {
          observeNativePlan: async (plan) => {
            plans.push(plan);
          },
        }),
      },
    );
    expect(historyVersionUpdates(candidates).map(([file]) => file)).toEqual(
      selected.map((id) => `products/${id}/VERSION`),
    );
    expect(plans).toHaveLength(1);
    expect(plans[0].selectedProducts).toEqual(selected);
    if (selected.includes('alpha'))
      expect(
        historyVersionUpdates(candidates).find(([file]) => file === 'products/alpha/VERSION')![1],
      ).toBe('0.2.1');
  }
});

test('native first delivery uses the configured Release Please initial version', async () => {
  const candidates = await generateHistoryCandidate(
    [
      { sha: head, message: 'feat: initial alpha interface', files: ['actual/shipping/alpha.c'] },
      {
        sha: second,
        message: 'feat!: earlier unrelated acquisition change',
        files: ['acquisition/old-tool.toml'],
      },
      { sha: first, message: 'fix: published other products', files: [historyShared] },
    ],
    { unreleased: ['alpha'], controllerOptions: nativeHistoryOptions(['alpha']) },
  );
  expect(historyVersionUpdates(candidates)).toEqual([['products/alpha/VERSION', '0.1.0']]);
});

test('native loaded recipe breaking intent applies only to a necessary configured consumer', async () => {
  const options = nativeHistoryOptions(['alpha']);
  options.nativeObservation.products[0].construction[0].analysisInputPaths = [
    'build_defs/alpha/producer.bzl',
  ];
  options.nativeObservation.products[1].construction[0].analysisInputPaths = [
    'build_defs/beta/producer.bzl',
  ];
  const candidates = await generateHistoryCandidate(
    [
      {
        sha: head,
        message: 'feat!: change native producer ABI',
        files: ['build_defs/alpha/producer.bzl'],
      },
      {
        sha: second,
        message: 'feat!: unrelated producer change',
        files: ['build_defs/beta/producer.bzl'],
      },
      { sha: first, message: 'fix: baseline', files: [historyShared] },
    ],
    { controllerOptions: options },
  );
  expect(historyVersionUpdates(candidates)).toEqual([['products/alpha/VERSION', '0.3.0']]);
  delete options.nativeObservation.products[0].construction[0].analysisInputPaths;
  await expect(generateHistoryCandidate([], { controllerOptions: options })).rejects.toThrow(
    'unknown loaded recipe version intent',
  );
});

test('native breaking intent follows removed Files to their authenticated historical owner', async () => {
  const options = nativeHistoryOptions(['alpha', 'beta']);
  options.nativeVersionIntentBaselines = {
    alpha: {
      product: { id: 'alpha' },
      construction: [
        { leafInputPaths: ['actual/shipping/removed-alpha.c'], analysisInputPaths: [] },
      ],
    },
  };
  const candidates = await generateHistoryCandidate(
    [
      {
        sha: head,
        message: 'feat!: remove alpha entry and update beta',
        files: ['actual/shipping/removed-alpha.c', 'actual/shipping/beta.c'],
      },
      { sha: first, message: 'fix: baseline', files: [historyShared] },
    ],
    { controllerOptions: options },
  );
  expect(historyVersionUpdates(candidates)).toEqual([
    ['products/alpha/VERSION', '0.3.0'],
    ['products/beta/VERSION', '0.3.0'],
  ]);
  options.nativeNecessaryProducts = ['beta'];
  expect(
    historyVersionUpdates(
      await generateHistoryCandidate(
        [
          {
            sha: head,
            message: 'feat!: remove alpha entry and update beta',
            files: ['actual/shipping/removed-alpha.c', 'actual/shipping/beta.c'],
          },
          { sha: first, message: 'fix: baseline', files: [historyShared] },
        ],
        { controllerOptions: options },
      ),
    ),
  ).toEqual([['products/beta/VERSION', '0.3.0']]);
});

test('partly mapped breaking history cannot silently patch a necessary legacy product without its old footprint', async () => {
  const commits = [
    {
      sha: head,
      message: 'feat!: remove an old alpha entry and update beta',
      files: ['actual/shipping/removed-alpha.c', 'actual/shipping/beta.c'],
    },
    { sha: first, message: 'fix: baseline', files: [historyShared] },
  ];
  await expect(
    generateHistoryCandidate(commits, {
      controllerOptions: nativeHistoryOptions(['alpha', 'beta']),
    }),
  ).rejects.toThrow('unknown breaking acquisition intent for alpha');
  commits[0].message = 'feat(alpha)!: explicitly remove the alpha entry';
  expect(
    historyVersionUpdates(
      await generateHistoryCandidate(commits, {
        controllerOptions: nativeHistoryOptions(['alpha', 'beta']),
      }),
    ),
  ).toEqual([
    ['products/alpha/VERSION', '0.3.0'],
    ['products/beta/VERSION', '0.3.0'],
  ]);
});

test('native unmapped breaking acquisition stays unknown until an explicit component intent resolves it', async () => {
  const commits = [
    {
      sha: head,
      message: 'feat!: replace acquired compiler ABI',
      files: ['acquisition/compiler-pin.toml'],
    },
    { sha: first, message: 'fix: published baseline', files: [historyShared] },
  ];
  await expect(
    generateHistoryCandidate(commits, { controllerOptions: nativeHistoryOptions(['alpha']) }),
  ).rejects.toThrow('unknown breaking acquisition intent');
  commits[0].message = 'feat(alpha)!: replace acquired compiler ABI';
  const candidate = await generateHistoryCandidate(commits, {
    controllerOptions: nativeHistoryOptions(['alpha']),
  });
  expect(historyVersionUpdates(candidate)).toEqual([['products/alpha/VERSION', '0.3.0']]);
  commits[0].message = 'feat(beta)!: replace beta acquired compiler ABI';
  expect(
    historyVersionUpdates(
      await generateHistoryCandidate(commits, {
        controllerOptions: nativeHistoryOptions(['alpha']),
      }),
    ),
  ).toEqual([['products/alpha/VERSION', '0.2.1']]);
  // The same unmapped breaking commit was already delivered by alpha. It
  // cannot block alpha merely because another owner has an older baseline.
  commits[0].message = 'feat!: replace acquired compiler ABI';
  expect(
    historyVersionUpdates(
      await generateHistoryCandidate(commits, {
        baselines: { alpha: head, beta: first, gamma: first },
        controllerOptions: nativeHistoryOptions(['alpha']),
      }),
    ),
  ).toEqual([['products/alpha/VERSION', '0.2.1']]);
});

test('native workspace cannot create unselected dependents or retarget a held independently necessary package', async () => {
  const commits = [
    {
      sha: head,
      message: 'fix: change physical deliveries',
      files: ['actual/shipping/alpha.c', 'actual/shipping/beta.c'],
    },
    { sha: first, message: 'fix: baseline', files: [historyShared] },
  ];
  for (const current of [false, true]) {
    const selected = ['alpha', 'beta'];
    const candidates = await generateHistoryCandidate(commits, {
      nodeWorkspace: true,
      controllerOptions: nativeHistoryOptions(selected, { current }),
    });
    expect(candidates[0].body.releaseData.map(({ component }) => component).sort()).toEqual(
      selected,
    );
    const packageUpdate = candidates[0].updates.filter(
      ({ path }) => path === 'products/alpha/package.json',
    );
    let text = JSON.stringify({ name: 'alpha', version: '0.2.0', dependencies: { beta: '0.2.0' } });
    for (const update of packageUpdate) text = update.updater.updateContent(text);
    expect(JSON.parse(text).dependencies.beta).toBe(current ? '0.2.1' : '0.2.0');
  }
  const candidates = await generateHistoryCandidate(commits, {
    nodeWorkspace: true,
    controllerOptions: nativeHistoryOptions(['beta']),
  });
  expect(candidates[0].body.releaseData.map(({ component }) => component)).toEqual(['beta']);
});

test('native missing coverage and rejected adoption decision stop before an applicable candidate exists', async () => {
  const commits = [
    { sha: head, message: 'fix: delivery', files: ['actual/shipping/alpha.c'] },
    { sha: first, message: 'fix: baseline', files: [historyShared] },
  ];
  for (const change of [
    (options) => {
      delete options.buildBound;
    },
    (options) => {
      options.nativeObservation.products[0].construction[0].leafInputPaths = undefined;
    },
    (options) => {
      options.nativeObservation.products.pop();
    },
    (options) => {
      options.nativeNecessaryProducts = ['foreign'];
    },
  ]) {
    const options = nativeHistoryOptions(['alpha']);
    change(options);
    await expect(generateHistoryCandidate(commits, { controllerOptions: options })).rejects.toThrow(
      'native Release Please',
    );
  }
  await expect(
    generateHistoryCandidate(commits, {
      controllerOptions: nativeHistoryOptions(['alpha'], {
        observeNativePlan: async () => {
          throw new Error('adoption physical qualification is unknown');
        },
      }),
    }),
  ).rejects.toThrow('qualification is unknown');
});

test('native explicit default-install fixed point is approved before RP and retains one exact candidate scope', async () => {
  const buildBound = new Map(Object.keys(graph.products).map((id) => [id, new Set<string>()]));
  buildBound.get('oliphaunt-wasix-napi')!.add('liboliphaunt-wasix');
  for (const [id, metadata] of Object.entries(graph.products))
    if (metadata.extension?.class === 'external')
      buildBound.set(id, new Set(['liboliphaunt-native', 'liboliphaunt-wasix']));
  const needed = ['liboliphaunt-wasix', 'oliphaunt-extension-vector'];
  let approved;
  const { candidate } = await generateProductCandidate(
    [
      {
        sha: head,
        message: 'fix: qualified changed host and member',
        files: [`${wasix}/toolchain.toml`, 'src/extensions/external/vector/source.toml'],
      },
    ],
    undefined,
    undefined,
    {
      buildBound,
      nativeNecessaryProducts: needed,
      nativeObservation: {
        coverage: { completeProductInventory: true },
        products: Object.entries(graph.products).map(([id, metadata]) => ({
          product: { id },
          construction: [
            {
              leafInputPaths: [
                `${metadata.path}/VERSION`,
                `${metadata.path}/source.toml`,
                `${metadata.path}/toolchain.toml`,
              ],
              analysisInputPaths: [],
            },
          ],
        })),
      },
      observeNativePlan: async (plan) => {
        approved = plan;
      },
    },
  );
  const actual = candidate.body.releaseData.map(({ component }) => component).sort();
  expect(actual).toEqual(approved.selectedProducts);
  expect(actual).toContain('oliphaunt-wasix-napi');
  expect(actual).toContain('oliphaunt-wasix-ts');
  expect(actual).not.toContain('liboliphaunt-native');
  expect(approved.requirements.length).toBeGreaterThan(0);
  expect([...buildBound.get('oliphaunt-wasix-napi')!]).toEqual(['liboliphaunt-wasix']);
});

test('native ABI extension adoption changes the source SDK requirement through RP while retaining dynamic helpers', async () => {
  const product = 'oliphaunt-extension-vector';
  const buildBound = new Map(Object.keys(graph.products).map((id) => [id, new Set<string>()]));
  const sdkFile = 'src/native/sdks/ts/package.json';
  const before = readFileSync(path.join(ROOT, sdkFile), 'utf8');
  let approved;
  const { candidate } = await generateProductCandidate(
    [
      {
        sha: head,
        message: 'fix: update extension payload',
        files: ['src/extensions/external/vector/source.toml'],
      },
    ],
    undefined,
    undefined,
    {
      buildBound,
      nativeNecessaryProducts: [product],
      nativeObservation: {
        coverage: { completeProductInventory: true },
        products: Object.entries(graph.products).map(([id, metadata]) => ({
          product: { id },
          construction: [
            { leafInputPaths: [`${metadata.path}/source.toml`], analysisInputPaths: [] },
          ],
        })),
      },
      observeNativePlan: async (plan) => {
        approved = plan;
      },
    },
  );
  const selected = candidate.body.releaseData.map(({ component }) => component).sort();
  expect(selected).toEqual(approved.selectedProducts);
  expect(selected).toContain(product);
  expect(selected).toContain('oliphaunt-js');
  for (const held of [
    'liboliphaunt-native',
    'liboliphaunt-wasix',
    'oliphaunt-node-direct',
    'oliphaunt-broker',
    'liboliphaunt-native-bindings',
  ])
    expect(selected).not.toContain(held);
  const sdkUpdate = mergeUpdates(candidate.updates).find(({ path }) => path === sdkFile);
  expect(sdkUpdate).toBeDefined();
  const source = JSON.parse(before);
  const adopted = JSON.parse(sdkUpdate.updater.updateContent(before));
  expect(adopted.oliphaunt.liboliphauntVersion).toBe(graph.products['liboliphaunt-native'].version);
  expect(adopted.version).not.toBe(source.version);
  expect(adopted.oliphaunt.nodeDirectAddonVersion).toBe(source.oliphaunt.nodeDirectAddonVersion);
  expect(adopted.oliphaunt.brokerVersion).toBe(source.oliphaunt.brokerVersion);
  expect(readFileSync(path.join(ROOT, sdkFile), 'utf8')).toBe(before);
});

test('actual Rust, npm, Swift and Gradle strategy updates apply to one local candidate', async () => {
  const root = path.resolve(import.meta.dir, '../..');
  const selected = [
    'src/native/sdks/rust',
    'src/native/sdks/ts',
    'src/native/sdks/swift',
    'src/native/sdks/kotlin',
  ];
  const { candidate, versions } = await generateProductCandidate(
    [
      {
        sha: head,
        message: 'fix: correct the selected SDK behavior',
        files: selected.map((owner) => `${owner}/src/implementation`),
      },
    ],
    undefined,
    undefined,
    nativeProductOptions(['oliphaunt-rust', 'oliphaunt-js', 'oliphaunt-swift', 'oliphaunt-kotlin']),
  );
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'release-please-ecosystems-'));
  try {
    for (const update of candidate.updates) {
      const input = path.join(root, update.path);
      if (existsSync(input)) {
        const destination = path.join(scratch, update.path);
        mkdirSync(path.dirname(destination), { recursive: true });
        writeFileSync(destination, readFileSync(input));
      }
    }
    applyCandidate(scratch, candidate);
    const after = JSON.parse(
      readFileSync(path.join(scratch, '.release-please-manifest.json'), 'utf8'),
    );
    const read = (file) => readFileSync(path.join(scratch, file), 'utf8');
    expect(Bun.TOML.parse(read('src/native/sdks/rust/Cargo.toml')).package.version).toBe(
      after['src/native/sdks/rust'],
    );
    expect(
      Bun.TOML.parse(read('src/native/sdks/rust/crates/oliphaunt-build/Cargo.toml')).package
        .version,
    ).toBe(after['src/native/sdks/rust']);
    expect(JSON.parse(read('src/native/sdks/ts/package.json')).version).toBe(
      after['src/native/sdks/ts'],
    );
    expect(read('src/native/sdks/swift/VERSION').trim()).toBe(after['src/native/sdks/swift']);
    expect(read('src/native/sdks/kotlin/VERSION').trim()).toBe(after['src/native/sdks/kotlin']);
    expect(read('src/native/sdks/kotlin/gradle.properties')).toContain(
      `VERSION_NAME=${after['src/native/sdks/kotlin']}`,
    );
    expect(existsSync(path.join(scratch, 'src/native/sdks/rust/Cargo.lock'))).toBe(false);
    for (const owner of selected) expect(after[owner]).not.toBe(versions[owner]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('independent SDK pins do not impose a single global runtime version', async () => {
  const readCompatibility = (product, source) =>
    product === 'oliphaunt-react-native' ? '0.2.0' : graph.products[source].version;
  const { candidate } = await generateProductCandidate(
    [
      {
        sha: head,
        message: 'fix: repair mobile adapters',
        files: [
          'src/native/sdks/kotlin/src/implementation',
          'src/native/sdks/react-native/ios/OliphauntAdapter.swift',
        ],
      },
    ],
    readCompatibility,
    undefined,
    nativeProductOptions(['oliphaunt-kotlin', 'oliphaunt-react-native']),
  );
  expect(candidate).toBeDefined();
  expect(
    candidate.updates.some(({ path: file }) => file.startsWith('src/extensions/external/')),
  ).toBe(false);
});

test('removing published exact host support supplies breaking intent before native version selection', async () => {
  const vector = graph.products['oliphaunt-extension-vector'];
  const reads = [];
  const readCompatibility = (product, source, _prefix, { ref = null } = {}) => {
    reads.push({ product, source, ref });
    return product === 'oliphaunt-extension-vector'
      ? ref
        ? '0.1.0'
        : graph.products[source].version
      : productCompatibilityVersion(product, source);
  };
  const { candidate, versions } = await generateProductCandidate(
    [
      {
        sha: head,
        message: 'fix: repair vector packaging',
        files: [`${vector.path}/source.toml`],
      },
    ],
    readCompatibility,
    undefined,
    nativeProductOptions(['oliphaunt-extension-vector']),
  );
  const update = mergeUpdates(candidate.updates).find(
    ({ path: file }) => file === '.release-please-manifest.json',
  );
  const after = JSON.parse(update.updater.updateContent(JSON.stringify(versions)));
  const [major, minor] = vector.version.split('.').map(Number);
  expect(after[vector.path]).toBe(`${major}.${minor + 1}.0`);
  const changelog = candidate.updates
    .find(({ path: file }) => file === vector.changelog_path)
    .updater.updateContent('# Changelog\n');
  expect(changelog).toContain('replace exact host support');
  expect(changelog).toContain('repair vector packaging');
  expect(
    reads.some(({ product, ref }) => product === 'oliphaunt-extension-vector' && ref !== null),
  ).toBe(true);
});

test('unchanged public support permits an ordinary patch release', async () => {
  const vector = graph.products['oliphaunt-extension-vector'];
  const { candidate, versions } = await generateProductCandidate(
    [
      {
        sha: head,
        message: 'fix: repair vector SQL',
        files: [`${vector.path}/source.toml`],
      },
    ],
    undefined,
    undefined,
    nativeProductOptions(['oliphaunt-extension-vector']),
  );
  const update = mergeUpdates(candidate.updates).find(
    ({ path: file }) => file === '.release-please-manifest.json',
  );
  const after = JSON.parse(update.updater.updateContent(JSON.stringify(versions)));
  const [major, minor, patch] = vector.version.split('.').map(Number);
  expect(after[vector.path]).toBe(`${major}.${minor}.${patch + 1}`);
});

test('unrelated Rust candidates do not inject unselected extension support intent', async () => {
  const vector = graph.products['oliphaunt-extension-vector'];
  let bump;
  await generateProductCandidate(
    [
      {
        sha: head,
        message: 'fix: update build helper API',
        files: ['src/native/sdks/rust/crates/oliphaunt-build/src/lib.rs'],
      },
    ],
    (_product, source, _prefix, { ref = null } = {}) =>
      ref ? '0.1.0' : graph.products[source].version,
    (manifest, github) => {
      manifest.plugins.push(
        new (class extends ManifestPlugin {
          async preconfigure(strategies, _commits, releases) {
            bump = await strategies[vector.path].versioningStrategy.bump(
              releases[vector.path].tag.version,
              [],
            );
            return strategies;
          }
        })(github, 'main', manifest.repositoryConfig),
      );
    },
    nativeProductOptions(['oliphaunt-rust']),
  );
  const [major, minor, patch] = vector.version.split('.').map(Number);
  expect(bump.toString()).toBe(`${major}.${minor}.${patch + 1}`);
});

test('docs changes do not read compatibility or create candidates', async () => {
  const { candidate } = await generateProductCandidate(
    [
      {
        sha: head,
        message: 'docs: clarify preparation',
        files: ['src/docs/maintainers/release.md'],
      },
    ],
    () => {
      throw new Error('unexpected compatibility read');
    },
    undefined,
    nativeProductOptions([]),
  );
  expect(candidate).toBeUndefined();
});

function nativeHistorySourceOptions(necessary) {
  const options = nativeHistoryOptions(necessary);
  for (const row of options.nativeObservation.products)
    row.construction[0].leafInputPaths.push(
      historyShared,
      `products/${row.product.id}/src/lib.rs`,
      `products/${row.product.id}/src/old.rs`,
    );
  return options;
}

test('out-of-directory completed releases strictly bound each owner before strategy selection', async () => {
  const old = 'd'.repeat(40);
  const candidates = await generateHistoryCandidate(
    [
      { sha: head, message: 'fix: new beta delivery', files: ['products/beta/src/lib.rs'] },
      {
        sha: second,
        message: 'fix: publication recovery',
        files: ['tools/release/controller.mts'],
      },
      {
        sha: old,
        message: 'fix: old shared delivery',
        files: [historyShared, 'products/beta/src/old.rs', 'products/gamma/src/old.rs'],
      },
      { sha: first, message: 'fix: original recovery', files: ['tools/release/controller.mts'] },
    ],
    {
      baselines: { alpha: first, beta: second, gamma: second },
      controllerOptions: nativeHistorySourceOptions(['alpha', 'beta']),
      inspect(selected) {
        expect(selected['products/alpha'].map(({ sha }) => sha)).toEqual([old]);
        expect(selected['products/beta'].map(({ sha }) => sha)).toEqual([head]);
        expect(selected['products/gamma']).toEqual([]);
      },
    },
  );
  expect(historyVersionUpdates(candidates).sort()).toEqual([
    ['products/alpha/VERSION', '0.2.1'],
    ['products/beta/VERSION', '0.2.1'],
  ]);
  const notes = candidates[0].body.toString();
  expect(notes.match(/old shared delivery/gu)).toHaveLength(1);
  expect(notes.match(/new beta delivery/gu)).toHaveLength(1);
  expect(notes).not.toContain('publication recovery');
  expect(notes).not.toContain('original recovery');
});

test('public release boundaries require a completed canonical version transition', async () => {
  const commits = [
    { sha: head, message: 'fix: new alpha behavior', files: ['products/alpha/src/lib.rs'] },
    { sha: first, message: 'chore(release): public baseline', files: [] },
  ];
  for (const completion of [{ pending: ['alpha'] }, { missingLabels: ['alpha'] }])
    await expect(
      generateHistoryCandidate(commits, {
        completion,
        controllerOptions: nativeHistorySourceOptions(['alpha']),
      }),
    ).rejects.toThrow('publication is not complete');
  for (const completion of [{ omitCompletions: ['alpha'] }, { unchangedAtMerge: ['alpha'] }])
    await expect(
      generateHistoryCandidate(commits, {
        completion,
        controllerOptions: nativeHistorySourceOptions(['alpha']),
      }),
    ).rejects.toThrow('no unique canonical release completion');
});

test('completed publication resolves the exact published tree and original release independently', async () => {
  const config = { 'products/alpha': { component: 'alpha' } };
  const versions = { 'products/alpha': Version.parse('0.2.0') };
  const identity = {
    product: 'alpha',
    version: '0.2.0',
    publicationSha: second,
    tagName: 'alpha-v0.2.0',
  };
  const check = fixtureCompletionChecker(
    config,
    versions,
    { 'products/alpha': second },
    {
      releaseMergeShas: { alpha: first },
    },
  );
  expect(await check(identity)).toEqual({
    ...identity,
    publicationTree: 'd'.repeat(40),
    releaseSha: first,
  });
  for (const commit of [
    { sha: head, tree: { sha: 'd'.repeat(40) } },
    { sha: second, tree: {} },
  ]) {
    const reject = fixtureCompletionChecker(
      config,
      versions,
      { 'products/alpha': second },
      {
        releaseMergeShas: { alpha: first },
        sourceCommits: { [second]: commit },
      },
    );
    await expect(reject(identity)).rejects.toThrow('publication source has no exact Git tree');
  }
});

test('completed publication recovery retains the original canonical release and exact source versions', async () => {
  const recovery = {
    controllerOptions: nativeHistorySourceOptions(['alpha']),
    baselines: Object.fromEntries(historyProducts.map((product) => [product, second])),
    completion: {
      releaseMergeShas: Object.fromEntries(historyProducts.map((product) => [product, first])),
    },
  };
  const commits = [
    { sha: head, message: 'fix: new alpha behavior', files: ['products/alpha/src/lib.rs'] },
    { sha: second, message: 'fix: recover publication', files: ['tools/release/controller.mts'] },
  ];
  expect(historyVersionUpdates(await generateHistoryCandidate(commits, recovery))).toEqual([
    ['products/alpha/VERSION', '0.2.1'],
  ]);
  expect(
    historyVersionUpdates(
      await generateHistoryCandidate(commits, {
        ...recovery,
        completion: {
          ...recovery.completion,
          comparisons: {
            [`${first}...${second}`]: {
              status: 'ahead',
              behind_by: 0,
              base_commit: { sha: first },
              merge_base_commit: { sha: first },
              total_commits: 2,
              commits: [{ sha: second }, { sha: 'd'.repeat(40) }],
            },
          },
        },
      }),
    ),
  ).toEqual([['products/alpha/VERSION', '0.2.1']]);
  for (const interval of [
    [{ sha: second }, { sha: second }],
    [{ sha: second }, { sha: 'invalid' }],
    [{ sha: 'd'.repeat(40) }, { sha: 'e'.repeat(40) }],
  ])
    await expect(
      generateHistoryCandidate(commits, {
        ...recovery,
        completion: {
          ...recovery.completion,
          comparisons: {
            [`${first}...${second}`]: {
              status: 'ahead',
              behind_by: 0,
              base_commit: { sha: first },
              merge_base_commit: { sha: first },
              total_commits: 2,
              commits: interval,
            },
          },
        },
      }),
    ).rejects.toThrow('publication recovery history is incomplete');
  await expect(
    generateHistoryCandidate(commits, {
      ...recovery,
      completion: { ...recovery.completion, releaseTargets: { 'alpha-v0.2.0': first } },
    }),
  ).rejects.toThrow('public release does not bind its exact publication source');
  await expect(
    generateHistoryCandidate(commits, {
      ...recovery,
      completion: {
        ...recovery.completion,
        sourceVersions: {
          [second]: {
            'products/alpha': '0.3.0',
            'products/beta': '0.2.0',
            'products/gamma': '0.2.0',
          },
        },
      },
    }),
  ).rejects.toThrow('publication source has different product versions');
  await expect(
    generateHistoryCandidate(commits, {
      ...recovery,
      completion: {
        ...recovery.completion,
        sourceVersions: {
          [second]: {
            'products/alpha': '0.2.0',
            'products/beta': '0.3.0',
            'products/gamma': '0.2.0',
          },
        },
      },
    }),
  ).rejects.toThrow('publication source has different product versions');
  await expect(
    generateHistoryCandidate(commits, {
      ...recovery,
      completion: {
        ...recovery.completion,
        comparisons: {
          [`${first}...${second}`]: {
            status: 'diverged',
            behind_by: 1,
            base_commit: { sha: first },
            merge_base_commit: { sha: first },
          },
        },
      },
    }),
  ).rejects.toThrow('publication source is not a release descendant');
  const intervening = 'd'.repeat(40);
  await expect(
    generateHistoryCandidate(commits, {
      ...recovery,
      completion: {
        ...recovery.completion,
        extraPullRequests: [
          {
            number: 999,
            title: 'chore(release): prepare main releases',
            state: 'closed',
            merged_at: '2026-09-12T00:00:00Z',
            merge_commit_sha: intervening,
            base: { ref: 'main', repo: { full_name: 'f0rr0/oliphaunt' } },
            head: { ref: 'release-please--branches--main', repo: { full_name: 'f0rr0/oliphaunt' } },
            labels: [{ name: 'autorelease: tagged' }],
            body: '',
          },
        ],
        comparisons: {
          [`${first}...${second}`]: {
            status: 'ahead',
            behind_by: 0,
            base_commit: { sha: first },
            merge_base_commit: { sha: first },
            total_commits: 2,
            commits: [{ sha: intervening }, { sha: second }],
          },
        },
      },
    }),
  ).rejects.toThrow('publication source follows another release candidate');
});

test('long publication recovery is completely paged and shared across product checks', async () => {
  const interval = Array.from({ length: 150 }, (_, index) => ({
    sha: (3_000_000 + index).toString(16).padStart(40, '0'),
  }));
  interval[149] = { sha: second };
  const calls = {};
  const options = {
    controllerOptions: nativeHistorySourceOptions(historyProducts),
    baselines: Object.fromEntries(historyProducts.map((product) => [product, second])),
    completion: {
      releaseMergeShas: Object.fromEntries(historyProducts.map((product) => [product, first])),
      comparisons: {
        [`${first}...${second}`]: {
          status: 'ahead',
          behind_by: 0,
          base_commit: { sha: first },
          merge_base_commit: { sha: first },
          total_commits: 150,
          commits: interval.slice(0, 100),
        },
      },
      pagedComparisons: { [`${first}...${second}`]: interval },
      calls,
    },
  };
  const commits = [
    { sha: head, message: 'fix: new shared behavior', files: [historyShared] },
    { sha: second, message: 'fix: recover publication', files: [] },
  ];
  expect(historyVersionUpdates(await generateHistoryCandidate(commits, options))).toHaveLength(3);
  expect(calls.pages).toBe(1);
  await expect(
    generateHistoryCandidate(commits, {
      ...options,
      completion: { ...options.completion, pagedComparisons: {} },
    }),
  ).rejects.toThrow('publication recovery history is incomplete');
});

test('actual Git ancestry bounds Release Please despite clock skew and reordered API history', async () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'release-history-ancestry-'));
  try {
    for (const delivered of [false, true]) {
      const repo = path.join(fixture, String(delivered));
      mkdirSync(repo);
      let date = '2020-01-01T12:00:00Z';
      const run = (command, args) => {
        const result = spawnSync(command, args, {
          cwd: repo,
          encoding: 'utf8',
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'Fixture',
            GIT_AUTHOR_EMAIL: 'fixture@example.com',
            GIT_COMMITTER_NAME: 'Fixture',
            GIT_COMMITTER_EMAIL: 'fixture@example.com',
            GIT_AUTHOR_DATE: date,
            GIT_COMMITTER_DATE: date,
          },
        });
        if (result.status !== 0) throw new Error(`${command}: ${result.stderr}`);
        return result.stdout.trim();
      };
      const commit = (message, nextDate) => {
        date = nextDate;
        run('git', ['add', '.']);
        run('git', ['commit', '--allow-empty', '-qm', message]);
        return run('git', ['rev-parse', 'HEAD']);
      };
      run('git', ['init', '-q', '-b', 'main']);
      mkdirSync(path.join(repo, 'products/alpha/src'), { recursive: true });
      writeFileSync(path.join(repo, 'products/alpha/src/lib.rs'), 'original\n');
      const root = commit('chore: original source', '2020-01-01T12:00:00Z');
      run('git', ['checkout', '-qb', 'feature']);
      writeFileSync(path.join(repo, 'products/alpha/src/lib.rs'), 'new API\n');
      const branch = commit('feat!: new alpha API', '2020-01-04T12:00:00Z');
      run('git', ['checkout', '-q', 'main']);
      let baseline;
      if (!delivered)
        baseline = commit('chore(release): completed versions', '2020-01-05T12:00:00Z');
      date = '2020-01-06T12:00:00Z';
      run('git', ['merge', '--no-ff', '-qm', 'chore: merge feature', 'feature']);
      const merge = run('git', ['rev-parse', 'HEAD']);
      if (delivered)
        baseline = commit('chore(release): completed versions', '2020-01-02T12:00:00Z');
      const source = delivered ? commit('docs: controller notes', '2020-01-07T12:00:00Z') : merge;
      const snapshot = path.join(repo, 'snapshot');
      run('bash', [
        path.join(ROOT, 'tools/release/snapshot-commit-paths.sh'),
        repo,
        source,
        snapshot,
      ]);
      const commitHistory = readCommitHistory(snapshot);
      const apiOrder = delivered
        ? [branch, source, baseline, merge, root]
        : [baseline, root, branch, source];
      const commits = apiOrder.map((sha) => ({
        sha,
        message: run('git', ['show', '-s', '--format=%B', sha]),
        files: [],
      }));
      const options = {
        controllerOptions: nativeHistorySourceOptions(delivered ? [] : ['alpha']),
        baselines: Object.fromEntries(historyProducts.map((product) => [product, baseline])),
        commitHistory,
        readCommitFiles: (sha) => readCommitPaths(sha, snapshot),
        sourceSha: source,
        readSource: async () => ({ object: { sha: source } }),
      };
      const candidates = await generateHistoryCandidate(commits, {
        ...options,
        inspect(selected, calls) {
          expect(calls.commits.maxResults).toBe(commitHistory.commits.size);
          expect(selected['products/beta']).toEqual([]);
          expect(selected['products/gamma']).toEqual([]);
          expect(new Set(selected['products/alpha'].map(({ sha }) => sha))).toEqual(
            new Set(delivered ? [] : [merge, branch]),
          );
        },
      });
      expect(historyVersionUpdates(candidates)).toEqual(
        delivered ? [] : [['products/alpha/VERSION', '0.3.0']],
      );
      await expect(
        generateHistoryCandidate(commits, {
          ...options,
          readSource: async () => ({ object: { sha: root } }),
        }),
      ).rejects.toThrow('main changed before');
      await expect(
        generateHistoryCandidate(commits, { ...options, sourceSha: root }),
      ).rejects.toThrow('captured Git history does not match');
      await expect(
        generateHistoryCandidate(
          [{ sha: 'f'.repeat(40), message: 'fix: foreign' }, ...commits],
          options,
        ),
      ).rejects.toThrow('outside the captured source');
      await expect(
        generateHistoryCandidate(
          commits.filter(({ sha }) => sha !== source),
          options,
        ),
      ).rejects.toThrow('API history did not cover captured source');
      await expect(generateHistoryCandidate([commits[0], ...commits], options)).rejects.toThrow(
        'duplicate history commit',
      );
      if (!delivered) {
        expect(
          historyVersionUpdates(
            await generateHistoryCandidate(commits, {
              ...options,
              unreleased: historyProducts,
              bootstrapSha: baseline,
            }),
          ),
        ).toEqual([['products/alpha/VERSION', '0.1.0']]);
      }
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('actual RP exact-module requirements preserve held resources and independently version a qualified current adoption', async () => {
  const product = 'database-resources',
    sourceProduct = 'liboliphaunt-wasix';
  const resource = graph.products[product],
    core = graph.products[sourceProduct];
  for (const selected of [[sourceProduct], [product], [sourceProduct, product]]) {
    const plans = [];
    const options = nativeProductOptions(selected);
    options.nativeCurrentExactInputs = [{ product, sourceProduct }];
    options.observeNativePlan = async (plan) => {
      plans.push(plan);
    };
    const { candidate, versions } = await generateProductCandidate(
      [],
      () => '0.3.2',
      () => {
        // Mutation after the hook receives the derived list cannot change its plan.
        options.nativeCurrentExactInputs[0].sourceProduct = 'liboliphaunt-native';
      },
      options,
    );
    expect(plans).toHaveLength(1);
    expect(plans[0].selectedProducts).toEqual([...selected].sort());
    const updates = mergeUpdates(candidate.updates);
    const manifest = updates.find(({ path: file }) => file === '.release-please-manifest.json');
    const after = JSON.parse(manifest.updater.updateContent(JSON.stringify(versions)));
    const expectedCore = selected.includes(sourceProduct)
      ? core.version
          .split('.')
          .map((part, index) => (index === 2 ? Number(part) + 1 : Number(part)))
          .join('.')
      : core.version;
    expect(after[core.path]).toBe(expectedCore);
    const pin = updates.find(
      ({ path: file }) => file === 'src/database-resources/seeds/wasix/Cargo.toml',
    );
    const original = readFileSync(
      path.join(ROOT, 'src/database-resources/seeds/wasix/Cargo.toml'),
      'utf8',
    );
    const final = pin ? pin.updater.updateContent(original) : original;
    expect(Bun.TOML.parse(final).package.metadata.oliphaunt['runtime-version']).toBe(
      selected.includes(sourceProduct) && selected.includes(product) ? expectedCore : '0.3.2',
    );
    expect(plans[0].requirements).toEqual(
      selected.length === 2 ? [{ product, sourceProduct, version: expectedCore }] : [],
    );
    expect(options.buildBound.get(product).size).toBe(0);
    if (selected.includes(product)) expect(after[resource.path]).not.toBe(resource.version);
    else expect(after[resource.path]).toBe(resource.version);
  }
});

test('actual RP local Cargo closure preserves held pins and projects released source minimums offline', async () => {
  const core = 'liboliphaunt-native-bindings',
    broker = 'oliphaunt-broker',
    sdk = 'oliphaunt-rust';
  const cases = [
    { owner: core, message: undefined, necessary: [], selected: [] },
    { owner: core, message: 'fix: update Core', necessary: [core], selected: [core] },
    { owner: core, message: 'fix: update Core', necessary: [core, sdk], selected: [core, sdk] },
    {
      owner: core,
      message: 'fix: update Core',
      necessary: [core, broker],
      selected: [core, broker],
    },
    {
      owner: core,
      message: 'fix: update Core',
      necessary: [core, sdk],
      selected: [core, sdk, 'oliphaunt-query'],
      sharedConsumer: 'oliphaunt-query',
    },
    {
      owner: core,
      message: 'feat!: change Core API',
      necessary: [core, broker],
      selected: [core, broker, sdk],
    },
    {
      owner: broker,
      message: 'feat!: change Broker API',
      necessary: [broker],
      selected: [broker, sdk],
    },
  ];
  for (const scenario of cases) {
    const options = nativeProductOptions(scenario.necessary);
    options.buildBound.get(broker).add(core);
    // The compiled broker contains Core; the source fa\u00E7ade contains its own
    // manifest. An adoption uses the existing private requirement bump policy.
    options.nativeObservation.products
      .find(({ product }) => product.id === broker)
      .construction[0].leafInputPaths.push(graph.products[core].path + '/src/implementation');
    let plan;
    options.observeNativePlan = async (value) => {
      plan = value;
    };
    const sharedFile = scenario.sharedConsumer
      ? graph.products[scenario.sharedConsumer].path + '/Cargo.toml'
      : undefined;
    const original = (file) => {
      const text = readFileSync(path.join(ROOT, file), 'utf8');
      if (file !== sharedFile) return text;
      const manifest = Bun.TOML.parse(text);
      manifest.dependencies ??= {};
      manifest.dependencies[core] = { workspace: true };
      return renderToml(manifest);
    };
    const configure = (_manifest, github) => {
      if (!sharedFile) return;
      const get = github.getFileContentsOnBranch.bind(github);
      github.getFileContentsOnBranch = async (file) => {
        if (file !== sharedFile) return get(file);
        const parsedContent = original(file);
        return { parsedContent, content: Buffer.from(parsedContent).toString('base64') };
      };
    };
    const { candidate, versions } = await generateProductCandidate(
      scenario.message
        ? [
            {
              sha: head,
              message: scenario.message,
              files: [graph.products[scenario.owner].path + '/src/implementation'],
            },
          ]
        : [],
      undefined,
      configure,
      options,
    );
    const updates = candidate ? mergeUpdates(candidate.updates) : [];
    const read = (file) => {
      const before = original(file);
      return (
        updates.find((update) => update.path === file)?.updater.updateContent(before) ?? before
      );
    };
    const after = JSON.parse(read('.release-please-manifest.json'));
    const selected = candidate?.body.releaseData.map(({ component }) => component).sort() ?? [];
    expect(selected).toEqual([...scenario.selected].sort());
    expect(plan.selectedProducts).toEqual(selected);
    const workspace = Bun.TOML.parse(read('Cargo.toml'));
    const coreManifest = Bun.TOML.parse(read(graph.products[core].path + '/Cargo.toml'));
    const brokerText = read(graph.products[broker].path + '/Cargo.toml');
    const brokerManifest = Bun.TOML.parse(brokerText);
    const sdkText = read(graph.products[sdk].path + '/Cargo.toml');
    const sdkManifest = Bun.TOML.parse(sdkText);
    const addon = Bun.TOML.parse(read('src/native/node-addon/Cargo.toml'));
    const imported = projectCargoWorkspace(
      workspace,
      Bun.TOML.parse(readFileSync(path.join(ROOT, 'Cargo.lock'), 'utf8')),
      [graph.products[sdk].path, graph.products[broker].path],
      (file) => Bun.TOML.parse(read(file)),
      (file) => existsSync(path.join(ROOT, file)),
    );
    expect(imported.facts[graph.products[core].path].version).toBe(coreManifest.package.version);
    expect(imported.facts[graph.products[broker].path].version).toBe(
      brokerManifest.package.version,
    );
    const heldSdk = Bun.TOML.parse(
      readFileSync(path.join(ROOT, graph.products[sdk].path, 'Cargo.toml'), 'utf8'),
    );
    expect(sdkManifest.package.metadata.oliphaunt).toEqual(heldSdk.package.metadata.oliphaunt);
    expect(read(graph.products[sdk].path + '/src/broker.rs')).toBe(
      readFileSync(path.join(ROOT, graph.products[sdk].path, 'src/broker.rs'), 'utf8'),
    );
    expect(workspace.workspace.dependencies[core].version).toBe(
      selected.includes(sdk) && selected.includes(core) ? coreManifest.package.version : '0.2.0',
    );
    expect(brokerManifest.dependencies[core].version).toBe(
      selected.includes(broker) && selected.includes(core) ? coreManifest.package.version : '0.2.0',
    );
    expect(sdkManifest.dependencies[broker].version).toBe(
      selected.includes(sdk) && selected.includes(broker)
        ? brokerManifest.package.version
        : heldSdk.dependencies[broker].version,
    );
    if (selected.includes(sdk)) expect(sdkManifest.package.version).toBe('0.3.3');
    if (!selected.includes(sdk) && !selected.includes(broker))
      expect(plan.requirements).toEqual([]);
    if (sharedFile) {
      // A single workspace declaration changes every public inheritor's
      // normalized source envelope; the existing fixed point admits it.
      const packed = sourceManifest(read(sharedFile), read('Cargo.toml'), {
        product: scenario.sharedConsumer,
        version: after[graph.products[scenario.sharedConsumer].path],
        dependencyOwners: {},
        compatibility: {},
      });
      expect(packed.dependencies[core]).toEqual({ version: coreManifest.package.version });
      expect(
        plan.requirements
          .filter(({ path: file }) => file === 'Cargo.toml')
          .map(({ product }) => product)
          .sort(),
      ).toEqual([sdk, scenario.sharedConsumer].sort());
    }
    for (const [product, text] of [
      [broker, brokerText],
      [sdk, sdkText],
    ]) {
      const packed = sourceManifest(text, read('Cargo.toml'), {
        product,
        version: after[graph.products[product].path],
        dependencyOwners: {},
        compatibility: {},
      });
      expect(packed.dependencies[core].path).toBeUndefined();
      expect(packed.dependencies[core].version).toBe(
        product === broker
          ? brokerManifest.dependencies[core].version
          : workspace.workspace.dependencies[core].version,
      );
      if (product === sdk) {
        expect(packed.dependencies[broker].path).toBeUndefined();
        expect(packed.dependencies[broker].version).toBe(sdkManifest.dependencies[broker].version);
      }
    }
    // Use real Cargo resolution, rather than --no-deps enumeration. The fixture
    // keeps exactly the repository's generated local version/path contracts;
    // unrelated registry dependencies need no repeated fetch or compilation.
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'native-cargo-cohort-'));
    try {
      const names = ['core', 'broker', 'sdk', 'addon'];
      const packageNames = [
        coreManifest.package.name,
        brokerManifest.package.name,
        sdkManifest.package.name,
        addon.package.name,
      ];
      const finalVersions = [
        coreManifest.package.version,
        brokerManifest.package.version,
        sdkManifest.package.version,
        addon.package.version,
      ];
      const beforeVersions = [
        graph.products[core].version,
        graph.products[broker].version,
        graph.products[sdk].version,
        addon.package.version,
      ];
      const write = (pins, packageVersions) => {
        writeFileSync(
          path.join(scratch, 'Cargo.toml'),
          renderToml({
            workspace: {
              members: names,
              resolver: '3',
              dependencies: {
                [coreManifest.package.name]: { path: 'core', version: pins.sdkCore },
              },
            },
          }),
        );
        for (const [index, name] of names.entries()) {
          mkdirSync(path.join(scratch, name, 'src'), { recursive: true });
          writeFileSync(path.join(scratch, name, 'src/lib.rs'), 'pub fn fixture() {}\n');
          const dependencies =
            name === 'broker'
              ? { [coreManifest.package.name]: { path: '../core', version: pins.brokerCore } }
              : name === 'sdk'
                ? {
                    [coreManifest.package.name]: { workspace: true },
                    [brokerManifest.package.name]: {
                      path: '../broker',
                      version: pins.sdkBroker,
                      optional: true,
                    },
                  }
                : name === 'addon'
                  ? { [coreManifest.package.name]: { path: '../core', version: pins.addonCore } }
                  : undefined;
          writeFileSync(
            path.join(scratch, name, 'Cargo.toml'),
            renderToml({
              package: {
                name: packageNames[index],
                version: packageVersions[index],
                edition: '2024',
              },
              ...(dependencies ? { dependencies } : {}),
              ...(name === 'sdk'
                ? {
                    features: {
                      default: ['desktop'],
                      desktop: ['dep:' + brokerManifest.package.name],
                    },
                  }
                : {}),
            }),
          );
        }
      };
      const originalAddon = Bun.TOML.parse(
        readFileSync(path.join(ROOT, 'src/native/node-addon/Cargo.toml'), 'utf8'),
      );
      write(
        {
          sdkCore: '0.2.0',
          brokerCore: '0.2.0',
          sdkBroker: heldSdk.dependencies[broker].version,
          addonCore: originalAddon.dependencies[core].version,
        },
        beforeVersions,
      );
      const cargo = (...args) =>
        spawnSync('cargo', args, {
          cwd: scratch,
          encoding: 'utf8',
          env: {
            ...process.env,
            CARGO_HOME: path.join(scratch, 'cargo-home'),
            CARGO_NET_OFFLINE: 'true',
          },
          timeout: 30_000,
        });
      const locked = cargo('generate-lockfile', '--offline');
      expect(locked.status, locked.stderr).toBe(0);
      write(
        {
          sdkCore: workspace.workspace.dependencies[core].version,
          brokerCore: brokerManifest.dependencies[core].version,
          sdkBroker: sdkManifest.dependencies[broker].version,
          addonCore: addon.dependencies[core].version,
        },
        finalVersions,
      );
      syncLockfile(
        path.join(scratch, 'Cargo.lock'),
        new Map(packageNames.map((name, index) => [name, finalVersions[index]])),
        [],
        { write: true },
      );
      const resolved = cargo('metadata', '--frozen', '--format-version', '1');
      expect(resolved.status, resolved.stderr).toBe(0);
      const metadata = JSON.parse(resolved.stdout);
      expect(metadata.resolve.nodes).toHaveLength(4);
      expect(metadata.packages.map(({ name, version }) => [name, version]).sort()).toEqual(
        packageNames.map((name, index) => [name, finalVersions[index]]).sort(),
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    for (const product of Object.keys(graph.products).filter(
      (product) => !selected.includes(product),
    ))
      expect(after[graph.products[product].path]).toBe(versions[graph.products[product].path]);
  }
});
