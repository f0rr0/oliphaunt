#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
import { env, exit } from 'node:process';

import { requestGithubJsonWithRetry } from '../../tools/release/github-read.mts';

const FULL_SHA = /^[0-9a-f]{40}$/u;
const FULL_SHA_INPUT = /^[0-9a-f]{40}$/iu;
const RUN_ID = /^[1-9][0-9]*$/u;
const MOBILE_ARTIFACTS = Object.freeze({
  android: 'react-native-mobile-android-app-android-x86_64',
  ios: 'react-native-mobile-ios-app',
});

function outputWriter(environment) {
  return (name, value) => {
    const rendered = `${name}=${value}\n`;
    if (environment.GITHUB_OUTPUT) {
      appendFileSync(environment.GITHUB_OUTPUT, rendered, 'utf8');
    } else {
      process.stdout.write(rendered);
    }
  };
}

export function mobilePlatformSelection(value = 'all') {
  if (!new Set(['all', 'android', 'ios']).has(value)) {
    throw new Error(
      `unsupported mobile E2E platform ${JSON.stringify(value)}; expected all, android, or ios`,
    );
  }
  return {
    android: value === 'all' || value === 'android',
    ios: value === 'all' || value === 'ios',
  };
}

export function githubResolverDependencies(repo, { environment = env, retryOptions = {} } = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(repo ?? ''))
    throw new Error('GH_REPO must be owner/repository');
  const api = (environment.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/u, '');
  const read = (endpoint) =>
    requestGithubJsonWithRetry(api + '/repos/' + repo + '/' + endpoint, {
      ...retryOptions,
      authToken: environment.GH_TOKEN || environment.GITHUB_TOKEN,
    });
  async function pages(endpoint, field) {
    const result = [];
    let expected;
    for (let page = 1; page <= 1000; page++) {
      const data = await read(
        endpoint + (endpoint.includes('?') ? '&' : '?') + 'per_page=100&page=' + page,
      );
      if (
        !Number.isSafeInteger(data?.total_count) ||
        data.total_count < 0 ||
        !Array.isArray(data[field]) ||
        data[field].length > 100
      )
        throw new Error('malformed GitHub ' + field + ' inventory');
      expected ??= data.total_count;
      if (data.total_count !== expected)
        throw new Error('GitHub ' + field + ' inventory changed during pagination');
      result.push(...data[field]);
      if (result.length === expected) return result;
      if (result.length > expected || data[field].length === 0)
        throw new Error('incomplete GitHub ' + field + ' inventory');
    }
    throw new Error('GitHub ' + field + ' inventory exceeds 1000 pages');
  }
  return {
    checkoutSha: () => environment.CHECKOUT_SHA,
    async listRuns(sha) {
      const data = await read('actions/workflows/ci.yml/runs?head_sha=' + sha + '&per_page=100');
      if (!Array.isArray(data?.workflow_runs)) throw new Error('CI workflow runs must be a list');
      return data.workflow_runs.map((row) => ({
        databaseId: row.id,
        headSha: row.head_sha,
        status: row.status,
        conclusion: row.conclusion,
      }));
    },
    async gateSucceeded(runId, gateJobName) {
      const jobs = await pages('actions/runs/' + runId + '/jobs?filter=latest', 'jobs');
      const matches = jobs.filter((job) => job?.name === gateJobName);
      return matches.length === 1 && matches[0]?.conclusion === 'success';
    },
    async artifactNames(runId) {
      const artifacts = await pages('actions/runs/' + runId + '/artifacts', 'artifacts');
      return artifacts
        .map((artifact) => {
          if (
            artifact === null ||
            typeof artifact !== 'object' ||
            typeof artifact.name !== 'string' ||
            artifact.name.length === 0 ||
            typeof artifact.expired !== 'boolean'
          )
            throw new Error('CI run ' + runId + ' contains malformed artifact metadata');
          return artifact;
        })
        .filter((artifact) => !artifact.expired)
        .map((artifact) => artifact.name);
    },
  };
}

