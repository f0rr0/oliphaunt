import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildIosCarrierManifest,
  iosBaseLegalMetadataFromArchives,
} from '../../src/native/sdks/swift/tools/ios-carrier-manifest.mts';
import {
  createDeterministicTar,
  createDeterministicZip,
} from '../../tools/packaging/archive-directory.mts';
import { canonicalGzipSync } from '../../tools/packaging/portable-archive.mts';
import { releaseNoticeDeclaration } from '../../tools/packaging/release-notices.mts';
import { fileIdentity } from '../../tools/release/native-file-identity.mts';

test('held Apple archives preserve exact old legal bytes independently of current core and Swift pins', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'completed-apple-base-'));
  try {
    const archives = {};
    for (const [role, profile, prefix, format] of [
      ['base-xcframework', 'native-runtime', 'liboliphaunt.xcframework', 'zip'],
      ['runtime-resources', 'native-runtime-resources', '', 'tar.gz'],
    ]) {
      const stage = path.join(root, role);
      mkdirSync(stage, { recursive: true });
      const declaration = releaseNoticeDeclaration(profile);
      for (const member of declaration.members) {
        const target = path.join(stage, prefix, member);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, `genuine fixture old3.4 bytes ${member}\n`, { mode: 0o644 });
      }
      const inner = path.join(stage, prefix || 'oliphaunt/runtime');
      mkdirSync(inner, { recursive: true });
      writeFileSync(
        path.join(inner, format === 'zip' ? 'Info.plist' : 'fixture.txt'),
        'old3.4 original payload\n',
      );
      const name =
        role === 'base-xcframework'
          ? 'liboliphaunt-0.3.4-apple-spm-xcframework.zip'
          : 'liboliphaunt-0.3.4-runtime-resources-ios-datum64.tar.gz';
      const destination = path.join(root, name);
      writeFileSync(
        destination,
        format === 'zip'
          ? await createDeterministicZip(path.join(stage, prefix), { keepParent: true })
          : canonicalGzipSync(await createDeterministicTar(stage)),
      );
      const identity = fileIdentity(destination);
      archives[role] = { path: destination, size: identity.size, sha256: identity.sha256 };
    }
    const currentCore = '0.3.5',
      heldSwift = '0.3.3';
    assert.notEqual(currentCore, '0.3.4');
    assert.notEqual(heldSwift, '0.3.4');
    const projected = buildIosCarrierManifest({
      baseRuntimeVersion: '0.3.4',
      baseArchiveInputs: archives,
      baseAssetDir: path.join(root, 'deliberately-missing-current3.5'),
      extensionManifests: [],
    });
    assert.equal(projected.base.version, '0.3.4');
    assert.equal(projected.base.tag, 'liboliphaunt-native-v0.3.4');
    assert.deepEqual(projected.carriers, []);
    assert.deepEqual(projected.extensions, []);
    assert.deepEqual(projected.legal.base, iosBaseLegalMetadataFromArchives(archives));
    assert.equal(projected.base.assets[0].sha256, archives['base-xcframework'].sha256);
    assert.equal(projected.base.assets[1].sha256, archives['runtime-resources'].sha256);
    assert(
      projected.legal.base.every((g) =>
        g.files.every((f) => f.bytes > 0 && /^[a-f0-9]{64}$/.test(f.sha256)),
      ),
    );
    const originalDoc = path.join(root, 'projected-ios.json');
    writeFileSync(originalDoc, JSON.stringify(projected));
    assert.deepEqual(
      buildIosCarrierManifest({
        baseRuntimeVersion: '0.3.4',
        baseArchiveInputs: archives,
        baseCarrierManifest: originalDoc,
      }),
      projected,
    );
    assert.throws(
      () =>
        buildIosCarrierManifest({
          baseRuntimeVersion: '0.3.4',
          baseArchiveInputs: {
            ...archives,
            'base-xcframework': { ...archives['base-xcframework'], sha256: '0'.repeat(64) },
          },
        }),
      /archive identity differs/,
    );
    assert.throws(
      () => buildIosCarrierManifest({ baseRuntimeVersion: '4.7.0', baseArchiveInputs: archives }),
      /archive identity differs/,
    );
    assert.throws(() =>
      buildIosCarrierManifest({
        baseRuntimeVersion: '0.3.4',
        baseArchiveInputs: { 'base-xcframework': archives['base-xcframework'] },
      }),
    );
    const changed = structuredClone(projected);
    changed.legal.base[0].files[0].sha256 = '0'.repeat(64);
    writeFileSync(originalDoc, JSON.stringify(changed));
    assert.throws(
      () =>
        buildIosCarrierManifest({
          baseRuntimeVersion: '0.3.4',
          baseArchiveInputs: archives,
          baseCarrierManifest: originalDoc,
        }),
      /exact declared public archives\/legal bytes/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
