/** Shared fixtures invoke the pinned RP strategies; synthetic records grant no release authority. */
import { expect } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Manifest } from 'release-please';
import { ManifestPlugin } from 'release-please/build/src/plugin.js';
import { PullRequestBody } from 'release-please/build/src/util/pull-request-body.js';
import { Version } from 'release-please/build/src/version.js';
import { createCompletedPublicationChecker } from '../completed-release-publication.mts';
import {
  bindReleaseSourceHistory,
  includeOwnedSourceCommits,
  useSourceDate,
} from '../prepare-release-candidate.mts';
import { productCompatibilityVersion, ROOT } from '../release-graph.mts';

const first = 'a'.repeat(40);
const head = 'c'.repeat(40);
export function fixtureCompletionChecker(
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

export const historyProducts = ['alpha', 'beta', 'gamma'];
export const historyShared = 'shared/shipped.c';

export async function generateHistoryCandidate(
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
    controllerOptions = {},
    nodeWorkspace = false,
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
        releaseType: nodeWorkspace ? 'node' : 'simple',
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
      const parsedContent = file.endsWith('/VERSION')
        ? `${owner.version}\n`
        : file.endsWith('/package.json')
          ? JSON.stringify({
              name: historyProducts.find((id) => products[id] === owner),
              version: owner.version,
              ...(owner === products.alpha ? { dependencies: { beta: '0.2.0' } } : {}),
            })
          : '# Changelog\n';
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
    plugins: nodeWorkspace ? [{ type: 'node-workspace', merge: false }] : [],
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
    ...controllerOptions,
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

export function historyVersionUpdates(candidates) {
  return candidates.flatMap((candidate) =>
    candidate.updates
      .filter((update) => update.path.endsWith('/VERSION'))
      .map((update) => [update.path, update.updater.updateContent('0.2.0\n').trim()]),
  );
}

export function nativeHistoryOptions(
  necessary,
  { current = false, observeNativePlan = async () => {} } = {},
) {
  // Controlled invocation of the actual pinned strategy/plugin API; these
  // fixture records do not claim authenticated workflow/product qualification.
  const buildBound = new Map(historyProducts.map((id) => [id, new Set<string>()]));
  if (current) buildBound.get('alpha')!.add('beta');
  return {
    nativeNecessaryProducts: necessary,
    buildBound,
    observeNativePlan,
    nativeObservation: {
      coverage: { completeProductInventory: true },
      products: historyProducts.map((id) => ({
        product: { id },
        construction: [{ leafInputPaths: [`actual/shipping/${id}.c`], analysisInputPaths: [] }],
      })),
    },
  };
}

export async function generateProductCandidateForGraph(
  graph,
  commits,
  readCompatibility = (product, source) => productCompatibilityVersion(product, source),
  configure = () => {},
  { root = ROOT, baseline = first, ...dependencyOptions } = {},
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
    ...dependencyOptions,
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
