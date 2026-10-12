/** Shared real source-envelope inputs for source packaging and physical transport fixtures. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  createDeterministicTar,
  createDeterministicZip,
} from '../../../tools/packaging/archive-directory.mts';
import {
  canonicalGzipSync,
  readPortableArchiveEntries,
} from '../../../tools/packaging/portable-archive.mts';
import type { SwiftSourceSpecification } from './source-package.mts';

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function fixture(
  scratch: string,
  legalMode = 0o644,
): Promise<SwiftSourceSpecification> {
  const carrier = JSON.parse(
    readFileSync('build_defs/release/testdata/swift-0.8.2-carrier.json', 'utf8'),
  );
  const files: Record<string, string> = {};
  for (const asset of carrier.base.assets) {
    const root = path.join(scratch, asset.role);
    const group = carrier.legal.base.find(
      (row: { assetRole: string }) => row.assetRole === asset.role,
    );
    mkdirSync(path.join(root, asset.member), { recursive: true });
    for (const legal of group.files) {
      const bytes = Buffer.from(`frozen fixture ${legal.member}\n`);
      const destination = path.join(root, legal.member);
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, bytes, { mode: legalMode });
      legal.bytes = bytes.length;
      legal.sha256 = digest(bytes);
    }
    if (asset.role === 'base-xcframework') {
      const framework = path.join(root, asset.member);
      const slices = [
        ['macos-arm64', 'macos', ''],
        ['ios-arm64', 'ios', ''],
        ['ios-arm64-simulator', 'ios', 'simulator'],
      ] as const;
      writeFileSync(
        path.join(framework, 'Info.plist'),
        `<plist version="1.0"><dict><key>AvailableLibraries</key><array>${slices.map(([identifier, platform, variant]) => `<dict><key>LibraryIdentifier</key><string>${identifier}</string><key>LibraryPath</key><string>fixture.a</string><key>SupportedArchitectures</key><array><string>arm64</string></array><key>SupportedPlatform</key><string>${platform}</string>${variant ? `<key>SupportedPlatformVariant</key><string>${variant}</string>` : ''}</dict>`).join('')}</array></dict></plist>`,
      );
      for (const [identifier] of slices) {
        mkdirSync(path.join(framework, identifier));
        writeFileSync(path.join(framework, identifier, 'fixture.a'), 'construction fixture\n');
        mkdirSync(path.join(framework, identifier, 'Headers'));
        writeFileSync(
          path.join(framework, identifier, 'Headers', 'oliphaunt.h'),
          '// genuine held native fixture header\n',
        );
      }
    }
    const archive = path.join(scratch, asset.name);
    const modes = Object.fromEntries(group.files.map((legal) => [legal.member, legalMode]));
    const bytes =
      asset.format === 'zip'
        ? await createDeterministicZip(path.join(root, asset.member), { keepParent: true, modes })
        : canonicalGzipSync(await createDeterministicTar(root, { modes }));
    writeFileSync(archive, bytes);
    asset.bytes = bytes.length;
    asset.sha256 = digest(bytes);
    files[asset.role] = archive;
  }
  const carrierFile = path.join(scratch, 'carrier.json');
  writeFileSync(carrierFile, `${JSON.stringify(carrier, null, 2)}\n`);
  const source = path.join(scratch, 'source-inputs');
  mkdirSync(source);
  const sourceFiles: Record<string, string> = {};
  for (const [member, bytes] of Object.entries({
    VERSION: '9.8.7\n',
    LIBOLIPHAUNT_VERSION: '0.3.3\n',
    'Package.swift': '// development package\n',
    'README.md': 'Swift SDK\n',
    'Sources/Oliphaunt/Oliphaunt.swift': '// source fixture\n',
    'Templates/OliphauntBroker/Info.plist': 'fixture\n',
    'Tests/test.swift': '// test fixture\n',
  })) {
    const file = path.join(source, member);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bytes);
    sourceFiles[member] = file;
  }
  for (const member of ['LICENSE', 'THIRD_PARTY_NOTICES.md'])
    sourceFiles[member] = path.resolve(member);
  const generatedSwift = path.join(scratch, 'OliphauntNativeBindings.swift');
  writeFileSync(generatedSwift, '// generated fixture\n');
  const bindingsArchive = path.join(scratch, 'oliphaunt-swift-9.8.7-bindings.xcframework.zip');
  const xcframework = files['base-xcframework'];
  const runtimeResources = files['runtime-resources'];
  assert.ok(xcframework && runtimeResources);
  const original = readPortableArchiveEntries(xcframework);
  const ffi = path.join(scratch, 'OliphauntNativeBindingsFFI.xcframework');
  mkdirSync(ffi);
  for (const [member, entry] of original) {
    if (!entry.isFile) continue;
    const destination = path.join(ffi, member.slice('liboliphaunt.xcframework/'.length));
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, entry.data());
  }
  writeFileSync(bindingsArchive, await createDeterministicZip(ffi, { keepParent: true }));
  return {
    version: '9.8.7',
    nativeVersion: '0.3.3',
    sources: sourceFiles,
    generatedSwift,
    bindingsArchive,
    carrier: carrierFile,
    xcframework,
    runtimeResources,
    generators: Object.fromEntries(
      ['extension-resource-inventory', 'render-extension-products', 'swift-carrier-resolver'].map(
        (name) => [`${name}.mjs`, realpathSync(`src/native/sdks/swift/tools/${name}.mts`)],
      ),
    ),
    ownerCatalog: path.resolve('src/extensions/generated/sdk/extensions.json'),
  };
}
