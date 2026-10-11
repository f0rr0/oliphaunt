import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Manifest } from 'release-please';
import { ManifestPlugin } from 'release-please/build/src/plugin.js';
import { mergeUpdates } from 'release-please/build/src/updaters/composite.js';
import { PullRequestBody } from 'release-please/build/src/util/pull-request-body.js';
import { Version } from 'release-please/build/src/version.js';
import { readCommitHistory, readCommitPaths } from './commit-paths.mts';
import { createCompletedPublicationChecker } from './completed-release-publication.mts';
import { frozenConsumerMatrix, frozenConsumerPlan } from './frozen-consumer.mts';
import {
  applyCandidate,
  bindReleaseSourceHistory,
  includeOwnedSourceCommits,
  useSourceDate,
} from './prepare-release-candidate.mts';
import { loadPublicationCatalog } from './publication-catalog.mts';
import { releaseDependencyPlan } from './release-dependency-plan.mts';
import {
  buildPlan,
  compatibilityVersionEntries,
  compatibilityVersionFromText,
  declaredSharedSourceImpacts,
  loadGraph,
  productCompatibilityVersion,
  ROOT,
} from './release-graph.mts';

const graph = loadGraph('prepare-release-candidate.test');
const native = 'src/native/runtime';
const wasix = 'src/wasix/runtime';
const shared = 'src/extensions/contrib/postgres18.toml';
const first = 'a'.repeat(40);
const second = 'b'.repeat(40);
const head = 'c'.repeat(40);

function fixtureCompletionChecker(
  config,
  versions,
  baselines = {},
  {
    pending = [],
    missingLabels = [],
    releaseMergeShas = {},
    comparisons = {},
    extraPullRequests = [],
    sourceVersions = {},
    pagedComparisons = {},
    omitCompletions = [],
    unchangedAtMerge = [],
    releaseTargets = {},
    sourceCommits = {},
    calls = {},
  } = {},
) {
  const repository = 'f0rr0/oliphaunt';
  const after = Object.fromEntries(
    Object.entries(versions).map(([owner, version]) => [owner, version.toString()]),
  );
  const groups = new Map();
  for (const [owner, entry] of Object.entries(config)) {
    if (after[owner] === '0.0.0') continue;
    const publicationSha = baselines[owner] ?? first;
    const releaseSha = releaseMergeShas[entry.component] ?? publicationSha;
    if (!groups.has(releaseSha)) groups.set(releaseSha, []);
    groups.get(releaseSha).push({ owner, product: entry.component, publicationSha });
  }
  const states = new Map();
  const commits = new Map();
  const pullRequests = [...groups].map(([sha, products], index) => {
    const parent = (2_000_000 + index).toString(16).padStart(40, '0');
    states.set(sha, after);
    states.set(parent, {
      ...after,
      ...Object.fromEntries(
        products.map(({ owner, product }) => [
          owner,
          unchangedAtMerge.includes(product) ? after[owner] : '0.0.0',
        ]),
      ),
    });
    for (const { publicationSha } of products) {
      states.set(publicationSha, after);
      commits.set(publicationSha, { sha: publicationSha, tree: { sha: 'd'.repeat(40) } });
    }
    commits.set(sha, { sha, parents: [{ sha: parent }], tree: { sha: 'd'.repeat(40) } });
    return {
      number: 500 + index,
      title: 'chore(release): prepare main releases',
      state: 'closed',
      merged_at: '2026-09-11T00:00:00Z',
      merge_commit_sha: sha,
      base: { ref: 'main', repo: { full_name: repository } },
      head: { ref: 'release-please--branches--main', repo: { full_name: repository } },
      labels: products.some(({ product }) => missingLabels.includes(product))
        ? []
        : [
            {
              name: products.some(({ product }) => pending.includes(product))
                ? 'autorelease: pending'
                : 'autorelease: tagged',
            },
          ],
      body: new PullRequestBody(
        products.map(({ product, owner }) => ({
          component: product,
          version: Version.parse(after[owner]),
          notes: 'Fixture release',
        })),
        { useComponents: true },
      ).toString(),
    };
  });
  for (const [sha, versions] of Object.entries(sourceVersions)) states.set(sha, versions);
  for (const [sha, commit] of Object.entries(sourceCommits)) commits.set(sha, commit);
  return createCompletedPublicationChecker({
    repository,
    listPullRequests: async () => [
      ...pullRequests.filter(
        (pullRequest) =>
          !groups
            .get(pullRequest.merge_commit_sha)
            .some(({ product }) => omitCompletions.includes(product)),
      ),
      ...extraPullRequests,
    ],
    readJson: async (endpoint) => {
      const relative = endpoint.slice(`repos/${repository}/`.length);
      if (relative.startsWith('releases/tags/')) {
        const tag = decodeURIComponent(relative.slice('releases/tags/'.length));
        const [owner] = Object.entries(config).find(
          ([owner, entry]) => `${entry.component}-v${after[owner]}` === tag,
        );
        return {
          tag_name: tag,
          draft: false,
          prerelease: false,
          target_commitish: releaseTargets[tag] ?? baselines[owner] ?? first,
        };
      }
      if (relative.startsWith('git/commits/')) return commits.get(relative.slice(12));
      if (relative.startsWith('compare/')) {
        const [base, publication] = relative.slice(8).split('?')[0].split('...');
        return (
          comparisons[`${base}...${publication}`] ?? {
            status: 'ahead',
            behind_by: 0,
            base_commit: { sha: base },
            merge_base_commit: { sha: base },
            total_commits: 1,
            commits: [{ sha: publication }],
          }
        );
      }
      const [file, sha] = relative.slice('contents/'.length).split('?ref=');
      if (!states.has(sha)) throw new Error(`fixture has no version state at ${sha}`);
      const content =
        file === 'release-please-config.json' ? { packages: config } : states.get(sha);
      return {
        encoding: 'base64',
        content: Buffer.from(JSON.stringify(content)).toString('base64'),
      };
    },
    readPages: async (endpoint) => {
      calls.pages = (calls.pages ?? 0) + 1;
      return pagedComparisons[endpoint.slice(`repos/${repository}/compare/`.length)];
    },
  });
}

test('extension facade generator changes select every product shipping its output', () => {
  const products = Object.entries(graph.products)
    .filter(([, product]) => product.extension?.class === 'external')
    .map(([id]) => id);
  expect(
    buildPlan(graph, [
      'src/extensions/artifacts/packages/tools/package-extension-cargo-facades.mts',
    ]).releaseProducts.sort(),
  ).toEqual(['liboliphaunt-native', ...products].sort());
});

