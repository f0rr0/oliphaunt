import { test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateSelectedIcuData, validateSelectedNativeSeed } from '../native/cluster-seed.js';

// Producer wire format: UTF-8 path NUL byte-count NUL contents newline.
function digest(files: Record<string, string>): string {
  const hash = createHash('sha256');
  for (const [path, content] of Object.entries(files).sort(([a], [b]) =>
    Buffer.compare(Buffer.from(a), Buffer.from(b)),
  )) {
    hash.update(`${path}\0${Buffer.byteLength(content)}\0${content}\n`);
  }
  return hash.digest('hex');
}

test('explicit native resources reject incompatible and altered bytes before initialization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-selected-seed-'));
  const seed = { directory: join(root, 'pgdata'), manifestPath: join(root, 'manifest.json') };
  const files = { PG_VERSION: '18\n', 'global/pg_control': 'control' };
  const manifest = {
    schema: 'oliphaunt-cluster-seed-v1',
    artifactRole: 'cluster-seed-standard',
    catalogProfile: 'standard',
    runtime: {
      product: 'liboliphaunt-native',
      version: '1.2.3',
      engineFamily: 'native',
      target: 'linux-x64-gnu',
      postgresMajor: 18,
      physicalFormat: 'native-pg18-v1',
      compatibilityKey: 'native-pg18-linux-x64-gnu-v1',
    },
    directory: { path: 'pgdata', treeSha256: digest(files), emptyDirectories: ['pg_notify'] },
    icu: null,
  };
  try {
    await mkdir(join(seed.directory, 'global'), { recursive: true });
    for (const [path, content] of Object.entries(files))
      await writeFile(join(seed.directory, path), content);
    await writeFile(seed.manifestPath, JSON.stringify(manifest));
    expect(await validateSelectedNativeSeed(seed, 'linux-x64-gnu', '1.2.3')).toEqual({
      catalogProfile: 'standard',
      emptyDirectories: ['pg_notify'],
    });
    await expect(validateSelectedNativeSeed(seed, 'linux-arm64-gnu', '1.2.3')).rejects.toThrow(
      'incompatible',
    );
    await expect(validateSelectedNativeSeed(seed, 'linux-x64-gnu', '1.2.4')).rejects.toThrow(
      'incompatible',
    );
    manifest.directory.emptyDirectories = ['../escape'];
    await writeFile(seed.manifestPath, JSON.stringify(manifest));
    await expect(validateSelectedNativeSeed(seed, 'linux-x64-gnu', '1.2.3')).rejects.toThrow(
      'unsafe',
    );
    manifest.directory.emptyDirectories = ['global/pg_control'];
    await writeFile(seed.manifestPath, JSON.stringify(manifest));
    await expect(validateSelectedNativeSeed(seed, 'linux-x64-gnu', '1.2.3')).rejects.toThrow(
      'overlaps',
    );
    manifest.directory.emptyDirectories = ['pg_notify'];
    await writeFile(seed.manifestPath, JSON.stringify(manifest));
    await writeFile(join(seed.directory, 'global/pg_control'), 'corrupt');
    await expect(validateSelectedNativeSeed(seed, 'linux-x64-gnu', '1.2.3')).rejects.toThrow(
      'corrupted',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ICU data identity covers the selected files and rejects symlinks and corruption', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-selected-icu-'));
  const resource = {
    directory: join(root, 'data'),
    manifestPath: join(root, 'manifest.properties'),
  };
  const content = 'canonical ICU fixture';
  const expected = digest({ 'icudt76l.dat': content });
  try {
    await mkdir(resource.directory);
    await writeFile(join(resource.directory, 'icudt76l.dat'), content);
    await writeFile(
      resource.manifestPath,
      `schema=oliphaunt-icu-data-v1\nartifactRole=icu-data\nicuDataVersion=76.1\nicuDataForm=files-le\nicuDataTreeSha256=${expected}\n`,
    );
    expect(await validateSelectedIcuData(resource)).toBe(expected);
    await writeFile(join(resource.directory, 'icudt76l.dat'), 'changed');
    await expect(validateSelectedIcuData(resource)).rejects.toThrow('does not match');
    if (process.platform !== 'win32') {
      await rm(join(resource.directory, 'icudt76l.dat'));
      await symlink(resource.manifestPath, join(resource.directory, 'icudt76l.dat'));
      await expect(validateSelectedIcuData(resource)).rejects.toThrow('symlink');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
