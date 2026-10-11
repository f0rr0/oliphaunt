import { PullRequestBody } from 'release-please/build/src/util/pull-request-body.js';
import { requestGithubPages, requestGithubRepositoryJson } from './github-read.mts';
import {
  releasePleaseClosedPullRequestQuery,
  releasePleaseLabelState,
  selectExactReleasePullRequest,
} from './release-please-pr-lifecycle.mts';

const quiet = { error() {}, warn() {} };
const fullSha = /^[0-9a-f]{40}$/u;

export interface CompletedPublication {
  product: string;
  version: string;
  tagName: string;
  publicationSha: string;
  publicationTree: string;
  releaseSha: string;
}

function error(message) {
  return new Error(`prepare-release-candidate: ${message}`);
}

// The existing publication workflow marks the canonical PR tagged only after
// registry verification, public consumer proof and promotion of every draft.
export function createCompletedPublicationChecker({
  repository,
  listPullRequests = () =>
    requestGithubPages(
      `repos/${repository}/pulls?${releasePleaseClosedPullRequestQuery(repository)}`,
      { label: 'completed release pull requests' },
    ),
  readJson = requestGithubRepositoryJson,
  readPages = requestGithubPages,
}) {
  let pullRequests;
  const reads = new Map();
  const versions = new Map();
  const transitions = new Map();
  const pagedComparisons = new Map();
  const read = (endpoint) => {
    if (!reads.has(endpoint)) reads.set(endpoint, readJson(endpoint));
    return reads.get(endpoint);
  };
  const versionState = (sha) => {
    if (!versions.has(sha))
      versions.set(
        sha,
        (async () => {
          const contents = await Promise.all(
            ['release-please-config.json', '.release-please-manifest.json'].map(async (file) => {
              const response = await read(`repos/${repository}/contents/${file}?ref=${sha}`);
              if (response.encoding !== 'base64' || typeof response.content !== 'string')
                throw error(`missing historical ${file} at ${sha}`);
              return JSON.parse(Buffer.from(response.content, 'base64').toString('utf8'));
            }),
          );
          const [config, manifest] = contents;
          const state = new Map();
          for (const [owner, entry] of Object.entries(config.packages ?? {})) {
            if (
              !entry.component ||
              state.has(entry.component) ||
              typeof manifest[owner] !== 'string'
            )
              throw error(`invalid historical product versions at ${sha}`);
            state.set(entry.component, manifest[owner]);
          }
          return state;
        })(),
      );
    return versions.get(sha);
  };
  const releaseTransition = (sha) => {
    if (!transitions.has(sha))
      transitions.set(
        sha,
        (async () => {
          const commit = await read(`repos/${repository}/git/commits/${sha}`);
          if (
            commit.sha !== sha ||
            commit.parents?.length !== 1 ||
            !fullSha.test(commit.parents[0].sha)
          )
            throw error(`release ${sha} is not an exact single-parent version commit`);
          const [before, after] = await Promise.all([
            versionState(commit.parents[0].sha),
            versionState(sha),
          ]);
          return new Map(
            [...after].filter(([product, version]) => before.get(product) !== version),
          );
        })(),
      );
    return transitions.get(sha);
  };

  return async ({ product, version, publicationSha, tagName }) => {
    if (typeof tagName !== 'string' || !tagName || !fullSha.test(publicationSha))
      throw error(`${product}@${version} has no exact publication identity`);
    const published = await read(
      `repos/${repository}/releases/tags/${encodeURIComponent(tagName)}`,
    );
    if (
      published.tag_name !== tagName ||
      published.draft !== false ||
      published.prerelease !== false ||
      published.target_commitish !== publicationSha
    )
      throw error(
        `${product}@${version} public release does not bind its exact publication source`,
      );
    pullRequests ??= Promise.resolve(listPullRequests());
    const canonical = (await pullRequests).filter((candidate) => {
      try {
        return (
          selectExactReleasePullRequest([candidate], {
            repository,
            releaseSha: candidate.merge_commit_sha,
          }) === candidate
        );
      } catch {
        return false;
      }
    });
    const matches = [];
    for (const candidate of canonical) {
      let body;
      try {
        body = typeof candidate.body === 'string' && PullRequestBody.parse(candidate.body, quiet);
      } catch {
        continue;
      }
      if (
        !body?.releaseData.some(
          (release) =>
            (!release.component || release.component === product) &&
            release.version?.toString() === version,
        )
      )
        continue;
      if ((await releaseTransition(candidate.merge_commit_sha)).get(product) === version)
        matches.push(candidate);
    }
    if (matches.length !== 1)
      throw error(`${product}@${version} has no unique canonical release completion`);
    const [release] = matches;
    const releaseSha = release.merge_commit_sha;
    if (
      releasePleaseLabelState(release, { base: 'main', repository, releaseSha }).kind !== 'desired'
    )
      throw error(`${product}@${version} publication is not complete`);
    const publicationVersions = await versionState(publicationSha);
    const releasedVersions = await releaseTransition(releaseSha);
    if (
      [...releasedVersions].some(
        ([released, expected]) => publicationVersions.get(released) !== expected,
      )
    )
      throw error(`${product}@${version} publication source has different product versions`);
    const publicationCommit = await read(`repos/${repository}/git/commits/${publicationSha}`);
    if (publicationCommit?.sha !== publicationSha || !fullSha.test(publicationCommit.tree?.sha))
      throw error(`${product}@${version} publication source has no exact Git tree`);
    const completed: CompletedPublication = Object.freeze({
      product,
      version,
      tagName,
      publicationSha,
      publicationTree: publicationCommit.tree.sha,
      releaseSha,
    });
    if (releaseSha === publicationSha) return completed;
    const endpoint = `repos/${repository}/compare/${releaseSha}...${publicationSha}`;
    const comparison = await read(`${endpoint}?per_page=100`);
    if (
      comparison.status !== 'ahead' ||
      comparison.behind_by !== 0 ||
      comparison.base_commit?.sha !== releaseSha ||
      comparison.merge_base_commit?.sha !== releaseSha
    )
      throw error(`${product}@${version} publication source is not a release descendant`);
    if (comparison.commits?.length !== comparison.total_commits && !pagedComparisons.has(endpoint))
      pagedComparisons.set(
        endpoint,
        readPages(endpoint, {
          itemsField: 'commits',
          label: 'publication recovery history',
        }),
      );
    const commits =
      comparison.commits?.length === comparison.total_commits
        ? comparison.commits
        : await pagedComparisons.get(endpoint);
    const shas = Array.isArray(commits) && commits.map(({ sha }) => sha);
    if (
      !Array.isArray(commits) ||
      commits.length !== comparison.total_commits ||
      shas.some((sha) => !fullSha.test(sha)) ||
      new Set(shas).size !== commits.length ||
      !shas.includes(publicationSha)
    )
      throw error(`${product}@${version} publication recovery history is incomplete`);
    const intervening = new Set(
      canonical
        .filter((candidate) => candidate !== release)
        .map((candidate) => candidate.merge_commit_sha),
    );
    if (commits.some(({ sha }) => intervening.has(sha)))
      throw error(`${product}@${version} publication source follows another release candidate`);
    return completed;
  };
}
