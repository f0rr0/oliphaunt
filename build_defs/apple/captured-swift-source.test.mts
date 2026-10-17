import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIosCarrierManifest } from '../../src/native/sdks/swift/tools/ios-carrier-manifest.mts';
import { createDeterministicZip } from '../../tools/packaging/archive-directory.mts';
import { fixture as swiftSourceFixture } from '../languages/swift/source-package.fixture.mts';
import { verifyAppleCapturedArchive } from './captured-archive.mts';
import { verifyCapturedFile } from './captured-file.mts';
import { swiftPackageConstruction, verifyCurrentSwiftSource } from './captured-swift-source.mts';
import { iosResourceBaseFiles } from './resources.mts';

const manifest = readFileSync(
  new URL('./testdata/swift-0.8.2-original-Package.swift', import.meta.url),
  'utf8',
);
describe('genuine independently held Swift source construction', () => {
  test('resource construction resolves producer File aliases without changing their captured identities', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ios-resource-file-alias-'));
    try {
      const spec = await swiftSourceFixture(root);
      const original = JSON.parse(readFileSync(spec.carrier, 'utf8'));
      const baseManifest = path.join(root, 'carrier-alias.json');
      symlinkSync(spec.carrier, baseManifest);
      const archives = Object.fromEntries(
        original.base.assets.map((asset) => {
          const physical =
            asset.role === 'base-xcframework' ? spec.xcframework : spec.runtimeResources;
          const alias = path.join(root, 'alias-' + asset.name);
          symlinkSync(physical, alias);
          return [asset.role, { path: alias, size: asset.bytes, sha256: asset.sha256 }];
        }),
      );
      const inputs = iosResourceBaseFiles({ baseManifest, archives });
      const actual = buildIosCarrierManifest({
        ...inputs,
        baseRuntimeVersion: spec.nativeVersion,
        baseTag: `liboliphaunt-native-v${spec.nativeVersion}`,
        declaredProducts: {},
      });
      expect(actual.base).toEqual(original.base);
      expect(actual.legal.base).toEqual(original.legal.base);
      expect(archives['base-xcframework'].path).toContain('/alias-');
      expect(() =>
        buildIosCarrierManifest({
          ...inputs,
          baseRuntimeVersion: spec.nativeVersion,
          baseTag: `liboliphaunt-native-v${spec.nativeVersion}`,
          declaredProducts: {},
          baseArchiveInputs: {
            ...inputs.baseArchiveInputs,
            'base-xcframework': {
              ...inputs.baseArchiveInputs['base-xcframework'],
              sha256: '0'.repeat(64),
            },
          },
        }),
      ).toThrow(/SHA|sha256|identity|frozen/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test('current source construction consumes its original package layout and rejects version relabeling', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'current-swift-archive-fixture-'));
    try {
      const source = path.join(root, 'package');
      mkdirSync(source);
      writeFileSync(path.join(source, 'VERSION'), '0.8.2\n');
      writeFileSync(
        path.join(source, 'Package.swift'),
        manifest.replaceAll('"src/sdks/swift/Sources/', '"Sources/'),
      );
      const bytes = await createDeterministicZip(source, { keepParent: true });
      const physicalArchive = path.join(root, 'source-output');
      writeFileSync(physicalArchive, bytes);
      const archive = path.join(root, 'Oliphaunt-source.zip');
      symlinkSync(physicalArchive, archive);
      const input = {
        owner: 'oliphaunt-swift',
        version: '0.8.2',
        archive: { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
        carrier: (() => {
          const bytes = readFileSync(
            new URL('../release/testdata/swift-0.8.2-carrier.json', import.meta.url),
          );
          const file = path.join(root, 'carrier.json');
          writeFileSync(file, bytes);
          return {
            path: file,
            size: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          };
        })(),
      };
      expect(verifyCurrentSwiftSource(archive, input).targets.Oliphaunt.path).toBe(
        'Sources/Oliphaunt',
      );
      expect(() => verifyCurrentSwiftSource(archive, { ...input, version: '0.8.3' })).toThrow(
        /cannot be relabelled/,
      );
      expect(() =>
        verifyCurrentSwiftSource(archive, {
          ...input,
          archive: { ...input.archive, sha256: '0'.repeat(64) },
        }),
      ).toThrow(/SHA differs/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test('authenticates outer declared File aliases while rejecting corrupt and non-file targets', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'captured-apple-alias-'));
    try {
      const source = path.join(root, 'framework');
      for (const member of [
        'liboliphaunt.xcframework/Info.plist',
        'liboliphaunt.xcframework/ios-arm64/liboliphaunt.framework/liboliphaunt',
        'liboliphaunt.xcframework/ios-arm64-simulator/liboliphaunt.framework/liboliphaunt',
        'liboliphaunt.xcframework/ios-arm64-simulator/liboliphaunt.framework/Headers/oliphaunt.h',
      ]) {
        mkdirSync(path.dirname(path.join(source, member)), { recursive: true });
        writeFileSync(path.join(source, member), member);
      }
      const bytes = await createDeterministicZip(source);
      const physical = path.join(root, 'archive-output');
      const alias = path.join(root, 'liboliphaunt-0.3.3-apple-spm-xcframework.zip');
      writeFileSync(physical, bytes);
      symlinkSync(physical, alias);
      const identity = {
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
      expect(verifyCapturedFile(alias, identity)).toBe(physical);
      expect(
        verifyAppleCapturedArchive(alias, {
          publication: { product: 'liboliphaunt-native', version: '0.3.3' },
          artifact: 'github-release:' + path.basename(alias),
          file: identity,
        }),
      ).toEqual({ version: '0.3.3', framework: true, resources: false });
      expect(() => verifyCapturedFile(alias, { ...identity, sha256: '0'.repeat(64) })).toThrow(
        /SHA differs/,
      );
      expect(() => verifyCapturedFile(alias, { ...identity, size: identity.size + 1 })).toThrow(
        /size differs/,
      );
      writeFileSync(physical, Buffer.alloc(bytes.length));
      expect(() => verifyCapturedFile(alias, identity)).toThrow(/SHA differs/);
      const directoryAlias = path.join(root, 'directory-alias');
      symlinkSync(source, directoryAlias);
      expect(() => verifyCapturedFile(directoryAlias, identity)).toThrow(/regular File/);
      const missingAlias = path.join(root, 'missing-alias');
      symlinkSync(path.join(root, 'absent'), missingAlias);
      expect(() => verifyCapturedFile(missingAlias, identity)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test('uses the delivered conventional manifest without expecting an absent legacy pin file', () => {
    const result = swiftPackageConstruction(manifest, '0.8.2');
    expect(result.nativeVersion).toBe('0.3.3');
    expect(result.bindingsChecksum).toBe(
      '118c2fc8634e2e6d652797b279f45a693cbe2a5be314fb40760c02204d844441',
    );
    expect(result.targets.OliphauntNativeBindings.dependencies).toEqual([
      'OliphauntNativeBindingsFFI',
    ]);
    expect(result.targets.Oliphaunt.path).toBe('src/sdks/swift/Sources/Oliphaunt');
    expect(result.targets.Oliphaunt.dependencies).toEqual([
      'COliphaunt',
      'OliphauntCore',
      'OliphauntNativeBindings',
    ]);
    expect(result.targets.COliphaunt).toEqual({
      path: 'src/sdks/swift/Sources/COliphaunt',
      dependencies: ['liboliphaunt'],
      publicHeaders: 'include',
      define: 'OLIPHAUNT_LINK_RUNTIME',
    });
  });
  test('does not accept current source under a different required Swift version', () => {
    expect(() => swiftPackageConstruction(manifest, '0.8.3')).toThrow();
  });
  test('rejects native URL/name version disagreement', () => {
    expect(() =>
      swiftPackageConstruction(
        manifest.replace('liboliphaunt-native-v0.3.3/', 'liboliphaunt-native-v0.3.4/'),
        '0.8.2',
      ),
    ).toThrow(/canonical exact/);
  });
  test('projects genuine dependency changes instead of keeping a parallel source graph', () => {
    const changed = manifest.replace(
      'dependencies: ["COliphaunt", "OliphauntCore", "OliphauntNativeBindings"]',
      'dependencies: ["COliphaunt", "OliphauntCore"]',
    );
    expect(swiftPackageConstruction(changed, '0.8.2').targets.Oliphaunt.dependencies).toEqual([
      'COliphaunt',
      'OliphauntCore',
    ]);
  });
  test('fails closed when the conventional source package introduces an unsupported expression', () => {
    expect(() =>
      swiftPackageConstruction(
        manifest.replace(
          'dependencies: ["OliphauntNativeBindingsFFI"]',
          'dependencies: [.product(name: "Other", package: "Other")]',
        ),
        '0.8.2',
      ),
    ).toThrow(/Unsupported Swift dependency/);
  });
  test('rejects an undeclared dependency before attempting compilation', () => {
    expect(() =>
      swiftPackageConstruction(
        manifest.replace(
          'dependencies: ["OliphauntNativeBindingsFFI"]',
          'dependencies: ["UnknownFFI"]',
        ),
        '0.8.2',
      ),
    ).toThrow(/Missing conventional/);
  });
});
