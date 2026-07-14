#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { env, exit } from 'node:process';

function fail(message) {
  console.error(message);
  exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: process.env,
  });
  if (result.error) {
    fail(result.error.message);
  }
  if (result.status !== 0) {
    if (result.stdout) {
      console.error(result.stdout.trimEnd());
    }
    if (result.stderr) {
      console.error(result.stderr.trimEnd());
    }
    fail(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
  return result.stdout;
}

function ghJson(args) {
  const output = run('gh', args).trim();
  return output ? JSON.parse(output) : null;
}

function artifactNames(repo, runId) {
  return new Set(
    run('gh', [
      'api',
      `repos/${repo}/actions/runs/${runId}/artifacts`,
      '--paginate',
      '--jq',
      '.artifacts[].name',
    ])
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

function gateSucceeded(runId, gateJobName) {
  const data = ghJson(['run', 'view', String(runId), '--json', 'jobs']);
  return (data?.jobs ?? []).some(
    (job) => job?.name === gateJobName && job?.conclusion === 'success',
  );
}

function setOutput(name, value) {
  const rendered = `${name}=${value}\n`;
  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, rendered, 'utf8');
  } else {
    process.stdout.write(rendered);
  }
}

const repo = env.GH_REPO;
if (!repo) {
  fail('GH_REPO is required');
}

const requestedPlatform = env.INPUT_PLATFORM || 'all';
const requestedSha = env.INPUT_SHA || env.DEFAULT_SHA;
if (!requestedSha) {
  fail('an input SHA or default SHA is required');
}
const sha = run('git', ['rev-parse', 'HEAD^{commit}']).trim();
if (!/^[0-9a-f]{40}$/u.test(sha)) {
  fail(`checked-out mobile E2E commit is not a full SHA: ${sha}`);
}
const gateJobName = env.BUILD_GATE_JOB || 'Builds';
const requested = {
  android: requestedPlatform === 'all' || requestedPlatform === 'android',
  ios: requestedPlatform === 'all' || requestedPlatform === 'ios',
};

function completeForRequest(runId) {
  const names = artifactNames(repo, runId);
  return {
    android:
      requested.android && names.has('react-native-mobile-android-app-android-x86_64'),
    ios: requested.ios && names.has('react-native-mobile-ios-app'),
  };
}

const candidateIds = [];
const runs = ghJson([
  'run',
  'list',
  '--workflow',
  'ci.yml',
  '--commit',
  sha,
  '--limit',
  '20',
  '--json',
  'databaseId,status,conclusion',
]);
for (const run of runs ?? []) {
  if (run?.status === 'completed' && run?.conclusion === 'success') {
    candidateIds.push(String(run.databaseId));
  }
}

let selectedRun = '';
let selected = { android: false, ios: false };
for (const runId of candidateIds) {
  if (!gateSucceeded(runId, gateJobName)) {
    continue;
  }
  const available = completeForRequest(runId);
  const matched = Object.entries(requested).every(
    ([platform, wanted]) => !wanted || available[platform],
  );
  if (matched) {
    selectedRun = String(runId);
    selected = available;
    break;
  }
}

if (!selectedRun) {
  fail(`No successful CI run for ${sha} contains requested mobile app artifacts.`);
}

const missing = Object.entries(requested)
  .filter(([platform, wanted]) => wanted && !selected[platform])
  .map(([platform]) => platform);
if (missing.length > 0) {
  fail(`Requested E2E platform artifacts are missing for ${sha}: ${missing.join(', ')}`);
}

setOutput('sha', sha);
setOutput('run_id', selectedRun);
setOutput('android', String(selected.android));
setOutput('ios', String(selected.ios));
