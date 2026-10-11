import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { GitHub, Manifest, registerChangelogNotes } from 'release-please';
import { DefaultChangelogNotes } from 'release-please/build/src/changelog-notes/default.js';
import { parseConventionalCommits } from 'release-please/build/src/commit.js';
import { ManifestPlugin } from 'release-please/build/src/plugin.js';
import { appendDependenciesSectionToChangelog } from 'release-please/build/src/plugins/workspace.js';
import { Changelog } from 'release-please/build/src/updaters/changelog.js';
import { mergeUpdates } from 'release-please/build/src/updaters/composite.js';
import { GenericJson } from 'release-please/build/src/updaters/generic-json.js';
import { ReleasePleaseManifest } from 'release-please/build/src/updaters/release-please-manifest.js';
import { TagName } from 'release-please/build/src/util/tag-name.js';
import { Version } from 'release-please/build/src/version.js';
import { readCommitHistory, readCommitPaths } from './commit-paths.mts';
import { createCompletedPublicationChecker } from './completed-release-publication.mts';
import { defaultExtensionReleasePlan } from './default-extension-release-plan.mts';
import { requestGithubRepositoryJson } from './github-read.mts';
import {
  buildBoundCompatibilityProducts,
  releaseDependencyPlan,
} from './release-dependency-plan.mts';
import {
  buildPlan,
  compatibilityVersionEntries,
  loadGraph,
  productCompatibilityVersion,
} from './release-graph.mts';
import { syncTomlStringPath } from './sync-release-pr.mts';

