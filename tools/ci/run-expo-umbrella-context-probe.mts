import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

export function withoutUIKitImport(source: string) {
  const imported = '"#import <UIKit/UIKit.h>"';
  assert.equal(source.split(imported).length, 2, 'Disable exactly one generated UIKit import.');
  return source.replace(imported, '"// UIKit import disabled for regression control"');
}

export function withoutClangModuleMapAdmission(source: string) {
  const admission = '["-fmodule-map-file=$(location " + module_map + ")" for module_map in clang_module_maps]';
  assert.equal(source.split(admission).length, 2, 'Disable exactly one explicit Clang module-map admission list.');
  return source.replace(admission, '[]');
}

export function withoutSelectiveCppExposure(source: string) {
  const exposure = '"-Xfrontend", "-clang-header-expose-decls=has-expose-attr",';
  assert.equal(source.split(exposure).length, 2, 'Disable exactly one selective C++ header exposure option pair.');
  return source.replace(exposure, '');
}

export function missingGeneratedCppBaseNamespace(logs: string) {
  const match = logs.match(/(?:^|\n)((?:[^\r\n]*\/)?ExpoUmbrellaMixed-Swift\.h:\d+:\d+):\s+(?:fatal )?error:\s+use of undeclared identifier 'ExpoUmbrellaBase'/);
  return match ? { headerLocation: match[1], namespace: 'ExpoUmbrellaBase' } : undefined;
}

export function aliasModuleHomeMismatch(logs: string) {
  const match = logs.match(/fatal error: module 'AliasFixture_Alias' was built in directory '([^'\r\n]*AliasFixture\.framework)' but now resides in directory '([^'\r\n]*AliasFixture\.framework\/Modules)'/);
  return match ? { builtDirectory: match[1], residentDirectory: match[2] } : undefined;
}

export function missingUmbrellaSymbols(logs: string) {
  const found: Record<'Headerless' | 'Mixed', string[]> = { Headerless: [], Mixed: [] };
  for (const match of logs.matchAll(/\b(Headerless|Mixed)\.swift:\d+:\d+:\s+error:\s+cannot find(?: type)? '(DispatchQueue|UIView)' in scope/g)) {
    const fixture = match[1] as keyof typeof found;
    if (!found[fixture].includes(match[2])) found[fixture].push(match[2]);
  }
  return found;
}

export function expoFixturePassed(logs: string) {
  return /^\/\/build_defs\/apple:expo_umbrella_test[ \t]+(?:\(cached\)[ \t]+)?PASSED\b/m.test(logs);
}

