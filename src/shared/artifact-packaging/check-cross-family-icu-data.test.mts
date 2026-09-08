import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nativeIcuDataManifestFromRows } from '../cluster-seed-contract/icu-data.mts';
import { createDeterministicTar } from './cargo-source-package.mts';
import { checkCrossFamilyIcuData } from './check-cross-family-icu-data.mts';
import { canonicalGzipSync, releaseZstdCompressSync } from './portable-archive.mts';

const scratch = [];
afterEach(() => {
  for (const root of scratch.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture({
  nativeBytes = 'same data',
  wasixBytes = 'same data',
  wasixPath = 'icudt76l/root.res',
} = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-cross-family-icu-'));
  scratch.push(root);
  const nativeAssets = path.join(root, 'native');
  const wasixAssets = path.join(root, 'wasix');
  for (const [family, assets, prefix, relative, bytes, compress, filename] of [
    [
      'native',
      nativeAssets,
      'share/icu',
      'icudt76l/root.res',
      nativeBytes,
      canonicalGzipSync,
      'liboliphaunt-1.2.3-icu-data.tar.gz',
    ],
    [
      'wasix',
      wasixAssets,
      'target/oliphaunt-wasix/icu/share/icu',
      wasixPath,
      wasixBytes,
      releaseZstdCompressSync,
      'liboliphaunt-wasix-4.5.6-icu-data.tar.zst',
    ],
  ]) {
    mkdirSync(assets);
    const stage = path.join(root, family + '-stage');
    mkdirSync(stage);
    if (family === 'native')
      writeFileSync(
        path.join(stage, 'manifest.properties'),
        nativeIcuDataManifestFromRows([
          { path: 'icudt76l/root.res', bytes: Buffer.from('same data') },
        ]),
      );
    if (bytes !== null) {
      const file = path.join(stage, prefix, relative);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, bytes);
    } else writeFileSync(path.join(stage, 'LICENSE'), 'no payload');
    writeFileSync(
      path.join(assets, filename),
      compress(
        createDeterministicTar(stage, '.', {
          fail(message) {
            throw new Error(message);
          },
          fixedFileMode: 0o644,
        }),
      ),
    );
  }
  return [nativeAssets, wasixAssets];
}

test('compares actual ICU paths and bytes across independently versioned archives', () => {
  expect(checkCrossFamilyIcuData(...fixture()).dataTreeSha256).toHaveLength(64);
  for (const options of [{ wasixBytes: 'changed' }, { wasixPath: 'icudt76l/renamed.res' }]) {
    expect(() => checkCrossFamilyIcuData(...fixture(options))).toThrow(/data trees differ/);
  }
});

test('rejects native manifest tampering and either family missing its payload', () => {
  expect(() => checkCrossFamilyIcuData(...fixture({ nativeBytes: 'changed' }))).toThrow(
    /icuDataTreeSha256/,
  );
  for (const options of [{ nativeBytes: null }, { wasixBytes: null }]) {
    expect(() => checkCrossFamilyIcuData(...fixture(options))).toThrow(/contains no files/);
  }
});
