import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// Private diagnostic. No downloads, project builds, or inherited credentials.
const options = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  assert.ok(['--swiftc', '--out-dir', '--sdk', '--developer-dir'].includes(name ?? ''));
  assert.ok(value && !options.has(name), `Missing or duplicate argument: ${name}`);
  options.set(name, value);
}
assert.equal(process.platform, 'darwin', 'Run this probe on macOS with the pinned Swift 6.3.2 compiler.');
const swiftc = resolve(options.get('--swiftc') ?? '');
const output = resolve(options.get('--out-dir') ?? '');
assert.ok(options.has('--swiftc') && existsSync(swiftc), '--swiftc must name the existing compiler.');
assert.ok(options.has('--out-dir') && !existsSync(output), '--out-dir must be a new private directory.');
mkdirSync(output, { mode: 0o700 });
for (const name of ['home', 'tmp', 'modules', 'generated', 'interfaces', 'payload/React_callinvoker/ReactCommon', 'cases']) {
  mkdirSync(join(output, name), { recursive: true, mode: 0o700 });
}

const environment: NodeJS.ProcessEnv = {
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  HOME: join(output, 'home'),
  TMPDIR: join(output, 'tmp'),
  LANG: 'C',
  LC_ALL: 'C',
};
if (options.has('--developer-dir')) {
  environment.DEVELOPER_DIR = resolve(options.get('--developer-dir')!);
}
const sdk = options.has('--sdk') ? ['-sdk', resolve(options.get('--sdk')!)] : [];
const digest = (contents: string | Buffer) => createHash('sha256').update(contents).digest('hex');
const sources = new Map<string, string>([
  ['modules/module.modulemap', 'module CBridge {\n  umbrella header "Bridge.h"\n  export *\n}\n'],
  ['modules/Bridge.h', `#ifndef OLIPHAUNT_PROBE_BRIDGE_H
#define OLIPHAUNT_PROBE_BRIDGE_H
#ifdef __cplusplus
#include <ReactCommon/CallInvoker.h>
#endif
static inline int bridge_marker(void) { return 42; }
#endif
`],
  ['payload/React_callinvoker/ReactCommon/CallInvoker.h', `#ifndef OLIPHAUNT_PROBE_CALL_INVOKER_H
#define OLIPHAUNT_PROBE_CALL_INVOKER_H
#if !defined(__cplusplus) || __cplusplus < 202002L
#error OLIPHAUNT_PROBE_CXX20_REQUIRED
#endif
#if !defined(OLIPHAUNT_PROBE_REQUIRED) || OLIPHAUNT_PROBE_REQUIRED != 17
#error OLIPHAUNT_PROBE_DEFINE_REQUIRED
#endif
static inline int oliphaunt_probe_cxx_marker(void) { return 17; }
#endif
`],
  ['generated/react.yaml', `${JSON.stringify({
    version: 0,
    roots: [{
      type: 'directory',
      name: 'virtual-react/Headers',
      contents: [{
        type: 'directory',
        name: 'ReactCommon',
        contents: [{
          type: 'file',
          name: 'CallInvoker.h',
          'external-contents': 'payload/React_callinvoker/ReactCommon/CallInvoker.h',
        }],
      }],
    }],
  }, null, 2)}\n`],
  ['Bridge.swift', '@_exported import CBridge\npublic func marker() -> Int { 42 }\n'],
  ['Consumer.swift', 'import Bridge\nlet _: Int = marker()\nlet _: Int32 = oliphaunt_probe_cxx_marker()\n'],
]);
for (const [name, contents] of sources) writeFileSync(join(output, name), contents, { mode: 0o600 });
assert.ok(!existsSync(join(output, 'virtual-react')), 'Virtual headers must have no physical search-root fallback.');