export function retainWarmupProfile(outputBase: string, output: string) {
  try {
    const bytes = readFileSync(join(outputBase, 'command.profile.gz'));
    const path = join(output, 'fixed-warmup.profile.gz');
    writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' });
    return { path, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function main() {
  const args = new Map<string, string>();
  for (let index = 2; index < process.argv.length; index += 2) {
    const name = process.argv[index];
    const value = process.argv[index + 1];
    assert.ok(['--out-dir', '--runner-temp'].includes(name) && value && !args.has(name));
    assert.ok(isAbsolute(value), `${name} must be absolute.`);
    args.set(name, value);
  }
  assert.equal(process.platform, 'darwin');
  assert.ok(args.has('--out-dir') && args.has('--runner-temp'));
  const checkout = process.cwd();
  const output = resolve(args.get('--out-dir')!);
  const outputBase = join(resolve(args.get('--runner-temp')!), 'expo-umbrella-bazel');
  assert.ok(!existsSync(output) && !existsSync(outputBase), 'Use fresh output and Bazel directories.');
  assert.ok(!output.startsWith(`${checkout}/`), 'Keep diagnostic logs outside the checkout.');
  mkdirSync(output, { mode: 0o700 });
  const helper = join(checkout, 'build_defs/apple/native.bzl');
  const original = readFileSync(helper);
  const baseline = withoutUIKitImport(original.toString('utf8'));
  const aliasBaseline = withoutClangModuleMapAdmission(original.toString('utf8'));
  const exposureBaseline = withoutSelectiveCppExposure(original.toString('utf8'));
  const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
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
    '--keep_going', '//build_defs/apple:expo_umbrella_test',
  ];
  const sourceFiles = [
    'build_defs/apple/native.bzl', 'build_defs/apple/BUILD.bazel', '.github/workflows/bazel.yml',
    'src/examples/native/react-native-expo/BUILD.bazel',
    'build_defs/android/native-repository.bzl', 'build_defs/apple/react-native-repository.bzl',
    'src/native/sdks/react-native/tools/expo-runner-ios-installed-app.sh',
    'src/native/sdks/react-native/tools/expo-runner-ios-installed-app.test.sh',
    ...['Headerless.swift', 'Mixed.swift', 'Mixed.h', 'Mixed.m', 'MixedPrivate.h', 'Base.swift', 'Consumer.swift',
      'include/ExpoUmbrellaMixed/Nested.h',
      'AliasFixture.framework/Headers/AliasFixture/Root.h', 'AliasFixture.framework/Headers/AliasFixture_Alias/Alias.h',
      'AliasFixture.framework/Modules/module.modulemap', 'AliasFixture.framework/Info.plist'].map(name => `build_defs/apple/testdata/expo-umbrella/${name}`),
  ];
  const observations: Record<string, unknown>[] = [];
  const result: Record<string, unknown> = {
    schemaVersion: 1, checkout, commit: process.env.GITHUB_SHA ?? null,
    command: ['/bin/bash', ...command], environmentNames: Object.keys(environment).sort(),
    sourceHashes: Object.fromEntries(sourceFiles.map(file => [file, sha256(readFileSync(join(checkout, file)))])),
    probeRunnerSha256: sha256(readFileSync(import.meta.path)),
    originalSourceSha256: sha256(original), baselineSourceSha256: sha256(baseline),
    aliasBaselineSourceSha256: sha256(aliasBaseline),
    exposureBaselineSourceSha256: sha256(exposureBaseline),
    observations, status: 'incomplete',
  };
  function run(name: string, timeoutMs: number) {
    const stdoutPath = join(output, `${name}.stdout.log`);
    const stderrPath = join(output, `${name}.stderr.log`);
    const stdout = openSync(stdoutPath, 'wx', 0o600);
    const stderr = openSync(stderrPath, 'wx', 0o600);
    const startedAt = new Date().toISOString();
    const started = performance.now();
    let invocation: ReturnType<typeof spawnSync>;
    try {
      invocation = spawnSync('/bin/bash', command, {
        cwd: checkout, env: environment, stdio: ['ignore', stdout, stderr],
        timeout: timeoutMs, killSignal: 'SIGTERM',
      });
    } finally {
      closeSync(stdout);
      closeSync(stderr);
    }
    const logs = `${readFileSync(stdoutPath, 'utf8')}\n${readFileSync(stderrPath, 'utf8')}`;
    const observation = {
      name, startedAt, completedAt: new Date().toISOString(),
      status: invocation.status, signal: invocation.signal, error: invocation.error?.message ?? null,
      elapsedMs: Math.round(performance.now() - started), timeoutMs,
      stdoutSha256: sha256(readFileSync(stdoutPath)), stderrSha256: sha256(readFileSync(stderrPath)),
      missingSymbols: missingUmbrellaSymbols(logs),
      aliasModuleHomeMismatch: aliasModuleHomeMismatch(logs) ?? null,
      missingGeneratedCppBaseNamespace: missingGeneratedCppBaseNamespace(logs) ?? null,
      testPassed: expoFixturePassed(logs),
    };
    observations.push(observation);
    return observation;
  }
  try {
    const warmup = run('fixed-warmup', 17 * 60_000);
    result.warmupProfile = retainWarmupProfile(outputBase, output);
    assert.ok(warmup.status === 0 && !warmup.signal && !warmup.error && warmup.testPassed,
      'The unchanged fixed helper must pass before disabling its UIKit import.');
    let negative: ReturnType<typeof run>;
    try {
      writeFileSync(helper, baseline);
      negative = run('uikit-import-disabled', 3 * 60_000);
    } finally {
      writeFileSync(helper, original);
      const restored = readFileSync(helper);
      result.restoredSourceSha256 = sha256(restored);
      assert.ok(restored.equals(original), 'Restore the exact original helper before the module-map control.');
    }
    let aliasNegative: ReturnType<typeof run>;
    try {
      writeFileSync(helper, aliasBaseline);
      aliasNegative = run('clang-module-map-admission-disabled', 3 * 60_000);
    } finally {
      writeFileSync(helper, original);
      const restored = readFileSync(helper);
      result.aliasRestoredSourceSha256 = sha256(restored);
      assert.ok(restored.equals(original), 'Restore the exact original helper after the module-map control.');
    }
    let exposureNegative: ReturnType<typeof run>;
    try {
      writeFileSync(helper, exposureBaseline);
      exposureNegative = run('selective-cpp-exposure-disabled', 3 * 60_000);
    } finally {
      writeFileSync(helper, original);
      const restored = readFileSync(helper);
      result.exposureRestoredSourceSha256 = sha256(restored);
      assert.ok(restored.equals(original), 'Restore the exact original helper after the C++ header exposure control.');
    }
    const positive = run('fixed-positive', 3 * 60_000);
    assert.ok(negative.status !== null && negative.status !== 0 && !negative.signal && !negative.error &&
      negative.missingSymbols.Headerless.length > 0 && negative.missingSymbols.Mixed.length > 0,
    'Disabling the UIKit import must fail on missing DispatchQueue or UIView in both Swift fixtures.');
    assert.ok(aliasNegative.status !== null && aliasNegative.status !== 0 && !aliasNegative.signal && !aliasNegative.error &&
      aliasNegative.aliasModuleHomeMismatch,
    'Disabling explicit map admission must fail on AliasFixture_Alias moving from the framework directory to Modules.');
    assert.ok(exposureNegative.status !== null && exposureNegative.status !== 0 && !exposureNegative.signal && !exposureNegative.error &&
      exposureNegative.missingGeneratedCppBaseNamespace,
    'Disabling selective C++ exposure must fail on undeclared ExpoUmbrellaBase in the generated Mixed header.');
    assert.ok(positive.status === 0 && !positive.signal && !positive.error && positive.testPassed,
      'The exact restored helper must pass the same permanent iOS build test.');
    result.status = 'passed';
  } catch (error) {
    result.status = 'failed';
    result.failure = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
  } finally {
    writeFileSync(helper, original);
    const final = readFileSync(helper);
    result.finalSourceSha256 = sha256(final);
    result.finalSourceRestored = final.equals(original);
    assert.ok(result.finalSourceRestored, 'The physical helper must be restored.');
    writeFileSync(join(output, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ status: result.status, output, failure: result.failure ?? null, observations }));
  }
}

if (import.meta.main) main();
