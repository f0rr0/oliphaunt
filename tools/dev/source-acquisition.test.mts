import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  prepareSourceArchive,
  sourceCheckoutIsReady,
  validateCachedArchive,
} from '../../src/third-party/tools/source-fetch-core.mts';
import { tarArchive } from '../packaging/testdata/tar-fixture.mts';
import { zipArchive } from '../packaging/testdata/zip-fixture.mts';

function fixture(
  bytes: Buffer,
  format: 'tar.gz' | 'zip',
  run: (value: ReturnType<typeof pin>) => void,
) {
  const root = mkdtempSync(path.join(tmpdir(), 'native-source-acquisition-'));
  try {
    const archive = path.join(root, `source.${format}`);
    writeFileSync(archive, bytes);
    run(pin(bytes, format, archive, path.join(root, 'checkout')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function pin(bytes: Buffer, format: 'tar.gz' | 'zip', archive: string, checkout: string) {
  const digest = createHash('sha256').update(bytes).digest('hex');
  return {
    archive,
    checkout,
    source: {
      name: 'fixture',
      kind: 'archive',
      url: `https://example.invalid/source.${format}`,
      branch: 'fixture',
      commit: digest,
      sha256: digest,
      stripPrefix: format === 'zip' ? '.' : 'pkg',
    },
  };
}

test('verified tar and rootless ZIP sources retain bytes and detect checkout edits', () => {
  for (const [format, bytes] of [
    ['tar.gz', tarArchive([{ name: 'pkg/file.txt', data: 'trusted' }])],
    ['zip', zipArchive([{ name: 'file.txt', data: 'trusted' }])],
  ] as const) {
    fixture(bytes, format, ({ archive, checkout, source }) => {
      prepareSourceArchive(source, archive, checkout);
      assert.equal(readFileSync(path.join(checkout, 'file.txt'), 'utf8'), 'trusted');
      assert.equal(sourceCheckoutIsReady(source, checkout), true);
      assert.throws(() => prepareSourceArchive(source, archive, checkout));
      assert.equal(readFileSync(path.join(checkout, 'file.txt'), 'utf8'), 'trusted');
      writeFileSync(path.join(checkout, 'file.txt'), 'changed');
      assert.throws(() => sourceCheckoutIsReady(source, checkout), /was modified/u);
    });
  }
});

test('a digest mismatch never creates or replaces a source checkout', () => {
  fixture(tarArchive([{ name: 'pkg/file.txt', data: 'trusted' }]), 'tar.gz', (value) => {
    writeFileSync(value.archive, 'corrupt transfer');
    assert.throws(() => validateCachedArchive(value.archive, value.source), /archive sha256/u);
    assert.throws(() => prepareSourceArchive(value.source, value.archive, value.checkout));
    assert.equal(existsSync(value.checkout), false);
  });
});

test('matching archive digests do not admit escaping, reserved, colliding or truncated members', () => {
  const unsafe = [
    tarArchive([{ name: 'pkg/../outside', data: 'bad' }]),
    tarArchive([{ name: 'pkg/.git/config', data: 'bad' }]),
    tarArchive([
      { name: 'pkg/File', data: 'one' },
      { name: 'pkg/file', data: 'two' },
    ]),
    tarArchive([{ name: 'pkg/link', type: '2', linkTarget: '../../outside', data: '' }]),
    tarArchive([{ name: 'pkg/file', data: 'bad' }]).subarray(0, -7),
  ];
  for (const bytes of unsafe) {
    fixture(bytes, 'tar.gz', ({ archive, checkout, source }) => {
      assert.throws(() => prepareSourceArchive(source, archive, checkout));
      assert.equal(existsSync(checkout), false);
    });
  }
});