type Observation = {
  name: string;
  args: string[];
  status: number | null;
  signal: string | null;
  elapsedMs: number;
  stdoutSha256: string;
  stderrSha256: string;
  error: string | null;
};
const observations: Observation[] = [];
function run(name: string, args: string[]) {
  const start = performance.now();
  const result = spawnSync(swiftc, args, {
    cwd: output,
    env: environment,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  writeFileSync(join(output, `${name}.stdout.log`), result.stdout ?? '', { mode: 0o600 });
  writeFileSync(join(output, `${name}.stderr.log`), result.stderr ?? '', { mode: 0o600 });
  observations.push({
    name, args, status: result.status, signal: result.signal,
    elapsedMs: Math.round(performance.now() - start),
    stdoutSha256: digest(result.stdout ?? ''),
    stderrSha256: digest(result.stderr ?? ''),
    error: result.error?.message ?? null,
  });
  return result;
}

const results: Record<string, unknown> = {
  schemaVersion: 1,
  compiler: swiftc,
  sdk: sdk.at(-1) ?? null,
  environmentNames: Object.keys(environment).sort(),
  sourceSha256: Object.fromEntries([...sources].map(([name, contents]) => [name, digest(contents)])),
  observations,
  status: 'incomplete',
};

try {
  const version = run('compiler-version', ['--version']);
  assert.equal(version.status, 0, 'Compiler version query failed.');
  assert.match(version.stdout, /(?:Apple )?Swift version 6\.3\.2\b/, 'Use the same Swift 6.3.2 version as the failing CI action.');
  results.compilerVersion = version.stdout.trim();

  // Generate an actual interface with C++ mode off. Keep its emitted binary in
  // generated/, while consumers can search only the copied interface directory.
  const generated = run('generate-interface', [
    ...sdk, '-swift-version', '6', '-cxx-interoperability-mode=off',
    '-I', 'modules', '-module-name', 'Bridge', '-enable-library-evolution',
    '-emit-module', '-emit-module-path', 'generated/Bridge.swiftmodule',
    '-emit-module-interface-path', 'generated/Bridge.swiftinterface',
    '-module-cache-path', 'generated/cache', 'Bridge.swift',
  ]);
  assert.equal(generated.status, 0, 'The C/Swift-only fixture must generate successfully.');
  const actualInterface = readFileSync(join(output, 'generated/Bridge.swiftinterface'), 'utf8');
  assert.match(actualInterface, /@_exported import CBridge/);
  assert.match(actualInterface, /-formal-cxx-interoperability-mode=off/);
  copyFileSync(join(output, 'generated/Bridge.swiftinterface'), join(output, 'interfaces/Bridge.swiftinterface'));
  assert.deepEqual(readdirSync(join(output, 'interfaces')), ['Bridge.swiftinterface']);
  results.generatedInterfaceSha256 = digest(actualInterface);

  const clangProfile = ['-Xcc', '-std=c++20', '-Xcc', '-DOLIPHAUNT_PROBE_REQUIRED=17'];
  const oldOverlay = ['-Xcc', '-ivfsoverlay', '-Xcc', 'generated/react.yaml', '-Xcc', '-Ivirtual-react/Headers'];
  const profiles = [
    { name: 'old-xcc-only', frontend: true, args: [...oldOverlay, ...clangProfile], expected: 'missing-header' },
    { name: 'swift-vfs-and-search-path', frontend: true, args: ['-vfsoverlay', 'generated/react.yaml', '-I', 'virtual-react/Headers', ...clangProfile], expected: 'missing-clang-profile' },
    { name: 'strict-context', frontend: true, args: ['-strict-implicit-module-context', ...oldOverlay, ...clangProfile], expected: 'success' },
    // Preserve the real driver's default module-building behavior as a separate
    // comparison; the original profile's outcome is observed, not prescribed.
    // -v retains the actual frontend/scanner commands used in both cases.
    { name: 'old-xcc-only-driver-default', frontend: false, args: ['-v', ...oldOverlay, ...clangProfile], expected: 'observed' },
    { name: 'strict-context-driver-default', frontend: false, args: ['-v', '-Xfrontend', '-strict-implicit-module-context', ...oldOverlay, ...clangProfile], expected: 'success' },
  ];
  const cases: Record<string, unknown> = {};
  results.cases = cases;
  for (const profile of profiles) {
    const cache = `cases/${profile.name}/cache`;
    mkdirSync(join(output, cache), { recursive: true, mode: 0o700 });
    const compiled = run(profile.name, [
      // Direct frontend holds the causal comparison on implicit loading.
      // The final driver case deliberately preserves its default behavior.
      ...(profile.frontend ? ['-frontend'] : []),
      ...sdk, '-swift-version', '6', '-cxx-interoperability-mode=default',
      '-I', 'interfaces', '-I', 'modules', '-module-name', 'Consumer',
      '-module-cache-path', cache,
      ...(profile.frontend ? ['-Rmodule-interface-rebuild'] : ['-Xfrontend', '-Rmodule-interface-rebuild']),
      ...profile.args, '-typecheck', 'Consumer.swift',
    ]);
    const diagnostics = `${compiled.stdout ?? ''}\n${compiled.stderr ?? ''}`;
    const missingHeader = /ReactCommon\/CallInvoker\.h[^\n]*(?:file not found|not found)/.test(diagnostics);
    const missingStandard = /OLIPHAUNT_PROBE_CXX20_REQUIRED/.test(diagnostics);
    const missingDefine = /OLIPHAUNT_PROBE_DEFINE_REQUIRED/.test(diagnostics);
    const rebuiltBridge = /rebuild[^\n]*(?:module ['"]?Bridge|Bridge\.swiftinterface)|(?:module ['"]?Bridge|Bridge\.swiftinterface)[^\n]*rebuild/i.test(diagnostics);
    const explicitModuleCommands = /-scan-dependencies\b|-explicit-interface-module-build\b|-disable-implicit-swift-modules\b/.test(diagnostics);
    const observedOutcome = compiled.status === 0 ? 'success' : missingHeader ? 'missing-header' : missingStandard || missingDefine ? 'missing-clang-profile' : 'other-failure';
    const expected = profile.expected === 'observed'
      ? compiled.status !== null && compiled.signal === null && !compiled.error
      : profile.expected === 'success'
        ? compiled.status === 0 && (!profile.frontend || rebuiltBridge)
        : profile.expected === 'missing-header'
          ? compiled.status !== null && compiled.status !== 0 && missingHeader
          : compiled.status !== null && compiled.status !== 0 && !missingHeader && (missingStandard || missingDefine);
    cases[profile.name] = { expected: profile.expected, matched: expected, observedOutcome, consumerMode: profile.frontend ? 'frontend-implicit' : 'driver-default', missingHeader, missingStandard, missingDefine, rebuiltBridge, explicitModuleCommands };
  }
  assert.ok(Object.values(cases).every((row) => (row as { matched: boolean }).matched), 'Observed diagnostics did not establish every expected compiler boundary; inspect retained logs.');
  results.status = 'passed';
} catch (error) {
  results.status = 'failed';
  results.failure = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  writeFileSync(join(output, 'result.json'), `${JSON.stringify(results, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ status: results.status, output, observations: observations.map(({ name, status }) => ({ name, status })), failure: results.failure ?? null }));
}
