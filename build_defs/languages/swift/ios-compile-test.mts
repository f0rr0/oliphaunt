import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

assert.equal(process.platform, 'darwin', 'iOS compile qualification requires declared Xcode');
assert.equal(process.arch, 'arm64', 'iOS compile qualification requires Apple arm64');
const [specification, compiler, sdkFile, receipt] = process.argv.slice(2);
assert.equal(process.argv.length, 6, 'Expected exact compiler inputs and declared host SDK');
const runfiles = process.env.OLIPHAUNT_BAZEL_RUNFILES;
const work = process.env.TEST_TMPDIR;
assert(runfiles && work && path.isAbsolute(runfiles) && path.isAbsolute(work));
const inputs = JSON.parse(readFileSync(specification, 'utf8'));
const declared = (name: string) => {
  assert(name && !path.isAbsolute(name) && !name.split('/').includes('..'));
  return path.join(runfiles, name);
};
const marker = `${path.sep}sdk_iphoneos${path.sep}`;
assert(sdkFile.includes(marker), 'Expected an actual declared iPhoneOS SDK File');
const sdkRoot = sdkFile.slice(0, sdkFile.indexOf(marker));
const sdk = path.join(sdkRoot, 'sdk_iphoneos');
const facts = JSON.parse(readFileSync(receipt, 'utf8'));
assert.equal(facts.family, 'apple');
assert(
  Number.parseInt(facts.observations.iphoneos_version, 10) >= 26,
  'Broker requires iOS 26 SDK',
);
assert.equal(facts.tools.swiftc, 'tools/swiftc');
const home = path.join(work, 'home');
const stage = path.join(work, 'modules');
const cache = path.join(work, 'module-cache');
for (const directory of [
  home,
  stage,
  cache,
  path.join(stage, 'ffi'),
  path.join(stage, 'COliphaunt'),
])
  mkdirSync(directory, { recursive: true });
for (const [key, destination] of [
  ['ffiHeader', 'ffi/OliphauntNativeBindingsFFI.h'],
  ['ffiModulemap', 'ffi/module.modulemap'],
  ['publicHeader', 'COliphaunt/oliphaunt.h'],
  ['cHeader', 'COliphaunt/COliphaunt.h'],
  ['cModulemap', 'COliphaunt/module.modulemap'],
])
  copyFileSync(declared(inputs[key]), path.join(stage, destination));
const flags = [
  // Match rules_swift: Swift's macro sandbox cannot nest inside Bazel's sandbox.
  '-disable-sandbox',
  '-sdk',
  sdk,
  '-resource-dir',
  path.join(sdkRoot, 'toolchain/lib/swift'),
  '-external-plugin-path',
  `${path.join(sdkRoot, 'toolchain/lib/swift/host/plugins')}#${path.join(sdkRoot, 'toolchain/bin/swift-plugin-server')}`,
  '-swift-version',
  '6',
  '-package-name',
  'Oliphaunt',
  '-parse-as-library',
  '-module-cache-path',
  cache,
  '-Xcc',
  `-fmodules-cache-path=${cache}`,
  '-I',
  stage,
  '-I',
  path.join(stage, 'ffi'),
];
const environment = {
  HOME: home,
  TMPDIR: work,
  PATH: path.join(sdkRoot, 'toolchain/bin'),
  DEVELOPER_DIR: facts.developerDirectory,
  SDKROOT: sdk,
};
function compile(label: string, arguments_: string[]): void {
  const result = spawnSync(realpathSync(compiler), [...flags, ...arguments_], {
    cwd: work,
    env: environment,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${label}\n${result.stdout}\n${result.stderr}`);
  console.log(`iOS compiler qualified ${label}`);
}
for (const [module, sources] of [
  ['OliphauntNativeBindings', [inputs.generatedSwift]],
  ...['OliphauntCore', 'Oliphaunt', 'OliphauntBroker', 'OliphauntBrokerExtension'].map((module) => [
    module,
    inputs.modules[module],
  ]),
] as [string, string[]][]) {
  const output = path.join(stage, `${module}.swiftmodule`);
  compile(module, [
    '-target',
    `arm64-apple-ios${module.startsWith('OliphauntBroker') ? '26.0' : '17.0'}`,
    '-emit-module',
    '-module-name',
    module,
    '-emit-module-path',
    output,
    ...sources.map(declared),
  ]);
  assert(
    statSync(output).isFile() && statSync(output).size > 0,
    `${module} emitted no actual module`,
  );
}
const extension = path.join(stage, 'DatabaseExtension.swift');
writeFileSync(
  extension,
  readFileSync(declared(inputs.extensionTemplate), 'utf8').replaceAll(
    '__HOST_BUNDLE_IDENTIFIER__',
    'dev.oliphaunt.BrokerCompile',
  ),
);
const host = path.join(stage, 'Host.swift');
copyFileSync(declared(inputs.hostTemplate), host);
compile('broker host template', ['-target', 'arm64-apple-ios26.0', '-typecheck', host]);
compile('broker application extension template', [
  '-target',
  'arm64-apple-ios26.0',
  '-application-extension',
  '-typecheck',
  extension,
]);
for (const [execution, target, definitions] of [
  ['nativeDirect', 'arm64-apple-ios17.0', []],
  ['broker', 'arm64-apple-ios26.0', ['-D', 'OLIPHAUNT_BROKER']],
] as [string, string, string[]][])
  compile(`React Native adapter ${execution}`, [
    '-target',
    target,
    ...definitions,
    '-import-objc-header',
    declared(inputs.adapterHeader),
    '-typecheck',
    declared(inputs.adapter),
  ]);
