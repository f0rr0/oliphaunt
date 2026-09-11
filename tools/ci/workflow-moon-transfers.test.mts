#!/usr/bin/env bun

import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
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
      if (direct.includes('checks') && direct.includes('tests') && direct.length === 3)
        assert(
          !/always\(|!cancelled\(/u.test(job.if ?? ''),
          `${id} must require successful source gates`,
        );
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
    for (const [workflowJob, job] of Object.entries(workflow.jobs)) {
      const steps = job.steps ?? [];
      for (const [index, step] of steps.entries()) {
        const run = String(step.run ?? '');
        assert.doesNotMatch(
          run,
          /OLIPHAUNT_MOON_UPSTREAM=none|run-moon-targets[.]sh --upstream none/u,
        );

        const rawTransfers = step.env?.OLIPHAUNT_MOON_TRANSFERRED_DEPS_JSON;
        if (rawTransfers === undefined) continue;
        const plannedJob = run.match(/run-planned-moon-job[.]sh ([a-z0-9-]+)/u)?.[1];
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

const phase = process.env.OLIPHAUNT_TRANSFER_FIXTURE_PHASE;
const scratch = process.argv[2];
if (phase) {
  assert.ok(scratch);
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