test('every binary release includes its compiled sources across product boundaries', () => {
  const mobile = ['oliphaunt-swift', 'oliphaunt-kotlin'];
  for (const [file, products] of [
    ['src/wasix/sdks/rust/src/oliphaunt/base.rs', ['oliphaunt-wasix-rust', 'oliphaunt-wasix-napi']],
    ['src/wasix/pgwire-server/src/lib.rs', ['oliphaunt-pgwire-server', 'oliphaunt-wasix-napi']],
    [
      'src/query/rust/src/lib.rs',
      ['oliphaunt-query', 'oliphaunt-broker', 'oliphaunt-wasix-napi', ...mobile],
    ],
    ['src/wasix/runtime/crates/assets/src/lib.rs', ['liboliphaunt-wasix', 'oliphaunt-wasix-napi']],
    ['src/wasix/runtime/toolchain.toml', ['liboliphaunt-wasix', 'oliphaunt-wasix-napi']],
    [
      'src/wasix/postgres-tools/crates/tools/build-support.rs',
      ['postgres-tools-wasix', 'oliphaunt-wasix-napi'],
    ],
    ['src/database-resources/icu/cargo/src/lib.rs', ['database-resources', 'oliphaunt-wasix-napi']],
    [
      'src/native/rust-bindings/src/lib.rs',
      ['liboliphaunt-native-bindings', 'oliphaunt-broker', 'oliphaunt-node-direct', ...mobile],
    ],
    ['src/native/broker/src/lib.rs', ['oliphaunt-broker', ...mobile]],
    ['src/native/sdks/rust/src/lib.rs', ['oliphaunt-rust', ...mobile]],
    ['src/native/mobile-bindings/src/lib.rs', mobile],
    ['src/native/sdks/rust/crates/oliphaunt-build/src/lib.rs', ['oliphaunt-rust', ...mobile]],
  ]) {
    const plan = buildPlan(graph, [file]);
    expect(plan.releaseProducts.sort()).toEqual(products.sort());
  }
  for (const file of [
    'src/wasix/sdks/rust/tests/runtime_smoke.rs',
    'src/wasix/sdks/rust/README.md',
  ]) {
    expect(buildPlan(graph, [file]).releaseProducts).not.toContain('oliphaunt-wasix-napi');
  }
  for (const file of [
    'src/native/sdks/rust/tests/mobile_broker.rs',
    'src/native/broker/README.md',
  ]) {
    for (const product of mobile)
      expect(buildPlan(graph, [file]).releaseProducts).not.toContain(product);
  }
  // A dynamically loaded native runtime does not become part of the adapter binary.
  expect(buildPlan(graph, ['src/native/runtime/VERSION']).releaseProducts).toEqual([
    'liboliphaunt-native',
  ]);
  for (const file of ['Cargo.toml', 'Cargo.lock']) {
    expect(buildPlan(graph, [file]).releaseProducts.sort()).toEqual([
      'oliphaunt-broker',
      'oliphaunt-kotlin',
      'oliphaunt-node-direct',
      'oliphaunt-swift',
      'oliphaunt-wasix-napi',
    ]);
  }
});

