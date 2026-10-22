import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// Run only in the throwaway macOS checkout prepared for this diagnostic.
const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  assert.ok(name && ['--out-dir', '--runner-temp'].includes(name) && value && !args.has(name));
  assert.ok(isAbsolute(value), `${name} must be absolute.`);
  args.set(name, value);
}
assert.equal(process.platform, 'darwin');
assert.ok(args.has('--out-dir') && args.has('--runner-temp'));
const output = resolve(args.get('--out-dir')!);
const outputBase = join(resolve(args.get('--runner-temp')!), 'swift-context-bazel');
assert.ok(!existsSync(output) && !existsSync(outputBase), 'Use fresh output and Bazel directories.');
const checkout = process.cwd();
assert.ok(!output.startsWith(`${checkout}/`), 'Keep diagnostic logs outside the checkout.');
mkdirSync(output, { mode: 0o700 });
const helper = join(checkout, 'build_defs/apple/native.bzl');
const original = readFileSync(helper);
const strictPair = '"-Xfrontend", "-strict-implicit-module-context",';
const source = original.toString('utf8');
assert.equal(source.split(strictPair).length, 2, 'The shared helper must contain exactly one strict frontend pair.');
const baseline = source.replace(strictPair, '');
const sha256 = (contents: string | Buffer) => createHash('sha256').update(contents).digest('hex');
const environment: NodeJS.ProcessEnv = {};
for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'DEVELOPER_DIR']) {
  if (process.env[name] !== undefined) environment[name] = process.env[name];
}
const command = [
  'tools/dev/bazel.sh', `--output_base=${outputBase}`, '--host_jvm_args=-Xmx3g',
  'test', '-c', 'opt', '--config=macos-sandbox',
  '--platforms=//build_defs/host:apple_package_macos_arm64',
  '--host_platform=//build_defs/host:native_macos_arm64',
  '--jobs=2', '--local_test_jobs=1', '--test_output=errors', '--lockfile_mode=error',
  '//build_defs/apple:swift_interface_context_test',
];
const observations: Record<string, unknown>[] = [];
const result: Record<string, unknown> = {
  schemaVersion: 1, checkout, command: ['/bin/bash', ...command],
  environmentNames: Object.keys(environment).sort(),
  originalSourceSha256: sha256(original), baselineSourceSha256: sha256(baseline),
  observations, status: 'incomplete',
};
function run(name: string) {
  const stdoutPath = join(output, `${name}.stdout.log`);
  const stderrPath = join(output, `${name}.stderr.log`);
  const stdout = openSync(stdoutPath, 'wx', 0o600);
  const stderr = openSync(stderrPath, 'wx', 0o600);
  const started = performance.now();
  let invocation: ReturnType<typeof spawnSync>;
  try {
    invocation = spawnSync('/bin/bash', command, {
      cwd: checkout, env: environment, stdio: ['ignore', stdout, stderr],
      timeout: 15 * 60_000, killSignal: 'SIGTERM',
    });
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }
  const logs = `${readFileSync(stdoutPath, 'utf8')}\n${readFileSync(stderrPath, 'utf8')}`;
  const observation = {
    name, status: invocation.status, signal: invocation.signal,
    error: invocation.error?.message ?? null, elapsedMs: Math.round(performance.now() - started),
    stdoutSha256: sha256(readFileSync(stdoutPath)), stderrSha256: sha256(readFileSync(stderrPath)),
    missingHeader: /ReactCommon\/CallInvoker\.h[^\n]*(?:file not found|not found)/.test(logs),
    testPassed: /\/\/build_defs\/apple:swift_interface_context_test\s+PASSED\b/.test(logs),
  };
  observations.push(observation);
  return observation;
}
try {
  let negative: ReturnType<typeof run>;
  try {
    writeFileSync(helper, baseline);
    negative = run('old-negative');
  } finally {
    writeFileSync(helper, original);
    const restored = readFileSync(helper);
    result.restoredSourceSha256 = sha256(restored);
    assert.ok(restored.equals(original), 'Restore must preserve the exact original helper bytes.');
  }
  const positive = run('fixed-positive');
  assert.ok(negative.status !== null && negative.status !== 0 && !negative.signal && !negative.error && negative.missingHeader, 'Baseline must fail specifically on the virtual ReactCommon/CallInvoker.h include.');
  assert.ok(positive.status === 0 && !positive.error && positive.testPassed, 'The restored shared helper must pass the same permanent Bazel test.');
  result.status = 'passed';
} catch (error) {
  result.status = 'failed';
  result.failure = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  result.finalSourceSha256 = sha256(readFileSync(helper));
  writeFileSync(join(output, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ status: result.status, output, failure: result.failure ?? null, observations }));
}
