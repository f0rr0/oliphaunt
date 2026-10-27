import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assembleNativeReleaseAssets } from './checksums.mts';
import { checkReleaseChecksumFamily } from './release-family.test.mts';

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'release-checksum-family-'));
  const expected = {
    product: 'fixture',
    checksum: 'fixture-release-assets.sha256',
    archives: ['fixture-linux.tar.gz', 'fixture-macos.zip'],
  };
  const inputs = expected.archives.map((name, index) => {
    const file = path.join(root, name);
    writeFileSync(file, `actual archive bytes ${index}\n`);
    return file;
  });
  const directory = path.join(root, 'family', 'release-assets');
  const copies = expected.archives.map((name) => path.join(directory, name));
  const checksum = path.join(directory, expected.checksum);
  assembleNativeReleaseAssets({
    expected: expected.archives,
    files: inputs,
    copies,
    output: checksum,
  });
  return { root, expected, checksum, files: [...copies, checksum] };
}

test('qualifies the writer actual complete Files and rejects changed public bytes', () => {
  const value = fixture();
  try {
    checkReleaseChecksumFamily(value.expected, value.files);
    writeFileSync(value.files[0], 'changed archive bytes');
    expect(() => checkReleaseChecksumFamily(value.expected, value.files)).toThrow(
      'does not match its frozen bytes',
    );
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test('rejects missing, extra, repeated, and wrongly named final Files', () => {
  const value = fixture();
  try {
    for (const files of [
      value.files.slice(1),
      [...value.files, value.files[0]],
      [...value.files, path.join(value.root, 'extra.tar.gz')],
    ])
      expect(() => checkReleaseChecksumFamily(value.expected, files)).toThrow(
        'exactly its canonical public Files',
      );
    expect(() =>
      checkReleaseChecksumFamily({ ...value.expected, checksum: 'other.sha256' }, value.files),
    ).toThrow('exactly its canonical public Files');
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test('retains the publication reader strict syntax, uniqueness, and complete coverage', () => {
  const value = fixture();
  try {
    const original = readFileSync(value.checksum, 'utf8');
    for (const content of [
      original.replaceAll('  ./', '  '),
      `${original}${original.split('\n')[0]}\n`,
      `${original.split('\n')[0]}\n`,
    ]) {
      writeFileSync(value.checksum, content);
      expect(() => checkReleaseChecksumFamily(value.expected, value.files)).toThrow();
    }
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});
