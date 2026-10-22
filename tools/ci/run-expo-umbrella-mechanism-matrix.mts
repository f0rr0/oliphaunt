import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

type ProbeCase = { id: string; cxx: 'default' | 'off'; sourceImport?: boolean; guarded?: boolean; exportAll?: boolean; frontendImport?: boolean };
export const matrixCases: ProbeCase[] = [
  { id: 'source-import-uikit-cxx-default', cxx: 'default', sourceImport: true },
  { id: 'bare-cxx-default', cxx: 'default' },
  { id: 'guarded-noexport-cxx-default', cxx: 'default', guarded: true, exportAll: false },
  { id: 'guarded-export-cxx-default', cxx: 'default', guarded: true, exportAll: true },
  { id: 'unguarded-noexport-cxx-default', cxx: 'default', guarded: false, exportAll: false },
  { id: 'unguarded-export-cxx-default', cxx: 'default', guarded: false, exportAll: true },
  { id: 'guarded-noexport-cxx-off', cxx: 'off', guarded: true, exportAll: false },
  { id: 'guarded-export-cxx-off', cxx: 'off', guarded: true, exportAll: true },
  { id: 'frontend-uikit-cxx-default', cxx: 'default', frontendImport: true },
];

export function swiftArguments(probe: ProbeCase, sdk: string, directory: string) {
  return [
    '-emit-module', '-parse-as-library', '-module-name', 'AmbientPod', '-swift-version', '5',
    '-sdk', sdk, '-target', 'arm64-apple-ios17.0-simulator',
    '-module-cache-path', join(directory, 'swift-cache'),
    '-Xcc', `-fmodules-cache-path=${join(directory, 'clang-cache')}`,
    '-emit-module-path', join(directory, 'AmbientPod.swiftmodule'),
    `-cxx-interoperability-mode=${probe.cxx}`,
    ...(probe.cxx === 'default' ? ['-Xcc', '-std=c++20'] : []),
    ...(probe.guarded === undefined ? [] : ['-import-underlying-module', '-Xcc', `-fmodule-map-file=${join(directory, 'module.modulemap')}`, `-I${directory}`]),
    ...(probe.frontendImport ? ['-Xfrontend', '-import-module', '-Xfrontend', 'UIKit'] : []),
    join(directory, 'Headerless.swift'),
  ];
}

export function missingNames(logs: string) {
  return [...new Set([...logs.matchAll(/error:\s+cannot find(?: type)? '(DispatchQueue|UIView)' in scope/g)].map(match => match[1]))].sort();
}

