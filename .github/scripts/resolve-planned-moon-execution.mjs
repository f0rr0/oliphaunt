#!/usr/bin/env bun
import {spawnSync} from 'node:child_process';
import process from 'node:process';

import {moonCommand, moonEnvironment} from '../../tools/dev/moon-command.mjs';
import {plannedTargets} from './select-planned-moon-targets.mjs';

function fail(message) {
  console.error(`resolve-planned-moon-execution.mjs: ${message}`);
  process.exit(1);
}

function dependencyTargets(task) {
  return (task?.deps ?? [])
    .map((dependency) => typeof dependency === 'string' ? dependency : dependency?.target)
    .filter((target) => typeof target === 'string');
}

export function resolveExecution(targets, transferred, tasks) {
  for (const target of targets) {
    if (!tasks.has(target)) throw new Error(`selected target ${target} is missing from the Moon task graph`);
  }
  const roots = new Set(targets);
  const transferredSet = new Set(transferred);
  if (transferredSet.size === 0) {
    return {localDependencies: [], targets: [...roots].sort(), transferred: []};
  }
  const directDependencies = new Set(
    targets.flatMap((target) => dependencyTargets(tasks.get(target))),
  );
  for (const target of transferredSet) {
    if (!directDependencies.has(target)) {
      throw new Error(`transferred dependency ${target} is not a direct dependency of a selected root`);
    }
  }

  const localDependencies = [...directDependencies].filter((target) => !transferredSet.has(target));
  const pending = [...localDependencies];
  const visited = new Set();
  while (pending.length > 0) {
    const target = pending.pop();
    if (visited.has(target)) continue;
    visited.add(target);
    if (!tasks.has(target)) throw new Error(`dependency ${target} is missing from the Moon task graph`);
    if (transferredSet.has(target)) {
      throw new Error(`transferred dependency ${target} is still required by a local prerequisite`);
    }
    pending.push(...dependencyTargets(tasks.get(target)));
  }

  return {
    localDependencies: localDependencies.sort(),
    targets: [...roots].sort(),
    transferred: [...transferredSet].sort(),
  };
}

function parseTransferred() {
  const raw = process.env.OLIPHAUNT_MOON_TRANSFERRED_DEPS_JSON ?? '[]';
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid OLIPHAUNT_MOON_TRANSFERRED_DEPS_JSON: ${error.message}`);
  }
  if (!Array.isArray(value) || value.some((target) => typeof target !== 'string')) {
    throw new Error('OLIPHAUNT_MOON_TRANSFERRED_DEPS_JSON must be a JSON string list');
  }
  return value;
}

function taskMap() {
  const result = spawnSync(moonCommand(), ['task-graph', '--json'], {
    encoding: 'utf8',
    env: moonEnvironment(),
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message ?? `moon task-graph exited ${result.status}`);
  }
  const graph = JSON.parse(result.stdout);
  return new Map(Object.values(graph.data ?? {}).map((task) => [task.target, task]));
}

if (import.meta.main) {
  const job = process.argv[2] ?? '';
  if (!job) fail('usage: resolve-planned-moon-execution.mjs <job-id>');
  try {
    const targets = plannedTargets(job);
    if (targets.length === 0) throw new Error(`CI job ${JSON.stringify(job)} has no planned Moon targets`);
    const execution = resolveExecution(targets, parseTransferred(), taskMap());
    for (const target of execution.localDependencies) console.log(`local\t${target}`);
    for (const target of execution.targets) console.log(`target\t${target}`);
    for (const target of execution.transferred) console.log(`transferred\t${target}`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
