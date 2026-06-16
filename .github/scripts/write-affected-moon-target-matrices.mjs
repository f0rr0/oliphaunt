#!/usr/bin/env bun
import {appendFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
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

const taskIds = process.argv.slice(2);
if (taskIds.length === 0 || taskIds.some((taskId) => !/^[A-Za-z0-9_-]+$/.test(taskId))) {
  fail('usage: write-affected-moon-target-matrices.mjs <task-id> [<task-id> ...]');
}

for (const taskId of taskIds) {
  const targets = targetsForTask(taskId);
  output(`${taskId}_count`, String(targets.length));
  output(`${taskId}_matrix`, {
    include: targets.map((target) => ({target})),
  });
}
