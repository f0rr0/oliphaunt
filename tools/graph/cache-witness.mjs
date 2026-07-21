#!/usr/bin/env bun
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { moonCommand } from '../dev/moon-command.mjs';
import { captureCommandOutput } from '../dev/capture-command-output.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WITNESS_ROOT = resolve(ROOT, 'target', 'graph', 'cache-witness');
const INPUT = resolve(WITNESS_ROOT, 'input.txt');
const OUTPUT = resolve(WITNESS_ROOT, 'output.txt');
const RUNS = resolve(WITNESS_ROOT, 'runs.txt');

function fail(message) {
  throw new Error(`cache-witness.mjs: ${message}`);
}

async function readRequiredText(path) {
  if (!existsSync(path)) {
    fail(`missing expected file: ${relative(ROOT, path)}`);
  }
  return await readFile(path, 'utf8');
}

async function fixture() {
  const value = (await readRequiredText(INPUT)).trim();
  await mkdir(WITNESS_ROOT, { recursive: true });
  let runs = 0;
  if (existsSync(RUNS)) {
    runs = Number.parseInt((await readFile(RUNS, 'utf8')).trim(), 10);
  }
  runs += 1;
  await writeFile(RUNS, `${runs}\n`, 'utf8');
  await writeFile(OUTPUT, `moon-cache-witness:${value}\n`, 'utf8');
}

function runMoonFixture() {
  const completed = captureCommandOutput(moonCommand(), ['run', 'graph-tools:cache-witness-fixture'], {
    cwd: ROOT,
    label: 'Moon cache witness fixture',
  });
  const output = `${completed.stdout ?? ''}${completed.stderr ?? ''}`;
  if (completed.error !== undefined) {
    fail(`could not start Moon cache fixture: ${completed.error.message}`);
  }
  if (completed.status !== 0) {
    process.stdout.write(output);
    process.exit(completed.status ?? 1);
  }
  return output;
}

async function assertCache() {
  await mkdir(WITNESS_ROOT, { recursive: true });
  const token = randomUUID().replaceAll('-', '');
  await writeFile(INPUT, `${token}\n`, 'utf8');
  await Promise.all([rm(OUTPUT, { force: true }), rm(RUNS, { force: true })]);

  const firstLog = runMoonFixture();
  const expected = `moon-cache-witness:${token}\n`;
  if ((await readRequiredText(OUTPUT)) !== expected) {
    fail('first run did not write the expected fixture output');
  }
  if ((await readRequiredText(RUNS)) !== '1\n') {
    fail('first run did not execute the fixture exactly once');
  }

  await rm(OUTPUT, { force: true });
  const secondLog = runMoonFixture();
  if ((await readRequiredText(OUTPUT)) !== expected) {
    fail('second run did not restore the expected fixture output');
  }
  if ((await readRequiredText(RUNS)) !== '1\n') {
    fail(
      'Moon reran the fixture instead of hydrating the declared output from cache ' +
        '(runs counter changed)',
    );
  }

  console.log('Moon cache witness passed');
  console.log('first run:');
  console.log(firstLog.trimEnd());
  console.log('second run:');
  console.log(secondLog.trimEnd());
}

async function main() {
  const [command] = process.argv.slice(2);
  if (command === 'fixture') {
    await fixture();
    return;
  }
  if (command === 'assert') {
    await assertCache();
    return;
  }
  fail('usage: cache-witness.mjs <fixture|assert>');
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
