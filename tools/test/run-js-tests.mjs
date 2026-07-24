#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

function fail(message) {
  console.error(`run-js-tests: ${message}`);
  process.exit(1);
}

function walk(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, files);
    } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

function jsonArrayEnv(name) {
  const raw = process.env[name];
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((value) => typeof value === 'string')) {
      return parsed;
    }
  } catch {
    // Fall through to the consistent error below.
  }
  fail(`${name} must be a JSON array of strings`);
}

function coverageArgs() {
  if (process.env.OLIPHAUNT_VITEST_COVERAGE !== '1') {
    return [];
  }
  const reportsDir = process.env.OLIPHAUNT_VITEST_COVERAGE_DIR;
  if (!reportsDir) {
    fail('OLIPHAUNT_VITEST_COVERAGE_DIR is required when coverage is enabled');
  }

  const args = [
    '--coverage.enabled=true',
    '--coverage.provider=v8',
    `--coverage.reportsDirectory=${reportsDir}`,
    '--coverage.reporter=text',
    '--coverage.reporter=lcov',
    '--coverage.reporter=json-summary',
    '--coverage.thresholds.branches=0',
    '--coverage.thresholds.functions=0',
    '--coverage.thresholds.statements=0',
  ];

  const lineThreshold = process.env.OLIPHAUNT_VITEST_COVERAGE_LINES;
  if (lineThreshold) {
    args.push(`--coverage.thresholds.lines=${lineThreshold}`);
  }
  for (const pattern of jsonArrayEnv('OLIPHAUNT_VITEST_COVERAGE_INCLUDE')) {
    args.push(`--coverage.include=${pattern}`);
  }
  for (const pattern of jsonArrayEnv('OLIPHAUNT_VITEST_COVERAGE_EXCLUDE')) {
    args.push(`--coverage.exclude=${pattern}`);
  }
  return args;
}

const testRoot = process.argv[2] ?? 'src/__tests__';
const absoluteRoot = path.resolve(process.cwd(), testRoot);
if (!existsSync(absoluteRoot) || !statSync(absoluteRoot).isDirectory()) {
  fail(`test directory does not exist: ${testRoot}`);
}

const tests = walk(absoluteRoot).sort((left, right) => left.localeCompare(right));
if (tests.length === 0) {
  fail(`no *.test.ts files discovered under ${testRoot}`);
}

const relativeTests = tests.map((test) => path.relative(process.cwd(), test));
const vitestArgs = [
  'run',
  '--pool=forks',
  '--fileParallelism=false',
  ...coverageArgs(),
  ...relativeTests,
];
console.log(`\n==> vitest ${vitestArgs.join(' ')}`);
const result = spawnSync('pnpm', ['exec', 'vitest', ...vitestArgs], {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
});
if (result.error) {
  fail(`could not run vitest: ${result.error.message}`);
}
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
