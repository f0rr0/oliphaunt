import { archiveDirectory } from './archive-directory.mts';
import { expect, test } from 'bun:test';
import {
  chmodSync,
  statSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { extractPortableArchiveTree, extractPortableTarGzipTree } from './portable-archive.mts';
import { zipArchive } from './testdata/zip-fixture.mts';
import { tarArchive } from './testdata/tar-fixture.mts';
const ROOT = path.resolve(import.meta.dirname, '../..');

const ARCHIVER = path.join(ROOT, 'tools/packaging/archive-directory.mts');

test('FAT ZIP entries receive portable permissions before promotion', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-fat-zip-'));
  try {
    const archive = path.join(root, 'fat.zip');
    writeFileSync(
      archive,
      zipArchive([
        { name: 'directory/', data: '', versionMadeBy: 20, externalAttributes: 0x10 },
        { name: 'directory/file', data: 'payload', versionMadeBy: 20, externalAttributes: 0x20 },
      ]),
    );
    const output = path.join(root, 'output');
    extractPortableArchiveTree(archive, output);
    expect(readFileSync(path.join(output, 'directory/file'), 'utf8')).toBe('payload');
    expect(statSync(path.join(output, 'directory')).mode & 0o777).toBe(0o755);
    expect(statSync(path.join(output, 'directory/file')).mode & 0o777).toBe(0o644);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeFixtureFile(root, relativePath, contents) {
  const file = path.join(root, ...relativePath.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

for (const format of ['zip', 'tar.gz'])
  test(`native npm ${format} assembly preserves complete nested runtime trees`, async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-native-npm-zip-tree-'));
    try {
      const source = path.join(root, 'source');
      const archive = path.join(root, `native.${format}`);
      const runtimeFiles = new Map([
        ['bin/initdb.exe', 'initdb\n'],
        ['bin/pg_ctl.exe', 'pg_ctl\n'],
        ['bin/postgres.exe', 'postgres\n'],
        ['lib/postgresql/plpgsql.dll', 'plpgsql\n'],
        ['share/postgresql/postgres.bki', 'catalog\n'],
        ['share/postgresql/timezone/Africa/Abidjan', 'timezone\n'],
      ]);
      for (const [relativePath, contents] of runtimeFiles) {
        writeFixtureFile(path.join(source, 'runtime'), relativePath, contents);
      }
      writeFixtureFile(source, 'lib/modules/dict_snowball.dll', 'embedded dict_snowball\n');
      writeFixtureFile(source, 'lib/modules/plpgsql.dll', 'embedded plpgsql\n');
      writeFixtureFile(source, 'outside/not-packaged.txt', 'outside\n');
      chmodSync(path.join(source, 'runtime/bin/initdb.exe'), 0o755);

      await archiveDirectory(source, archive);

      const stage = path.join(root, 'release-package', 'runtime');
      extractPortableArchiveTree(archive, stage, 'runtime');
      for (const [relativePath, contents] of runtimeFiles) {
        expect(readFileSync(path.join(stage, ...relativePath.split('/')), 'utf8')).toBe(contents);
      }
      expect(statSync(path.join(stage, 'bin/initdb.exe')).mode & 0o777).toBe(0o755);
      const empty = path.join(root, 'release-package', 'empty');
      const emptyArchive = path.join(root, `empty.${format}`);
      writeFileSync(
        emptyArchive,
        format === 'zip'
          ? zipArchive([{ name: 'empty/', data: '', externalAttributes: 0o40755 << 16 }])
          : tarArchive([{ name: 'empty/', type: '5', mode: 0o755 }]),
      );
      extractPortableArchiveTree(emptyArchive, empty, 'empty');
      expect(readdirSync(empty)).toEqual([]);
      const modules = path.join(root, 'release-package', 'lib/modules');
      extractPortableArchiveTree(archive, modules, 'lib/modules');
      expect(readFileSync(path.join(modules, 'dict_snowball.dll'), 'utf8')).toBe(
        'embedded dict_snowball\n',
      );
      expect(readFileSync(path.join(modules, 'plpgsql.dll'), 'utf8')).toBe('embedded plpgsql\n');
      expect(existsSync(path.join(root, 'release-package', 'outside', 'not-packaged.txt'))).toBe(
        false,
      );
      writeFileSync(archive, readFileSync(archive).subarray(0, 40));
      expect(() => extractPortableArchiveTree(archive, stage, 'runtime')).toThrow();
      expect(readFileSync(path.join(stage, 'bin/initdb.exe'), 'utf8')).toBe('initdb\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

test('streaming TAR extraction preserves modes and validates the entire archive before promotion', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-stream-extract-'));
  try {
    const archive = path.join(root, 'carrier.tar.gz');
    const output = path.join(root, 'output');
    const rows = [
      { name: 'bin', type: '5', mode: 0o755 },
      { name: 'bin/run', data: 'run'.repeat(20000), mode: 0o755 },
      { name: 'empty', data: '', mode: 0o644 },
    ];
    writeFileSync(archive, tarArchive(rows));
    await extractPortableTarGzipTree(archive, output);
    expect(readFileSync(path.join(output, 'bin/run'), 'utf8')).toBe(rows[1].data);
    expect(statSync(path.join(output, 'bin/run')).mode & 0o777).toBe(0o755);
    expect(statSync(path.join(output, 'empty')).size).toBe(0);
    await extractPortableTarGzipTree(archive, output, {}, 'bin/run');
    expect(existsSync(path.join(output, 'empty'))).toBe(false);
    for (const corrupt of [
      tarArchive([...rows, { name: '../escape', data: 'bad' }]),
      tarArchive([...rows, { name: 'bin/run', data: 'duplicate' }]),
      tarArchive([...rows, { name: 'link', type: '2', linkTarget: '/tmp' }]),
      tarArchive(rows).subarray(0, -4),
    ]) {
      writeFileSync(archive, corrupt);
      await expect(extractPortableTarGzipTree(archive, output, {}, 'bin/run')).rejects.toThrow();
      expect(readFileSync(path.join(output, 'bin/run'), 'utf8')).toBe(rows[1].data);
      expect(readdirSync(root).sort()).toEqual(['carrier.tar.gz', 'output']);
    }
    writeFileSync(archive, tarArchive(rows));
    await expect(
      extractPortableTarGzipTree(archive, output, { maxExpandedBytes: 10 }),
    ).rejects.toThrow();
    await expect(extractPortableTarGzipTree(archive, output, {}, 'missing')).rejects.toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
