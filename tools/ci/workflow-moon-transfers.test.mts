#!/usr/bin/env bun

import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  executionBatches,
  resolveExecution,
} from '../../.github/scripts/resolve-planned-moon-execution.mts';
import { CI_JOB_TARGETS } from './ci_plan.mts';

const ROOT = path.resolve(import.meta.dir, '../..');
const workflow = Bun.YAML.parse(readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8'));
const graphFile = process.env.OLIPHAUNT_MOON_TASK_GRAPH_FILE;
assert.ok(graphFile, 'run through tools/ci/check-workflows.sh');
const tasks = new Map(
  Object.values(JSON.parse(readFileSync(graphFile, 'utf8')).data).map((task) => [
    task.target,
    task,
  ]),
);

if (!process.env.OLIPHAUNT_TRANSFER_FIXTURE_PHASE)
  test('Rust source uploads follow their selected package producers', () => {
    for (const step of workflow.jobs['rust-sdk-package'].steps) {
      if (!step.with?.path?.startsWith('target/sdk-artifacts/')) continue;
      const product = step.with.path.split('/').at(-1);
      assert.equal(
        step.if,
        `\${{ contains(join(fromJson(needs.affected.outputs.job_targets)['rust-sdk-package'], ','), '${product}:') }}`,
      );
    }
  });

if (!process.env.OLIPHAUNT_TRANSFER_FIXTURE_PHASE)
  test('workflow-wide environment does not force product builds during planning', () => {
    for (const task of tasks.values()) {
      for (const input of task.inputs ?? []) {
        if (typeof input !== 'string' || !input.startsWith('$')) continue;
        assert(
          !Object.hasOwn(workflow.env ?? {}, input.slice(1)),
          `${input} affects ${task.target}; scope it to the consuming build job`,
        );
      }
    }
  });

if (!process.env.OLIPHAUNT_TRANSFER_FIXTURE_PHASE)
  test('jobs without a Moon cache have no cacheable local task subtree', () => {
    for (const [id, job] of Object.entries(workflow.jobs)) {
      if (
        !job.steps?.some(
          (step) =>
            step.uses === './.github/actions/setup-moon' && step.with?.['task-cache'] === 'false',
        )
      )
        continue;
      const roots = CI_JOB_TARGETS[id] ?? [];
      if (!roots.length) {
        assert(
          !job.steps.some((step) =>
            /run-(?:planned-moon-job|moon-targets)[.]sh/u.test(step.run ?? ''),
          ),
          `${id} executes unclassified Moon work`,
        );
        continue;
      }
      const transferred = [
        ...new Set(
          job.steps.flatMap((step) =>
            JSON.parse(step.env?.OLIPHAUNT_MOON_TRANSFERRED_DEPS_JSON ?? '[]'),
          ),
        ),
      ];
      const execution = resolveExecution(roots, transferred, tasks);
      assert.deepEqual(
        execution.localDependencies,
        [],
        `${id} has local work that could reuse the cache`,
      );
      // The adapter always executes paths consuming transferred artifacts with
      // MOON_CACHE=off; only localDependencies use normal Moon caching.
      assert.ok(execution.transferred.length > 0, `${id} runs without an artifact boundary`);
    }
    const action = Bun.YAML.parse(
      readFileSync(path.join(ROOT, '.github/actions/setup-moon/action.yml'), 'utf8'),
    );
    assert.equal(action.inputs['task-cache'].default, 'true');
    const cache = action.runs.steps.find((step) => step.uses?.startsWith('actions/cache@'));
    assert.equal(cache.if, `\${{ inputs.task-cache == 'true' }}`);
  });

if (!process.env.OLIPHAUNT_TRANSFER_FIXTURE_PHASE)
  test('artifact production waits for source check and test results without a dependency cycle', () => {
    const jobs = workflow.jobs;
    const sourceJobs = new Set([
      'affected',
      'release-intent',
      'check-targets',
      'policy-targets',
      'test-targets',
      'checks',
      'tests',
    ]);
    const ancestors = (id, visiting = new Set()) => {
      assert(!visiting.has(id), `workflow dependency cycle at ${id}`);
      const chain = new Set([...visiting, id]);
      const result = new Set();
      for (const dependency of [jobs[id].needs ?? []].flat()) {
        assert(jobs[dependency], `${id} requires unknown job ${dependency}`);
        result.add(dependency);
        for (const ancestor of ancestors(dependency, chain)) result.add(ancestor);
      }
      return result;
    };
    for (const [id, job] of Object.entries(jobs)) {
      const dependencies = ancestors(id);
      if (sourceJobs.has(id) || !dependencies.has('affected')) continue;
      assert(dependencies.has('checks'), `${id} can start before source checks`);
      assert(dependencies.has('tests'), `${id} can start before source tests`);
      const direct = [job.needs ?? []].flat();
      if (direct.includes('checks') && direct.includes('tests') && direct.length === 3) {
        // Optional source matrices may be skipped; require the aggregate gate results.
        assert(
          job.if?.startsWith(
            "${{ !cancelled() && needs.affected.result == 'success' && needs.checks.result == 'success' && needs.tests.result == 'success' && ",
          ),
          `${id} must require successful source gates`,
        );
      }
    }
  });

if (!process.env.OLIPHAUNT_TRANSFER_FIXTURE_PHASE)
  test('mandatory artifact consumers check direct producer success explicitly', () => {
    for (const id of [
      'extension-artifacts-native-android',
      'extension-artifacts-wasix',
      'mobile-extension-packages-android',
      'mobile-extension-packages-ios',
      'liboliphaunt-native-release-assets',
      'swift-sdk-package',
      'liboliphaunt-wasix-release-assets',
      'mobile-build-ios',
      'mobile-e2e-ios',
    ]) {
      const job = workflow.jobs[id];
      assert(job.if.startsWith('${{ !cancelled() && '), `${id} can inherit skipped ancestors`);
      for (const dependency of [job.needs].flat()) {
        assert(
          job.if.includes(`needs.${dependency}.result == 'success'`),
          `${id} must require successful ${dependency}`,
        );
      }
      assert(!job.if.includes('needs.*.result'), `${id} relies on wildcard status filtering`);
    }
  });

if (!process.env.OLIPHAUNT_TRANSFER_FIXTURE_PHASE)
  test('WASIX aggregates require successful selected hosts before accepting their artifacts', () => {
    for (const id of ['wasix-napi', 'liboliphaunt-wasix-aot']) {
      for (const host of ['linux', 'other']) {
        assert(
          workflow.jobs[id].if.includes(
            `(fromJson(needs.affected.outputs.liboliphaunt_wasix_aot_runtime_matrix_${host}).include[0] == null || needs.wasix-host-${host}.result == 'success')`,
          ),
          `${id} accepts a skipped selected ${host} host`,
        );
      }
    }
  });

if (!process.env.OLIPHAUNT_TRANSFER_FIXTURE_PHASE)
  test('cross-workflow artifact gates reference existing producer job names', () => {
    const jobNames = Object.values(workflow.jobs).map((job) => job.name);
    for (const file of ['release.yml', 'mobile-e2e.yml']) {
      const consumer = Bun.YAML.parse(
        readFileSync(path.join(ROOT, '.github/workflows', file), 'utf8'),
      );
      for (const job of Object.values(consumer.jobs)) {
        for (const step of job.steps ?? []) {
          const run = String(step.run ?? '');
          if (!/download-build-artifacts[.]sh|require-workflow-success[.]sh/u.test(run)) continue;
          for (const match of run.matchAll(/--job\s+(?:"([^"]+)"|'([^']+)'|([^\s\\]+))/gu)) {
            const name = match[1] ?? match[2] ?? match[3];
            assert.equal(
              jobNames.filter((candidate) => candidate === name).length,
              1,
              `${file}: ${step.name} requires exactly one CI job named ${name}`,
            );
          }
        }
      }
    }
  });

if (!process.env.OLIPHAUNT_TRANSFER_FIXTURE_PHASE)
  test('extension package assembly consumes transferred artifacts without compiler prerequisites', () => {
    const step = workflow.jobs['extension-packages'].steps.find(
      (step) => step.name === 'Assemble exact-extension product packages',
    );
    const execution = resolveExecution(
      ['extension-packages:package'],
      JSON.parse(step.env.OLIPHAUNT_MOON_TRANSFERRED_DEPS_JSON),
      tasks,
    );
    assert.deepEqual(execution.localDependencies, []);
    assert.deepEqual(execution.targets, ['extension-packages:package']);
  });

if (!process.env.OLIPHAUNT_TRANSFER_FIXTURE_PHASE)
  test('WASIX consumers prepare shared inputs before running against transferred SDK artifacts', () => {
    const step = workflow.jobs['wasix-ts-sdk-package'].steps.find(
      (step) => step.name === 'Test WASIX TypeScript consumers',
    );
    const execution = resolveExecution(
      CI_JOB_TARGETS['wasix-ts-sdk-package'],
      JSON.parse(step.env.OLIPHAUNT_MOON_TRANSFERRED_DEPS_JSON),
      tasks,
    );
    // SDK transfers cut off their upstream query build, so every independently
    // selectable consumer must retain its own edge to the shared producer.
    for (const target of CI_JOB_TARGETS['wasix-ts-sdk-package']) {
      for (const dependency of [
        'oliphaunt-query-ts:build',
        'extension-artifacts-wasix:compiler-output',
      ])
        assert(dependencies(target).includes(dependency), `${target} requires ${dependency}`);
    }
    const batches = executionBatches(execution.targets, tasks);
    const seeds = batches.findIndex((batch) => batch.includes('database-resources:package-wasix'));
    assert(seeds >= 0, 'seed packages must be prepared locally from transferred seed outputs');
    for (const target of ['oliphaunt-wasix-ts:test-browser', 'postgres-tools-wasix:test-browser']) {
      for (const dependency of [
        'database-resources:package-wasix',
        'database-resources:package-icu',
      ])
        assert(dependencies(target).includes(dependency), `${target} requires ${dependency}`);
      assert(batches.findIndex((batch) => batch.includes(target)) > seeds, target);
    }
    assert.deepEqual(execution.localDependencies, ['oliphaunt-query-ts:build']);
    for (const target of [...execution.localDependencies, ...execution.targets]) {
      assert(
        ![
          'wasix-browser-host:build',
          'oliphaunt-wasix-ts:build',
          'oliphaunt-wasix-ts:package',
        ].includes(target),
        target,
      );
    }
  });

function dependencies(target) {
  const task = tasks.get(target);
  assert.ok(task, `workflow root ${target} must exist in Moon`);
  return (task.deps ?? [])
    .map((dependency) => (typeof dependency === 'string' ? dependency : dependency.target))
    .filter((target) => {
      const dependency = tasks.get(target);
      return !(
        dependency?.options?.internal &&
        dependency.command === 'noop' &&
        !dependency.script
      );
    });
}

if (!process.env.OLIPHAUNT_TRANSFER_FIXTURE_PHASE)
  test('downloaded Moon dependencies are explicit reachable handoffs', () => {
    const host = Bun.YAML.parse(
      readFileSync(path.join(ROOT, '.github/workflows/wasix-host.yml'), 'utf8'),
    );
    for (const [workflowJob, job] of Object.entries({
      ...workflow.jobs,
      'wasix-host': { ...host.jobs.build, needs: ['liboliphaunt-wasix-runtime'] },
    })) {
      const steps = job.steps ?? [];
      for (const [index, step] of steps.entries()) {
        const run = String(step.run ?? '');
        assert.doesNotMatch(
          run,
          /OLIPHAUNT_MOON_UPSTREAM=none|run-moon-targets[.]sh --upstream none/u,
        );

        const rawTransfers = step.env?.OLIPHAUNT_MOON_TRANSFERRED_DEPS_JSON;
        if (rawTransfers === undefined) continue;
        const plannedJob =
          run.match(/run-planned-moon-job[.]sh ([a-z0-9-]+)/u)?.[1] ??
          (run.includes('collect-wasix-evidence.sh') ? 'wasix-release-regression' : undefined);
        assert.ok(plannedJob, `${workflowJob} transferred handoff must use the planned-job runner`);
        const transfers = JSON.parse(rawTransfers);
        assert.ok(Array.isArray(transfers) && transfers.length > 0);

        let roots = CI_JOB_TARGETS[plannedJob];
        const inlinePlan = step.env?.OLIPHAUNT_CI_JOB_TARGETS_JSON;
        if (typeof inlinePlan === 'string' && inlinePlan.startsWith('{')) {
          roots = JSON.parse(inlinePlan)[plannedJob];
        }
        assert.ok(
          Array.isArray(roots) && roots.length > 0,
          `${plannedJob} must resolve Moon roots`,
        );
        const direct = new Set(roots.flatMap(dependencies));
        const reachable = new Set(direct);
        for (const dependency of reachable) {
          for (const upstream of dependencies(dependency)) reachable.add(upstream);
        }
        for (const transfer of transfers) {
          assert.ok(
            reachable.has(transfer),
            `${workflowJob} transfers unrelated dependency ${transfer}`,
          );
        }
        for (const dependency of direct) {
          if (!transfers.includes(dependency)) {
            assert.notEqual(
              tasks.get(dependency)?.options?.internal,
              true,
              `${workflowJob} cannot directly run internal dependency ${dependency}`,
            );
          }
        }

        assert.ok(
          steps
            .slice(0, index)
            .some(({ uses }) => String(uses ?? '').startsWith('actions/download-artifact@')),
          `${workflowJob} declares transferred dependencies without downloading artifacts`,
        );
        const needs = Array.isArray(job.needs) ? job.needs : [job.needs];
        assert.ok(
          needs.some((need) => need && need !== 'affected'),
          `${workflowJob} has no producer job`,
        );
      }
    }
  });

if (!process.env.OLIPHAUNT_TRANSFER_FIXTURE_PHASE)
  test('SDK runtime suites execute in artifact-consuming jobs without rebuilding their producers', () => {
    for (const [job, roots, forbidden] of [
      [
        'native-consumers',
        [
          'oliphaunt-rust:test-integration',
          'oliphaunt-mobile-bindings:test-native',
          'oliphaunt-swift:test-native',
          'oliphaunt-kotlin:test-native-bindings',
        ],
        [
          'liboliphaunt-native:build-runtime-desktop-target',
          'oliphaunt-broker:build-release-assets',
        ],
      ],
      [
        'wasix-release-regression',
        ['oliphaunt-wasix-rust:test-integration'],
        [
          'liboliphaunt-wasix:compiler-output',
          'liboliphaunt-wasix:runtime-aot',
          'database-resources:build-icu-data',
        ],
      ],
    ]) {
      const step = workflow.jobs[job].steps.find(
        (step) => step.env?.OLIPHAUNT_MOON_TRANSFERRED_DEPS_JSON,
      );
      const available = JSON.parse(step.env.OLIPHAUNT_MOON_TRANSFERRED_DEPS_JSON);
      for (const root of roots) {
        assert(CI_JOB_TARGETS[job].includes(root), `${root} has no executable hosted owner`);
        const reachable = new Set(dependencies(root));
        for (const dependency of reachable)
          for (const parent of dependencies(dependency)) reachable.add(parent);
        const execution = resolveExecution(
          [root],
          available.filter((target) => reachable.has(target)),
          tasks,
        );
        assert(execution.targets.includes(root));
        const executed = [...execution.targets, ...execution.localDependencies];
        for (const target of forbidden)
          assert(!executed.includes(target), `${root} rebuilds ${target}`);
        assert.equal(
          tasks.get(root).options.cache,
          false,
          `${root} must execute against this run's artifacts`,
        );
      }
    }
  });

const phase = process.env.OLIPHAUNT_TRANSFER_FIXTURE_PHASE;
const scratch = process.argv[2];
if (phase) {
  assert.ok(scratch);
  const postmasterRoot = 'target/oliphaunt-wasix-postmaster';
  const nativeFiles = [
    'runtime/build/wasmer-build.receipt',
    'runtime/build/postmaster-executor-build.receipt',
    'runtime/wasmer/target/release/wasmer',
    'runtime/wasmer/target/release/wasmer-headless',
    'runtime/postmaster-executor-target/release/oliphaunt-wasix-postmaster-executor',
    'runtime/postmaster-executor-target/release/oliphaunt-wasix-start-proof',
    'runtime/postmaster-executor-target/release/oliphaunt-wasix-memory-profile',
    'runtime/postmaster-compiler-target/release/oliphaunt-wasix-postmaster-compiler',
  ];
  if (phase === 'prepare') {
    for (const file of nativeFiles) {
      const destination = path.join(scratch, 'postmaster-producer', postmasterRoot, file);
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, file);
      chmodSync(destination, file.endsWith('.receipt') ? 0o644 : 0o755);
    }
    mkdirSync(path.join(scratch, 'postmaster-temp'));
    mkdirSync(path.join(scratch, 'postmaster-consumer', postmasterRoot, 'native-input-download'), {
      recursive: true,
    });
    for (const [job, name, script] of [
      [
        'wasix-postmaster-portable',
        'Pack qualified Linux x64 postmaster runtime',
        'postmaster-produce.sh',
      ],
      [
        'wasix-postmaster-target',
        'Restore qualified Linux x64 postmaster runtime',
        'postmaster-restore.sh',
      ],
    ]) {
      writeFileSync(
        path.join(scratch, script),
        workflow.jobs[job].steps.find((step) => step.name === name).run,
      );
    }
  } else {
    for (const file of nativeFiles) {
      const restored = path.join(scratch, 'postmaster-consumer', postmasterRoot, file);
      assert.equal(readFileSync(restored, 'utf8'), file);
      assert.equal(statSync(restored).mode & 0o777, file.endsWith('.receipt') ? 0o644 : 0o755);
    }
  }
  for (const [platform, title, target] of [
    ['android', 'Android', 'android-x86_64'],
    ['ios', 'iOS', 'ios-xcframework'],
  ]) {
    const staged = path.join(scratch, platform, 'staged');
    const temporary = path.join(scratch, platform, 'temp');
    const host = `target/liboliphaunt-mobile-host/${target}/install/bin`;
    if (phase === 'prepare') {
      mkdirSync(path.join(staged, host), { recursive: true });
      mkdirSync(temporary, { recursive: true });
      writeFileSync(path.join(staged, host, 'initdb'), '#!/bin/sh\necho executable-host-tool\n');
      chmodSync(path.join(staged, host, 'initdb'), 0o755);
      symlinkSync('initdb', path.join(staged, host, 'postgres'));
      writeFileSync(path.join(staged, 'abi-receipt.json'), '{}\n');
      const producer = workflow.jobs[`liboliphaunt-native-${platform}`].steps.find(
        (step) => step.name === 'Preserve native build file modes and symlinks',
      );
      writeFileSync(path.join(scratch, platform, 'produce.sh'), producer.run);
    }
    for (const consumer of [`mobile-build-${platform}`, `liboliphaunt-native-${platform}-abi`]) {
      const cwd = path.join(scratch, consumer);
      const abi = consumer.endsWith('-abi');
      const download = abi ? `target/liboliphaunt-native-ci/${target}` : '.';
      if (phase === 'prepare') {
        mkdirSync(path.join(cwd, download), { recursive: true });
        const restore = workflow.jobs[consumer].steps.find(
          (step) =>
            step.name ===
            (abi ? `Restore ${target} build outputs` : `Restore ${title} native build outputs`),
        );
        assert.ok(restore, consumer);
        writeFileSync(path.join(cwd, 'restore.sh'), restore.run);
      } else if (phase === 'verify') {
        assert.equal(readlinkSync(path.join(cwd, host, 'postgres')), 'initdb');
        assert.ok(existsSync(path.join(cwd, download, 'abi-receipt.json')));
      } else {
        throw new Error('unknown phase');
      }
    }
  }
}
