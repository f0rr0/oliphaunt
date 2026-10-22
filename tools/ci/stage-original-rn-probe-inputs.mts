import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

function main() {
  assert.equal(process.platform, 'darwin');
  const temporary = process.env.RUNNER_TEMP!;
  assert.ok(temporary && isAbsolute(temporary));
  const checkout = process.cwd();
  const output = join(temporary, 'expo-umbrella-context', 'original-rn-inputs');
  const originalCheckout = join(temporary, 'original-rn-source-bbe8b93');
  const archives = join(temporary, 'original-rn-archive-inputs');
  const publicInputs = join(temporary, 'original-public-inputs');
  for (const file of [output, originalCheckout, archives, `${archives}.inputs`]) assert.ok(!existsSync(file));
  assert.ok(!originalCheckout.startsWith(`${checkout}/`));
  assert.ok(process.env.GITHUB_ENV && process.env.GH_TOKEN, 'Authentication needs the step-scoped GitHub token and environment file.');
  mkdirSync(output, { mode: 0o700 });
  const source = { commit: 'bbe8b93614830b68af257e30cfa3bee2bd89b500', tree: 'c295716c95fa0d7475ed28d855ed375022b83fb0' };
  const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'DEVELOPER_DIR']) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  const git = (...args: string[]) => {
    const invocation = spawnSync('git', args, { cwd: checkout, env: environment, encoding: 'utf8' });
    assert.equal(invocation.status, 0, 'Read the actual local Git identity.');
    return invocation.stdout.trim();
  };
  assert.equal(git('status', '--porcelain', '--untracked-files=all'), '', 'The fixed candidate must be committed and clean.');
  const candidate = { checkout, commit: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}') };
  assert.equal(candidate.commit, process.env.GITHUB_SHA);
  assert.equal(git('rev-parse', `${source.commit}^{tree}`), source.tree);
  const observations: Record<string, unknown>[] = [];
  const result: Record<string, unknown> = {
    scope: 'diagnostic-only', admission: false, source, originalRunId: 39712693156, originalRunAttempt: 2,
    originalRunConclusion: 'failure', candidate,
    publicInputArtifact: { id: 12399683430, name: 'native-public-inputs', expectedBytes: 273516782,
      expectedDigest: 'sha256:b9d93cc3adba9ec692f82977fd4ed9e31d57526dfa8b826611e4280321d8e53c',
      integrityBoundary: 'Expected artifact metadata; actual source and File identities are checked by the unmodified old-source importer and producer authenticator' },
    observations, status: 'incomplete',
  };
  function run(name: string, command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeout: number) {
    const stdoutPath = join(output, `${name}.stdout.log`);
    const stderrPath = join(output, `${name}.stderr.log`);
    const stdout = openSync(stdoutPath, 'wx', 0o600);
    const stderr = openSync(stderrPath, 'wx', 0o600);
    const started = performance.now();
    let invocation: ReturnType<typeof spawnSync>;
    try {
      invocation = spawnSync(command, args, { cwd, env, stdio: ['ignore', stdout, stderr], timeout, killSignal: 'SIGTERM' });
    } finally {
      closeSync(stdout);
      closeSync(stderr);
    }
    observations.push({ name, command: [command, ...args], status: invocation.status, signal: invocation.signal,
      error: invocation.error?.message ?? null, elapsedMs: Math.round(performance.now() - started), timeoutMs: timeout,
      environmentNames: Object.keys(env).sort(), stdoutSha256: hash(readFileSync(stdoutPath)), stderrSha256: hash(readFileSync(stderrPath)) });
    assert.ok(invocation.status === 0 && !invocation.signal && !invocation.error, `${name} failed; see retained logs.`);
    return readFileSync(stdoutPath, 'utf8').trim();
  }
  try {
    run('original-worktree', 'git', ['worktree', 'add', '--detach', originalCheckout, source.commit], checkout, environment, 2 * 60_000);
    run('install-locked-tools', '/bin/bash', ['tools/dev/bun.sh', '--no-env-file', 'install', '--frozen-lockfile', '--filter', '@oliphaunt/release-tools', '--ignore-scripts'], originalCheckout, environment, 5 * 60_000);
    const imported = run('import-original-public-inputs', '/bin/bash', ['tools/release/with-source.sh', 'HEAD', 'bash', 'tools/dev/bun.sh', '--no-env-file', 'tools/release/native-release-inputs.mts', '--import-public-inputs', publicInputs], originalCheckout, environment, 3 * 60_000);
    assert.ok(isAbsolute(imported) && imported.startsWith(`${resolve(publicInputs)}/`));
    const before = readFileSync(imported);
    assert.deepEqual(JSON.parse(before.toString()).source, source);
    const consumers = join(output, 'consumer-products.json');
    writeFileSync(consumers, '["oliphaunt-react-native"]\n', { mode: 0o600, flag: 'wx' });
    run('authenticate-original-mobile-producer', '/bin/bash', [
      'tools/release/with-source.sh', 'HEAD', 'bash', 'tools/dev/bun.sh', '--no-env-file', 'tools/release/native-release-preparation.mts',
      '--stage-release-archives', '--run-id', '39712693156', '--ref', 'refs/pull/295/merge',
      '--consumer-products-json', consumers, '--output-directory', archives,
    ], originalCheckout, { ...environment, GH_TOKEN: process.env.GH_TOKEN, GITHUB_ENV: process.env.GITHUB_ENV, OLIPHAUNT_NATIVE_PUBLICATION_INPUTS: imported }, 25 * 60_000);
    assert.ok(readFileSync(imported).equals(before), 'The imported public snapshot must remain unchanged.');
    const stagedFile = `${archives}.inputs/native-publication-inputs.json`;
    const stagedBytes = readFileSync(stagedFile);
    const staged = JSON.parse(stagedBytes.toString());
    assert.deepEqual(staged.source, source);
    for (const row of staged.nativeCurrentArtifacts ?? []) assert.deepEqual(row.source, source);
    const fact = (file: any) => ({ size: file.size, sha256: file.sha256, producer: file.producer, ...(file.member === undefined ? {} : { member: file.member }) });
    result.importedSnapshot = { path: imported, sha256: hash(before), unchanged: true };
    result.stagedSnapshot = { path: stagedFile, sha256: hash(stagedBytes), source: staged.source,
      currentArtifacts: (staged.nativeCurrentArtifacts ?? []).map((row: any) => ({ product: row.product, version: row.version, artifact: row.artifact, source: row.source, file: fact(row.file) })),
      appleBase: staged.nativeAppleBase ? { framework: fact(staged.nativeAppleBase.framework), resources: fact(staged.nativeAppleBase.resources) } : null,
      swiftSource: staged.nativeSwiftSource ? { archive: fact(staged.nativeSwiftSource.archive), carrier: fact(staged.nativeSwiftSource.carrier) } : null };
    result.status = 'passed';
  } catch (error) {
    result.status = 'failed';
    result.failure = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
  } finally {
    writeFileSync(join(output, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ status: result.status, output, failure: result.failure ?? null }));
  }
}

if (import.meta.main) main();