function stringCounts(value, label) {
  if (value === null || value === undefined || typeof value[Symbol.iterator] !== 'function') {
    throw new Error(`${label} must be an iterable of artifact names`);
  }
  const result = new Map();
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0) {
      throw new Error(`${label} contains an invalid artifact name`);
    }
    result.set(item, (result.get(item) ?? 0) + 1);
  }
  return result;
}

export async function resolveMobileE2e(
  { repo, requestedPlatform = 'all', requestedSha, defaultSha, gateJobName = 'Builds' },
  dependencies,
) {
  if (typeof repo !== 'string' || repo.length === 0) {
    throw new Error('GH_REPO is required');
  }
  if (!dependencies || typeof dependencies !== 'object') {
    throw new Error('mobile E2E resolver dependencies are required');
  }
  const requested = mobilePlatformSelection(requestedPlatform);
  const inputSha = requestedSha || defaultSha;
  if (!inputSha) {
    throw new Error('an input SHA or default SHA is required');
  }
  if (!FULL_SHA_INPUT.test(inputSha)) {
    throw new Error(`mobile E2E input must be a full commit SHA: ${inputSha}`);
  }

  const sha = String(dependencies.checkoutSha()).trim();
  if (!FULL_SHA.test(sha)) {
    throw new Error(`checked-out mobile E2E commit is not a full SHA: ${sha}`);
  }
  if (sha !== inputSha.toLowerCase()) {
    throw new Error(
      `checked-out mobile E2E commit ${sha} does not match requested SHA ${inputSha}`,
    );
  }

  const runs = await dependencies.listRuns(sha);
  if (runs !== null && !Array.isArray(runs)) {
    throw new Error('gh run list must return a JSON array');
  }
  const candidateIds = [];
  const seenRunIds = new Set();
  for (const candidate of runs ?? []) {
    if (candidate?.status !== 'completed' || candidate?.conclusion !== 'success') continue;
    if (!FULL_SHA.test(candidate.headSha ?? '')) {
      throw new Error('successful CI run metadata is missing a full lowercase headSha');
    }
    if (candidate.headSha !== sha) continue;
    const runId = String(candidate.databaseId ?? '');
    if (!RUN_ID.test(runId)) {
      throw new Error(
        `successful CI run for ${sha} has invalid databaseId ${JSON.stringify(candidate.databaseId)}`,
      );
    }
    if (!seenRunIds.has(runId)) {
      seenRunIds.add(runId);
      candidateIds.push(runId);
    }
  }

  for (const runId of candidateIds) {
    if ((await dependencies.gateSucceeded(runId, gateJobName)) !== true) continue;
    const names = stringCounts(
      await dependencies.artifactNames(runId),
      `CI run ${runId} artifacts`,
    );
    const selected = {
      android: requested.android && names.get(MOBILE_ARTIFACTS.android) === 1,
      ios: requested.ios && names.get(MOBILE_ARTIFACTS.ios) === 1,
    };
    if (Object.entries(requested).every(([platform, wanted]) => !wanted || selected[platform])) {
      return {
        android: selected.android,
        ios: selected.ios,
        platformJobs: [...(selected.android ? ['android'] : []), ...(selected.ios ? ['ios'] : [])],
        runId,
        sha,
      };
    }
  }

  throw new Error(`No successful CI run for ${sha} contains requested mobile app artifacts.`);
}

export async function runMobileE2eResolver({
  environment = env,
  dependencies = undefined,
  writeOutput = undefined,
} = {}) {
  const repo = environment.GH_REPO;
  const resolved = await resolveMobileE2e(
    {
      defaultSha: environment.DEFAULT_SHA,
      gateJobName: environment.BUILD_GATE_JOB || 'Builds',
      repo,
      requestedPlatform: environment.INPUT_PLATFORM || 'all',
      requestedSha: environment.INPUT_SHA,
    },
    dependencies ??
      githubResolverDependencies(repo, {
        environment,
      }),
  );
  const emit = writeOutput ?? outputWriter(environment);
  emit('sha', resolved.sha);
  emit('run_id', resolved.runId);
  emit('android', String(resolved.android));
  emit('ios', String(resolved.ios));
  emit('platform_jobs', JSON.stringify(resolved.platformJobs));
  return resolved;
}

if (import.meta.main) {
  try {
    await runMobileE2eResolver();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    exit(1);
  }
}
