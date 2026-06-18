#!/usr/bin/env bun
import {appendFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {homedir} from 'node:os';
import {existsSync} from 'node:fs';
import process from 'node:process';

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

function moonBin() {
  if (process.env.MOON_BIN) {
    return process.env.MOON_BIN;
  }
  for (const candidate of [
    `${homedir()}/.proto/shims/moon`,
    `${homedir()}/.proto/bin/moon`,
  ]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return 'moon';
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
    moonBin(),
    [
      'query',
      'tasks',
      '--affected',
      '--id',
      taskId,
      '--upstream',
      'none',
      '--downstream',
      'deep',
    ],
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

function affectedTaskMap() {
  const result = spawnSync(
    moonBin(),
    ['query', 'tasks', '--affected', '--upstream', 'none', '--downstream', 'deep'],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );
  if (result.status !== 0) {
    fail('moon query tasks failed for affected tasks');
  }
  let query;
  try {
    query = JSON.parse(result.stdout);
  } catch (error) {
    fail(`moon query tasks returned invalid JSON for affected tasks: ${error.message}`);
  }
  const tasksByProject = query.tasks;
  if (!tasksByProject || typeof tasksByProject !== 'object' || Array.isArray(tasksByProject)) {
    fail('moon query tasks did not return a tasks object for affected tasks');
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

function taskDeps(task) {
  return (Array.isArray(task?.deps) ? task.deps : [])
    .map((dep) => {
      if (typeof dep === 'string') {
        return dep;
      }
      if (dep && typeof dep === 'object' && typeof dep.target === 'string') {
        return dep.target;
      }
      return '';
    })
    .filter(Boolean);
}

function addMatrixTarget(targets, target, upstream) {
  const existing = targets.get(target);
  if (!existing || existing.upstream !== 'none') {
    targets.set(target, {target, upstream});
  }
}

function classifyTarget(task, targets) {
  if (isPolicyTarget(task)) {
    addMatrixTarget(targets.policy, task.target, 'none');
  } else if (!isNoopTask(task)) {
    addMatrixTarget(targets.check, task.target, 'deep');
  }
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

let wrotePolicyOutputs = false;
for (const taskId of taskIds) {
  const targets = targetsForTask(taskId);
  if (taskId === 'check') {
    const taskMap = taskMapForTask(taskId);
    const allAffectedTasks = affectedTaskMap();
    const checkTargets = new Map();
    const policyTargets = new Map();
    for (const target of targets) {
      const task = taskMap.get(target);
      if (!task) {
        fail(`Moon metadata did not include selected target ${target}`);
      }
      if (isNoopTask(task)) {
        for (const dependency of taskDeps(task)) {
          const dependencyTask = allAffectedTasks.get(dependency);
          if (dependencyTask && runsInCI(dependencyTask)) {
            classifyTarget(dependencyTask, {check: checkTargets, policy: policyTargets});
          }
        }
        continue;
      }
      classifyTarget(task, {check: checkTargets, policy: policyTargets});
    }
    output('check_count', String(checkTargets.size));
    output('check_matrix', matrix([...checkTargets.values()]));
    output('policy_count', String(policyTargets.size));
    output('policy_matrix', matrix([...policyTargets.values()]));
    wrotePolicyOutputs = true;
    continue;
  }
  output(`${taskId}_count`, String(targets.length));
  output(`${taskId}_matrix`, matrix(targets));
}

if (!wrotePolicyOutputs) {
  output('policy_count', '0');
  output('policy_matrix', matrix([]));
}
