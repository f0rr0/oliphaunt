#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import process from 'node:process';

import { groupTargets, matrixTarget, taskDependencies } from './moon-task-capabilities.mts';

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

function readQuery(file, label) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`${label} returned invalid JSON: ${error.message}`);
  }
}

function selectedScopeTaskMap() {
  const query = readQuery(process.argv[2], 'moon query tasks');
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
  const query = readQuery(process.argv[3], 'moon task-graph');
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

const policyProjectIds = new Set(['dev-tools', 'perf-tools', 'policy-tools', 'release-tools']);
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

function classifySelectedTask(
  task,
  targets,
  { selectedScopeTasks, allTasks, visiting = new Set() },
) {
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
      classifySelectedTask(dependencyTask, targets, { selectedScopeTasks, allTasks, visiting });
    }
  }
  visiting.delete(task.target);
}

function matrix(targets) {
  return {
    include: targets.map((target) => {
      if (typeof target === 'string') {
        return { target, upstream: 'deep' };
      }
      return target;
    }),
  };
}

if (process.argv.length !== 4) {
  fail('usage: write-affected-moon-target-matrices.mts <selected-tasks.json> <task-graph.json>');
}

const completeTasks = allTaskMap();
const selectedScopeTasks = selectedScopeTaskMap();
const checkTargets = new Map();
const policyTargets = new Map();
const testTargets = new Map();
for (const task of selectedScopeTasks.values()) {
  const taskTags = tags(task);
  if (taskTags.has('coverage') || (taskTags.has('quality') && taskTags.has('unit'))) {
    if (runsInCI(task)) testTargets.set(task.target, matrixTarget(task, 'deep', completeTasks));
  } else if (
    taskTags.has('quality') &&
    ['format', 'smoke', 'static'].some((role) => taskTags.has(role))
  ) {
    classifySelectedTask(
      task,
      { check: checkTargets, policy: policyTargets },
      {
        selectedScopeTasks,
        allTasks: completeTasks,
      },
    );
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
output(
  'policy_requires_workspace',
  String([...policyTargets.values()].some((target) => target.requires_workspace)),
);
output(
  'policy_requires_wasmer_llvm',
  String([...policyTargets.values()].some((target) => target.requires_wasmer_llvm)),
);
output('check_jobs', [
  ...(checkTargets.size > 0 ? ['check-targets'] : []),
  ...(policyTargets.size > 0 ? ['policy-targets'] : []),
]);
output('test_count', String(testTargets.size));
output('test_matrix', matrix(testGroups));
output('test_jobs', testTargets.size > 0 ? ['test-targets'] : []);
