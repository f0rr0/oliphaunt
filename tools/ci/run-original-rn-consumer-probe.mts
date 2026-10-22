import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export const originalRnTargets = [
  '//src/native/sdks/react-native:package_test',
  '//src/native/sdks/react-native:installed_consumer_test',
  '//src/examples/native/react-native-expo:autolinking_consumer_test',
  '//src/examples/native/react-native-expo:ios_installed_test',
];

export function passedRnTargets(logs: string) {
  return originalRnTargets.filter(target => logs.split('\n').some(line =>
    line.startsWith(target) && /^\s+(?:\(cached\)\s+)?PASSED\b/.test(line.slice(target.length))));
}

function main() {
  assert.equal(process.platform, 'darwin');
  const temporary = process.env.RUNNER_TEMP!;
  const snapshot = process.env.OLIPHAUNT_NATIVE_PUBLICATION_INPUTS!;
  assert.ok(temporary && isAbsolute(temporary) && snapshot && isAbsolute(snapshot));
  const checkout = process.cwd();
  const output = join(temporary, 'expo-umbrella-context', 'original-rn-consumer');
  const outputBase = join(temporary, 'expo-umbrella-bazel');
  assert.ok(existsSync(outputBase) && !existsSync(output), 'Reuse only this probe fixture output base.');
  mkdirSync(output, { mode: 0o700 });
  const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'DEVELOPER_DIR']) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  const git = (...args: string[]) => {
    const invocation = spawnSync('git', args, { cwd: checkout, env: environment, encoding: 'utf8' });
    assert.equal(invocation.status, 0);
    return invocation.stdout.trim();
  };
  assert.equal(git('status', '--porcelain', '--untracked-files=all'), '', 'The fixed candidate must be committed and clean.');
  const candidate = { checkout, commit: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}') };
  assert.equal(candidate.commit, process.env.GITHUB_SHA);
  const staged = readFileSync(snapshot);
  const stageProof = JSON.parse(readFileSync(join(temporary, 'expo-umbrella-context', 'original-rn-inputs', 'result.json'), 'utf8'));
  assert.equal(stageProof.status, 'passed');
  assert.equal(stageProof.stagedSnapshot.path, snapshot);
  assert.equal(stageProof.stagedSnapshot.sha256, hash(staged));
  assert.deepEqual(stageProof.candidate, candidate);
  environment.OLIPHAUNT_NATIVE_PUBLICATION_INPUTS = snapshot;
  environment.OLIPHAUNT_MOBILE_CANDIDATE_CHECKOUT = checkout;
  environment.OLIPHAUNT_MOBILE_CANDIDATE_SHA = candidate.commit;
  environment.OLIPHAUNT_MOBILE_CANDIDATE_TREE = candidate.tree;
  assert.equal(environment.OLIPHAUNT_GIT_SOURCE_JSON, undefined);
  const command = [
    'tools/dev/bazel.sh', `--output_base=${outputBase}`, '--host_jvm_args=-Xmx3g',
    'test', '-c', 'opt', '--config=macos-sandbox',
    '--platforms=//build_defs/host:apple_package_macos_arm64',
    '--host_platform=//build_defs/host:native_macos_arm64',
    '--jobs=1', '--local_test_jobs=1', '--test_output=errors', '--lockfile_mode=error',
    `--repo_env=OLIPHAUNT_NATIVE_PUBLICATION_INPUTS=${snapshot}`, ...originalRnTargets,
  ];
  const result: Record<string, unknown> = {
    scope: 'diagnostic-only', admission: false, candidate, originalInputSource: stageProof.source,
    originalRunId: 39712693156, originalRunAttempt: 2, stagedSnapshotSha256: hash(staged),
    command: ['/bin/bash', ...command], environmentNames: Object.keys(environment).sort(), status: 'incomplete',
  };
  const stdoutPath = join(output, 'consumer.stdout.log');
  const stderrPath = join(output, 'consumer.stderr.log');
  const stdout = openSync(stdoutPath, 'wx', 0o600);
  const stderr = openSync(stderrPath, 'wx', 0o600);
  const started = performance.now();
  try {
    let invocation: ReturnType<typeof spawnSync>;
    try {
      invocation = spawnSync('/bin/bash', command, {
        cwd: checkout, env: environment, stdio: ['ignore', stdout, stderr], timeout: 45 * 60_000, killSignal: 'SIGTERM',
      });
    } finally {
      closeSync(stdout);
      closeSync(stderr);
    }
    const stdoutBytes = readFileSync(stdoutPath);
    const stderrBytes = readFileSync(stderrPath);
    const passed = passedRnTargets(`${stdoutBytes.toString()}\n${stderrBytes.toString()}`);
    result.observation = { status: invocation.status, signal: invocation.signal, error: invocation.error?.message ?? null,
      elapsedMs: Math.round(performance.now() - started), stdoutSha256: hash(stdoutBytes), stderrSha256: hash(stderrBytes), passedTargets: passed };
    assert.ok(invocation.status === 0 && !invocation.signal && !invocation.error, 'The original whole RN request must succeed.');
    assert.deepEqual(passed, originalRnTargets, 'All four original RN tests must explicitly pass.');
    assert.equal(git('status', '--porcelain', '--untracked-files=all'), '', 'The fixed candidate must remain clean.');
    result.status = 'passed';
  } catch (error) {
    result.status = 'failed';
    result.failure = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
  } finally {
    const testOutputs = join(checkout, 'bazel-testlogs/src/examples/native/react-native-expo/ios_installed_test/test.outputs');
    if (existsSync(testOutputs)) cpSync(testOutputs, join(output, 'installed-test-outputs'), { recursive: true });
    writeFileSync(join(output, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ status: result.status, output, failure: result.failure ?? null, observation: result.observation }));
  }
}

if (import.meta.main) main();
