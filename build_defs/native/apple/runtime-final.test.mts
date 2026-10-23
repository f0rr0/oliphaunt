import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import {
  compareNativeMobileAbiReceipts,
  parseNativeMobileAbiReceipt,
} from '../../../src/native/runtime/tools/native-mobile-abi-contract.mts';
import { bindNativeRuntimeResourceManifest } from '../../../src/native/runtime/tools/native-runtime-carrier-contract.mts';
import { validateAppleXcframeworkAsset } from '../../../src/native/sdks/swift/tools/swift-xcframework-contract.mts';
import { readPortableArchiveEntries } from '../../../tools/packaging/portable-archive.mts';
import { assertMatchingArchiveTrees } from '../../resources/mobile_resource_contract.mts';
import { inspectDynamicFrameworkBinary } from './framework-envelope.mts';

const [archive, swiftpm, resources, checksums, header, iosManifest, ...receipts] =
  process.argv.slice(2);
assert.equal(receipts.length, 3, 'final Apple resources require all three actual ABI receipts');
const [physicalArchive, physicalSwiftpm, physicalResources] = [archive, swiftpm, resources].map(
  (file) => realpathSync(file),
);
await validateAppleXcframeworkAsset(physicalSwiftpm);
const framework = readPortableArchiveEntries(physicalSwiftpm);
const github = readPortableArchiveEntries(physicalArchive);
const runtimeResources = readPortableArchiveEntries(physicalResources);
const manifest = JSON.parse(readFileSync(iosManifest, 'utf8'));
assert.equal(manifest.base.product, 'liboliphaunt-native');
assert.equal(manifest.base.tag, `liboliphaunt-native-v${manifest.base.version}`);
assert.deepEqual(manifest.extensions, []);
assert.deepEqual(manifest.carriers, []);
assert.deepEqual(manifest.legal.extensions, []);
for (const [role, file, entries] of [
  ['base-xcframework', swiftpm, framework],
  ['runtime-resources', resources, runtimeResources],
]) {
  const bytes = readFileSync(file);
  const asset = manifest.base.assets.find((row) => row.role === role);
  assert(asset, `missing actual ${role} base asset`);
  assert.equal(asset.name, file.split('/').at(-1));
  assert.equal(asset.bytes, bytes.byteLength);
  assert.equal(asset.sha256, createHash('sha256').update(bytes).digest('hex'));
  const legal = manifest.legal.base.find((row) => row.assetRole === role);
  assert(legal, `missing actual ${role} legal contract`);
  for (const row of legal.files) {
    const entry = entries.get(row.member);
    assert(entry?.isFile && !entry.isSymbolicLink, `missing base legal member ${row.member}`);
    const actual = entry.data();
    assert.equal(actual.byteLength, row.bytes);
    assert.equal(createHash('sha256').update(actual).digest('hex'), row.sha256);
  }
}
const prefix = 'liboliphaunt.xcframework/';
assertMatchingArchiveTrees(github, prefix, framework, prefix);
const regular = (entries: typeof framework, name: string) => {
  const entry = entries.get(name);
  assert(entry?.isFile && !entry.isSymbolicLink, `missing regular Apple carrier member ${name}`);
  return entry.data();
};
const runtimeManifest = regular(runtimeResources, 'oliphaunt/runtime/manifest.properties');
assert(runtimeManifest.equals(bindNativeRuntimeResourceManifest(runtimeManifest, 'ios-datum64')));
const abi = receipts.map((file) => ({ text: readFileSync(file, 'utf8'), label: file }));
compareNativeMobileAbiReceipts('ios-datum64', abi);
for (const [identifier, target] of [
  ['ios-arm64', 'ios-arm64'],
  ['ios-arm64-simulator', 'ios-arm64-simulator'],
  ['macos-arm64', 'macos-arm64'],
]) {
  const slice = `${prefix}${identifier}/liboliphaunt.framework/`;
  inspectDynamicFrameworkBinary(regular(framework, `${slice}liboliphaunt`), target);
  assert(regular(framework, `${slice}Headers/oliphaunt.h`).equals(readFileSync(header)));
  if (target.startsWith('ios-'))
    assertMatchingArchiveTrees(
      framework,
      `${slice}Resources/oliphaunt/`,
      runtimeResources,
      'oliphaunt/',
    );
  const carrier = `${slice}Resources/oliphaunt/`;
  for (const { text, label } of abi) {
    const abiTarget = parseNativeMobileAbiReceipt(text, label).get('target');
    // The iOS resource contract preserves all genuine domain receipts in each slice.
    if (target.startsWith('ios-'))
      assert(
        regular(framework, `${carrier}provenance/native-mobile-abi/${abiTarget}.properties`).equals(
          Buffer.from(text),
        ),
      );
  }
}
const actualChecksums = new Map(
  readFileSync(checksums, 'utf8')
    .trim()
    .split('\n')
    .map((line) => {
      const match = /^([a-f0-9]{64}) {2}\.\/([^/]+)$/u.exec(line);
      assert(match, 'Apple checksum rows require canonical public names');
      return [match[2], match[1]];
    }),
);
assert.equal(actualChecksums.size, 3);
for (const file of [archive, swiftpm, resources]) {
  const name = file.split('/').at(-1);
  assert(name, 'Apple checksum input requires its actual asset name');
  assert.equal(
    actualChecksums.get(name),
    createHash('sha256').update(readFileSync(file)).digest('hex'),
  );
}
console.log(
  'Final Apple GitHub framework and iOS resources agree with the qualified native SwiftPM candidate',
);
