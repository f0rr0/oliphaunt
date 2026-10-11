import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { archive } from '../../../../../build_defs/query/package.mts';
import { readFrozenNativeCarrier } from '../../../../../build_defs/release/frozen-native-carrier.mts';
import { readPortableArchiveEntries } from '../../../../../tools/packaging/portable-archive.mts';
import {
  assertSourceOnlyNpmArchive,
  SOURCE_ONLY_NPM_PROFILES,
} from '../../../../../tools/packaging/source-only-sdk-package.mts';
import { IOS_CARRIER_FILENAME } from '../../swift/tools/swift-native-carrier-contract.mts';
import { attachReactNativeCarrierManifest } from './native-carrier-package.mts';

export interface ReactNativePackageInputs {
  sourceArchive: string;
  authoredManifest: string;
  carrier: string;
  carrierSource: string;
  nativeVersion: string;
  nativeReleases: string;
  nativeCompletion: string;
  swiftSource: string;
  xcframework: string;
  iosStaticDependencies: string;
}

const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

function regularArchive<T>(file: string, read: (local: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'oliphaunt-react-native-envelope-'));
  try {
    const local = join(directory, basename(file));
    copyFileSync(file, local);
    return read(local);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function reactNativeCarrier(inputs: ReactNativePackageInputs) {
  const authored = json(inputs.authoredManifest);
  const source = json(inputs.carrierSource);
  assert.equal(
    authored.oliphaunt?.swiftSdkVersion,
    source.source_tag,
    'React Native Swift compatibility pin must match the captured source tag',
  );
  return readFrozenNativeCarrier({
    source,
    carrierBytes: readFileSync(inputs.carrier),
    expectedVersion: readFileSync(inputs.nativeVersion, 'utf8').trim(),
    publicationContext: {
      nativeReleases: json(inputs.nativeReleases),
      nativeCompletion: json(inputs.nativeCompletion),
      swiftSource: json(inputs.swiftSource),
    },
    assetDirectory: undefined,
  });
}

function sourceEntries(inputs: ReactNativePackageInputs) {
  return regularArchive(inputs.sourceArchive, (source) => {
    assertSourceOnlyNpmArchive(source, SOURCE_ONLY_NPM_PROFILES['react-native']);
    const entries: Record<string, Uint8Array> = {};
    for (const entry of readPortableArchiveEntries(source).values()) {
      assert(entry.isFile && entry.name.startsWith('package/'), 'npm must contain package files');
      assert(
        !/\.(?:so(?:\.\d+)*|a|node|dylib|dll|exe|lib)$/u.test(entry.name) &&
          !/^package\/(?:ios\/(?:vendor|frameworks|extension-frameworks|generated|resources)|android\/(?:\.gradle|\.cxx|build|src\/main\/(?:jniLibs|assets)))\//u.test(
            entry.name,
          ),
        `Source npm must omit compiled native and app-owned payloads: ${entry.name}`,
      );
      entries[entry.name] = entry.data();
    }
    const manifest = JSON.parse(Buffer.from(entries['package/package.json']).toString('utf8'));
    const authored = json(inputs.authoredManifest);
    for (const field of [
      'name',
      'version',
      'oliphaunt',
      'dependencies',
      'peerDependencies',
      'exports',
    ])
      assert.deepEqual(
        manifest[field],
        authored[field],
        `Source npm must preserve authored ${field}`,
      );
    assert(
      !entries[`package/${IOS_CARRIER_FILENAME}`],
      'Source npm already contains carrier metadata',
    );
    return { entries, manifest };
  });
}

export function packageReactNativeNpm(inputs: ReactNativePackageInputs): Buffer {
  const carrier = reactNativeCarrier(inputs);
  const framework = carrier.base.assets.find((asset) => asset.role === 'base-xcframework');
  const frameworkBytes = readFileSync(inputs.xcframework);
  assert.equal(
    frameworkBytes.length,
    framework.bytes,
    'Held XCFramework size differs from carrier',
  );
  assert.equal(
    createHash('sha256').update(frameworkBytes).digest('hex'),
    framework.sha256,
    'Held XCFramework digest differs from carrier',
  );
  const headers = regularArchive(inputs.xcframework, (file) =>
    [...readPortableArchiveEntries(file, { format: 'zip' }).values()]
      .filter(
        (entry) =>
          entry.isFile &&
          /^liboliphaunt\.xcframework\/.+\/Headers\/oliphaunt\.h$/u.test(entry.name),
      )
      .map((entry) => Buffer.from(entry.data())),
  );
  assert(
    headers.length >= 3 && headers[0].length > 0,
    'Held XCFramework must declare its public C headers',
  );
  for (const header of headers)
    assert.deepEqual(
      header,
      headers[0],
      'Held XCFramework slices must share the canonical public C header',
    );
  const { entries, manifest } = sourceEntries(inputs);
  entries['package/package.json'] = Buffer.from(
    `${JSON.stringify(attachReactNativeCarrierManifest(manifest), null, 2)}\n`,
  );
  entries[`package/${IOS_CARRIER_FILENAME}`] = readFileSync(inputs.carrier);
  entries['package/android/src/main/cpp/include/oliphaunt.h'] = headers[0];
  entries['package/src/generated/ios-static-dependencies.json'] = readFileSync(
    inputs.iosStaticDependencies,
  );
  return archive(entries);
}

/** Verify the entire final envelope against the declared compiler output and immutable carrier. */
export function validateReactNativeNpm(file: string, inputs: ReactNativePackageInputs) {
  regularArchive(file, (local) =>
    assertSourceOnlyNpmArchive(local, SOURCE_ONLY_NPM_PROFILES['react-native']),
  );
  const expected = packageReactNativeNpm(inputs);
  assert.deepEqual(
    readFileSync(file),
    expected,
    'Final React Native npm differs from its declared source/carrier inputs',
  );
  return reactNativeCarrier(inputs);
}

if (import.meta.main) {
  const [specification, output] = Bun.argv.slice(2);
  assert(
    specification && output && Bun.argv.length === 4,
    'usage: native-package.mts INPUTS.json OUTPUT.tgz',
  );
  const inputs = json(specification) as ReactNativePackageInputs;
  writeFileSync(output, packageReactNativeNpm(inputs));
  validateReactNativeNpm(output, inputs);
}
