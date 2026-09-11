import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { tarArchive } from '../../tools/packaging/testdata/tar-fixture.mts';
import { zipArchive } from '../../tools/packaging/testdata/zip-fixture.mts';

import {
  assertHttpsUrl,
  canonicalGnuArchiveFallbackUrl,
  promotePathTransactional,
  sameDirectoryIdentity,
  sha256File,
  validateSource,
} from './source-fetch-core.mts';

function makeRoot(label) {
  return mkdtempSync(path.join(os.tmpdir(), `oliphaunt-${label}-`));
}

function directoryMetadata(dev, ino, isDirectory = true) {
  return { dev, ino, isDirectory: () => isDirectory };
}

const [mode, root] = process.argv.slice(2);
if (mode) {
  if (mode === 'prepare') {
    createTarFixtures(root);
    createZipFixtures(root);
    const valid = gnuArchiveSource(path.join(root, 'valid.tar.gz'));
    const pins = {
      valid,
      updated: archiveSource(path.join(root, 'updated.tar.gz'), valid.name),
      unsafe: archiveSource(path.join(root, 'traversal.tar.gz'), valid.name),
      zip: {
        ...archiveSource(path.join(root, 'valid.zip')),
        url: 'https://example.invalid/release.zip',
        stripPrefix: '.',
      },
    };
    for (const [name, pin] of Object.entries(pins))
      writeFileSync(path.join(root, name + '.json'), JSON.stringify(pin));
    writeArchiveManifest(path.join(root, 'source.toml'), valid);
  } else if (mode === 'git-pin') {
    writeFileSync(path.join(root, 'pin.json'), JSON.stringify(gitSource(process.argv[4])));
  } else throw Error('unknown source test mode: ' + mode);
  process.exit(0);
}

test('directory identity accepts Windows short and long aliases for the same filesystem object', () => {
  const shortPath = String.raw`C:\Users\RUNNER~1\AppData\Local\Temp\checkout`;
  const longPath = String.raw`C:\Users\runneradmin\AppData\Local\Temp\checkout`;
  const metadata = new Map([
    [shortPath, directoryMetadata(17n, 42n)],
    [longPath, directoryMetadata(17n, 42n)],
  ]);

  assert.equal(
    sameDirectoryIdentity(shortPath, longPath, {
      stat: (candidate) => metadata.get(candidate),
    }),
    true,
  );
});

test('directory identity rejects different filesystem objects', () => {
  assert.equal(
    sameDirectoryIdentity('/expected', '/external', {
      stat: (candidate) =>
        candidate === '/expected' ? directoryMetadata(17n, 42n) : directoryMetadata(17n, 43n),
    }),
    false,
  );
});

test('directory identity rejects unavailable or partial filesystem identifiers', () => {
  const identities = [
    [directoryMetadata(0n, 0n), directoryMetadata(0n, 0n)],
    [directoryMetadata(17n, 0n), directoryMetadata(17n, 0n)],
    [directoryMetadata(0n, 42n), directoryMetadata(0n, 42n)],
    [directoryMetadata(17n, 42n), directoryMetadata(0n, 42n)],
  ];
  for (const [left, right] of identities) {
    assert.equal(
      sameDirectoryIdentity('/left', '/right', {
        stat: (candidate) => (candidate === '/left' ? left : right),
      }),
      false,
    );
  }
});

test('directory identity rejects a matching inode on a different device', () => {
  assert.equal(
    sameDirectoryIdentity('/left', '/right', {
      stat: (candidate) =>
        candidate === '/left' ? directoryMetadata(17n, 42n) : directoryMetadata(18n, 42n),
    }),
    false,
  );
});

test('directory identity rejects non-directories and propagates stat errors', () => {
  assert.equal(
    sameDirectoryIdentity('/directory', '/file', {
      stat: (candidate) =>
        directoryMetadata(17n, candidate === '/directory' ? 42n : 43n, candidate === '/directory'),
    }),
    false,
  );
  assert.throws(
    () =>
      sameDirectoryIdentity('/missing', '/expected', {
        stat: () => {
          throw new Error('stat failed');
        },
      }),
    /stat failed/u,
  );
});

function createTarFixtures(root) {
  const directory = { name: 'pkg/', type: '5', mode: 0o755, data: '' };
  const file = { name: 'pkg/file.txt', data: 'trusted bytes', v7: true };
  const link = (name, linkTarget, type = '2') => ({ name, linkTarget, type, data: '' });
  const fixtures = {
    valid: [
      directory,
      file,
      link('pkg/link.txt', 'file.txt'),
      link('pkg/hard.txt', 'pkg/file.txt', '1'),
    ],
    updated: [directory, { name: 'pkg/file.txt', data: 'updated trusted bytes' }],
    traversal: [{ name: 'pkg/../../escape' }],
    absolute: [{ name: '/tmp/escape' }],
    'outside-prefix': [{ name: 'other/file' }],
    backslash: [{ name: 'pkg\\escape' }],
    duplicate: [{ name: 'pkg/file' }, { name: 'pkg/file', data: 'second' }],
    'case-collision': [{ name: 'pkg/File' }, { name: 'pkg/file', data: 'second' }],
    'windows-ads': [{ name: 'pkg/file:stream' }],
    'windows-device': [{ name: 'pkg/CON.txt' }],
    'escaping-symlink': [link('pkg/link', '../../escape')],
    'dangling-symlink': [link('pkg/link', 'missing')],
    'escaping-hardlink': [link('pkg/link', '../../escape', '1')],
    fifo: [{ name: 'pkg/fifo', type: '6', data: '' }],
    'reserved-git': [{ name: 'pkg/.git/config' }],
    'reserved-stamp': [{ name: 'pkg/.oliphaunt-source-pin' }],
    'symlink-ancestor': [
      { name: 'pkg/dir/', type: '5', mode: 0o755, data: '' },
      link('pkg/link', 'dir'),
      { name: 'pkg/link/child' },
    ],
    huge: [{ name: 'pkg/huge', size: 3 * 1024 ** 3 }],
  };
  for (const [name, entries] of Object.entries(fixtures))
    writeFileSync(path.join(root, name + '.tar.gz'), tarArchive(entries));
}

