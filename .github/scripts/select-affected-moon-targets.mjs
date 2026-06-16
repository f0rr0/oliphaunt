#!/usr/bin/env bun
import {spawnSync} from 'node:child_process';
import {homedir} from 'node:os';
import {existsSync} from 'node:fs';
import process from 'node:process';

function fail(message) {
  console.error(message);
  process.exit(1);
}

const taskId = process.argv[2] ?? '';
if (!/^[A-Za-z0-9_-]+$/.test(taskId)) {
  fail('usage: select-affected-moon-targets.mjs <task-id>');
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

function moonQueryTasks() {
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
    fail(`moon query tasks failed for task id ${taskId}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    fail(`moon query tasks returned invalid JSON: ${error.message}`);
  }
}

function parseJsonEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`invalid ${name} JSON: ${error.message}`);
  }
}

const upstreamInheritedBuildJobs = new Set([
  'extension-artifacts-native',
  'liboliphaunt-native-desktop',
  'liboliphaunt-native-android',
  'liboliphaunt-native-ios',
  'rust-sdk-package',
  'broker-runtime',
  'node-direct',
  'swift-sdk-package',
  'kotlin-sdk-package',
  'react-native-sdk-package',
  'js-sdk-package',
  'wasix-rust-package',
  'liboliphaunt-wasix-runtime',
]);

function plannedBuildTargetsWithUpstream() {
  if (process.env.OLIPHAUNT_SKIP_TARGETS_COVERED_BY_PLANNED_JOBS !== '1') {
    return [];
  }
  const mapping = parseJsonEnv('OLIPHAUNT_CI_JOB_TARGETS_JSON', {});
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
    fail('OLIPHAUNT_CI_JOB_TARGETS_JSON must be a JSON object when coverage filtering is enabled');
  }
  const targets = [];
  for (const [job, jobTargets] of Object.entries(mapping)) {
    if (!upstreamInheritedBuildJobs.has(job)) {
      continue;
    }
    if (!Array.isArray(jobTargets) || jobTargets.some((target) => typeof target !== 'string')) {
      fail(`CI job ${JSON.stringify(job)} has invalid target list`);
    }
    targets.push(...jobTargets);
  }
  return [...new Set(targets)].sort();
}

function actionGraphTargets(target) {
  const result = spawnSync(moonBin(), ['action-graph', target, '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (result.status !== 0) {
    fail(`moon action-graph failed for ${target}`);
  }
  let graph;
  try {
    graph = JSON.parse(result.stdout);
  } catch (error) {
    fail(`moon action-graph returned invalid JSON for ${target}: ${error.message}`);
  }
  const actions = Array.isArray(graph?.data)
    ? graph.data
    : graph?.data && typeof graph.data === 'object'
      ? Object.values(graph.data)
      : Array.isArray(graph?.actions)
        ? graph.actions
        : null;
  if (!Array.isArray(actions)) {
    fail(`moon action-graph returned invalid action data for ${target}`);
  }
  return actions
    .filter((action) => action?.action === 'run-task')
    .map((action) => action?.params?.target)
    .filter((candidate) => typeof candidate === 'string');
}

function targetsCoveredByPlannedBuilds() {
  const covered = new Set();
  for (const target of plannedBuildTargetsWithUpstream()) {
    for (const graphTarget of actionGraphTargets(target)) {
      const [, graphTaskId = ''] = graphTarget.split(':');
      if (graphTaskId === taskId) {
        covered.add(graphTarget);
      }
    }
  }
  return covered;
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

const coveredTargets = targetsCoveredByPlannedBuilds();
for (const target of [...new Set(targets)].sort()) {
  if (!coveredTargets.has(target)) {
    console.log(target);
  }
}
