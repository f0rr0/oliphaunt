import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { GitHub, Manifest, registerChangelogNotes } from 'release-please';
import { ManifestPlugin } from 'release-please/build/src/plugin.js';
import { DefaultChangelogNotes } from 'release-please/build/src/changelog-notes/default.js';
import { mergeUpdates } from 'release-please/build/src/updaters/composite.js';
import { buildPlan, loadGraph } from './release-graph.mts';

// Only ownership is supplied here. Release Please remains responsible for
// conventional commits, version policy, changelog text and ecosystem updaters.
export function includeOwnedSourceCommits(manifest, github, graph) {
  const observed = [];
  const iterate = github.mergeCommitIterator.bind(github);
  github.mergeCommitIterator = async function* (...args) {
    for await (const commit of iterate(...args)) {
      observed.push(commit);
      yield commit;
    }
  };
  manifest.plugins.unshift(
    new (class extends ManifestPlugin {
      async preconfigure(strategies, commitsByPath, releasesByPath) {
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
        return strategies;
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
