import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { validateFrozenNativeCarrierIdentity } from '../../../src/native/sdks/swift/tools/swift-native-carrier-contract.mts';
import { renderSwiftReleaseManifest } from '../../../src/native/sdks/swift/tools/swift-release-manifest.mts';
import { validateAppleXcframeworkAsset } from '../../../src/native/sdks/swift/tools/swift-xcframework-contract.mts';
import { createDeterministicZip } from '../../../tools/packaging/archive-directory.mts';
import { bundleJavaScript, emitJavaScript } from '../../../tools/packaging/emit-javascript.mts';
import { readPortableArchiveEntries } from '../../../tools/packaging/portable-archive.mts';
import {
  assertReleaseNoticesInDirectory,
  stageReleaseNotices,
} from '../../../tools/packaging/release-notices.mts';

const REPOSITORY = 'https://github.com/f0rr0/oliphaunt';
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const CARRIER = 'oliphaunt-react-native-ios-carriers.json';

export type SwiftSourceSpecification = {
  version: string;
  nativeVersion: string;
  sources: Record<string, string>;
  generatedSwift: string;
  publicHeader: string;
  bindingsArchive: string;
  carrier: string;
  xcframework: string;
  runtimeResources: string;
  generators: Record<string, string>;
  ownerCatalog: string;
};

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function copy(source: string, destination: string): void {
  mkdirSync(path.dirname(destination), { recursive: true });
  copyFileSync(realpathSync(source), destination);
  chmodSync(destination, 0o644);
}

export function verifyFrozenNativeArchives(
  spec: Pick<
    SwiftSourceSpecification,
    'carrier' | 'nativeVersion' | 'xcframework' | 'runtimeResources'
  >,
) {
  const carrier = validateFrozenNativeCarrierIdentity({
    carrier: JSON.parse(readFileSync(spec.carrier, 'utf8')),
    expectedNativeVersion: spec.nativeVersion,
  });
  for (const asset of carrier.base.assets) {
    const file = realpathSync(
      asset.role === 'base-xcframework' ? spec.xcframework : spec.runtimeResources,
    );
    const bytes = readFileSync(file);
    assert.equal(bytes.length, asset.bytes, `${asset.name} size differs from frozen carrier`);
    assert.equal(sha256(bytes), asset.sha256, `${asset.name} SHA-256 differs from frozen carrier`);
    const entries = readPortableArchiveEntries(file, { format: asset.format });
    assert.ok(
      [...entries.keys()].some(
        (member) => member === asset.member || member.startsWith(`${asset.member}/`),
      ),
      `${asset.name} lacks declared member ${asset.member}`,
    );
    const group = carrier.legal.base.find((row) => row.assetRole === asset.role);
    assert.ok(group, `${asset.name} lacks frozen legal metadata`);
    for (const legal of group.files) {
      const entry = entries.get(legal.member);
      assert.ok(entry?.isFile, `${asset.name} lacks legal file ${legal.member}`);
      assert.equal(entry.mode & 0o777, 0o644, `${legal.member} must have mode 0644`);
      const content = entry.data();
      assert.equal(content.length, legal.bytes, `${legal.member} size differs from frozen carrier`);
      assert.equal(
        sha256(content),
        legal.sha256,
        `${legal.member} SHA-256 differs from frozen carrier`,
      );
    }
  }
  return carrier;
}

