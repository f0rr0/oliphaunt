import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import {
  buildPlan,
  loadGraph,
  normalizeFiles,
} from '../../src/shared/product-metadata/release-graph.mts';
import { affectedNames, triggeringProjectNames, triggeringTaskNames } from '../graph/affected.mts';
import {
  CI_JOB_TARGETS,
  planJobsForAffected,
  renderPlanWithSelection,
  selectedExtensionProductsForPlan,
} from '../graph/ci_plan.mts';
import { moonCommand, moonEnvironment } from '../test/moon-command.mts';

const ROOT = path.resolve(import.meta.dir, '../..');

function taskGraph(target) {
  const environment = { ...process.env, MOON_CACHE: 'off' };
  const result = spawnSync(moonCommand(environment), ['task-graph', target, '--json'], {
    cwd: ROOT,
    env: moonEnvironment(environment),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, result.error?.message ?? result.stderr);
  assert.equal(result.status, 0, result.stderr);
  return Object.values(JSON.parse(result.stdout).data);
}

test('postmaster CI selects only terminal product roots', () => {
  assert.deepEqual(CI_JOB_TARGETS['wasix-postmaster'], [
    'liboliphaunt-wasix-postmaster:finalize-release-assets',
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
    qualificationMode: 'affected',
    qualificationBaseSha: 'base-sha',
    qualificationHeadSha: 'head-sha',
  });
  assert.equal(plan.qualification_mode, 'affected');
  assert.equal(plan.qualification_base_sha, 'base-sha');
  assert.equal(plan.qualification_head_sha, 'head-sha');
  assert.deepEqual(
    plan.liboliphaunt_wasix_postmaster_runtime_matrix.include.map(({ target_id }) => target_id),
    ['linux-arm64-gnu', 'linux-x64-gnu', 'macos-arm64'],
  );

  const planWithoutPostmaster = renderPlanWithSelection({
    jobs: new Set(['affected']),
    projects: new Set(),
    tasks: new Set(),
    reason: 'non-postmaster planner fixture',
    selectedTargets: null,
    selectedExtensionProducts: new Set(),
  });
  assert.deepEqual(planWithoutPostmaster.liboliphaunt_wasix_postmaster_runtime_matrix, {
    include: [],
  });
  assert.equal(planWithoutPostmaster.qualification_mode, 'full-payload');
  assert.equal(planWithoutPostmaster.qualification_base_sha, null);
  assert.equal(planWithoutPostmaster.qualification_head_sha, null);
});

test('postmaster source preparation waits for the shared source fetch', () => {
  const task = taskGraph('liboliphaunt-wasix-postmaster:prepare-postgres').find(
    ({ target }) => target === 'liboliphaunt-wasix-postmaster:prepare-postgres',
  );
  assert.ok(task);
  assert.equal(
    task.deps.some(
      ({ target }) => target === 'source-inputs:source-fetch-wasix-postmaster-runtime',
    ),
    true,
  );
});

test('postmaster production and qualification roots stay separate', () => {
  const patchTests = 'liboliphaunt-wasix-postmaster:runtime-patch-tests';
  const targets = (root) => new Set(taskGraph(root).map(({ target }) => target));
  const portableProduction = targets('liboliphaunt-wasix-postmaster:portable-inputs');
  const targetProduction = targets('liboliphaunt-wasix-postmaster:release-assets');
  assert.equal(portableProduction.has(patchTests), false);
  assert.equal(targetProduction.has(patchTests), false);
  for (const behavior of [
    'liboliphaunt-wasix-postmaster:backend-wave-stress',
    'liboliphaunt-wasix-postmaster:immediate-recovery',
    'liboliphaunt-wasix-postmaster:linear-memory-integration',
  ]) {
    assert.equal(targetProduction.has(behavior), false);
  }
});

function directEffects(relativePath) {
  const environment = { ...process.env, MOON_CACHE: 'off' };
  delete environment.MOON_BASE;
  delete environment.MOON_HEAD;
  const result = spawnSync(
    moonCommand(environment),
    ['query', 'affected', 'stdin', '--upstream', 'none', '--downstream', 'direct'],
    {
      cwd: ROOT,
      env: moonEnvironment(environment),
      input: `${relativePath}\n`,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  assert.equal(result.error, undefined, result.error?.message ?? result.stderr);
  assert.equal(result.status, 0, result.stderr);
  const affected = JSON.parse(result.stdout);
  const projects = triggeringProjectNames(affected.projects);
  const directTasks = triggeringTaskNames(affected.tasks);
  const tasks = affectedNames(affected.tasks);
  const jobs = [...planJobsForAffected(new Set(directTasks))].sort();
  return { projects, directTasks, tasks, jobs };
}

function assertReleaseSelection(relativePath) {
  const effects = directEffects(relativePath);
  assert.equal(effects.projects.includes('liboliphaunt-wasix-postmaster'), true);
  assert.equal(effects.jobs.includes('wasix-postmaster'), true);

  const releasePlan = buildPlan(
    loadGraph('ci-plan-wasix-postmaster-release.test.mts'),
    normalizeFiles([relativePath]),
    'ci-plan-wasix-postmaster-release.test.mts',
  );
  assert.equal(releasePlan.hasReleaseChanges, true);
  assert.equal(releasePlan.releaseProducts.includes('liboliphaunt-wasix-postmaster'), true);
}

function assertNativeExtensionLifecycleSelection(relativePath) {
  const effects = directEffects(relativePath);
  assert.equal(effects.tasks.includes('native-extension-lifecycle:lifecycle'), true);
  assert.equal(effects.jobs.includes('native-extension-lifecycle'), true);
  const jobs = new Set(effects.jobs);
  const projects = new Set(effects.projects);
  const tasks = new Set(effects.directTasks);
  const plan = renderPlanWithSelection({
    jobs,
    projects,
    tasks,
    reason: relativePath,
    selectedTargets: null,
    selectedExtensionProducts: selectedExtensionProductsForPlan(projects, tasks, jobs),
  });
  assert.ok(plan.native_extension_lifecycle_sql_names.includes('vector'));
  const producer = plan.extension_artifacts_native_matrix.include.find(
    (row) => row.target === 'linux-x64-gnu',
  );
  assert.ok(producer, 'the lifecycle runner needs a Linux extension producer');
  for (const name of plan.native_extension_lifecycle_sql_names) {
    assert.ok(producer.sql_names_csv.split(',').includes(name), `${name} needs a producer`);
  }
}

test('postmaster build-input pins select its builder and release', () => {
  assertReleaseSelection('src/sources/third-party/wasix-postmaster/wasmer.toml');
});

test('source fetch unit fixtures do not rebuild product artifacts', () => {
  const effects = directEffects('src/sources/tools/source-fetch-core.test.mts');
  assert.deepEqual(effects.jobs, ['affected']);
  assert.equal(effects.tasks.includes('source-inputs:unit'), true);
  assert.equal(effects.tasks.includes('policy-tools:unit'), false);
  assert.equal(
    effects.tasks.some((target) => target.startsWith('source-inputs:source-fetch-')),
    false,
  );
});

test('source fetch implementation changes retain their real consumers', () => {
  const effects = directEffects('src/sources/tools/source-fetch-core.mts');
  for (const target of [
    'extension-artifacts-native:build-target',
    'liboliphaunt-native:build-runtime-desktop-target',
    'liboliphaunt-wasix-postmaster:prepare-runtime',
    'liboliphaunt-wasix:runtime-portable',
  ]) {
    assert.equal(effects.tasks.includes(target), true, `${target} must consume source fetching`);
  }
});

test('source prose, transport tests, and unrelated toolchains do not rebuild runtimes', () => {
  const cases = [
    ['src/postgres/versions/18/fetch-source.test.sh', 'source-inputs:unit'],
    ['src/runtimes/liboliphaunt/wasix-postmaster/runtime/README.md', null],
    ['src/runtimes/liboliphaunt/wasix-postmaster/runtime/capabilities.tsv', null],
    [
      'src/runtimes/liboliphaunt/wasix-postmaster/runtime/bin/verify-postmaster-concurrency-contract.test.mts',
      'liboliphaunt-wasix-postmaster:unit',
    ],
    ['src/sources/third-party/native/README.md', null],
    ['src/sources/toolchains/maestro.toml', 'ci-workflows:check'],
  ];
  for (const [relativePath, expectedTask] of cases) {
    const effects = directEffects(relativePath);
    if (expectedTask !== null) assert.equal(effects.tasks.includes(expectedTask), true);
    for (const target of [
      'liboliphaunt-native:package-runtime-desktop-target',
      'liboliphaunt-wasix-postmaster:prepare-runtime',
      'liboliphaunt-wasix:runtime-portable',
    ]) {
      assert.equal(
        effects.tasks.includes(target),
        false,
        `${target} does not consume ${relativePath}`,
      );
    }
  }
});

test('runtime shell lint follows executable inputs without documentation gates', () => {
  for (const relativePath of [
    'src/extensions/external/vector/source.toml',
    'src/runtimes/liboliphaunt/wasix/crates/tools/src/lib.rs',
    'src/runtimes/liboliphaunt/wasix/tools/xtask/src/main.rs',
  ]) {
    const effects = directEffects(relativePath);
    assert.equal(effects.tasks.includes('liboliphaunt-wasix:lint'), false);
  }
  assert.equal(
    directEffects(
      'src/runtimes/liboliphaunt/wasix/assets/build/docker/install-pinned-wasixcc.sh',
    ).tasks.includes('liboliphaunt-wasix:lint'),
    true,
  );
  assert.equal(
    directEffects('docs/internal/OLIPHAUNT_PATCH_STACK.md').tasks.includes(
      'liboliphaunt-native:lint',
    ),
    false,
  );
});

test('postmaster runtime changes select its production builder and release', () => {
  assertReleaseSelection(
    'src/runtimes/liboliphaunt/wasix-postmaster/runtime/executor/src/execute.rs',
  );
});

test('postmaster aggregate helper invalidates the product finalizer', () => {
  const effects = directEffects(
    'src/runtimes/liboliphaunt/wasix-postmaster/tools/merge-product-release-assets.mts',
  );
  assert.equal(effects.projects.includes('release-tools'), false);
  assert.equal(effects.projects.includes('liboliphaunt-wasix-postmaster'), true);
  assert.equal(
    effects.tasks.includes('liboliphaunt-wasix-postmaster:finalize-release-assets'),
    true,
  );
  assert.equal(effects.jobs.includes('wasix-postmaster'), true);
});

test('native lifecycle runner changes select its exact hosted proof', () => {
  assertNativeExtensionLifecycleSelection(
    'src/extensions/tests/native/tools/run-native-extension-lifecycle-proof.sh',
  );
});

test('native lifecycle proof source selects its exact hosted proof', () => {
  assertNativeExtensionLifecycleSelection('src/extensions/tests/native/src/main.rs');
});

test('native lifecycle supervisor changes select its exact hosted proof', () => {
  assertNativeExtensionLifecycleSelection(
    'src/runtimes/liboliphaunt/wasix-postmaster/lib/process-supervision.sh',
  );
});
