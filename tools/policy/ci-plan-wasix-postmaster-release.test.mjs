import assert from 'node:assert/strict';
import path from 'node:path';
import {test} from 'node:test';

import {captureCommandOutput} from '../dev/capture-command-output.mjs';
import {moonCommand} from '../dev/moon-command.mjs';
import {affectedNames, triggeringProjectNames} from '../graph/affected.mjs';
import {
  CI_JOB_TARGETS,
  planJobsForAffected,
  renderPlanWithSelection,
} from '../graph/ci_plan.mjs';
import {buildPlan, loadGraph, normalizeFiles} from '../release/release-graph.mjs';

const ROOT = path.resolve(import.meta.dir, '../..');

test('postmaster CI selects only terminal product roots', () => {
  assert.deepEqual(CI_JOB_TARGETS['wasix-postmaster'], [
    'liboliphaunt-wasix-postmaster:aggregate-release-assets',
    'liboliphaunt-wasix-postmaster:portable-inputs',
    'liboliphaunt-wasix-postmaster:release-assets',
  ]);
});

test('postmaster planner renders every supported release target', () => {
  const plan = renderPlanWithSelection({
    jobs: new Set(['affected', 'wasix-postmaster']),
    projects: new Set(),
    tasks: new Set(CI_JOB_TARGETS['wasix-postmaster']),
    reason: 'postmaster planner fixture',
    selectedTargets: null,
    selectedExtensionProducts: new Set(),
  });
  assert.deepEqual(
    plan.liboliphaunt_wasix_postmaster_runtime_matrix.include.map(
      ({target_id}) => target_id,
    ),
    [
      'linux-arm64-gnu',
      'linux-x64-gnu',
      'macos-arm64',
    ],
  );

  const planWithoutPostmaster = renderPlanWithSelection({
    jobs: new Set(['affected']),
    projects: new Set(),
    tasks: new Set(),
    reason: 'non-postmaster planner fixture',
    selectedTargets: null,
    selectedExtensionProducts: new Set(),
  });
  assert.deepEqual(
    planWithoutPostmaster.liboliphaunt_wasix_postmaster_runtime_matrix,
    {include: []},
  );
});

test('postmaster source preparation waits for the shared source fetch', () => {
  const environment = {...process.env, MOON_CACHE: 'off'};
  const result = captureCommandOutput(
    moonCommand(environment),
    [
      'query',
      'tasks',
      '--project',
      'liboliphaunt-wasix-postmaster',
      '--id',
      'prepare-postgres',
    ],
    {
      cwd: ROOT,
      env: environment,
      label: 'Moon WASIX postmaster prepare-postgres dependency graph',
    },
  );
  assert.equal(result.error, undefined, result.error?.message ?? result.stderr);
  assert.equal(result.status, 0, result.stderr);
  const task = JSON.parse(result.stdout).tasks['liboliphaunt-wasix-postmaster'][
    'prepare-postgres'
  ];
  assert.equal(
    task.deps.some(
      ({target}) => target === 'liboliphaunt-wasix-postmaster:source-fetch',
    ),
    true,
  );
});

function directEffects(relativePath) {
  const environment = {...process.env, MOON_CACHE: 'off'};
  delete environment.MOON_BASE;
  delete environment.MOON_HEAD;
  const result = captureCommandOutput(
    moonCommand(environment),
    ['query', 'affected', 'stdin', '--upstream', 'none', '--downstream', 'none'],
    {
      cwd: ROOT,
      env: environment,
      input: `${relativePath}\n`,
      label: `moon WASIX postmaster release fixture ${relativePath}`,
    },
  );
  assert.equal(result.error, undefined, result.error?.message ?? result.stderr);
  assert.equal(result.status, 0, result.stderr);
  const affected = JSON.parse(result.stdout);
  const projects = triggeringProjectNames(affected.projects);
  const tasks = affectedNames(affected.tasks);
  const jobs = [...planJobsForAffected(new Set(projects), new Set(tasks))].sort();
  return {projects, tasks, jobs};
}

function assertReleaseSelection(relativePath) {
  const effects = directEffects(relativePath);
  assert.equal(effects.projects.includes('liboliphaunt-wasix-postmaster'), true);
  assert.equal(effects.jobs.includes('wasix-postmaster'), true);

  const releasePlan = buildPlan(
    loadGraph('ci-plan-wasix-postmaster-release.test.mjs'),
    normalizeFiles([relativePath]),
    'ci-plan-wasix-postmaster-release.test.mjs',
  );
  assert.equal(releasePlan.hasReleaseChanges, true);
  assert.equal(
    releasePlan.releaseProducts.includes('liboliphaunt-wasix-postmaster'),
    true,
  );
}

function assertNativeExtensionLifecycleSelection(relativePath) {
  const effects = directEffects(relativePath);
  assert.equal(
    effects.tasks.includes(
      'release-tools:native-extension-lifecycle-trigger',
    ),
    true,
  );
  assert.equal(effects.jobs.includes('native-extension-lifecycle'), true);
}

test('postmaster source pins select its production builder and release', () => {
  assertReleaseSelection('src/sources/third-party/wasix-postmaster/wasmer.toml');
});

test('postmaster runtime changes select its production builder and release', () => {
  assertReleaseSelection(
    'src/runtimes/liboliphaunt/wasix-postmaster/runtime/capabilities.tsv',
  );
});

test('postmaster aggregate helper remains owned by the product CI graph', () => {
  const effects = directEffects('tools/release/merge-product-release-assets.mjs');
  assert.equal(effects.projects.includes('liboliphaunt-wasix-postmaster'), true);
  assert.equal(effects.tasks.includes(
    'liboliphaunt-wasix-postmaster:aggregate-release-assets',
  ), true);
  assert.equal(effects.jobs.includes('wasix-postmaster'), true);
});

test('native lifecycle runner changes select its exact hosted proof', () => {
  assertNativeExtensionLifecycleSelection(
    'tools/release/run-native-extension-lifecycle-proof.sh',
  );
});

test('native lifecycle supervisor changes select its exact hosted proof', () => {
  assertNativeExtensionLifecycleSelection(
    'src/runtimes/liboliphaunt/wasix-postmaster/lib/process-supervision.sh',
  );
});
