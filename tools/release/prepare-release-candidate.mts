import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { GitHub, Manifest, registerChangelogNotes } from 'release-please';
import { DefaultChangelogNotes } from 'release-please/build/src/changelog-notes/default.js';
import { parseConventionalCommits } from 'release-please/build/src/commit.js';
import { ManifestPlugin } from 'release-please/build/src/plugin.js';
import { mergeUpdates } from 'release-please/build/src/updaters/composite.js';
import { Changelog } from 'release-please/build/src/updaters/changelog.js';
import { GenericJson } from 'release-please/build/src/updaters/generic-json.js';
import { ReleasePleaseManifest } from 'release-please/build/src/updaters/release-please-manifest.js';
import { appendDependenciesSectionToChangelog } from 'release-please/build/src/plugins/workspace.js';
import { Version } from 'release-please/build/src/version.js';
import { defaultExtensionReleasePlan } from './default-extension-release-plan.mts';
import { syncTomlStringPath } from './sync-release-pr.mts';
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

// Supply source ownership and public host support intent. Release Please
// owns version policy, changelog text and ecosystem updaters in both cases.
export function includeOwnedSourceCommits(
  manifest,
  github,
  graph,
  readCompatibility = productCompatibilityVersion,
) {
  const observed = [];
  const iterate = github.mergeCommitIterator.bind(github);
  github.mergeCommitIterator = async function* (...args) {
    for await (const commit of iterate(...args)) {
      observed.push(commit);
      yield commit;
    }
  };
  manifest.plugins.push(
    new (class extends ManifestPlugin {
      strategies;
      releasesByPath;

      async preconfigure(strategies, commitsByPath, releasesByPath) {
        this.strategies = strategies;
        this.releasesByPath = releasesByPath;
        const owners = new Map(
          observed.map((commit) => [
            commit.sha,
            new Set(
              buildPlan(graph, commit.files ?? [], 'prepare-release-candidate').releaseProducts,
            ),
          ]),
        );
        for (const [ownerPath, config] of Object.entries(manifest.repositoryConfig)) {
          const boundary = releasesByPath[ownerPath]?.sha;
          const selected = new Map(
            (commitsByPath[ownerPath] ?? []).map((commit) => [commit.sha, commit]),
          );
          for (const commit of observed) {
            if (commit.sha === boundary) break;
            if (owners.get(commit.sha).has(config.component)) selected.set(commit.sha, commit);
          }
          commitsByPath[ownerPath] = observed.filter((commit) => selected.has(commit.sha));
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
        const workspaceIntent = Object.entries(manifest.repositoryConfig).some(
          ([ownerPath, config]) =>
            config.releaseType === 'rust' && hasReleaseIntent(ownerPath, config),
        );
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
          if (!releaseIntent && !runtimeChanged && !workspaceIntent) continue;
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
  const iterate = github.mergeCommitIterator.bind(github);
  github.mergeCommitIterator = async function* (...args) {
    let first = true;
    for await (const commit of iterate(...args)) {
      if (first && commit.sha !== sha)
        throw new Error('main changed before Release Please history capture');
      first = false;
      yield commit;
    }
    if (first) throw new Error('Release Please returned no source history');
  };
  const manifest = await Manifest.fromManifest(github, 'main');
  includeOwnedSourceCommits(manifest, github, loadGraph('prepare-release-candidate'));
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