export async function packageSwiftSource(
  outputRoot: string,
  spec: SwiftSourceSpecification,
): Promise<void> {
  outputRoot = path.resolve(outputRoot);
  assert.match(spec.version, SEMVER, 'Swift owner version must be stable SemVer');
  assert.match(spec.nativeVersion, SEMVER, 'Swift compatibility version must be stable SemVer');
  const carrier = verifyFrozenNativeArchives(spec);
  await validateAppleXcframeworkAsset(realpathSync(spec.xcframework));
  await validateAppleXcframeworkAsset(
    realpathSync(spec.bindingsArchive),
    'OliphauntNativeBindingsFFI',
  );
  const base = carrier.base.assets.find((asset) => asset.role === 'base-xcframework');
  const bindingsName = `oliphaunt-swift-${spec.version}-bindings.xcframework.zip`;
  assert.equal(
    path.basename(spec.bindingsArchive),
    bindingsName,
    'Swift FFI asset must match release owner version',
  );
  const manifest = renderSwiftReleaseManifest(
    `${REPOSITORY}/releases/download/${carrier.base.tag}`,
    spec.nativeVersion,
    base.sha256,
    `${REPOSITORY}/releases/download/oliphaunt-swift-v${spec.version}/${bindingsName}`,
    sha256(readFileSync(spec.bindingsArchive)),
  );
  mkdirSync(outputRoot, { recursive: true });
  const scratch = mkdtempSync(path.join(outputRoot, '.swift-source-'));
  try {
    const sourceRoot = path.join(scratch, 'sources');
    const sourcePackage = path.join(scratch, 'package');
    const tree = path.join(outputRoot, 'release-tree');
    for (const [member, source] of Object.entries(spec.sources)) {
      assert.ok(
        member &&
          !member.includes('\\') &&
          !member.startsWith('/') &&
          !/^[A-Za-z]:/u.test(member) &&
          !/[\u0000-\u001f\u007f]/u.test(member) &&
          member.split('/').every((part) => part && part !== '.' && part !== '..'),
        `Unsafe Swift source entry ${member}`,
      );
      assert.ok(
        member === 'LICENSE' ||
          member === 'THIRD_PARTY_NOTICES.md' ||
          /^(Sources|Templates|Tests)\//u.test(member) ||
          [
            'README.md',
            'CHANGELOG.md',
            'VERSION',
            'LIBOLIPHAUNT_VERSION',
            'Package.swift',
          ].includes(member),
        `Unexpected Swift source entry ${member}`,
      );
      copy(source, path.join(sourcePackage, member));
      if (member === 'LICENSE' || member === 'THIRD_PARTY_NOTICES.md')
        copy(source, path.join(sourceRoot, member));
      if (/^(Sources|Templates)\//u.test(member))
        copy(source, path.join(tree, 'src/sdks/swift', member));
    }
    assert.equal(
      readFileSync(path.join(sourcePackage, 'VERSION'), 'utf8').trim(),
      spec.version,
      'Swift conventional version disagrees with owner',
    );
    assert.equal(
      readFileSync(path.join(sourcePackage, 'LIBOLIPHAUNT_VERSION'), 'utf8').trim(),
      spec.nativeVersion,
      'Swift conventional compatibility pin disagrees with owner',
    );
    for (const root of [tree, sourcePackage]) {
      stageReleaseNotices(root, { profile: 'source-sdk', sourceRoot });
      assertReleaseNoticesInDirectory(root, { profile: 'source-sdk', sourceRoot });
    }
    const bindingsDestination = 'Sources/OliphauntNativeBindings/OliphauntNativeBindings.swift';
    copy(spec.generatedSwift, path.join(sourcePackage, bindingsDestination));
    copy(spec.generatedSwift, path.join(tree, 'src/sdks/swift', bindingsDestination));
    // The checkout header forwards outside this package. Standalone consumers
    // receive the actual runtime-owned ABI header, matching current staging.
    const publicHeader = 'Sources/COliphaunt/include/oliphaunt.h';
    copy(spec.publicHeader, path.join(sourcePackage, publicHeader));
    copy(spec.publicHeader, path.join(tree, 'src/sdks/swift', publicHeader));
    writeFileSync(path.join(outputRoot, 'Package.swift.release'), manifest, { mode: 0o644 });
    writeFileSync(
      path.join(sourcePackage, 'Package.swift'),
      manifest.replaceAll('"src/sdks/swift/Sources/', '"Sources/'),
      { mode: 0o644 },
    );
    const carrierFile = path.join(tree, 'src/sdks/swift/Carriers', CARRIER);
    mkdirSync(path.dirname(carrierFile), { recursive: true });
    // Preserve the immutable public carrier bytes, rather than rebinding its
    // held dependency to current workspace versions or legal source files.
    copy(spec.carrier, carrierFile);
    const generatorRoot = path.join(outputRoot, 'extension-generator');
    mkdirSync(generatorRoot, { recursive: true });
    assert.deepEqual(Object.keys(spec.generators).sort(), [
      'extension-resource-inventory.mjs',
      'render-extension-products.mjs',
      'swift-carrier-resolver.mjs',
    ]);
    for (const [name, source] of Object.entries(spec.generators)) {
      const destination = path.join(generatorRoot, name);
      if (name === 'swift-carrier-resolver.mjs')
        writeFileSync(destination, await bundleJavaScript(source), { mode: 0o644 });
      else emitJavaScript(source, destination);
    }
    copy(spec.ownerCatalog, path.join(generatorRoot, 'extension-owner-catalog.json'));
    writeFileSync(
      path.join(outputRoot, 'Oliphaunt-source.zip'),
      await createDeterministicZip(sourcePackage, { keepParent: true }),
      { mode: 0o644 },
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [outputRoot, specification] = process.argv.slice(2);
  assert.equal(process.argv.length, 4, 'Expected output root and declared Swift specification');
  await packageSwiftSource(outputRoot, JSON.parse(readFileSync(specification, 'utf8')));
}
