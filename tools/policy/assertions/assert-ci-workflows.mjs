#!/usr/bin/env bun
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import process from 'node:process';

function workspaceRoot() {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : process.cwd();
}

const root = workspaceRoot();
process.chdir(root);

if (process.argv.includes('--help')) {
  console.log('usage: assert-ci-workflows.mjs');
  process.exit(0);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function read(path) {
  return readFileSync(path, 'utf8');
}

function requireText(path, text, message = `${path} must contain ${text}`) {
  if (!read(path).includes(text)) {
    fail(message);
  }
}

function rejectText(path, text, message = `${path} must not contain ${text}`) {
  if (read(path).includes(text)) {
    fail(message);
  }
}

function jobBlocks(path) {
  const text = read(path);
  const [, jobsSection = ''] = text.split(/\njobs:\n/, 2);
  if (!jobsSection) {
    fail(`${path} must declare jobs`);
  }
  const matches = [...jobsSection.matchAll(/^  ([A-Za-z0-9_-]+):\n/gm)];
  if (matches.length === 0) {
    fail(`${path} parser found no jobs`);
  }
  const blocks = new Map();
  for (const [index, match] of matches.entries()) {
    const end = matches[index + 1]?.index ?? jobsSection.length;
    blocks.set(match[1], jobsSection.slice(match.index, end));
  }
  return blocks;
}

function jobBlock(blocks, job) {
  const block = blocks.get(job);
  if (!block) {
    fail(`missing workflow job ${job}`);
  }
  return block;
}

function needs(blocks, job) {
  const block = jobBlock(blocks, job);
  const match = block.match(/^    needs:\n((?:      - [A-Za-z0-9_-]+\n)+)/m);
  if (!match) {
    return new Set();
  }
  return new Set(
    match[1]
      .trimEnd()
      .split('\n')
      .map((line) => line.replace('      - ', '').trim())
      .filter(Boolean),
  );
}

function assertNeeds(blocks, job, expected) {
  const actual = needs(blocks, job);
  const missing = expected.filter((need) => !actual.has(need));
  const unexpected = [...actual].filter((need) => !expected.includes(need)).sort();
  if (missing.length > 0 || unexpected.length > 0) {
    fail(
      `${job}.needs mismatch; missing=${JSON.stringify(missing)} unexpected=${JSON.stringify(unexpected)}`,
    );
  }
}

function assertBlockContains(blocks, job, text, message) {
  const block = jobBlock(blocks, job);
  if (!block.includes(text)) {
    fail(message);
  }
}

function checkoutStep(blocks, job) {
  const block = jobBlock(blocks, job);
  const match = block.match(/      - name: Checkout repository\n[\s\S]*?(?=\n      - name: |\n$)/);
  if (!match) {
    fail(`${job} must checkout the repository`);
  }
  return match[0];
}

function assertCheckoutRef(blocks, job, ref) {
  const step = checkoutStep(blocks, job);
  if (!step.includes(ref)) {
    fail(`${job} must checkout ${ref}`);
  }
}

function plannedBuildJobs(ciText) {
  return [
    ...new Set(
      [...ciText.matchAll(/run-planned-moon-job[.]sh ([A-Za-z0-9_-]+)/g)].map(
        (match) => match[1],
      ),
    ),
  ].sort();
}

const ciPath = '.github/workflows/ci.yml';
const mobilePath = '.github/workflows/mobile-e2e.yml';
const releasePath = '.github/workflows/release.yml';
const wasixDownloadPath = '.github/scripts/download-wasix-runtime-build-artifacts.sh';

const ci = read(ciPath);
const ciBlocks = jobBlocks(ciPath);
const mobileBlocks = jobBlocks(mobilePath);
const beforePushTrigger = ci.split('push:', 1)[0] ?? '';
const ciHeadRef = 'ref: ${{ github.event.pull_request.head.sha || github.sha }}';
const mobileArtifactRef = 'ref: ${{ needs.resolve.outputs.sha }}';

requireText(ciPath, 'name: CI');
if (/^name: Builds$/m.test(ci)) {
  fail('CI workflow must not be renamed to Builds');
}
rejectText(ciPath, 'artifact-builders');
rejectText(ciPath, 'python3 - <<');
if (beforePushTrigger.includes('paths:')) {
  fail('CI pull_request trigger must not use path filters; Moon affected is the source of truth');
}
jobBlock(ciBlocks, 'liboliphaunt-wasix-runtime');
jobBlock(ciBlocks, 'liboliphaunt-wasix-aot');
requireText(ciPath, 'run: .github/scripts/run-affected-moon-task.sh check');
requireText(ciPath, 'run: .github/scripts/run-affected-moon-task.sh test');
assertBlockContains(ciBlocks, 'checks', 'name: Checks', 'checks job must be named Checks');
assertBlockContains(ciBlocks, 'tests', 'name: Tests', 'tests job must be named Tests');
assertBlockContains(ciBlocks, 'builds', 'name: Builds', 'builds job must be named Builds');
assertBlockContains(
  ciBlocks,
  'checks',
  'uses: ./.github/actions/setup-android',
  'checks must set up Android for Kotlin/React Native static checks',
);
assertBlockContains(
  ciBlocks,
  'tests',
  'uses: ./.github/actions/setup-android',
  'tests must set up Android for Kotlin/React Native unit tests',
);
rejectText(
  ciPath,
  'run-moon-ci.sh',
  'checks and tests must select exact affected Moon task ids before calling moon run',
);
assertNeeds(ciBlocks, 'checks', ['affected']);
assertNeeds(ciBlocks, 'tests', ['checks']);
assertNeeds(ciBlocks, 'required', ['affected', 'checks', 'tests', 'builds']);
assertBlockContains(
  ciBlocks,
  'builds',
  'bun .github/scripts/check-ci-gate.mjs selected',
  'builds gate must use the shared Bun CI gate checker',
);
assertBlockContains(
  ciBlocks,
  'required',
  'bun .github/scripts/check-ci-gate.mjs required',
  'required gate must use the shared Bun CI gate checker',
);
assertBlockContains(
  ciBlocks,
  'builds',
  'SELECTED_JOBS_JSON: ${{ needs.affected.outputs.builder_jobs }}',
  'builds gate must check the Moon-planned artifact jobs',
);

for (const job of ['affected', 'checks', 'tests', 'builds', 'required']) {
  assertCheckoutRef(ciBlocks, job, ciHeadRef);
}

const buildsNeeds = needs(ciBlocks, 'builds');
if (!buildsNeeds.has('tests')) {
  fail('builds.needs must include tests');
}
for (const job of plannedBuildJobs(ci)) {
  if (!needs(ciBlocks, job).has('tests')) {
    fail(`${job}.needs must include tests before artifact production`);
  }
  if (!buildsNeeds.has(job)) {
    fail(`builds.needs must include artifact job ${job}`);
  }
  assertCheckoutRef(ciBlocks, job, ciHeadRef);
}

requireText(mobilePath, 'workflows: ["CI"]');
rejectText(mobilePath, 'workflows: ["Builds"]');
rejectText(mobilePath, 'artifact_builders_succeeded');
requireText(mobilePath, 'name: E2E');
requireText(mobilePath, 'BUILD_GATE_JOB: Builds');
requireText(mobilePath, 'bun .github/scripts/resolve-mobile-e2e.mjs');
requireText(mobilePath, 'bun .github/scripts/check-ci-gate.mjs allow-skipped');
assertBlockContains(mobileBlocks, 'required', 'name: E2E', 'E2E gate job must be named E2E');
assertCheckoutRef(mobileBlocks, 'android', mobileArtifactRef);
assertCheckoutRef(mobileBlocks, 'ios', mobileArtifactRef);

rejectText(releasePath, 'require-workflow-success.sh Builds');
rejectText(releasePath, 'artifact-builders');
rejectText(releasePath, 'BUILDS_RUN_ID');
requireText(releasePath, 'Require same-SHA CI build gate');
requireText(releasePath, 'id: ci_build_gate');
requireText(releasePath, 'require-workflow-success.sh CI "$GITHUB_SHA" 7200 --job Builds');
requireText(releasePath, 'CI_RUN_ID: ${{ steps.ci_build_gate.outputs.run_id }}');
requireText(releasePath, '--job Builds');

requireText(wasixDownloadPath, 'CI_RUN_ID');
requireText(wasixDownloadPath, '--required-job Builds');
