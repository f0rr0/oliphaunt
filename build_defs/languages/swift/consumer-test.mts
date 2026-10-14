import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { localizeSwiftReleaseManifest } from '../../../src/native/sdks/swift/tools/prepare-swift-release-consumer.mts';
import { extractPortableArchiveTree } from '../../../tools/packaging/portable-archive.mts';
import { composeSwiftCandidateManifest } from '../../native/apple/swift-candidate-contract.mts';
import {
  assertSwiftIosResourceParity,
  assertSwiftSourceDeliveryParity,
  readSwiftSourceTagMembers,
} from './source-delivery-contract.mts';

assert.equal(process.platform, 'darwin', 'Installed Swift runtime qualification requires macOS');
assert.equal(process.arch, 'arm64', 'Installed Swift runtime qualification requires Apple arm64');
const [
  source,
  base,
  bindings,
  resources,
  consumer,
  swift,
  swiftc,
  clang,
  clangxx,
  sdkFile,
  receipt,
  triple,
  mode,
  sourceTree,
] = process.argv.slice(2);
assert.equal(
  process.argv.length,
  16,
  'Expected exact Swift package, native assets, consumer and declared toolchain',
);
assert.ok(['frozen', 'bundled-candidate'].includes(mode), 'Expected a declared consumer mode');
const root = process.env.TEST_TMPDIR;
assert.ok(root && path.isAbsolute(root), 'Bazel must supply a private TEST_TMPDIR');
const sdkMarker = `${path.sep}sdk_macosx${path.sep}`;
assert.ok(sdkFile.includes(sdkMarker), 'Expected a file from the declared macOS SDK');
const sdk = `${sdkFile.slice(0, sdkFile.indexOf(sdkMarker))}${path.sep}sdk_macosx`;
const home = path.join(root, 'home');
mkdirSync(home);
const packageRoot = path.join(root, 'package');
extractPortableArchiveTree(realpathSync(source), packageRoot, 'package');
const checksum = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
assertSwiftSourceDeliveryParity(
  realpathSync(source),
  readSwiftSourceTagMembers(sourceTree),
  readFileSync(path.join(sourceTree, 'Package.swift')),
);
const manifestFile = path.join(packageRoot, 'Package.swift');
let composition;
if (mode === 'bundled-candidate') {
  const { manifest, ...identity } = composeSwiftCandidateManifest(
    readFileSync(manifestFile, 'utf8'),
    readFileSync(path.join(packageRoot, 'LIBOLIPHAUNT_VERSION'), 'utf8'),
    path.basename(base),
    checksum(base),
  );
  composition = identity;
  writeFileSync(manifestFile, manifest);
  assertSwiftIosResourceParity(base, resources);
}
localizeSwiftReleaseManifest({
  manifestFile,
  assetFile: realpathSync(base),
  bindingsAssetFile: realpathSync(bindings),
  outputFile: manifestFile,
});
extractPortableArchiveTree(
  realpathSync(base),
  path.join(packageRoot, 'Artifacts/liboliphaunt.xcframework'),
  'liboliphaunt.xcframework',
);
extractPortableArchiveTree(
  realpathSync(bindings),
  path.join(packageRoot, 'Artifacts/OliphauntNativeBindingsFFI.xcframework'),
  'OliphauntNativeBindingsFFI.xcframework',
);
const runtimeRoot = path.join(root, 'runtime');
if (mode === 'frozen') extractPortableArchiveTree(realpathSync(resources), runtimeRoot);
const consumerRoot = path.join(root, 'consumer');
mkdirSync(path.join(consumerRoot, 'Sources/InstalledConsumer'), { recursive: true });
writeFileSync(
  path.join(consumerRoot, 'Sources/InstalledConsumer/main.swift'),
  readFileSync(consumer),
);
const facts = JSON.parse(readFileSync(receipt, 'utf8'));
assert.equal(
  triple,
  `arm64-apple-macosx${facts.deploymentTargets.package_macos}`,
  'Swift package profile disagrees with the declared host SDK',
);
writeFileSync(
  path.join(consumerRoot, 'Package.swift'),
  `// swift-tools-version: 6.0
import PackageDescription
let package = Package(name: "InstalledConsumer", platforms: [.macOS("${facts.deploymentTargets.package_macos}")], dependencies: [.package(name: "OliphauntSDK", path: "../package")], targets: [.executableTarget(name: "InstalledConsumer", dependencies: [${['COliphaunt', 'Oliphaunt', 'OliphauntCore', 'OliphauntBroker', 'OliphauntBrokerExtension', 'OliphauntExtensionSupport'].map((product) => `.product(name: "${product}", package: "OliphauntSDK")`).join(', ')}])])
`,
);
const environment = {
  HOME: home,
  TMPDIR: root,
  PATH: path.dirname(swift),
  DEVELOPER_DIR: facts.developerDirectory,
  SDKROOT: sdk,
  SWIFT_EXEC: swiftc,
  CC: clang,
  CXX: clangxx,
};
const build = path.join(root, 'build');
const result = spawnSync(
  swift,
  [
    'build',
    '--package-path',
    consumerRoot,
    '--scratch-path',
    build,
    '--cache-path',
    path.join(root, 'cache'),
    '--config-path',
    path.join(root, 'configuration'),
    '--security-path',
    path.join(root, 'security'),
    '--sdk',
    sdk,
    '--triple',
    triple,
    '--jobs',
    '2',
    '--disable-sandbox',
    '-Xswiftc',
    '-resource-dir',
    '-Xswiftc',
    path.resolve(path.dirname(swift), '../lib/swift'),
    '-Xcc',
    '-isysroot',
    '-Xcc',
    sdk,
  ],
  { env: environment, stdio: 'inherit' },
);
assert.equal(result.error, undefined, String(result.error));
assert.equal(result.status, 0, 'Installed Swift source ZIP failed to compile/link');
const executable = path.join(build, 'debug/InstalledConsumer');
for (const phase of ['create', 'reopen']) {
  const run = spawnSync(executable, [phase, path.join(root, 'database')], {
    env: {
      ...environment,
      ...(mode === 'frozen'
        ? { OLIPHAUNT_RUNTIME_DIR: path.join(runtimeRoot, 'oliphaunt/runtime/files') }
        : {}),
    },
    encoding: 'utf8',
  });
  assert.equal(run.error, undefined, String(run.error));
  assert.equal(run.status, 0, `Installed Swift ${phase} failed: ${run.stderr}`);
  assert.equal(run.stdout.trim(), `installed-swift-${phase}-42`);
}
const output = process.env.TEST_UNDECLARED_OUTPUTS_DIR ?? root;
mkdirSync(output, { recursive: true });
writeFileSync(
  path.join(output, 'swift-consumer-receipt.json'),
  `${JSON.stringify(
    {
      schema: 'oliphaunt-installed-swift-consumer-v1',
      mode,
      composition,
      inputs: Object.fromEntries(
        Object.entries({ source, base, bindings, resources, consumer, hostSdk: receipt }).map(
          ([name, file]) => [name, { name: path.basename(file), sha256: checksum(file) }],
        ),
      ),
      triple,
      resourceResolution: mode === 'bundled-candidate' ? 'framework-bundle' : 'explicit-runtime',
      cases: ['create-query-42', 'reopen-query-42'],
    },
    null,
    2,
  )}\n`,
);
