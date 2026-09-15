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
  // Only paths touching an artifact boundary need dependency-free execution.
  // Leave complete local subtrees to Moon so their normal caching still applies.
  const affected = new Map();
  const visiting = new Set();
  const consumed = new Set();
  function visit(target) {
    if (transferredSet.has(target)) {
      consumed.add(target);
      return true;
    }
    if (affected.has(target)) return affected.get(target);
    if (visiting.has(target)) throw new Error(`task dependency cycle at ${target}`);
    if (!tasks.has(target))
      throw new Error(`dependency ${target} is missing from the Moon task graph`);
    visiting.add(target);
    const dependencies = dependencyTargets(tasks.get(target), tasks).map(visit);
    visiting.delete(target);
    const needsIsolation = roots.has(target) || dependencies.some(Boolean);
    affected.set(target, needsIsolation);
    return needsIsolation;
  }
  for (const target of [...roots].sort()) visit(target);
  for (const target of transferredSet) {
    if (!consumed.has(target))
      throw new Error(`transferred dependency ${target} is not reachable from a selected root`);
  }

  const localDependencies = new Set();
  const orderedTargets = new Set();
  function schedule(target) {
    if (transferredSet.has(target) || orderedTargets.has(target)) return;
    if (!affected.get(target)) {
      localDependencies.add(target);
      return;
    }
    for (const dependency of dependencyTargets(tasks.get(target), tasks)) schedule(dependency);
    orderedTargets.add(target);
  }
  for (const target of [...roots].sort()) schedule(target);
  return {
    localDependencies: [...localDependencies].sort(),
    targets: [...orderedTargets],
    transferred: [...consumed].sort(),
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
    const available = new Set(parseTransferred());
    const transferred = new Set();
    const visited = new Set();
    function collect(target) {
      if (visited.has(target)) return;
      visited.add(target);
      if (available.has(target) && !targets.includes(target)) {
        transferred.add(target);
        return;
      }
      for (const dependency of dependencyTargets(tasks.get(target), tasks)) collect(dependency);
    }
    // A narrowed plan consumes reachable artifacts, stopping at each downloaded producer.
    for (const target of targets) collect(target);
    const execution = resolveExecution(targets, transferred, tasks);
    for (const target of execution.localDependencies) console.log(`local\t${target}`);
    for (const target of execution.targets) console.log(`target\t${target}`);
    for (const target of execution.transferred) console.log(`transferred\t${target}`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
