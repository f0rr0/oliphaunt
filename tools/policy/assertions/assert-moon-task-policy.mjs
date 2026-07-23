#!/usr/bin/env bun
import {readFileSync} from 'node:fs';
import process from 'node:process';

import {captureCommandOutput} from '../../dev/capture-command-output.mjs';

function workspaceRoot() {
  const result = captureCommandOutput('git', ['rev-parse', '--show-toplevel'], {
    label: 'git rev-parse --show-toplevel',
  });
  const root = result.status === 0 && typeof result.stdout === 'string' ? result.stdout.trim() : '';
  if (root) {
    return root;
  }
  const cwd = process.cwd();
  if (cwd) {
    return cwd;
  }
  throw new Error('could not determine workspace root');
}

const root = workspaceRoot();
process.chdir(root);

if (process.argv.includes('--help')) {
  console.log('usage: assert-moon-task-policy.mjs');
  process.exit(0);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function read(path) {
  return readFileSync(path, 'utf8');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function taskBlock(path, task) {
  const text = read(path);
  const match = new RegExp(`^  ${escapeRegExp(task)}:\\n`, 'm').exec(text);
  if (!match) {
    fail(`${path} is missing task ${task}`);
  }
  const rest = text.slice(match.index + match[0].length);
  const nextTask = /^  [A-Za-z0-9_-]+:\n/m.exec(rest);
  const end = nextTask ? match.index + match[0].length + nextTask.index : text.length;
  return text.slice(match.index, end);
}

function requireInBlock(block, text, message) {
  if (!block.includes(text)) {
    fail(message);
  }
}

const workflowCheck = taskBlock('.github/moon.yml', 'check');
requireInBlock(
  workflowCheck,
  'cache: true',
  'ci-workflows:check must be cacheable; workflow lint/security checks are deterministic',
);
for (const requiredInput of [
  '/.github/actions/**/*',
  '/.github/scripts/**/*',
  '/.github/workflows/**/*',
  '/.github/zizmor.yml',
  '/tools/policy/check-workflows.sh',
  '/tools/release/toolchain-bootstrap.test.mjs',
]) {
  requireInBlock(
    workflowCheck,
    requiredInput,
    `ci-workflows:check must include ${requiredInput} in its Moon inputs`,
  );
}

for (const [path, dependency, cache] of [
  ['.github/moon.yml', 'ci-workflows:check', 'cache: true'],
  ['tools/release/moon.yml', 'release-tools:check', 'cache: true'],
  ['moon.yml', 'release-tools:check', 'cache: local'],
]) {
  const block = taskBlock(path, 'release-check');
  requireInBlock(block, 'command: "true"', `${path} release-check must be a dependency-only aggregate`);
  requireInBlock(block, `- "${dependency}"`, `${path} release-check must delegate to ${dependency}`);
  requireInBlock(block, cache, `${path} release-check must preserve its deterministic cache policy`);
  if (block.includes('release-check.mjs') || block.includes('check-workflows.sh')) {
    fail(`${path} release-check must not replay its canonical check command`);
  }
}

for (const path of [
  'moon.yml',
  'src/runtimes/liboliphaunt/native/moon.yml',
  'src/sdks/rust/moon.yml',
  'src/sdks/swift/moon.yml',
  'src/sdks/kotlin/moon.yml',
  'src/sdks/react-native/moon.yml',
  'src/sdks/js/moon.yml',
  'src/runtimes/liboliphaunt/wasix/moon.yml',
]) {
  const block = taskBlock(path, 'smoke');
  requireInBlock(block, 'cache: local', `${path} smoke task must use local-only Moon caching`);
  requireInBlock(block, 'inputs:', `${path} smoke task must declare explicit inputs for cache correctness`);
}

for (const path of [
  'moon.yml',
  'tools/perf/moon.yml',
  'src/runtimes/liboliphaunt/native/moon.yml',
  'src/sdks/rust/moon.yml',
  'src/sdks/swift/moon.yml',
  'src/sdks/kotlin/moon.yml',
  'src/sdks/react-native/moon.yml',
  'src/sdks/js/moon.yml',
  'src/bindings/wasix-rust/moon.yml',
]) {
  const block = taskBlock(path, 'bench');
  requireInBlock(block, 'cache: true', `${path} bench task must cache benchmark plan/harness validation`);
  requireInBlock(block, 'inputs:', `${path} bench task must declare explicit benchmark plan inputs`);
  requireInBlock(block, '"/benchmarks/**/*"', `${path} bench task must include benchmark specs in Moon inputs`);
  if (block.includes('run_mobile_footprint_matrix.sh') && !block.includes('--plan-only')) {
    fail(`${path} mobile bench task must be plan-only; measured mobile benchmarks belong in bench-run`);
  }
  if (block.includes('run_native_oliphaunt_matrix.sh') && !block.includes('--plan-only')) {
    fail(`${path} native benchmark matrix bench task must be plan-only; measured benchmarks belong in bench-run`);
  }
}

for (const path of [
  'moon.yml',
  'src/sdks/rust/moon.yml',
  'src/sdks/swift/moon.yml',
  'src/sdks/kotlin/moon.yml',
  'src/sdks/react-native/moon.yml',
  'src/sdks/js/moon.yml',
  'src/bindings/wasix-rust/moon.yml',
]) {
  const block = taskBlock(path, 'bench-run');
  requireInBlock(block, 'cache: false', `${path} bench-run task must stay uncached because it measures the current runtime`);
  requireInBlock(block, 'runInCI: false', `${path} bench-run task must not run in default CI lanes`);
  requireInBlock(block, '"/benchmarks/**/*"', `${path} bench-run task must include benchmark specs in Moon inputs`);
}

const srcGeneratedExcludes = [
  '      - "!/src/**/node_modules/**"',
  '      - "!/src/**/.build/**"',
  '      - "!/src/**/.gradle/**"',
  '      - "!/src/**/.cxx/**"',
  '      - "!/src/**/.next/**"',
  '      - "!/src/**/.source/**"',
  '      - "!/src/**/build/**"',
  '      - "!/src/**/out/**"',
  '      - "!/src/**/Pods/**"',
  '      - "!/src/**/DerivedData/**"',
];

const moonFilesResult = captureCommandOutput('git', ['ls-files', '-z', '*moon.yml'], {
  allowEmptyOutput: true,
  label: 'git ls-files *moon.yml',
  stdoutTerminator: '\0',
});
if (moonFilesResult.error !== undefined || moonFilesResult.status !== 0) {
  fail(moonFilesResult.stderr.trim() || 'failed to list tracked Moon files');
}

for (const path of moonFilesResult.stdout.split('\0').filter(Boolean)) {
  const text = read(path);
  if (text.includes('      - "/src/**/*"')) {
    for (const excluded of srcGeneratedExcludes) {
      if (!text.includes(excluded)) {
        fail(`${path}: broad /src/**/* inputs must exclude generated local state with ${excluded}`);
      }
    }
  }
  if (text.includes('      - "/src/sdks/react-native/**/*"')) {
    for (const excluded of [
      '      - "!/src/sdks/react-native/**/node_modules"',
      '      - "!/src/sdks/react-native/**/node_modules/**"',
    ]) {
      if (!text.includes(excluded)) {
        fail(`${path}: React Native inputs must exclude nested Expo node_modules with ${excluded}`);
      }
    }
  }
}

const ci = read('.github/workflows/ci.yml');
for (const tag of ['mobile-build-android', 'mobile-build-ios']) {
  const expected = `MOON_CACHE=off .github/scripts/run-planned-moon-job.sh ${tag}`;
  if (!ci.includes(expected)) {
    fail(`${tag} CI mobile lane must force live execution through the planned Moon wrapper`);
  }
}
for (const target of [
  'oliphaunt-react-native:mobile-build-android',
  'oliphaunt-react-native:mobile-build-ios',
]) {
  const forbidden = `pnpm moon run ${target} --cache off`;
  if (ci.includes(forbidden)) {
    fail(`${target} CI mobile lane must not bypass .github/scripts/run-moon-targets.sh`);
  }
}
if (ci.includes('pnpm moon run liboliphaunt-wasix:regression --cache off')) {
  fail('CI WASM regression must not bypass .github/scripts/run-moon-targets.sh');
}

const toolingDocs = read('docs/maintainers/tooling.md');
for (const requiredText of [
  'Use `cache: local` for developer smoke tasks',
  'Force live execution for CI/mobile/device proof with `MOON_CACHE=off`',
  'Cache benchmark plan checks, never measured benchmark runs',
]) {
  if (!toolingDocs.includes(requiredText)) {
    fail(`docs/maintainers/tooling.md must document Moon cache policy: ${requiredText}`);
  }
}
