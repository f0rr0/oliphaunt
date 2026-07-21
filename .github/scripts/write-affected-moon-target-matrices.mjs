#!/usr/bin/env bun
import {appendFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import process from 'node:process';

import {moonCommand} from '../../tools/dev/moon-command.mjs';
import {
  matrixTarget,
  shardCheckTargets,
  taskDependencies,
} from './moon-task-capabilities.mjs';

function fail(message) {
  console.error(message);
  process.exit(1);
}

function output(name, value) {
  const rendered = typeof value === 'string' ? value : JSON.stringify(value);
  console.log(`${name}=${rendered}`);
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) {
    appendFileSync(outputPath, `${name}=${rendered}\n`, 'utf8');
  }
}

function useAffectedQuery() {
  return Boolean(process.env.MOON_BASE?.trim() && process.env.MOON_HEAD?.trim());
}

function moonQueryTaskArgs(taskId = '', {affected = useAffectedQuery()} = {}) {
  const args = ['query', 'tasks'];
  if (affected) {
    args.push('--affected');
  }
  if (taskId) {
    args.push('--id', taskId);
  }
  if (affected) {
    args.push('--upstream', 'none', '--downstream', 'deep');
  }
  return args;
}

function targetsForTask(taskId) {
  const result = spawnSync('bun', ['.github/scripts/select-affected-moon-targets.mjs', taskId], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    env: process.env,
  });
  if (result.status !== 0) {
    fail(`failed to select affected Moon ${taskId} targets`);
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function taskMapForTask(taskId) {
  const result = spawnSync(
    moonCommand(),
    moonQueryTaskArgs(taskId),
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );
  if (result.status !== 0) {
    fail(`moon query tasks failed for ${taskId}`);
  }
  let query;
  try {
    query = JSON.parse(result.stdout);
  } catch (error) {
    fail(`moon query tasks returned invalid JSON for ${taskId}: ${error.message}`);
  }
  const tasksByProject = query.tasks;
  if (!tasksByProject || typeof tasksByProject !== 'object' || Array.isArray(tasksByProject)) {
    fail(`moon query tasks did not return a tasks object for ${taskId}`);
  }
  const tasks = new Map();
  for (const projectTasks of Object.values(tasksByProject)) {
    if (!projectTasks || typeof projectTasks !== 'object' || Array.isArray(projectTasks)) {
      continue;
    }
    for (const task of Object.values(projectTasks)) {
      if (task?.id === taskId && typeof task.target === 'string') {
        tasks.set(task.target, task);
      }
    }
  }
  return tasks;
}

function selectedScopeTaskMap() {
  const result = spawnSync(
    moonCommand(),
    moonQueryTaskArgs(),
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );
  if (result.status !== 0) {
    fail('moon query tasks failed for selected-scope tasks');
  }
  let query;
  try {
    query = JSON.parse(result.stdout);
  } catch (error) {
    fail(`moon query tasks returned invalid JSON for selected-scope tasks: ${error.message}`);
  }
  const tasksByProject = query.tasks;
  if (!tasksByProject || typeof tasksByProject !== 'object' || Array.isArray(tasksByProject)) {
    fail('moon query tasks did not return a tasks object for selected-scope tasks');
  }
  const tasks = new Map();
  for (const projectTasks of Object.values(tasksByProject)) {
    if (!projectTasks || typeof projectTasks !== 'object' || Array.isArray(projectTasks)) {
      continue;
    }
    for (const task of Object.values(projectTasks)) {
      if (task && typeof task === 'object' && typeof task.target === 'string') {
        tasks.set(task.target, task);
      }
    }
  }
  return tasks;
}

function allTaskMap() {
  const result = spawnSync(
    moonCommand(),
    moonQueryTaskArgs('', {affected: false}),
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );
  if (result.status !== 0) {
    fail('moon query tasks failed for complete task capability metadata');
  }
  let query;
  try {
    query = JSON.parse(result.stdout);
  } catch (error) {
    fail(`moon query tasks returned invalid JSON for complete task capability metadata: ${error.message}`);
  }
  const tasksByProject = query.tasks;
  if (!tasksByProject || typeof tasksByProject !== 'object' || Array.isArray(tasksByProject)) {
    fail('moon query tasks did not return a tasks object for complete task capability metadata');
  }
  const tasks = new Map();
  for (const projectTasks of Object.values(tasksByProject)) {
    if (!projectTasks || typeof projectTasks !== 'object' || Array.isArray(projectTasks)) {
      continue;
    }
    for (const task of Object.values(projectTasks)) {
      if (task && typeof task === 'object' && typeof task.target === 'string') {
        tasks.set(task.target, task);
      }
    }
  }
  return tasks;
}

function commandText(task) {
  const parts = [];
  if (typeof task?.command === 'string') {
    parts.push(task.command);
  }
  if (Array.isArray(task?.args)) {
    parts.push(...task.args.filter((arg) => typeof arg === 'string'));
  }
  return parts.join(' ').trim();
}

function tags(task) {
  return new Set(Array.isArray(task?.tags) ? task.tags : []);
}

const policyProjectIds = new Set([
  'dev-tools',
  'graph-tools',
  'perf-tools',
  'policy-tools',
  'release-tools',
]);
function projectId(target) {
  return target.split(':', 1)[0] ?? '';
}

function isPolicyTarget(task) {
  const taskTags = tags(task);
  const command = commandText(task);
  return (
    taskTags.has('policy') ||
    taskTags.has('assertion') ||
    command.includes('tools/policy/assertions/assert-') ||
    command.includes('src/extensions/tools/check-extension-') ||
    policyProjectIds.has(projectId(task.target))
  );
}

function isNoopTask(task) {
  return commandText(task) === 'true';
}

function runsInCI(task) {
  const value = task?.options?.runInCI;
  return value !== false && value !== 'skip';
}

function addMatrixTarget(targets, task, upstream, allTasks) {
  const target = task.target;
  const existing = targets.get(target);
  if (!existing || existing.upstream !== 'none') {
    targets.set(target, matrixTarget(task, upstream, allTasks));
  }
}

function classifyTarget(task, targets, allTasks) {
  if (!runsInCI(task)) return;
  if (isPolicyTarget(task)) {
    addMatrixTarget(targets.policy, task, 'none', allTasks);
  } else if (!isNoopTask(task)) {
    addMatrixTarget(targets.check, task, 'deep', allTasks);
  }
}

function classifySelectedTask(task, targets, {selectedScopeTasks, allTasks, visiting = new Set()}) {
  if (!runsInCI(task)) return;
  if (!isNoopTask(task)) {
    classifyTarget(task, targets, allTasks);
    return;
  }
  if (visiting.has(task.target)) {
    fail(`Moon aggregate task cycle through ${task.target}`);
  }
  visiting.add(task.target);
  for (const dependency of taskDependencies(task)) {
    const dependencyTask = selectedScopeTasks.get(dependency);
    if (dependencyTask !== undefined) {
      classifySelectedTask(dependencyTask, targets, {selectedScopeTasks, allTasks, visiting});
    }
  }
  visiting.delete(task.target);
}

function matrix(targets) {
  return {
    include: targets.map((target) => {
      if (typeof target === 'string') {
        return {target, upstream: 'deep'};
      }
      return target;
    }),
  };
}

const taskIds = process.argv.slice(2);
if (taskIds.length === 0 || taskIds.some((taskId) => !/^[A-Za-z0-9_-]+$/.test(taskId))) {
  fail('usage: write-affected-moon-target-matrices.mjs <task-id> [<task-id> ...]');
}

const completeTasks = allTaskMap();
let wroteCheckOutputs = false;
let wrotePolicyOutputs = false;
for (const taskId of taskIds) {
  const targets = targetsForTask(taskId);
  if (taskId === 'check') {
    const taskMap = taskMapForTask(taskId);
    const selectedScopeTasks = selectedScopeTaskMap();
    const checkTargets = new Map();
    const policyTargets = new Map();
    for (const target of targets) {
      const task = taskMap.get(target);
      if (!task) {
        fail(`Moon metadata did not include selected target ${target}`);
      }
      classifySelectedTask(task, {check: checkTargets, policy: policyTargets}, {
        selectedScopeTasks,
        allTasks: completeTasks,
      });
    }
    const checkShards = shardCheckTargets([...checkTargets.values()]);
    output('check_count', String(checkTargets.size));
    output('check_job_count', String(checkShards.length));
    output('check_matrix', matrix(checkShards));
    output('policy_count', String(policyTargets.size));
    output('policy_matrix', matrix([...policyTargets.values()]));
    output(
      'policy_requires_android_sdk',
      String([...policyTargets.values()].some((target) => target.requires_android_sdk)),
    );
    output(
      'policy_requires_maintainer_tools',
      String([...policyTargets.values()].some((target) => target.requires_maintainer_tools)),
    );
    output('check_jobs', [
      ...(checkTargets.size > 0 ? ['check-targets'] : []),
      ...(policyTargets.size > 0 ? ['policy-targets'] : []),
    ]);
    wroteCheckOutputs = true;
    wrotePolicyOutputs = true;
    continue;
  }
  const taskMap = taskMapForTask(taskId);
  const matrixTargets = targets.flatMap((target) => {
    const task = taskMap.get(target);
    if (!task) {
      fail(`Moon metadata did not include selected target ${target}`);
    }
    return runsInCI(task) ? [matrixTarget(task, 'deep', completeTasks)] : [];
  });
  output(`${taskId}_count`, String(matrixTargets.length));
  output(`${taskId}_matrix`, matrix(matrixTargets));
  if (taskId === 'test') {
    output('test_jobs', matrixTargets.length > 0 ? ['test-targets'] : []);
  }
}

if (!wroteCheckOutputs) {
  output('check_count', '0');
  output('check_job_count', '0');
  output('check_matrix', matrix([]));
}
if (!wrotePolicyOutputs) {
  output('policy_count', '0');
  output('policy_matrix', matrix([]));
  output('policy_requires_android_sdk', 'false');
  output('policy_requires_maintainer_tools', 'false');
  output('check_jobs', []);
}