// Supply source ownership and public host support intent. Release Please
// owns version policy, changelog text and ecosystem updaters in both cases.
export function includeOwnedSourceCommits(
  manifest,
  github,
  graph,
  readCompatibility = productCompatibilityVersion,
  {
    readCommitFiles,
    commitHistory,
    assertCompletedPublication = createCompletedPublicationChecker({
      repository: `${github.repository.owner}/${github.repository.repo}`,
    }),
  } = {},
) {
  const observed = [];
  const published = new Map();
  const selectedHistory = new Map();
  const releases = github.releaseIterator.bind(github);
  github.releaseIterator = async function* (options = {}) {
    published.clear();
    for await (const release of releases({ ...options, maxResults: Number.MAX_SAFE_INTEGER })) {
      if (release.draft) continue;
      published.set(release.tagName, release.sha);
      yield release;
    }
  };
  const iterate = github.mergeCommitIterator.bind(github);
  github.mergeCommitIterator = async function* (branch, options = {}) {
    observed.length = 0;
    selectedHistory.clear();
    const required = new Set();
    if (commitHistory) {
      for (const [ownerPath, config] of Object.entries(manifest.repositoryConfig)) {
        const version = manifest.releasedVersions[ownerPath]?.toString();
        const matches = [...published].filter(([name]) => {
          const tag = TagName.parse(name);
          return tag?.component === config.component && tag.version.toString() === version;
        });
        if (version !== '0.0.0' && matches.length !== 1)
          throw new Error(
            `prepare-release-candidate: ${config.component}@${version} has no unique published release boundary`,
          );
        const boundary = version === '0.0.0' ? manifest.bootstrapSha : matches[0][1];
        const selected = commitHistory.after(boundary);
        selectedHistory.set(ownerPath, { boundary, selected });
        for (const sha of selected) required.add(sha);
        if (boundary) required.add(boundary);
      }
    }
    const seen = new Set();
    // Buffer the exact local ancestry interval before Manifest can stop at a
    // delivered release SHA. API history order does not define publication scope.
    for await (const commit of iterate(branch, {
      ...options,
      maxResults: commitHistory?.commits.size ?? Number.MAX_SAFE_INTEGER,
      backfillFiles: readCommitFiles ? false : options.backfillFiles,
    })) {
      if (commitHistory && !commitHistory.commits.has(commit.sha))
        throw new Error(
          `prepare-release-candidate: history commit ${commit.sha} is outside the captured source`,
        );
      if (seen.has(commit.sha))
        throw new Error(`prepare-release-candidate: duplicate history commit ${commit.sha}`);
      seen.add(commit.sha);
      const captured = readCommitFiles
        ? { ...commit, files: await readCommitFiles(commit.sha) }
        : commit;
      observed.push(captured);
      if (!commitHistory) yield captured;
      else {
        required.delete(commit.sha);
        if (!required.size) break;
      }
    }
    if (commitHistory) {
      if (required.size)
        throw new Error(
          `prepare-release-candidate: API history did not cover captured source commits ${[...required].join(', ')}`,
        );
      const order = new Map([...commitHistory.commits].map((sha, index) => [sha, index]));
      observed.sort((left, right) => order.get(left.sha) - order.get(right.sha));
      yield* observed;
    }
  };
  manifest.plugins.push(
    new (class extends ManifestPlugin {
      strategies;
      releasesByPath;

      async preconfigure(strategies, commitsByPath, releasesByPath) {
        this.strategies = strategies;
        this.releasesByPath = releasesByPath;
        const seen = new Set();
        for (const commit of observed) {
          if (seen.has(commit.sha))
            throw new Error(`prepare-release-candidate: duplicate history commit ${commit.sha}`);
          if (!Array.isArray(commit.files))
            throw new Error(`prepare-release-candidate: missing changed files for ${commit.sha}`);
          seen.add(commit.sha);
        }
        const needsBootstrap = Object.keys(manifest.repositoryConfig).some(
          (ownerPath) => manifest.releasedVersions[ownerPath]?.toString() === '0.0.0',
        );
        if (needsBootstrap && manifest.bootstrapSha && !seen.has(manifest.bootstrapSha))
          throw new Error(
            `prepare-release-candidate: history did not reach bootstrap boundary ${manifest.bootstrapSha}`,
          );
        const owners = new Map(
          observed.map((commit) => [
            commit.sha,
            new Set(
              buildPlan(graph, commit.files ?? [], 'prepare-release-candidate').releaseProducts,
            ),
          ]),
        );
        for (const [ownerPath, config] of Object.entries(manifest.repositoryConfig)) {
          const release = releasesByPath[ownerPath];
          const version = manifest.releasedVersions[ownerPath]?.toString();
          if (!version)
            throw new Error(`prepare-release-candidate: missing product version for ${ownerPath}`);
          if (
            version !== '0.0.0' &&
            (!release?.sha || published.get(release.tag.toString()) !== release.sha)
          )
            throw new Error(
              `prepare-release-candidate: ${config.component}@${version} has no published release boundary`,
            );
          if (version !== '0.0.0')
            await assertCompletedPublication({
              product: config.component,
              version,
              publicationSha: release.sha,
              tagName: release.tag.toString(),
            });
          const boundary = release?.sha || (needsBootstrap ? manifest.bootstrapSha : undefined);
          const local = selectedHistory.get(ownerPath);
          if (local && local.boundary !== boundary)
            throw new Error(
              `prepare-release-candidate: ${config.component} release boundary changed during capture`,
            );
          if (boundary && !seen.has(boundary))
            throw new Error(
              `prepare-release-candidate: history did not reach ${config.component} boundary ${boundary}`,
            );
          const selected = [];
          for (const commit of observed) {
            if (local ? !local.selected.has(commit.sha) : commit.sha === boundary) {
              if (local) continue;
              break;
            }
            if (owners.get(commit.sha).has(config.component)) selected.push(commit);
          }
          commitsByPath[ownerPath] = selected;
        }
        const entries = compatibilityVersionEntries(graph.products, { requireSourceProduct: true });
        const hasReleaseIntent = (ownerPath, config) => {
          const releaseTypes = new Set(
            (config.changelogSections ?? [])
              .filter((section) => !section.hidden)
              .map((section) => section.type),
          );
          return parseConventionalCommits(commitsByPath[ownerPath] ?? []).some(
            (commit) => commit.notes?.length || releaseTypes.has(commit.type),
          );
        };
        const plannedProducts = structuredClone(graph.products);
        const compiled = buildBoundCompatibilityProducts(graph.products);
        // Only these source-selected producers determine public exact host retargets.
        for (const runtime of ['liboliphaunt-native', 'liboliphaunt-wasix']) {
          const owner = graph.products[runtime]?.path;
          if (!strategies[owner]) continue;
          let commits = parseConventionalCommits(commitsByPath[owner] ?? []);
          for (const plugin of manifest.plugins) commits = plugin.processCommits(commits);
          const candidate = await strategies[owner].buildReleasePullRequest(
            commits,
            releasesByPath[owner],
            manifest.draftPullRequest,
            manifest.labels,
          );
          if (candidate) plannedProducts[runtime].version = candidate.version.toString();
        }
        for (const [ownerPath, config] of Object.entries(manifest.repositoryConfig)) {
          const product = config.component;
          if (!graph.products[product] || !releasesByPath[ownerPath]) continue;
          const releaseIntent = hasReleaseIntent(ownerPath, config);
          const runtimeChanged = ['liboliphaunt-native', 'liboliphaunt-wasix'].some(
            (runtime) => plannedProducts[runtime]?.version !== graph.products[runtime]?.version,
          );
          if (!releaseIntent && !runtimeChanged) continue;
          const plan = releaseDependencyPlan(plannedProducts, [product], {
            entries: entries.filter((entry) => entry.product === product && entry.publicSupport),
            buildBound: compiled,
            readValue: (entry) => readCompatibility(entry.product, entry.sourceProduct),
          });
          const changes = plan.flatMap((entry) => {
            const previous = readCompatibility(
              product,
              entry.sourceProduct,
              'prepare-release-candidate',
              {
                ref:
                  graph.products[product].tag_prefix +
                  releasesByPath[ownerPath].tag.version.toString(),
              },
            );
            return previous === entry.version
              ? []
              : [{ producer: entry.sourceProduct, before: previous, after: entry.version }];
          });
          if (!changes.length) continue;
          const intent = parseConventionalCommits([
            {
              sha: '',
              files: [],
              message: `fix!: replace exact host support ${changes.map(({ producer, before, after }) => `${producer}@${before} with ${producer}@${after}`).join('; ')}`,
            },
          ]);
          const strategy = strategies[ownerPath];
          const bump = strategy.versioningStrategy.bump.bind(strategy.versioningStrategy);
          const withIntent = (commits) => [...commits, ...intent];
          // Workspace-created consumers call the native bump strategy with no commits.
          strategy.versioningStrategy.bump = (version, commits) =>
            bump(version, withIntent(commits));
          const build = strategy.buildReleasePullRequest.bind(strategy);
          strategy.buildReleasePullRequest = async (commits, latest, draft, labels, options) => {
            let candidate = await build(commits, latest, draft, labels, options);
            if (candidate)
              candidate = await build(withIntent(commits), latest, draft, labels, options);
            if (candidate && latest) {
              const floor = await bump(latest.tag.version, intent);
              if (Bun.semver.order(candidate.version.toString(), floor.toString()) < 0)
                throw new Error(
                  `prepare-release-candidate: ${product} version ${candidate.version} is below Release Please public-support floor ${floor}`,
                );
            }
            return candidate;
          };
        }
        return strategies;
      }

      async run(candidates) {
        let plan;
        for (;;) {
          const products = structuredClone(graph.products);
          const selected = new Set();
          for (const candidate of candidates) {
            const product = this.repositoryConfig[candidate.path].component;
            products[product].version = candidate.pullRequest.version.toString();
            selected.add(product);
          }
          plan = defaultExtensionReleasePlan(products, selected, { readCompatibility });
          const missing = [...plan.required].filter((product) => !selected.has(product));
          if (!missing.length) break;
          for (const product of missing) {
            const metadata = products[product];
            const ownerPath = metadata.path;
            const commits = parseConventionalCommits([
              {
                sha: '',
                files: [],
                message: `${metadata.extension?.class === 'external' ? 'fix!' : 'fix'}: align default extension installation`,
              },
            ]);
            const pullRequest = await this.strategies[ownerPath].buildReleasePullRequest(
              commits,
              this.releasesByPath[ownerPath],
              manifest.draftPullRequest,
              manifest.labels,
            );
            if (!pullRequest) throw new Error(`could not prepare compatible product ${product}`);
            pullRequest.updates.push({
              path: manifest.manifestPath,
              createIfMissing: false,
              updater: new ReleasePleaseManifest({
                version: pullRequest.version,
                versionsMap: new Map([[ownerPath, pullRequest.version]]),
              }),
            });
            candidates.push({
              path: ownerPath,
              config: this.repositoryConfig[ownerPath],
              pullRequest,
            });
          }
        }
        const entries = compatibilityVersionEntries(graph.products, { requireSourceProduct: true });
        for (const candidate of candidates) {
          const product = this.repositoryConfig[candidate.path].component;
          const changes = [...plan.requirements.values()].filter(
            (entry) => entry.product === product,
          );
          for (const { sourceProduct, version } of changes) {
            for (const entry of entries.filter(
              (entry) => entry.product === product && entry.sourceProduct === sourceProduct,
            )) {
              candidate.pullRequest.updates.push({
                path: entry.path,
                createIfMissing: false,
                updater: entry.parser.startsWith('json:')
                  ? new GenericJson(`$.${entry.parser.slice(5)}`, Version.parse(version))
                  : {
                      updateContent: (content) =>
                        entry.parser === 'raw'
                          ? `${version}\n`
                          : syncTomlStringPath(content, entry.parser.slice(5), version, entry.id)
                              .text,
                    },
              });
            }
          }
          if (!changes.length) continue;
          const notes = changes
            .map(
              ({ sourceProduct, version }) =>
                `* Require ${sourceProduct}@${version} for the default extension install.`,
            )
            .join('\n');
          for (const update of candidate.pullRequest.updates) {
            if (update.updater instanceof Changelog)
              update.updater.changelogEntry = appendDependenciesSectionToChangelog(
                update.updater.changelogEntry,
                notes,
              );
          }
          for (const release of candidate.pullRequest.body.releaseData)
            release.notes = appendDependenciesSectionToChangelog(release.notes, notes);
        }
        return candidates;
      }
    })(github, 'main', manifest.repositoryConfig),
  );
}

