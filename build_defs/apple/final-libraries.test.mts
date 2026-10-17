import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { zipArchive } from '../../tools/packaging/testdata/zip-fixture.mts';
import { finalIosLibraryBytes } from './final-libraries.mts';

test('app link input is the exact selected final device/simulator library and refuses substitutions', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'final-ios-link-fixture-'));
  try {
    const bundle = 'liboliphaunt_extension_vector';
    const archive = path.join(root, 'final.xcframework.zip');
    const rows = ['ios-arm64', 'ios-arm64-simulator'].map((slice) => ({
      name: `${bundle}.xcframework/${slice}/${bundle}.framework/${bundle}`,
      data: Buffer.from(`!<arch>\n${slice}-original-binary`),
    }));
    writeFileSync(archive, zipArchive(rows));
    for (const row of rows)
      expect(
        finalIosLibraryBytes(
          archive,
          bundle,
          row.name.includes('simulator') ? 'ios-arm64-simulator' : 'ios-arm64',
        ),
      ).toEqual(row.data);
    expect(() => finalIosLibraryBytes(archive, bundle, 'macos-arm64')).toThrow();
    expect(() => finalIosLibraryBytes(archive, 'another_framework', 'ios-arm64')).toThrow();
    expect(() => finalIosLibraryBytes(archive, '../vector', 'ios-arm64')).toThrow();
    writeFileSync(
      archive,
      zipArchive([{ ...rows[0], data: Buffer.from('dynamic/stub substitute') }]),
    );
    expect(() => finalIosLibraryBytes(archive, bundle, 'ios-arm64')).toThrow(/static ar/);
    expect(() => finalIosLibraryBytes(archive, bundle, 'ios-arm64-simulator')).toThrow(
      /lacks exact/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