test('Cargo owns transitive, inherited, renamed, build, target and custom source inputs', () => {
  mkdirSync(path.join(ROOT, 'target'), { recursive: true });
  const scratch = mkdtempSync(path.join(ROOT, 'target/embedded-cargo-'));
  const relative = path.relative(ROOT, scratch).split(path.sep).join('/');
  const previousCargoHome = process.env.CARGO_HOME;
  try {
    const names = ['binary', 'middle', 'leaf', 'build', 'target', 'test-only'];
    writeFileSync(
      path.join(scratch, 'Cargo.toml'),
      `[workspace]\nmembers = ${JSON.stringify(names)}\nresolver = "3"\n` +
        '[workspace.dependencies]\nrenamed = { package = "leaf", path = "leaf" }\n',
    );
    for (const name of names) {
      mkdirSync(path.join(scratch, name, 'src'), { recursive: true });
      writeFileSync(path.join(scratch, name, 'src/lib.rs'), 'pub fn fixture() {}\n');
      writeFileSync(
        path.join(scratch, name, 'Cargo.toml'),
        `[package]\nname = "${name}"\nversion = "1.0.0"\n`,
      );
    }
    appendFileSync(
      path.join(scratch, 'binary/Cargo.toml'),
      '[dependencies]\nmiddle = { path = "../middle" }\n' +
        '[build-dependencies]\nbuild = { path = "../build" }\n' +
        '[target.\'cfg(target_arch = "riscv64")\'.dependencies]\ntarget = { path = "../target", optional = true }\n' +
        '[dev-dependencies]\ntest-only = { path = "../test-only" }\n',
    );
    appendFileSync(
      path.join(scratch, 'middle/Cargo.toml'),
      '[dependencies]\nrenamed.workspace = true\nserde = "1"\n',
    );
    mkdirSync(path.join(scratch, 'leaf/custom'), { recursive: true });
    mkdirSync(path.join(scratch, 'leaf/scripts'), { recursive: true });
    writeFileSync(path.join(scratch, 'leaf/custom/lib.rs'), 'pub fn custom() {}\n');
    writeFileSync(path.join(scratch, 'leaf/scripts/build.rs'), 'fn main() {}\n');
    writeFileSync(
      path.join(scratch, 'leaf/Cargo.toml'),
      '[package]\nname = "leaf"\nversion = "1.0.0"\nbuild = "scripts/build.rs"\n' +
        '[lib]\npath = "custom/lib.rs"\n',
    );
    // Planning must work before any registry cache or lockfile exists.
    process.env.CARGO_HOME = path.join(scratch, 'empty-cargo-cache');
    const impacts = declaredSharedSourceImpacts({
      'oliphaunt-node-direct': {
        embedded_cargo_manifests: [`${relative}/binary/Cargo.toml`],
      },
    });
    const fixtureGraph = { ...graph, shared_release_sources: impacts };
    for (const name of ['middle', 'build', 'target']) {
      expect(buildPlan(fixtureGraph, [`${relative}/${name}/src/lib.rs`]).releaseProducts).toEqual([
        'oliphaunt-node-direct',
      ]);
    }
    expect(buildPlan(fixtureGraph, [`${relative}/test-only/src/lib.rs`]).releaseProducts).toEqual(
      [],
    );
    expect(buildPlan(fixtureGraph, [`${relative}/leaf/README.md`]).releaseProducts).toEqual([]);
    expect(buildPlan(fixtureGraph, [`${relative}/leaf/src/lib.rs`]).releaseProducts).toEqual([]);
    for (const file of ['leaf/custom/module.rs', 'leaf/scripts/helper.rs']) {
      expect(buildPlan(fixtureGraph, [`${relative}/${file}`]).releaseProducts).toEqual([
        'oliphaunt-node-direct',
      ]);
    }
    expect(existsSync(path.join(scratch, 'Cargo.lock'))).toBe(false);
    expect(existsSync(path.join(process.env.CARGO_HOME, 'registry'))).toBe(false);
  } finally {
    if (previousCargoHome === undefined) delete process.env.CARGO_HOME;
    else process.env.CARGO_HOME = previousCargoHome;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('embedded generated payloads follow private producer ownership for source-pin changes', () => {
  for (const file of ['src/third-party/postgres/source.toml', 'src/third-party/icu/source.toml']) {
    expect(existsSync(path.join(ROOT, file))).toBe(true);
    const plan = buildPlan(graph, [file]);
    expect(plan.releaseProducts).toContain('liboliphaunt-wasix');
    expect(plan.releaseProducts).toContain('oliphaunt-wasix-napi');
  }
});

async function generate(commits, baselines = { [native]: first, [wasix]: first }) {
  useSourceDate('2026-09-11');
  const config = Object.fromEntries(
    [native, wasix].map((owner) => [
      owner,
      {
        releaseType: 'simple',
        component: owner === native ? 'liboliphaunt-native' : 'liboliphaunt-wasix',
        packageName: owner === native ? 'liboliphaunt-native' : 'liboliphaunt-wasix',
        versionFile: 'VERSION',
        changelogPath: 'CHANGELOG.md',
        includeVInTag: true,
        tagSeparator: '-',
        bumpMinorPreMajor: true,
        bumpPatchForMinorPreMajor: true,
      },
    ]),
  );
  const github = {
    repository: { owner: 'f0rr0', repo: 'oliphaunt', defaultBranch: 'main' },
    async *releaseIterator() {
      for (const owner of [native, wasix])
        yield {
          tagName: `${config[owner].component}-v0.2.0`,
          sha: baselines[owner],
          notes: 'Previous release',
        };
    },
    async *mergeCommitIterator() {
      yield* commits;
    },
    async getFileContentsOnBranch(file) {
      const parsedContent = file.endsWith('/VERSION')
        ? '0.2.0\n'
        : '# Changelog\n\n## 0.2.0\n\nPrevious release\n';
      return { parsedContent, content: Buffer.from(parsedContent).toString('base64') };
    },
    async getFileContents(file) {
      return this.getFileContentsOnBranch(file);
    },
  };
  const manifest = new Manifest(
    github,
    'main',
    config,
    {
      [native]: Version.parse('0.2.0'),
      [wasix]: Version.parse('0.2.0'),
    },
    {
      separatePullRequests: false,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Release Please expands this title pattern.
      groupPullRequestTitlePattern: 'chore(release): prepare ${branch} releases',
    },
  );
  includeOwnedSourceCommits(manifest, github, graph, undefined, {
    assertCompletedPublication: fixtureCompletionChecker(
      config,
      manifest.releasedVersions,
      baselines,
    ),
  });
  return manifest.buildPullRequests();
}

test('Release Please alone versions and describes shared shipped changes exactly once', async () => {
  const commits = [
    {
      sha: head,
      message: 'feat: improve shared extension behavior',
      files: [shared, `${native}/src/liboliphaunt.c`],
    },
    {
      sha: first,
      message: 'chore(release): previous releases',
      files: [`${native}/VERSION`, `${wasix}/VERSION`],
    },
  ];
  const [candidate] = await generate(commits);
  expect(candidate.headRefName).toBe('release-please--branches--main');
  expect(candidate.title.toString()).toBe('chore(release): prepare main releases');
  const versions = candidate.updates.filter((update) => update.path.endsWith('/VERSION'));
  expect(
    versions.map((update) => [update.path, update.updater.updateContent('0.2.0\n').trim()]).sort(),
  ).toEqual([
    [`${native}/VERSION`, '0.2.1'],
    [`${wasix}/VERSION`, '0.2.1'],
  ]);
  for (const update of candidate.updates.filter((update) =>
    update.path.endsWith('/CHANGELOG.md'),
  )) {
    const text = update.updater.updateContent('# Changelog\n');
    expect(text.match(/improve shared extension behavior/gu)).toHaveLength(1);
    expect(text).toContain('2026-09-11');
  }
  const [repeat] = await generate(commits);
  expect(repeat.body.toString()).toBe(candidate.body.toString());
  const render = (update) => [
    update.path,
    update.updater.updateContent(
      update.path === '.release-please-manifest.json'
        ? JSON.stringify({ [native]: '0.2.0', [wasix]: '0.2.0' })
        : update.path.endsWith('/VERSION')
          ? '0.2.0\n'
          : '# Changelog\n',
    ),
  ];
  expect(repeat.updates.map(render)).toEqual(candidate.updates.map(render));
});

test('shared source qualification respects each owner release boundary and ignores nonrelease prose', async () => {
  const candidates = await generate(
    [
      { sha: head, message: 'docs: clarify maintenance instructions', files: [shared] },
      {
        sha: second,
        message: 'chore(release): WASIX already includes this change',
        files: [`${wasix}/VERSION`],
      },
      { sha: 'd'.repeat(40), message: 'fix: repair shared extension behavior', files: [shared] },
      { sha: first, message: 'chore(release): native baseline', files: [`${native}/VERSION`] },
    ],
    { [native]: first, [wasix]: second },
  );
  expect(candidates).toHaveLength(1);
  expect(
    candidates[0].updates
      .filter((update) => update.path.endsWith('/VERSION'))
      .map((update) => update.path),
  ).toEqual([`${native}/VERSION`]);
});

const historyProducts = ['alpha', 'beta', 'gamma'];
const historyShared = 'shared/shipped.c';

async function generateHistoryCandidate(
  commits,
  {
    baselines = Object.fromEntries(historyProducts.map((product) => [product, first])),
    unreleased = [],
    drafts = [],
    tagOnly = [],
    missing = [],
    unrelatedReleaseCount = 0,
    bootstrapSha = undefined,
    lastReleaseSha = undefined,
    completion = {},
    readCommitFiles,
    commitHistory,
    sourceSha,
    readSource,
    inspect = () => {},
  } = {},
) {
  const products = Object.fromEntries(
    historyProducts.map((product) => [
      product,
      {
        path: `products/${product}`,
        kind: 'source-package',
        tag_prefix: `${product}-v`,
        version: unreleased.includes(product) ? '0.0.0' : '0.2.0',
      },
    ]),
  );
  const fixtureGraph = {
    products,
    moon_projects: Object.fromEntries(
      historyProducts.map((id) => [id, { id, source: products[id].path, dependencies: [] }]),
    ),
    shared_release_sources: [{ files: [historyShared], products: historyProducts }],
  };
  const config = Object.fromEntries(
    historyProducts.map((product) => [
      products[product].path,
      {
        releaseType: 'simple',
        component: product,
        packageName: product,
        versionFile: 'VERSION',
        changelogPath: 'CHANGELOG.md',
        includeVInTag: true,
        tagSeparator: '-',
        initialVersion: '0.1.0',
        bumpMinorPreMajor: true,
        bumpPatchForMinorPreMajor: true,
      },
    ]),
  );
  const versions = Object.fromEntries(
    Object.values(products).map((product) => [product.path, Version.parse(product.version)]),
  );
  const calls = {};
  const releaseRecords = historyProducts
    .filter((product) => !unreleased.includes(product) && !missing.includes(product))
    .map((product) => ({
      tagName: `${product}-v0.2.0`,
      sha: baselines[product],
      draft: drafts.includes(product),
      notes: 'Completed release',
    }));
  const github = {
    repository: { owner: 'f0rr0', repo: 'oliphaunt', defaultBranch: 'main' },
    async *releaseIterator(options = {}) {
      calls.releases = options;
      const records = [
        ...Array.from({ length: unrelatedReleaseCount }, (_, index) => ({
          tagName: `unrelated-v1.0.${index}`,
          sha: head,
          draft: false,
        })),
        ...releaseRecords,
      ];
      for (const release of records.slice(0, options.maxResults)) {
        if (!tagOnly.includes(release.tagName.split('-v')[0])) yield release;
      }
    },
    async *tagIterator() {
      for (const release of releaseRecords) yield { name: release.tagName, sha: release.sha };
    },
    async *mergeCommitIterator(_branch, options = {}) {
      calls.commits = options;
      yield* commits.slice(0, options.maxResults);
    },
    async getFileContentsOnBranch(file) {
      const owner = Object.values(products).find((product) => file.startsWith(`${product.path}/`));
      const parsedContent = file.endsWith('/VERSION') ? `${owner.version}\n` : '# Changelog\n';
      return { parsedContent, content: Buffer.from(parsedContent).toString('base64') };
    },
    async getFileContents(file) {
      return this.getFileContentsOnBranch(file);
    },
  };
  const logger = { info() {}, debug() {}, warn() {}, error() {} };
  const manifest = new Manifest(github, 'main', config, versions, {
    separatePullRequests: false,
    bootstrapSha,
    lastReleaseSha,
    logger,
  });
  if (sourceSha) bindReleaseSourceHistory(github, commitHistory, sourceSha, readSource);
  includeOwnedSourceCommits(manifest, github, fixtureGraph, undefined, {
    readCommitFiles,
    commitHistory,
    assertCompletedPublication: fixtureCompletionChecker(
      config,
      versions,
      Object.fromEntries(
        historyProducts.map((product) => [products[product].path, baselines[product]]),
      ),
      completion,
    ),
  });
  manifest.plugins.push(
    new (class extends ManifestPlugin {
      async preconfigure(strategies, selected) {
        // This supported hook runs before Release Please's individual candidate strategies.
        inspect(selected, calls);
        return strategies;
      }
    })(github, 'main', config),
  );
  return manifest.buildPullRequests();
}

function historyVersionUpdates(candidates) {
  return candidates.flatMap((candidate) =>
    candidate.updates
      .filter((update) => update.path.endsWith('/VERSION'))
      .map((update) => [update.path, update.updater.updateContent('0.2.0\n').trim()]),
  );
}

test('bounded Release Please selection produces zero, one and many owner candidates', async () => {
  for (const [files, expected] of [
    [['tools/release/controller.mts', 'products/alpha/README.md'], []],
    [['products/alpha/src/lib.rs'], ['alpha']],
    [[historyShared], historyProducts],
  ]) {
    const candidates = await generateHistoryCandidate([
      { sha: head, message: 'fix: change selected delivery', files },
      { sha: first, message: 'fix: already delivered behavior', files: [historyShared] },
    ]);
    expect(historyVersionUpdates(candidates).sort()).toEqual(
      expected.map((product) => [`products/${product}/VERSION`, '0.2.1']).sort(),
    );
  }
});

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
    await expect(generateHistoryCandidate(commits, { completion })).rejects.toThrow(
      'publication is not complete',
    );
  for (const completion of [{ omitCompletions: ['alpha'] }, { unchangedAtMerge: ['alpha'] }])
    await expect(generateHistoryCandidate(commits, { completion })).rejects.toThrow(
      'no unique canonical release completion',
    );
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

test('actual capture retains move-out, move-in and renamed product inputs before Release Please selection', async () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'release-commit-moves-'));
  const snapshot = path.join(fixture, 'snapshot');
  const run = (command, args) => {
    const result = spawnSync(command, args, {
      cwd: fixture,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.com',
        GIT_COMMITTER_NAME: 'Fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.com',
      },
    });
    if (result.status !== 0) throw new Error(`${command}: ${result.stderr}`);
    return result.stdout.trim();
  };
  try {
    run('git', ['init', '-q']);
    mkdirSync(path.join(fixture, 'products/alpha/src'), { recursive: true });
    mkdirSync(path.join(fixture, 'products/beta/src'), { recursive: true });
    mkdirSync(path.join(fixture, 'unowned'), { recursive: true });
    writeFileSync(path.join(fixture, 'products/alpha/src/source.rs'), 'alpha\n');
    writeFileSync(path.join(fixture, 'unowned/source.rs'), 'beta\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-qm', 'chore: published baseline']);
    const baseline = run('git', ['rev-parse', 'HEAD']);
    run('git', ['mv', 'products/alpha/src/source.rs', 'unowned/alpha.rs']);
    run('git', ['commit', '-qm', 'fix: remove alpha input']);
    const moveOut = run('git', ['rev-parse', 'HEAD']);
    run('git', ['mv', 'unowned/source.rs', 'products/beta/src/source.rs']);
    run('git', ['commit', '-qm', 'fix: install beta input']);
    const moveIn = run('git', ['rev-parse', 'HEAD']);
    run('git', ['mv', 'products/beta/src/source.rs', 'products/beta/src/renamed.rs']);
    run('git', ['commit', '-qm', 'fix: rename beta input']);
    const rename = run('git', ['rev-parse', 'HEAD']);
    run('bash', [
      path.join(ROOT, 'tools/release/snapshot-commit-paths.sh'),
      fixture,
      rename,
      snapshot,
    ]);
    const candidates = await generateHistoryCandidate(
      [
        { sha: rename, message: 'fix: rename beta input', files: ['products/beta/src/renamed.rs'] },
        { sha: moveIn, message: 'fix: install beta input', files: ['products/beta/src/source.rs'] },
        { sha: moveOut, message: 'fix: remove alpha input', files: ['unowned/alpha.rs'] },
        { sha: baseline, message: 'chore: published baseline', files: [] },
      ],
      {
        baselines: Object.fromEntries(historyProducts.map((product) => [product, baseline])),
        readCommitFiles: (sha) => readCommitPaths(sha, snapshot),
        commitHistory: readCommitHistory(snapshot),
        sourceSha: rename,
        readSource: async () => ({ object: { sha: rename } }),
        inspect(selected, calls) {
          expect(calls.commits.backfillFiles).toBe(false);
          expect(selected['products/alpha'].map(({ sha }) => sha)).toEqual([moveOut]);
          expect(selected['products/alpha'][0].files).toEqual([
            'products/alpha/src/source.rs',
            'unowned/alpha.rs',
          ]);
          expect(selected['products/beta'].map(({ sha }) => sha)).toEqual([rename, moveIn]);
          expect(selected['products/beta'][0].files).toEqual([
            'products/beta/src/renamed.rs',
            'products/beta/src/source.rs',
          ]);
          expect(selected['products/gamma']).toEqual([]);
        },
      },
    );
    expect(historyVersionUpdates(candidates).sort()).toEqual([
      ['products/alpha/VERSION', '0.2.1'],
      ['products/beta/VERSION', '0.2.1'],
    ]);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
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

test('history capture reaches release boundaries beyond pinned library search limits', async () => {
  const commits = Array.from({ length: 510 }, (_, index) => ({
    sha: (index + 1000).toString(16).padStart(40, '0'),
    message: 'docs: controller maintenance',
    files: ['tools/release/README.md'],
  }));
  commits.push(
    {
      sha: head,
      message: 'fix: older unshipped alpha change',
      files: ['products/alpha/src/lib.rs'],
    },
    { sha: first, message: 'chore(release): completed baseline', files: [] },
  );
  const candidates = await generateHistoryCandidate(commits, {
    unrelatedReleaseCount: 410,
    inspect(_selected, calls) {
      expect(calls.commits.maxResults).toBe(Number.MAX_SAFE_INTEGER);
      expect(calls.releases.maxResults).toBe(Number.MAX_SAFE_INTEGER);
    },
  });
  expect(historyVersionUpdates(candidates)).toEqual([['products/alpha/VERSION', '0.2.1']]);
});

test('missing, skipped, draft and tag-only release boundaries stop preparation', async () => {
  const baseline = { sha: first, message: 'chore(release): completed baseline', files: [] };
  const current = {
    sha: head,
    message: 'fix: alpha delivery',
    files: ['products/alpha/src/lib.rs'],
  };
  await expect(generateHistoryCandidate([current])).rejects.toThrow('did not reach alpha boundary');
  await expect(
    generateHistoryCandidate([current, baseline], { lastReleaseSha: head }),
  ).rejects.toThrow('did not reach alpha boundary');
  for (const options of [{ drafts: ['alpha'] }, { tagOnly: ['alpha'] }, { missing: ['alpha'] }])
    await expect(generateHistoryCandidate([current, baseline], options)).rejects.toThrow(
      'alpha@0.2.0 has no published release boundary',
    );
  await expect(generateHistoryCandidate([current, current, baseline])).rejects.toThrow(
    'duplicate history commit',
  );
  await expect(
    generateHistoryCandidate([{ sha: head, message: 'fix: unknown file history' }, baseline]),
  ).rejects.toThrow(/missing.*files/u);
});

test('first releases consume the complete exclusive bootstrap boundary', async () => {
  const commits = [
    { sha: head, message: 'fix: first alpha delivery', files: ['products/alpha/src/lib.rs'] },
    { sha: first, message: 'fix: legacy shared delivery', files: [historyShared] },
  ];
  const options = { unreleased: historyProducts, bootstrapSha: first };
  expect(historyVersionUpdates(await generateHistoryCandidate(commits, options))).toEqual([
    ['products/alpha/VERSION', '0.1.0'],
  ]);
  await expect(generateHistoryCandidate(commits.slice(0, 1), options)).rejects.toThrow(
    'did not reach bootstrap boundary',
  );
});

test('a new product without bootstrap uses complete history alongside published owners', async () => {
  const candidates = await generateHistoryCandidate(
    [
      { sha: head, message: 'docs: explain beta', files: ['products/beta/README.md'] },
      { sha: second, message: 'chore(release): existing owners', files: [] },
      { sha: first, message: 'feat: first gamma delivery', files: ['products/gamma/src/lib.rs'] },
    ],
    {
      baselines: { alpha: second, beta: second },
      unreleased: ['gamma'],
      inspect(selected) {
        expect(selected['products/alpha']).toEqual([]);
        expect(selected['products/beta']).toEqual([]);
        expect(selected['products/gamma'].map(({ sha }) => sha)).toEqual([first]);
      },
    },
  );
  expect(historyVersionUpdates(candidates)).toEqual([['products/gamma/VERSION', '0.1.0']]);
});

test('seeded histories match independent per-owner published-boundary oracles', async () => {
  let state = 0x294;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  for (let scenario = 0; scenario < 24; scenario++) {
    const expectedOwners = [];
    const commits = Array.from({ length: 32 }, (_, index) => {
      const choice = random() % 6;
      const owners = choice < 3 ? [historyProducts[choice]] : choice === 3 ? historyProducts : [];
      expectedOwners.push(owners);
      return {
        sha: (10000 + scenario * 100 + index).toString(16).padStart(40, '0'),
        message: `fix: scenario ${scenario} input ${index}`,
        files:
          choice < 3
            ? [`products/${historyProducts[choice]}/src/lib.rs`]
            : [
                choice === 3
                  ? historyShared
                  : choice === 4
                    ? 'products/alpha/README.md'
                    : 'tools/controller.mts',
              ],
      };
    });
    const boundaries = Object.fromEntries(
      historyProducts.map((product) => [product, 4 + (random() % 28)]),
    );
    const expected = Object.fromEntries(
      historyProducts.map((product) => [
        `products/${product}`,
        commits.filter(
          (_commit, index) =>
            index < boundaries[product] && expectedOwners[index].includes(product),
        ),
      ]),
    );
    const captured = mkdtempSync(path.join(os.tmpdir(), 'release-random-ancestry-'));
    try {
      writeFileSync(
        path.join(captured, '.parents'),
        `head ${commits[0].sha}\n${commits
          .map(
            (commit, index) =>
              `${commit.sha}${commits[index + 1] ? ` ${commits[index + 1].sha}` : ''}\n`,
          )
          .join('')}`,
      );
      const apiCommits = [...commits];
      for (let index = apiCommits.length - 1; index > 0; index--) {
        const other = random() % (index + 1);
        [apiCommits[index], apiCommits[other]] = [apiCommits[other], apiCommits[index]];
      }
      const candidates = await generateHistoryCandidate(apiCommits, {
        commitHistory: readCommitHistory(captured),
        baselines: Object.fromEntries(
          historyProducts.map((product) => [product, commits[boundaries[product]].sha]),
        ),
        inspect(selected) {
          for (const [owner, entries] of Object.entries(expected))
            expect(selected[owner].map(({ sha }) => sha)).toEqual(entries.map(({ sha }) => sha));
        },
      });
      expect(historyVersionUpdates(candidates).sort()).toEqual(
        Object.entries(expected)
          .filter(([, entries]) => entries.length)
          .map(([owner]) => [`${owner}/VERSION`, '0.2.1'])
          .sort(),
      );
    } finally {
      rmSync(captured, { recursive: true, force: true });
    }
  }
});

async function generateProductCandidate(
  commits,
  readCompatibility = (product, source) => productCompatibilityVersion(product, source),
  configure = () => {},
  { root = ROOT, baseline = first } = {},
) {
  const config = JSON.parse(readFileSync(path.join(root, 'release-please-config.json'), 'utf8'));
  const versions = JSON.parse(
    readFileSync(path.join(root, '.release-please-manifest.json'), 'utf8'),
  );
  const github = {
    repository: { owner: 'f0rr0', repo: 'oliphaunt', defaultBranch: 'main' },
    async *releaseIterator() {
      for (const owner of Object.keys(config.packages))
        yield {
          tagName: `${config.packages[owner].component}-v${versions[owner]}`,
          sha: baseline,
          notes: 'Existing release',
        };
    },
    async *mergeCommitIterator() {
      yield* commits;
      yield { sha: baseline, message: 'chore(release): previous versions', files: [] };
    },
    async getFileContentsOnBranch(file) {
      const local = path.join(root, file);
      const parsedContent =
        file === 'release-please-config.json'
          ? JSON.stringify(config)
          : file === '.release-please-manifest.json'
            ? JSON.stringify(versions)
            : existsSync(local)
              ? readFileSync(local, 'utf8')
              : undefined;
      if (parsedContent === undefined)
        throw Object.assign(new Error(`missing ${file}`), { status: 404 });
      return { parsedContent, content: Buffer.from(parsedContent).toString('base64') };
    },
    async getFileContents(file) {
      return this.getFileContentsOnBranch(file);
    },
    async getFileJson(file) {
      return JSON.parse((await this.getFileContentsOnBranch(file)).parsedContent);
    },
  };
  const manifest = await Manifest.fromManifest(github, 'main');
  useSourceDate('2026-09-11');
  includeOwnedSourceCommits(manifest, github, graph, readCompatibility, {
    assertCompletedPublication: fixtureCompletionChecker(
      manifest.repositoryConfig,
      manifest.releasedVersions,
      Object.fromEntries(Object.keys(manifest.repositoryConfig).map((owner) => [owner, baseline])),
    ),
  });
  configure(manifest, github);
  const candidates = await manifest.buildPullRequests();
  expect(candidates.length).toBeLessThanOrEqual(1);
  const [candidate] = candidates;
  return { candidate, versions };
}

for (const scenario of [
  {
    name: 'documentation only',
    files: [
      'src/native/sdks/ts/README.md',
      'src/extensions/generated/docs/extension-evidence.json',
    ],
    products: [],
  },
  {
    name: 'one source SDK',
    files: ['src/native/sdks/ts/src/index.ts'],
    products: ['oliphaunt-js'],
  },
  {
    name: 'query updates and native ecosystem dependency bumps',
    files: ['src/query/ts/src/query.ts', 'src/query/rust/src/lib.rs'],
    products: [
      'oliphaunt-query-ts',
      'oliphaunt-query',
      'oliphaunt-broker',
      'oliphaunt-kotlin',
      'oliphaunt-swift',
      'oliphaunt-wasix-napi',
      'oliphaunt-js',
      'oliphaunt-react-native',
      'oliphaunt-wasix-ts',
    ],
  },
  {
    name: 'runtime and one external extension',
    files: [`${native}/src/liboliphaunt.c`, 'src/extensions/external/vector/source.toml'],
    products: [
      'liboliphaunt-native',
      'oliphaunt-extension-vector',
      'oliphaunt-extension-pg-hashids',
      'oliphaunt-extension-pg-ivm',
      'oliphaunt-extension-pg-textsearch',
      'oliphaunt-extension-pg-uuidv7',
      'oliphaunt-extension-pgtap',
      'oliphaunt-extension-postgis',
      'oliphaunt-js',
      'oliphaunt-kotlin',
      'oliphaunt-swift',
      'oliphaunt-react-native',
    ],
  },
  {
    name: 'broker and Rust SDK retain the older published broker requirement',
    files: ['src/native/broker/src/lib.rs', 'src/native/sdks/rust/src/lib.rs'],
    products: ['oliphaunt-broker', 'oliphaunt-rust', 'oliphaunt-kotlin', 'oliphaunt-swift'],
  },
  {
    name: 'WASIX compiled inputs advance while installed SDK pins retain published history',
    files: [
      `${wasix}/toolchain.toml`,
      'src/wasix/sdks/rust/src/oliphaunt/base.rs',
      'src/wasix/sdks/ts/src/index.ts',
    ],
    products: [
      'liboliphaunt-wasix',
      'oliphaunt-wasix-napi',
      'oliphaunt-wasix-rust',
      'oliphaunt-wasix-ts',
    ],
  },
  {
    name: 'both runtime families and one extension close all default installs',
    files: [
      `${native}/src/liboliphaunt.c`,
      `${wasix}/toolchain.toml`,
      'src/extensions/external/vector/source.toml',
    ],
    products: [
      'liboliphaunt-native',
      'liboliphaunt-wasix',
      ...Object.keys(graph.products).filter(
        (id) => graph.products[id].extension?.class === 'external',
      ),
      'oliphaunt-js',
      'oliphaunt-kotlin',
      'oliphaunt-swift',
      'oliphaunt-react-native',
      'oliphaunt-wasix-rust',
      'oliphaunt-wasix-ts',
      'oliphaunt-wasix-napi',
      'oliphaunt-pgwire-server',
    ],
  },
  {
    name: 'shared package writer',
    files: ['src/extensions/artifacts/packages/tools/package-extension-cargo-facades.mts'],
    products: [
      'liboliphaunt-native',
      'oliphaunt-extension-pg-hashids',
      'oliphaunt-extension-pg-ivm',
      'oliphaunt-extension-pg-textsearch',
      'oliphaunt-extension-pg-uuidv7',
      'oliphaunt-extension-pgtap',
      'oliphaunt-extension-postgis',
      'oliphaunt-extension-vector',
      'oliphaunt-js',
      'oliphaunt-kotlin',
      'oliphaunt-swift',
      'oliphaunt-react-native',
    ],
  },
])
  test(`release scenario: ${scenario.name} produces coherent versions and exact consumer scope`, async () => {
    if (!scenario.products.length) {
      const { candidate } = await generateProductCandidate([
        { sha: head, message: 'docs: clarify usage', files: scenario.files },
      ]);
      expect(candidate).toBeUndefined();
      return;
    }
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'release-scenario-'));
    const env = {
      ...process.env,
      CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR ?? path.join(ROOT, 'target'),
    };
    for (const name of Object.keys(env)) {
      if (
        /^(ACTIONS_|GH_|GITHUB_|RELEASE_|PUBLICATION_|OLIPHAUNT_(RELEASE_|PRODUCT_HISTORY|GIT_SOURCE_JSON|EVIDENCE_))/u.test(
          name,
        )
      )
        delete env[name];
    }
    const run = (command, args) => {
      const result = spawnSync(command, args, {
        cwd: scratch,
        env,
        encoding: 'utf8',
        timeout: 120_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      if (result.error || result.status !== 0)
        throw new Error(
          `${command} ${args.join(' ')}: ${result.error?.message ?? result.status}\n${result.stdout?.slice(-4000)}\n${result.stderr?.slice(-4000)}`,
        );
      return result.stdout.trim();
    };
    try {
      run('git', ['clone', '--quiet', '--shared', ROOT, '.']);
      // Include uncommitted control fixes, without rebuilding any product outputs.
      const changed = spawnSync('git', ['diff', '--name-only', '-z', 'HEAD'], {
        cwd: ROOT,
        encoding: 'utf8',
      });
      expect(changed.status).toBe(0);
      const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
        cwd: ROOT,
        encoding: 'utf8',
      });
      expect(untracked.status).toBe(0);
      for (const file of new Set(
        `${changed.stdout}${untracked.stdout}`.split('\0').filter(Boolean),
      )) {
        const destination = path.join(scratch, file);
        if (existsSync(path.join(ROOT, file))) {
          mkdirSync(path.dirname(destination), { recursive: true });
          cpSync(path.join(ROOT, file), destination);
        } else rmSync(destination, { force: true });
      }
      appendFileSync(path.join(scratch, '.git/info/exclude'), '/node_modules\n');
      symlinkSync(path.join(ROOT, 'node_modules'), path.join(scratch, 'node_modules'));
      run('git', ['config', 'user.name', 'Release Fixture']);
      run('git', ['config', 'user.email', 'release@example.invalid']);
      run('git', ['add', '-A']);
      run('git', ['commit', '--allow-empty', '-qm', 'test: published release baseline']);
      const baseline = run('git', ['rev-parse', 'HEAD']);
      for (const product of Object.values(graph.products))
        run('git', ['tag', '-f', product.tag_prefix + product.version, baseline]);
      for (const file of scenario.files)
        appendFileSync(
          path.join(scratch, file),
          file.endsWith('.toml') ? '\n# release fixture\n' : '\n// release fixture\n',
        );
      if (scenario.files.some((file) => file.endsWith('/source.toml')))
        run('bash', ['tools/release/sync-release-pr.sh']);
      run('git', ['add', '-A']);
      run('git', ['commit', '-qm', 'fix: repair shipped behavior']);
      const source = run('git', ['rev-parse', 'HEAD']);
      const entries = compatibilityVersionEntries(graph.products, { requireSourceProduct: true });
      const readCompatibility = (product, dependency, _prefix, { ref = null } = {}) => {
        const entry = entries.find(
          (entry) => entry.product === product && entry.sourceProduct === dependency,
        );
        return compatibilityVersionFromText(
          entry,
          ref
            ? run('git', ['show', `${ref}:${entry.path}`])
            : readFileSync(path.join(scratch, entry.path), 'utf8'),
        );
      };
      const { candidate, versions } = await generateProductCandidate(
        [
          {
            sha: source,
            message: 'fix: repair shipped behavior',
            files: run('git', ['diff', '--name-only', baseline, source]).split('\n'),
          },
        ],
        readCompatibility,
        undefined,
        { root: scratch, baseline },
      );
      applyCandidate(scratch, candidate);
      const declaredRequirements = new Map(
        entries.map((entry) => [
          entry.id,
          compatibilityVersionFromText(entry, readFileSync(path.join(scratch, entry.path), 'utf8')),
        ]),
      );
      const metadata = path.join(scratch, '.git/release-candidate');
      mkdirSync(metadata);
      writeFileSync(path.join(metadata, 'required'), 'true\n');
      writeFileSync(path.join(metadata, 'title'), `${candidate.title.toString()}\n`);
      writeFileSync(path.join(metadata, 'body.md'), `${candidate.body.toString()}\n`);
      run('bash', ['tools/release/close-release-candidate.sh', metadata]);
      const closed = run('git', ['rev-parse', 'HEAD']);
      expect(run('git', ['rev-parse', 'HEAD^'])).toBe(source);
      run('bash', ['tools/release/sync-release-pr.sh']);
      run('bash', ['tools/release/sync-release-pr.sh', '--check-generated-release']);
      expect(run('git', ['diff', '--no-ext-diff'])).toBe('');
      expect(run('git', ['status', '--porcelain', '--untracked-files=all'])).toBe('');
      expect(run('git', ['rev-parse', 'HEAD'])).toBe(closed);
      const after = JSON.parse(
        readFileSync(path.join(scratch, '.release-please-manifest.json'), 'utf8'),
      );
      const changedOwners = Object.keys(after).filter((owner) => after[owner] !== versions[owner]);
      expect(changedOwners.sort()).toEqual(
        scenario.products.map((id) => graph.products[id].path).sort(),
      );
      const paths = candidate.updates.map((update) => update.path);
      expect(new Set(paths).size).toBe(paths.length);
      const products = structuredClone(graph.products);
      for (const id of scenario.products) {
        products[id].version = after[products[id].path];
        const before = Version.parse(versions[products[id].path]);
        expect(Version.parse(products[id].version).compare(before)).toBeGreaterThan(0);
        expect(paths).toContain(`${products[id].path}/CHANGELOG.md`);
      }
      const readRequirement = (entry) =>
        compatibilityVersionFromText(entry, readFileSync(path.join(scratch, entry.path), 'utf8'));
      const requirements = releaseDependencyPlan(products, scenario.products, {
        readValue: (entry) => declaredRequirements.get(entry.id),
      });
      for (const requirement of requirements) {
        expect(readRequirement(requirement)).toBe(requirement.version);
        if (requirement.binding === 'compiled-input')
          expect(requirement.version).toBe(products[requirement.sourceProduct].version);
        if (
          requirement.binding === 'declared-requirement' &&
          ['liboliphaunt-native', 'liboliphaunt-wasix'].includes(requirement.sourceProduct)
        )
          expect(requirement.version).toBe(declaredRequirements.get(requirement.id));
      }
      const catalog = loadPublicationCatalog('release scenario', { products: scenario.products });
      const lock = {
        lockDigest: 'a'.repeat(64),
        products: catalog.products.map((product) => ({
          ...product,
          version: products[product.id].version,
        })),
        carriers: catalog.carriers.map((carrier) => ({
          ...carrier,
          version: products[carrier.product].version,
        })),
      };
      const plan = frozenConsumerPlan(lock, { configurationDigest: 'b'.repeat(64) });
      expect([...new Set(plan.cases.map((test) => test.product))].sort()).toEqual(
        [...scenario.products].sort(),
      );
      for (const carrier of lock.carriers)
        expect(
          plan.cases.some(
            (test) =>
              test.carrierId === carrier.id &&
              test.id.startsWith(`${carrier.id}@${carrier.version}/`),
          ),
        ).toBe(true);
      expect(new Set(frozenConsumerMatrix(plan).include.map((row) => row.target)).size).toBe(
        frozenConsumerMatrix(plan).include.length,
      );
      if (scenario.products.includes('oliphaunt-rust')) {
        expect(readCompatibility('oliphaunt-rust', 'oliphaunt-broker')).toBe(
          graph.products['oliphaunt-broker'].version,
        );
        expect(products['oliphaunt-broker'].version).not.toBe(
          graph.products['oliphaunt-broker'].version,
        );
      }
      if (
        scenario.products.includes('liboliphaunt-native') &&
        scenario.products.includes('oliphaunt-js')
      ) {
        // Removing the planned SDK host edit recreates the original individually
        // valid, mutually incompatible release. Admission must catch it independently.
        run('git', ['reset', '--hard', source]);
        applyCandidate(scratch, candidate);
        const sdkPath = path.join(scratch, 'src/native/sdks/ts/package.json');
        const sdk = JSON.parse(readFileSync(sdkPath, 'utf8'));
        sdk.oliphaunt.liboliphauntVersion = productCompatibilityVersion(
          'oliphaunt-js',
          'liboliphaunt-native',
        );
        writeFileSync(sdkPath, `${JSON.stringify(sdk, null, 2)}\n`);
        expect(() => run('bash', ['tools/release/close-release-candidate.sh', metadata])).toThrow(
          /but oliphaunt-extension-.* targets liboliphaunt-native/u,
        );
      }
      if (scenario.products.includes('liboliphaunt-wasix')) {
        expect(readCompatibility('oliphaunt-wasix-rust', 'liboliphaunt-wasix')).toBe(
          declaredRequirements.get(
            entries.find(
              (entry) =>
                entry.product === 'oliphaunt-wasix-rust' &&
                entry.sourceProduct === 'liboliphaunt-wasix',
            ).id,
          ),
        );
        expect(readCompatibility('oliphaunt-wasix-napi', 'liboliphaunt-wasix')).toBe(
          products['liboliphaunt-wasix'].version,
        );
        run('git', ['reset', '--hard', source]);
        applyCandidate(scratch, candidate);
        const sdkPath = path.join(scratch, 'src/wasix/sdks/ts/package.json');
        const sdk = JSON.parse(readFileSync(sdkPath, 'utf8'));
        sdk.oliphaunt.runtimeVersion =
          sdk.oliphaunt.runtimeVersion === products['liboliphaunt-wasix'].version
            ? graph.products['liboliphaunt-wasix'].version
            : products['liboliphaunt-wasix'].version;
        writeFileSync(sdkPath, `${JSON.stringify(sdk, null, 2)}\n`);
        expect(() => run('bash', ['tools/release/close-release-candidate.sh', metadata])).toThrow(
          /differs from oliphaunt-wasix-napi .* runtime/u,
        );
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 180_000);

test('actual Rust, npm, Swift and Gradle strategy updates apply to one local candidate', async () => {
  const root = path.resolve(import.meta.dir, '../..');
  const selected = [
    'src/native/sdks/rust',
    'src/native/sdks/ts',
    'src/native/sdks/swift',
    'src/native/sdks/kotlin',
  ];
  const { candidate, versions } = await generateProductCandidate([
    {
      sha: head,
      message: 'fix: correct the selected SDK behavior',
      files: selected.map((owner) => `${owner}/src/implementation`),
    },
  ]);
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

test('runtime and SDK changes retain independent extension releases', async () => {
  for (const sdk of ['oliphaunt-kotlin', 'oliphaunt-wasix-rust', 'oliphaunt-react-native']) {
    const { candidate } = await generateProductCandidate([
      {
        sha: head,
        message: 'fix: repair integration',
        files: [`${native}/tools/package.sh`, `${graph.products[sdk].path}/src/implementation`],
      },
    ]);
    expect(
      candidate.updates.some(({ path: file }) => file.startsWith('src/extensions/external/')),
    ).toBe(false);
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
    return ref ? '0.1.0' : graph.products[source].version;
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
  const { candidate, versions } = await generateProductCandidate([
    {
      sha: head,
      message: 'fix: repair vector SQL',
      files: [`${vector.path}/source.toml`],
    },
  ]);
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
  );
  expect(candidate).toBeUndefined();
});

test('regeneration preserves the grouped body and complete update set', async () => {
  const commits = [
    { sha: head, message: 'fix: repair runtime', files: [`${native}/tools/package.sh`] },
  ];
  const render = ({ candidate }) => ({
    body: candidate.body.toString(),
    updates: mergeUpdates(candidate.updates).map((update) => {
      const file = path.join(ROOT, update.path);
      return [
        update.path,
        update.updater.updateContent(existsSync(file) ? readFileSync(file, 'utf8') : undefined),
      ];
    }),
  });
  expect(render(await generateProductCandidate(commits))).toEqual(
    render(await generateProductCandidate(commits)),
  );
});