export function useSourceDate(sourceDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(sourceDate)) throw new Error('source date must be YYYY-MM-DD');
  const require = createRequire(import.meta.url);
  const releaseRequire = createRequire(require.resolve('release-please'));
  const header = readFileSync(
    releaseRequire.resolve('conventional-changelog-conventionalcommits/templates/header.hbs'),
    'utf8',
  );
  registerChangelogNotes(
    'default',
    (options) =>
      new DefaultChangelogNotes({
        ...options,
        headerPartial: (options.headerPartial ?? header).replaceAll('{{date}}', sourceDate),
      }),
  );
}

export function bindReleaseSourceHistory(
  github,
  commitHistory,
  sha,
  readSource = () =>
    requestGithubRepositoryJson(
      `repos/${github.repository.owner}/${github.repository.repo}/git/ref/heads/main`,
    ),
) {
  if (commitHistory.head !== sha)
    throw new Error('captured Git history does not match the release source');
  const iterate = github.mergeCommitIterator.bind(github);
  github.mergeCommitIterator = async function* (...args) {
    const source = await readSource();
    if (source.object?.sha !== sha)
      throw new Error('main changed before Release Please history capture');
    yield* iterate(...args);
  };
}

export function applyCandidate(root, candidate) {
  const changed = [];
  for (const update of mergeUpdates(candidate.updates)) {
    const destination = path.resolve(root, update.path);
    if (!destination.startsWith(`${path.resolve(root)}${path.sep}`))
      throw new Error(`unsafe release update path ${update.path}`);
    const before = existsSync(destination) ? readFileSync(destination, 'utf8') : undefined;
    if (before === undefined && !update.createIfMissing) continue;
    const after = update.updater.updateContent(before);
    if (after && after !== before) {
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, after);
      changed.push(update.path);
    }
  }
  return changed;
}

