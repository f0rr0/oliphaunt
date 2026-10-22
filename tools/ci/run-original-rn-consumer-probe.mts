import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

function fileIdentity(file: string) {
  const digest = createHash('sha256');
  const descriptor = openSync(file, 'r');
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    for (let count; (count = readSync(descriptor, buffer)) !== 0;) digest.update(buffer.subarray(0, count));
  } finally {
    closeSync(descriptor);
  }
  return { path: file, bytes: statSync(file).size, sha256: digest.digest('hex') };
}

/** Read only the package outputs already constructed by the actual installed-app request. */
export function retainIosLinkDiagnostics(checkout: string, output: string, environment: NodeJS.ProcessEnv) {
  const directory = join(output, 'ios-link-diagnostics');
  mkdirSync(directory, { mode: 0o700 });
  const observations: Record<string, unknown>[] = [];
  const inputs: (ReturnType<typeof fileIdentity> & { retainedAs?: string })[] = [];
  const command = (name: string, executable: string, args: string[], maximumBytes = 1024 * 1024) => {
    const invocation = spawnSync(executable, args, {
      cwd: checkout, env: environment, timeout: 15_000, maxBuffer: maximumBytes,
    });
    const stdout = invocation.stdout ?? Buffer.alloc(0);
    const stderr = invocation.stderr ?? Buffer.alloc(0);
    writeFileSync(join(directory, `${name}.stdout.log`), stdout, { mode: 0o600 });
    writeFileSync(join(directory, `${name}.stderr.log`), stderr, { mode: 0o600 });
    observations.push({ name, command: [executable, ...args], status: invocation.status, signal: invocation.signal,
      error: invocation.error?.message ?? null, capturedStdoutBytes: stdout.length, capturedStdoutSha256: hash(stdout),
      stderrBytes: stderr.length, stderrSha256: hash(stderr), timeoutMs: 15_000, maximumBytes });
    writeFileSync(join(directory, 'commands.json'), `${JSON.stringify(observations, null, 2)}\n`, { mode: 0o600 });
    return invocation;
  };
  const packagePath = 'src/examples/native/react-native-expo';
  const descriptor = join(checkout, 'bazel-bin', packagePath, 'ios_installed_test.inputs.json');
  const application: string = JSON.parse(readFileSync(descriptor, 'utf8')).replay.files.application;
  assert.match(application, /^bazel-out\/[^/]+\/bin\/src\/examples\/native\/react-native-expo\/ios_release\.(?:ipa|zip)$/);
  const archive = join(checkout, application);
  const availableConfigurations = readdirSync(join(checkout, 'bazel-out'), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^[\w.-]+$/.test(entry.name)).map(entry => entry.name).sort();
  const configurations = [...new Set([application.split('/')[1]!, ...availableConfigurations])].slice(0, 64);
  const packageOutputs: Record<string, unknown>[] = [];
  let providerInvocations = 0;
  let retainedParams = 0;
  for (const configuration of configurations) {
    const packageDirectory = join(checkout, 'bazel-out', configuration, 'bin', packagePath);
    if (!existsSync(packageDirectory)) continue;
    const retainedDirectory = join(directory, configuration);
    mkdirSync(retainedDirectory, { mode: 0o700 });
    const provider = join(packageDirectory, 'ios_project', 'ExpoModulesProvider.swift');
    if (existsSync(provider) && statSync(provider).size <= 1024 * 1024) {
      writeFileSync(join(retainedDirectory, 'ExpoModulesProvider.swift'), readFileSync(provider), { mode: 0o600 });
      inputs.push({ ...fileIdentity(provider), retainedAs: `${configuration}/ExpoModulesProvider.swift` });
    }
    const entries = readdirSync(packageDirectory, { withFileTypes: true }).filter(entry => entry.isFile());
    const libraries = entries.filter(entry => /^libios_(?:ExpoModulesProvider|AppDelegate).*\.(?:a|lo)$/.test(entry.name));
    for (const library of libraries) {
      if (providerInvocations >= 4) break;
      const file = join(packageDirectory, library.name);
      inputs.push(fileIdentity(file));
      command(`${configuration}.${library.name}.nm`, '/usr/bin/nm', ['-m', file], 32 * 1024 * 1024);
      providerInvocations += 1;
    }
    const params = entries.filter(entry => /^_?(?:ios_release|libios_(?:ExpoModulesProvider|AppDelegate)).*(?:\.params|\.param|\.objlist|\.(?:link)?filelist)$/.test(entry.name));
    for (const entry of params) {
      if (retainedParams >= 16) break;
      const file = join(packageDirectory, entry.name);
      if (statSync(file).size > 1024 * 1024) continue;
      writeFileSync(join(retainedDirectory, entry.name), readFileSync(file), { mode: 0o600 });
      inputs.push({ ...fileIdentity(file), retainedAs: `${configuration}/${entry.name}` });
      retainedParams += 1;
    }
    packageOutputs.push({ configuration, providerPresent: existsSync(provider), providerLibraries: libraries.map(entry => entry.name),
      linkParamFilesFound: params.map(entry => entry.name) });
  }
  const archiveIdentity = fileIdentity(archive);
  const listing = command('archive-members', '/usr/bin/unzip', ['-Z1', archive]);
  let binary: (ReturnType<typeof fileIdentity> & { archiveMember: string }) | undefined;
  if (listing.status === 0 && !listing.error && !listing.signal) {
    const members = (listing.stdout ?? Buffer.alloc(0)).toString().split('\n').filter(member => /^(?:Payload\/)?reactnativeoliphauntexpo\.app\/reactnativeoliphauntexpo$/.test(member));
    assert.equal(members.length, 1, 'Inspect exactly the original app executable.');
    const temporaryDirectory = mkdtempSync(join(output, '..', '..', 'oliphaunt-ios-link-'));
    const temporaryBinary = join(temporaryDirectory, 'reactnativeoliphauntexpo');
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporaryBinary, 'wx', 0o600);
      const extraction = spawnSync('/usr/bin/unzip', ['-p', archive, members[0]!], {
        cwd: checkout, env: environment, stdio: ['ignore', descriptor, 'pipe'], timeout: 15_000, maxBuffer: 1024 * 1024,
      });
      observations.push({ name: 'extract-app-binary', command: ['/usr/bin/unzip', '-p', archive, members[0]],
        status: extraction.status, signal: extraction.signal, error: extraction.error?.message ?? null,
        stderr: extraction.stderr?.toString() ?? '' });
      writeFileSync(join(directory, 'commands.json'), `${JSON.stringify(observations, null, 2)}\n`, { mode: 0o600 });
      if (extraction.status === 0 && !extraction.error && !extraction.signal) {
        binary = { ...fileIdentity(temporaryBinary), archiveMember: members[0]! };
        command('app.nm', '/usr/bin/nm', ['-m', temporaryBinary], 32 * 1024 * 1024);
        command('app.objc-metadata', '/usr/bin/otool', ['-ov', temporaryBinary], 32 * 1024 * 1024);
        command('app.frameworks', '/usr/bin/otool', ['-L', temporaryBinary]);
      }
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }
  const result = { scope: 'diagnostic-only', admission: false, descriptor, archive: archiveIdentity,
    availableConfigurations, scannedConfigurations: configurations, packageOutputs, inputs, binary, binaryRetained: false,
    limits: { configurations: 64, providerNmCommands: 4, retainedParamFiles: 16, retainedSourceOrParamBytes: 1024 * 1024 }, observations };
  writeFileSync(join(directory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  return result;
}

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
  assert.ok(!existsSync(outputBase) && !existsSync(output), 'Use fresh runtime output and Bazel directories.');
  mkdirSync(output, { mode: 0o700 });
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
        cwd: checkout, env: environment, stdio: ['ignore', stdout, stderr], timeout: 42 * 60_000, killSignal: 'SIGTERM',
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
    try {
      if (existsSync(testOutputs)) cpSync(testOutputs, join(output, 'installed-test-outputs'), { recursive: true });
    } catch (error) {
      result.testOutputRetentionError = error instanceof Error ? error.message : String(error);
    }
    try {
      result.iosLinkDiagnostics = retainIosLinkDiagnostics(checkout, output, environment);
    } catch (error) {
      result.iosLinkDiagnostics = { status: 'unavailable', error: error instanceof Error ? error.message : String(error) };
    }
    writeFileSync(join(output, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ status: result.status, output, failure: result.failure ?? null, observation: result.observation }));
  }
}

if (import.meta.main) main();