function main() {
  assert.equal(process.platform, 'darwin');
  const temporary = process.env.RUNNER_TEMP!;
  assert.ok(temporary && isAbsolute(temporary));
  const output = join(temporary, 'expo-umbrella-mechanism');
  const scratch = join(temporary, 'expo-umbrella-mechanism-scratch');
  assert.ok(!existsSync(output) && !existsSync(scratch), 'Use fresh per-probe directories.');
  mkdirSync(output, { mode: 0o700 });
  mkdirSync(scratch, { mode: 0o700 });
  const fixturePath = join(process.cwd(), 'build_defs/apple/testdata/expo-umbrella/Headerless.swift');
  const fixture = readFileSync(fixturePath);
  assert.ok(!/^\s*import\b/m.test(fixture.toString()), 'The common fixture must omit source imports.');
  const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'DEVELOPER_DIR']) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  const observations: any[] = [];
  const result: Record<string, any> = {
    scope: 'diagnostic-only', admission: false, commit: process.env.GITHUB_SHA ?? null,
    fixtureSha256: hash(fixture), runnerSha256: hash(readFileSync(import.meta.path)),
    environmentNames: Object.keys(environment).sort(), expectedXcode: '26.5', expectedSwift: '6.3.2',
    tools: {}, observations, status: 'incomplete',
  };
  function invoke(name: string, command: string, args: string[], timeoutMs: number) {
    const started = performance.now();
    const startedAt = new Date().toISOString();
    const child = spawnSync(command, args, { env: environment, timeout: timeoutMs, killSignal: 'SIGTERM', maxBuffer: 4 * 1024 * 1024 });
    const stdout = child.stdout ?? Buffer.alloc(0);
    const stderr = child.stderr ?? Buffer.alloc(0);
    writeFileSync(join(output, `${name}.stdout.log`), stdout, { mode: 0o600, flag: 'wx' });
    writeFileSync(join(output, `${name}.stderr.log`), stderr, { mode: 0o600, flag: 'wx' });
    return { stdout: stdout.toString(), stderr: stderr.toString(), record: {
      command: [command, ...args], status: child.status, signal: child.signal, error: child.error?.message ?? null,
      startedAt, completedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started), timeoutMs,
      stdoutSha256: hash(stdout), stderrSha256: hash(stderr),
    } };
  }
  function tool(name: string, command: string, args: string[]) {
    const observation = invoke(name, command, args, 10_000);
    result.tools[name] = { ...observation.record, stdout: observation.stdout.trim(), stderr: observation.stderr.trim() };
    assert.ok(observation.record.status === 0 && !observation.record.signal && !observation.record.error, `${name} failed.`);
    return observation.stdout.trim();
  }
  try {
    const xcode = tool('xcode-version', '/usr/bin/xcodebuild', ['-version']);
    assert.match(xcode, /^Xcode 26\.5(?:\r?\n|$)/m);
    const swiftc = tool('swiftc-path', '/usr/bin/xcrun', ['--sdk', 'iphonesimulator', '--find', 'swiftc']);
    assert.ok(isAbsolute(swiftc));
    const version = tool('swift-version', swiftc, ['--version']);
    assert.match(version, /^(?:Apple )?Swift version 6\.3\.2(?:\s|$)/m);
    const sdk = tool('simulator-sdk-path', '/usr/bin/xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path']);
    assert.ok(isAbsolute(sdk));
    result.sdkVersion = tool('simulator-sdk-version', '/usr/bin/xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-version']);
    for (const probe of matrixCases) {
      const directory = join(scratch, probe.id);
      mkdirSync(directory, { mode: 0o700 });
      for (const cache of ['swift-cache', 'clang-cache']) mkdirSync(join(directory, cache), { mode: 0o700 });
      const source = (probe.sourceImport ? 'import UIKit\n\n' : '') + fixture.toString();
      writeFileSync(join(directory, 'Headerless.swift'), source, { mode: 0o600, flag: 'wx' });
      let header: string | null = null;
      let moduleMap: string | null = null;
      if (probe.guarded !== undefined) {
        header = probe.guarded ? '#ifdef __OBJC__\n#import <UIKit/UIKit.h>\n#endif\n' : '#import <UIKit/UIKit.h>\n';
        moduleMap = `module AmbientPod {\n  header "Umbrella.h"\n${probe.exportAll ? '  export *\n' : ''}}\n`;
        writeFileSync(join(directory, 'Umbrella.h'), header, { mode: 0o600, flag: 'wx' });
        writeFileSync(join(directory, 'module.modulemap'), moduleMap, { mode: 0o600, flag: 'wx' });
      }
      const invocation = invoke(probe.id, swiftc, swiftArguments(probe, sdk, directory), 90_000);
      const emitted = join(directory, 'AmbientPod.swiftmodule');
      observations.push({ ...probe, ...invocation.record, sourceSha256: hash(source),
        header, moduleMap, missingNames: missingNames(invocation.stderr),
        diagnostics: invocation.stderr.split('\n').filter(line => line.includes('error:')).slice(0, 20),
        emittedModule: existsSync(emitted) ? { bytes: statSync(emitted).size, sha256: hash(readFileSync(emitted)) } : null });
    }
    assert.ok(observations.every(row => row.status !== null && !row.signal && !row.error), 'Every compiler invocation must complete without timeout or spawn failure.');
    const positive = observations.find(row => row.sourceImport);
    assert.ok(positive.status === 0 && positive.emittedModule?.bytes > 0, 'The explicit UIKit source import must pass as the SDK positive control.');
    const bare = observations.find(row => row.id === 'bare-cxx-default');
    assert.ok(bare.status !== 0 && bare.missingNames.includes('DispatchQueue') && bare.missingNames.includes('UIView'), 'The bare negative must fail on the expected missing names.');
    result.status = 'passed';
  } catch (error) {
    result.status = 'failed';
    result.failure = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
  } finally {
    result.fixtureUnchanged = readFileSync(fixturePath).equals(fixture);
    if (!result.fixtureUnchanged) { result.status = 'failed'; result.failure = 'The repository fixture changed.'; process.exitCode = 1; }
    writeFileSync(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ status: result.status, output, failure: result.failure ?? null,
      observations: observations.map(({ id, status, signal, error, elapsedMs, missingNames }) => ({ id, status, signal, error, elapsedMs, missingNames })) }));
  }
}

if (import.meta.main) main();
