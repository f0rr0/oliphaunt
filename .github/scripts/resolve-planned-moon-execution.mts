#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import process from 'node:process';

import { plannedTargets } from './select-planned-moon-targets.mts';

function fail(message) {
  console.error(`resolve-planned-moon-execution.mts: ${message}`);
  process.exit(1);
}

function dependencyTargets(task, tasks) {
  return (task?.deps ?? [])
    .map((dependency) => (typeof dependency === 'string' ? dependency : dependency?.target))
    .filter((target) => {
      const dependency = tasks.get(target);
      return (
        typeof target === 'string' &&
        !(dependency?.options?.internal && dependency.command === 'noop' && !dependency.script)
      );
    });
}

export function resolveExecution(targets, transferred, tasks) {
  for (const target of targets) {
    if (!tasks.has(target))
      throw new Error(`selected target ${target} is missing from the Moon task graph`);
  }
  const roots = new Set(targets);
  const transferredSet = new Set(transferred);
  if (transferredSet.size === 0) {
    return { localDependencies: [], targets: [...roots].sort(), transferred: [] };
  }
  const directDependencies = new Set(
    targets.flatMap((target) => dependencyTargets(tasks.get(target), tasks)),
  );
  for (const target of transferredSet) {
    if (!directDependencies.has(target)) {
      throw new Error(
        `transferred dependency ${target} is not a direct dependency of a selected root`,
      );
    }
  }

  const orderedRoots = [];
  const visiting = new Set();
  const ordered = new Set();
  function visit(target) {
    if (transferredSet.has(target) || ordered.has(target)) return;
    if (visiting.has(target)) throw new Error(`task dependency cycle at ${target}`);
    if (!tasks.has(target))
      throw new Error(`dependency ${target} is missing from the Moon task graph`);
    visiting.add(target);
    for (const dependency of dependencyTargets(tasks.get(target), tasks)) visit(dependency);
    visiting.delete(target);
    ordered.add(target);
    if (roots.has(target)) orderedRoots.push(target);
  }
  for (const target of [...roots].sort()) visit(target);

  const localDependencies = [...directDependencies].filter(
    (target) => !transferredSet.has(target) && !roots.has(target),
  );
  const pending = [...localDependencies];
  const visited = new Set();
  while (pending.length > 0) {
    const target = pending.pop();
    if (visited.has(target)) continue;
    visited.add(target);
    if (!tasks.has(target))
      throw new Error(`dependency ${target} is missing from the Moon task graph`);
    if (transferredSet.has(target)) {
      throw new Error(`transferred dependency ${target} is still required by a local prerequisite`);
    }
    if (roots.has(target)) {
      throw new Error(`selected root ${target} is still required by a local prerequisite`);
    }
    pending.push(...dependencyTargets(tasks.get(target), tasks));
  }

  return {
    localDependencies: localDependencies.sort(),
    targets: orderedRoots,
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
  const graph = JSON.parse(readFileSync(process.env.OLIPHAUNT_MOON_TASK_GRAPH_FILE, 'utf8'));
  return new Map(Object.values(graph.data ?? {}).map((task) => [task.target, task]));
}

if (import.meta.main) {
  const job = process.argv[2] ?? '';
  const selectedTarget = process.argv[3];
  if (!job || process.argv.length > 4)
    fail('usage: resolve-planned-moon-execution.mts <job-id> [target]');
  try {
    const planned = plannedTargets(job);
    if (planned.length === 0)
      throw new Error(`CI job ${JSON.stringify(job)} has no planned Moon targets`);
    if (selectedTarget !== undefined && !planned.includes(selectedTarget)) {
      throw new Error(`Moon target ${selectedTarget} is not planned for CI job ${job}`);
    }
    const targets = selectedTarget === undefined ? planned : [selectedTarget];
    const tasks = taskMap();
    const direct = new Set(
      targets.flatMap((target) => dependencyTargets(tasks.get(target), tasks)),
    );
    // Workflows declare available artifacts; a narrowed plan consumes only its own inputs.
    const transferred = parseTransferred().filter((target) => direct.has(target));
    const execution = resolveExecution(targets, transferred, tasks);
    for (const target of execution.localDependencies) console.log(`local\t${target}`);
    for (const target of execution.targets) console.log(`target\t${target}`);
    for (const target of execution.transferred) console.log(`transferred\t${target}`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
