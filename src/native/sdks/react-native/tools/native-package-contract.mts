/** Declared Bazel archive consumer; requires its runner-supplied package inputs. */
import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { archive as npmArchive } from '../../../../../build_defs/query/package.mts';
import { readPortableArchiveEntries } from '../../../../../tools/packaging/portable-archive.mts';
import { IOS_CARRIER_FILENAME } from '../../swift/tools/swift-native-carrier-contract.mts';
import {
  packageReactNativeNpm,
  type ReactNativePackageInputs,
  validateReactNativeNpm,
} from './native-package.mts';

const [specification, archiveInput, carrierOutput] = Bun.argv.slice(2);
assert(
  specification &&
    archiveInput &&
    carrierOutput &&
    process.env.OLIPHAUNT_BAZEL_RUNFILES &&
    process.env.TEST_TMPDIR,
);
const runfilesRoot = process.env.OLIPHAUNT_BAZEL_RUNFILES;
const archive = join(process.env.TEST_TMPDIR, 'react-native-public.tgz');
copyFileSync(archiveInput, archive);
const inputs = Object.fromEntries(
  Object.entries(JSON.parse(readFileSync(specification, 'utf8'))).map(([name, file]) => [
    name,
    join(runfilesRoot, file as string),
  ]),
) as unknown as ReactNativePackageInputs;
const carrier = validateReactNativeNpm(archive, inputs);
assert.equal(
  carrier.base.version,
  JSON.parse(readFileSync(inputs.carrierSource, 'utf8')).nativeVersion,
);
assert.deepEqual(
  packageReactNativeNpm(inputs),
  readFileSync(archive),
  'Public npm must be deterministic',
);
const entries = Object.fromEntries(
  [...readPortableArchiveEntries(archive).values()].map((entry) => [
    entry.name,
    Buffer.from(entry.data()),
  ]),
);
assert.deepEqual(entries[`package/${IOS_CARRIER_FILENAME}`], readFileSync(inputs.carrier));
assert.deepEqual(
  readFileSync(carrierOutput),
  entries[`package/${IOS_CARRIER_FILENAME}`],
  'Source-owned RN carrier output must be the actual final npm member',
);
const manifest = JSON.parse(entries['package/package.json'].toString('utf8'));
assert.equal(manifest.exports['./ios-carriers'], `./${IOS_CARRIER_FILENAME}`);
assert.equal(manifest.oliphaunt.iosCarrierManifest, `./${IOS_CARRIER_FILENAME}`);
assert(manifest.files.includes(IOS_CARRIER_FILENAME));
assert(entries['package/android/src/main/cpp/include/oliphaunt.h'].length > 0);
assert.deepEqual(
  entries['package/src/generated/ios-static-dependencies.json'],
  readFileSync(inputs.iosStaticDependencies),
);

const bad = join(process.env.TEST_TMPDIR, 'react-native-invalid.tgz');
for (const mutate of [
  (rows) => {
    delete rows[`package/${IOS_CARRIER_FILENAME}`];
  },
  (rows) => {
    rows[`package/${IOS_CARRIER_FILENAME}`] = Buffer.from('{}\n');
  },
  (rows) => {
    rows['package/android/src/main/cpp/include/oliphaunt.h'] = Buffer.from('retargeted header');
  },
  (rows) => {
    rows['package/ios/frameworks/liboliphaunt.dylib'] = Buffer.from('unwanted native payload');
  },
  (rows) => {
    rows['package/unowned.txt'] = Buffer.from('undeclared member');
  },
  (rows) => {
    const changed = JSON.parse(rows['package/package.json'].toString('utf8'));
    changed.oliphaunt.swiftSdkVersion = '99.0.0';
    rows['package/package.json'] = Buffer.from(JSON.stringify(changed));
  },
]) {
  const changed = { ...entries };
  mutate(changed);
  writeFileSync(bad, npmArchive(changed));
  assert.throws(() => validateReactNativeNpm(bad, inputs));
}
const authored = JSON.parse(readFileSync(inputs.authoredManifest, 'utf8'));
authored.oliphaunt.swiftSdkVersion = '99.0.0';
const wrongPin = join(process.env.TEST_TMPDIR, 'wrong-pin.json');
writeFileSync(wrongPin, JSON.stringify(authored));
assert.throws(
  () => packageReactNativeNpm({ ...inputs, authoredManifest: wrongPin }),
  /compatibility pin/u,
);
const changedCarrier = join(process.env.TEST_TMPDIR, 'changed-carrier.json');
writeFileSync(changedCarrier, `${readFileSync(inputs.carrier, 'utf8')} `);
assert.throws(
  () => packageReactNativeNpm({ ...inputs, carrier: changedCarrier }),
  /original source member/u,
);
console.log(
  'React Native public npm: exact immutable carrier/header, full deterministic envelope and eight negative cases passed',
);
