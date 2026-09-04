#!/usr/bin/env node
import {appendFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import process from 'node:process';

import {moonCommand, moonEnvironment} from '../../tools/dev/moon-command.mjs';
import {
  groupTargets,
  matrixTarget,
  taskDependencies,
} from './moon-task-capabilities.mjs';

const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;

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
    args.push('--upstream', 'none', '--downstream', 'direct');
  }
  return args;
}

function selectedScopeTaskMap() {
  const result = spawnSync(
    moonCommand(),
    moonQueryTaskArgs(),
    {
      encoding: 'utf8',
      env: moonEnvironment(),
      stdio: ['ignore', 'pipe', 'inherit'],
      maxBuffer: MAX_CAPTURE_BYTES,
    },
  );
  if (result.error !== undefined || result.status !== 0) {
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
    ['task-graph', '--json'],
    {
      encoding: 'utf8',
      env: moonEnvironment(),
      stdio: ['ignore', 'pipe', 'inherit'],
      maxBuffer: MAX_CAPTURE_BYTES,
    },
  );
  if (result.error !== undefined || result.status !== 0) {
    fail('moon task-graph failed for complete task capability metadata');
  }
  let query;
  try {
    query = JSON.parse(result.stdout);
  } catch (error) {
    fail(`moon task-graph returned invalid JSON for complete task capability metadata: ${error.message}`);
  }
  const taskData = query.data;
  if (!taskData || typeof taskData !== 'object') {
    fail('moon task-graph did not return task data for complete task capability metadata');
  }
  const tasks = new Map();
  for (const task of Object.values(taskData)) {
    if (task && typeof task === 'object' && typeof task.target === 'string') {
      tasks.set(task.target, task);
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
const selectedScopeTasks = selectedScopeTaskMap();
const staticTaskIds = new Set([
  'check',
  'compile',
  'format-check',
  'js-format-check',
  'lint',
  'rust-format-check',
  'tools-compile',
]);
const unitTaskIds = new Set(['graph-unit', 'test', 'tools-unit', 'unit']);
const checkTargets = new Map();
const policyTargets = new Map();
const testTargets = new Map();
for (const taskId of taskIds) {
  const taskMap = new Map(
    [...selectedScopeTasks].filter(([, task]) => task.id === taskId),
  );
  const targets = [...taskMap.keys()].sort();
  if (staticTaskIds.has(taskId)) {
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
    continue;
  }
  const matrixTargets = targets.flatMap((target) => {
    const task = taskMap.get(target);
    if (!task) {
      fail(`Moon metadata did not include selected target ${target}`);
    }
    return runsInCI(task) ? [matrixTarget(task, 'deep', completeTasks)] : [];
  });
  if (unitTaskIds.has(taskId)) {
    for (const target of matrixTargets) testTargets.set(target.target, target);
  } else {
    output(`${taskId}_count`, String(matrixTargets.length));
    output(`${taskId}_matrix`, matrix(matrixTargets));
  }
}

const checkGroups = groupTargets([...checkTargets.values()]);
const testGroups = groupTargets([...testTargets.values()]);
output('check_count', String(checkTargets.size));
output('check_job_count', String(checkGroups.length));
output('check_matrix', matrix(checkGroups));
output('policy_count', String(policyTargets.size));
output('policy_matrix', matrix([...policyTargets.values()]));
output(
  'policy_requires_android_sdk',
  String([...policyTargets.values()].some((target) => target.requires_android_sdk)),
);
output(
  'policy_requires_rust',
  String([...policyTargets.values()].some((target) => target.requires_rust)),
);
output(
  'policy_requires_maintainer_tools',
  String([...policyTargets.values()].some((target) => target.requires_maintainer_tools)),
);
output('check_jobs', [
  ...(checkTargets.size > 0 ? ['check-targets'] : []),
  ...(policyTargets.size > 0 ? ['policy-targets'] : []),
]);
output('test_count', String(testTargets.size));
output('test_matrix', matrix(testGroups));
output('test_jobs', testTargets.size > 0 ? ['test-targets'] : []);
