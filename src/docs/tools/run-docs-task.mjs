#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const docsRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(scriptDir, '../../..');
const generatedRoot = path.join(repoRoot, 'target', 'docs');
const lockDir = path.join(generatedRoot, '.docs-task.lock');
const lockMetadata = path.join(lockDir, 'owner.json');
const lockTimeoutMs = Number.parseInt(process.env.OLIPHAUNT_DOCS_LOCK_TIMEOUT_MS ?? '120000', 10);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function sleep(milliseconds) {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, milliseconds);
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function removeStaleLock() {
  if (!fs.existsSync(lockDir)) {
    return false;
  }
  try {
    if (fs.existsSync(lockMetadata)) {
      const metadata = JSON.parse(fs.readFileSync(lockMetadata, 'utf8'));
      if (!processIsAlive(metadata.pid)) {
        fs.rmSync(lockDir, { force: true, recursive: true });
        return true;
      }
      return false;
    }
    const stat = fs.statSync(lockDir);
    if (Date.now() - stat.mtimeMs > lockTimeoutMs) {
      fs.rmSync(lockDir, { force: true, recursive: true });
      return true;
    }
  } catch {
    fs.rmSync(lockDir, { force: true, recursive: true });
    return true;
  }
  return false;
}

function acquireLock() {
  fs.mkdirSync(generatedRoot, { recursive: true });
  const started = Date.now();
  while (Date.now() - started <= lockTimeoutMs) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(
        lockMetadata,
        `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2)}\n`,
      );
      return () => fs.rmSync(lockDir, { force: true, recursive: true });
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }
      removeStaleLock();
      sleep(100);
    }
  }
  fail(`timed out waiting for docs generation lock: ${path.relative(repoRoot, lockDir)}`);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: docsRoot,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) {
    fail(`could not run ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const task = process.argv[2];
const fumadocsMdx = ['pnpm', ['exec', 'fumadocs-mdx']];
const checkFumadocsSource = ['node', ['tools/check-fumadocs-source.mjs']];
const tasks = {
  generate: [['node', ['tools/generate-content.mjs']], fumadocsMdx, checkFumadocsSource],
  check: [
    ['node', ['tools/check-docs-product.mjs']],
    fumadocsMdx,
    checkFumadocsSource,
    ['pnpm', ['exec', 'next', 'typegen']],
    fumadocsMdx,
    checkFumadocsSource,
    ['pnpm', ['exec', 'tsc', '--noEmit']],
  ],
  build: [
    ['node', ['tools/check-docs-product.mjs']],
    fumadocsMdx,
    checkFumadocsSource,
    ['pnpm', ['exec', 'next', 'build']],
    fumadocsMdx,
    checkFumadocsSource,
    ['node', ['tools/publish-next-export.mjs']],
  ],
  'release-check': [['node', ['tools/check-docs-product.mjs', '--release']]],
};

if (!Object.hasOwn(tasks, task)) {
  fail(`usage: node tools/run-docs-task.mjs ${Object.keys(tasks).join('|')}`);
}

const releaseLock = acquireLock();
try {
  for (const [command, args] of tasks[task]) {
    run(command, args);
  }
} finally {
  releaseLock();
}
