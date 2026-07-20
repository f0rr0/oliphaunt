#!/usr/bin/env bun
import {spawnSync} from 'node:child_process';
import process from 'node:process';

import {moonCommand} from '../../tools/dev/moon-command.mjs';

function fail(message) {
  console.error(message);
  process.exit(1);
}

const taskId = process.argv[2] ?? '';
if (!/^[A-Za-z0-9_-]+$/.test(taskId)) {
  fail('usage: select-affected-moon-targets.mjs <task-id>');
}

function useAffectedQuery() {
  return Boolean(process.env.MOON_BASE?.trim() && process.env.MOON_HEAD?.trim());
}

function moonQueryTaskArgs() {
  const args = ['query', 'tasks'];
  if (useAffectedQuery()) {
    args.push('--affected');
  }
  args.push('--id', taskId);
  if (useAffectedQuery()) {
    args.push('--upstream', 'none', '--downstream', 'deep');
  }
  return args;
}

function moonQueryTasks() {
  const result = spawnSync(
    moonCommand(),
    moonQueryTaskArgs(),
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );
  if (result.status !== 0) {
    fail(`moon query tasks failed for task id ${taskId}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    fail(`moon query tasks returned invalid JSON: ${error.message}`);
  }
}

function runsInCI(task) {
  const value = task?.options?.runInCI;
  return value !== false && value !== 'skip';
}

const query = moonQueryTasks();
const tasksByProject = query.tasks;
if (!tasksByProject || typeof tasksByProject !== 'object' || Array.isArray(tasksByProject)) {
  fail('moon query tasks did not return a tasks object');
}

const targets = [];
for (const projectTasks of Object.values(tasksByProject)) {
  if (!projectTasks || typeof projectTasks !== 'object' || Array.isArray(projectTasks)) {
    continue;
  }
  for (const task of Object.values(projectTasks)) {
    if (!task || typeof task !== 'object') {
      continue;
    }
    if (task.id === taskId && typeof task.target === 'string' && runsInCI(task)) {
      targets.push(task.target);
    }
  }
}

for (const target of [...new Set(targets)].sort()) {
  console.log(target);
}
