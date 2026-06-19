#!/usr/bin/env bun
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import process from 'node:process';

function workspaceRoot() {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  });
  const root = result.status === 0 && typeof result.stdout === 'string' ? result.stdout.trim() : '';
  if (root) {
    return root;
  }
  const cwd = process.cwd();
  if (cwd) {
    return cwd;
  }
  throw new Error('could not determine workspace root');
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
requireText(
  ciPath,
  "run-name: CI / ${{ github.event_name == 'pull_request' && format('PR {0}', github.event.number) || github.ref_name }}",
  'CI run name must use the top-level pull_request event number',
);
if (/^name: Builds$/m.test(ci)) {
  fail('CI workflow must not be renamed to Builds');
}
requireText(
  ciPath,
  'types: [opened, synchronize, reopened, closed]',
  'CI pull_request trigger must include closed so PR close/merge cancels in-progress PR CI',
);
requireText(
  ciPath,
  "group: ci-${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.event.number || github.ref }}",
  'CI concurrency must group pull_request runs by PR number so closed events cancel the active PR run',
);
assertBlockContains(
  ciBlocks,
  'affected',
  "if: ${{ github.event_name != 'pull_request' || github.event.action != 'closed' }}",
  'closed pull_request events must only cancel the prior run and must not execute CI planning',
);
rejectText(ciPath, 'artifact-builders');
rejectText(ciPath, 'python3 - <<');
if (beforePushTrigger.includes('paths:')) {
  fail('CI pull_request trigger must not use path filters; Moon affected is the source of truth');
}
jobBlock(ciBlocks, 'liboliphaunt-wasix-runtime');
jobBlock(ciBlocks, 'liboliphaunt-wasix-aot');
requireText(ciPath, 'run: bun .github/scripts/write-affected-moon-target-matrices.mjs check test');
requireText(ciPath, 'check_matrix: ${{ steps.target-matrices.outputs.check_matrix }}');
requireText(ciPath, 'policy_matrix: ${{ steps.target-matrices.outputs.policy_matrix }}');
requireText(ciPath, 'test_matrix: ${{ steps.target-matrices.outputs.test_matrix }}');
requireText(ciPath, 'name: Checks / ${{ matrix.target }}');
requireText(ciPath, 'name: Policy / ${{ matrix.target }}');
requireText(ciPath, 'name: Tests / ${{ matrix.target }}');
requireText(ciPath, 'name: E2E / mobile-android');
requireText(ciPath, 'name: E2E / mobile-ios');
requireText(ciPath, 'MOON_TARGET: ${{ matrix.target }}');
requireText(ciPath, 'MOON_UPSTREAM: ${{ matrix.upstream }}');
requireText(ciPath, 'run: .github/scripts/run-moon-targets.sh --upstream "$MOON_UPSTREAM" "$MOON_TARGET"');
requireText(ciPath, 'run: bash src/sdks/react-native/tools/mobile-e2e.sh android');
requireText(ciPath, 'run: bash src/sdks/react-native/tools/mobile-e2e.sh ios');
requireText(ciPath, 'name: react-native-mobile-android-app-android-x86_64');
requireText(ciPath, 'name: react-native-mobile-ios-app');
requireText(ciPath, 'OLIPHAUNT_ANDROID_EMULATOR_API: "35"');
rejectText(ciPath, 'OLIPHAUNT_SKIP_TARGETS_COVERED_BY_PLANNED_JOBS');
assertBlockContains(ciBlocks, 'check-targets', 'matrix: ${{ fromJson(needs.affected.outputs.check_matrix) }}', 'check targets must use the Moon-selected check matrix');
assertBlockContains(ciBlocks, 'policy-targets', 'matrix: ${{ fromJson(needs.affected.outputs.policy_matrix) }}', 'policy targets must use the Moon-selected policy matrix');
assertBlockContains(ciBlocks, 'test-targets', 'matrix: ${{ fromJson(needs.affected.outputs.test_matrix) }}', 'test targets must use the Moon-selected test matrix');
assertBlockContains(ciBlocks, 'checks', 'name: Checks', 'checks job must be named Checks');
assertBlockContains(ciBlocks, 'tests', 'name: Tests', 'tests job must be named Tests');
assertBlockContains(ciBlocks, 'builds', 'name: Builds', 'builds job must be named Builds');
assertBlockContains(ciBlocks, 'e2e', 'name: E2E', 'E2E gate job must be named E2E');
assertBlockContains(
  ciBlocks,
  'check-targets',
  'uses: ./.github/actions/setup-android',
  'check target jobs must set up Android for Kotlin/React Native static checks',
);
assertBlockContains(
  ciBlocks,
  'policy-targets',
  'uses: ./.github/actions/setup-android',
  'policy target jobs must set up Android for cross-repo policy assertions that inspect mobile package metadata',
);
assertBlockContains(
  ciBlocks,
  'test-targets',
  'uses: ./.github/actions/setup-android',
  'test target jobs must set up Android for Kotlin/React Native unit tests',
);
rejectText(
  ciPath,
  'run-moon-ci.sh',
  'checks and tests must select exact affected Moon task ids before calling moon run',
);
assertNeeds(ciBlocks, 'check-targets', ['affected']);
assertNeeds(ciBlocks, 'policy-targets', ['affected']);
assertNeeds(ciBlocks, 'test-targets', ['affected']);
assertNeeds(ciBlocks, 'checks', ['affected', 'check-targets', 'policy-targets']);
assertNeeds(ciBlocks, 'tests', ['affected', 'test-targets']);
assertNeeds(ciBlocks, 'mobile-e2e-android', ['affected', 'mobile-build-android']);
assertNeeds(ciBlocks, 'mobile-e2e-ios', ['affected', 'mobile-build-ios']);
assertNeeds(ciBlocks, 'e2e', ['affected', 'mobile-e2e-android', 'mobile-e2e-ios']);
assertNeeds(ciBlocks, 'required', ['affected', 'release-intent', 'checks', 'tests', 'builds', 'e2e']);
assertBlockContains(
  ciBlocks,
  'checks',
  'bun .github/scripts/check-ci-gate.mjs allow-skipped',
  'checks gate must use the shared Bun CI gate checker',
);
assertBlockContains(
  ciBlocks,
  'tests',
  'bun .github/scripts/check-ci-gate.mjs allow-skipped',
  'tests gate must use the shared Bun CI gate checker',
);
assertBlockContains(
  ciBlocks,
  'builds',
  'bun .github/scripts/check-ci-gate.mjs selected',
  'builds gate must use the shared Bun CI gate checker',
);
assertBlockContains(
  ciBlocks,
  'e2e',
  'bun .github/scripts/check-ci-gate.mjs allow-skipped',
  'E2E gate must use the shared Bun CI gate checker',
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
assertBlockContains(
  ciBlocks,
  'required',
  'REQUIRED_JOBS_JSON: \'["affected","release-intent","checks","tests","builds","e2e"]\'',
  'required gate must include release intent and the E2E phase',
);

for (const job of [
  'affected',
  'check-targets',
  'policy-targets',
  'checks',
  'test-targets',
  'tests',
  'builds',
  'mobile-e2e-android',
  'mobile-e2e-ios',
  'e2e',
  'required',
]) {
  assertCheckoutRef(ciBlocks, job, ciHeadRef);
}

const buildsNeeds = needs(ciBlocks, 'builds');
for (const job of plannedBuildJobs(ci)) {
  if (needs(ciBlocks, job).has('tests')) {
    fail(`${job}.needs must not include the global Tests job; package prerequisites belong in Moon task deps or artifact-specific needs`);
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
requireText(mobilePath, 'OLIPHAUNT_ANDROID_EMULATOR_API: "35"');
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