function createZipFixtures(root) {
  const ntfs = Buffer.alloc(36);
  ntfs.writeUInt16LE(0x000a, 0);
  ntfs.writeUInt16LE(32, 2);
  ntfs.writeUInt16LE(1, 8);
  ntfs.writeUInt16LE(24, 10);
  writeFileSync(
    path.join(root, 'valid.zip'),
    zipArchive([
      { name: 'LICENSE', data: 'license\n', centralExtra: ntfs, localExtra: ntfs },
      { name: 'payload/data.bin', data: 'trusted bytes' },
    ]),
  );
  writeFileSync(path.join(root, 'traversal.zip'), zipArchive([{ name: '../escape' }]));
  writeFileSync(
    path.join(root, 'symlink.zip'),
    zipArchive([{ name: 'link', externalAttributes: 0o120777 << 16, data: 'payload/data.bin' }]),
  );
}

function archiveSource(fixture, name = 'fixture') {
  const sha256 = sha256File(fixture);
  return {
    name,
    kind: 'archive',
    url: `https://example.invalid/${name}.tar.gz`,
    branch: 'archive-1.0',
    commit: sha256,
    sha256,
    stripPrefix: 'pkg',
  };
}

function gnuArchiveSource(fixture) {
  return {
    ...archiveSource(fixture, 'libiconv'),
    url: 'https://ftpmirror.gnu.org/libiconv/libiconv-1.19.tar.gz',
  };
}

function writeArchiveManifest(manifestPath, source) {
  writeFileSync(
    manifestPath,
    `name = "${source.name}"\nkind = "archive"\nurl = "${source.url}"\nbranch = "${source.branch}"\ncommit = "${source.commit}"\nsha256 = "${source.sha256}"\nstrip_prefix = "${source.stripPrefix}"\n`,
  );
}

test('transactional promotion restores the prior destination on a normal failure', () => {
  const root = makeRoot('source-promotion');
  try {
    const destination = path.join(root, 'live');
    const candidate = path.join(root, 'candidate');
    mkdirSync(destination);
    mkdirSync(candidate);
    writeFileSync(path.join(destination, 'value'), 'old');
    writeFileSync(path.join(candidate, 'value'), 'new');
    assert.throws(
      () =>
        promotePathTransactional(candidate, destination, {
          afterBackup: () => {
            throw new Error('fault');
          },
        }),
      /fault/u,
    );
    assert.equal(readFileSync(path.join(destination, 'value'), 'utf8'), 'old');
    assert.equal(readFileSync(path.join(candidate, 'value'), 'utf8'), 'new');
    assert.deepEqual(readdirSync(root).sort(), ['candidate', 'live']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function gitSource(commit) {
  return {
    name: 'source',
    kind: 'git',
    url: 'https://primary.example.invalid/source.git',
    mirrorUrl: 'https://mirror.example.invalid/source.git',
    branch: 'pinned',
    commit,
  };
}

test('source pins reject unsafe URLs, branches, names, and archive mirrors', () => {
  const source = gitSource('1'.repeat(40));
  for (const url of [
    'http://example.test/source',
    'https://user:secret@example.test/source',
    'https://example.test\\source',
    'https://example.test/source#fragment',
  ]) {
    assert.throws(() => assertHttpsUrl(url));
    assert.throws(() => validateSource({ ...source, mirrorUrl: url }));
  }
  assert.throws(() => validateSource({ ...source, mirrorUrl: source.url }));
  for (const branch of ['--config', 'a..b', 'a.lock', 'a\nb', '/a'])
    assert.throws(() => validateSource({ ...source, branch }));
  for (const name of ['../outside', '/absolute', 'bad\\name'])
    assert.throws(() => validateSource({ ...source, name }));
  assert.throws(() =>
    validateSource({ ...source, kind: 'archive', sha256: '1'.repeat(64), stripPrefix: 'pkg' }),
  );
  for (const url of [
    'https://example.invalid/libiconv/libiconv-1.19.tar.gz',
    'https://ftpmirror.gnu.org/libiconv/nested/libiconv-1.19.tar.gz',
    'https://ftpmirror.gnu.org/libiconv/libiconv-1.19.tar.gz?mutable=1',
    'https://ftpmirror.gnu.org/libiconv/%6cibiconv-1.19.tar.gz',
    'https://ftpmirror.gnu.org/libiconv/../libiconv-1.19.tar.gz',
    'https://ftpmirror.gnu.org/libiconv/libiconv-1.19.zip',
  ]) {
    assert.equal(canonicalGnuArchiveFallbackUrl(url), undefined);
  }
});