async function main() {
  const root = process.cwd();
  const destination = process.argv[2];
  const sha = process.env.RELEASE_SOURCE_SHA;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!destination || !/^[0-9a-f]{40}$/u.test(sha ?? '') || repository !== 'f0rr0/oliphaunt')
    throw new Error('candidate generation requires an exact canonical source and output directory');
  useSourceDate(process.env.RELEASE_SOURCE_DATE);
  const [owner, repo] = repository.split('/');
  const github = await GitHub.create({
    owner,
    repo,
    defaultBranch: 'main',
    token: process.env.GH_TOKEN,
    fetch: (url, options = {}) =>
      fetch(url, {
        ...options,
        signal: options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000),
      }),
  });
  // File reads use the exact source even if main advances during API pagination.
  const getFile = github.getFileContentsOnBranch.bind(github);
  github.getFileContentsOnBranch = (file) => getFile(file, sha);
  const commitHistory = readCommitHistory();
  bindReleaseSourceHistory(github, commitHistory, sha);
  const manifest = await Manifest.fromManifest(github, 'main');
  includeOwnedSourceCommits(manifest, github, loadGraph('prepare-release-candidate'), undefined, {
    readCommitFiles: readCommitPaths,
    commitHistory,
  });
  const candidates = await manifest.buildPullRequests();
  if (candidates.length > 1) throw new Error('expected one grouped Release Please candidate');
  mkdirSync(destination, { recursive: true });
  if (!candidates.length) {
    writeFileSync(path.join(destination, 'required'), 'false\n');
    return;
  }
  const candidate = candidates[0];
  if (
    candidate.headRefName !== 'release-please--branches--main' ||
    candidate.title.toString() !== 'chore(release): prepare main releases'
  )
    throw new Error('unexpected Release Please branch/title');
  applyCandidate(root, candidate);
  writeFileSync(path.join(destination, 'required'), 'true\n');
  writeFileSync(path.join(destination, 'title'), `${candidate.title.toString()}\n`);
  writeFileSync(path.join(destination, 'body.md'), `${candidate.body.toString()}\n`);
}

if (import.meta.main) await main();
