import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileOnlyTarGzipEntries } from '../../tools/packaging/portable-archive.mts';
import { archive, crateManifest, packageEnvelope } from './package.mts';

test('archive has deterministic bytes, sorted entries and fixed file metadata', async () => {
  const entries = { 'package/z': Buffer.from('last'), 'package/a': Buffer.from('first') };
  const first = archive(entries);
  expect([...first.subarray(0, 10)]).toEqual([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3]);
  expect(archive({ 'package/a': entries['package/a'], 'package/z': entries['package/z'] })).toEqual(
    first,
  );
  const files = await new Bun.Archive(first).files();
  expect([...files.keys()]).toEqual(['package/a', 'package/z']);
  expect(await files.get('package/a')?.text()).toBe('first');
  expect(files.get('package/a')?.lastModified).toBe(0);
  for (const path of ['/absolute', '../outside', 'a/../outside', 'a\\b', 'x'.repeat(101)]) {
    expect(() => archive({ [path]: Buffer.from('bad') })).toThrow('Unsupported archive path');
  }
  const nested = `${'prefix'.repeat(20)}/file.txt`;
  const nestedFiles = await new Bun.Archive(archive({ [nested]: Buffer.from('nested') })).files();
  expect(await nestedFiles.get(nested)?.text()).toBe('nested');
  const directory = await mkdtemp(join(tmpdir(), 'query-archive-'));
  try {
    const path = join(directory, 'package.tgz');
    await writeFile(path, first);
    expect([...readFileOnlyTarGzipEntries(path).keys()]).toEqual(['package/a', 'package/z']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('source crate resolves authored workspace values and preserves the original manifest', async () => {
  const original =
    '[package]\nname = "oliphaunt-query"\nversion = "0.1.1"\nedition.workspace = true\nlicense.workspace = true\n';
  const workspace = '[workspace.package]\nedition = "2024"\nlicense = "MIT"\n';
  expect(Bun.TOML.parse(crateManifest(original, workspace)).package).toEqual({
    name: 'oliphaunt-query',
    version: '0.1.1',
    edition: '2024',
    license: 'MIT',
  });
  expect(() => crateManifest(original, '[workspace.package]\nedition = "2024"\n')).toThrow(
    'workspace.package.license',
  );
  expect(() =>
    crateManifest(`${original}[dependencies]\nserde.workspace = true\n`, workspace),
  ).toThrow('dependency-free package section');
  expect(() =>
    crateManifest(
      original.replace('edition.workspace = true', 'edition.workspace = true # inherited'),
      workspace,
    ),
  ).toThrow('Unsupported workspace inheritance syntax');
  const directory = await mkdtemp(join(tmpdir(), 'query-crate-'));
  try {
    const manifest = join(directory, 'Cargo.toml');
    const workspacePath = join(directory, 'workspace.toml');
    await writeFile(manifest, original);
    await writeFile(workspacePath, workspace);
    const bytes = await packageEnvelope(
      'crate',
      manifest,
      { 'Cargo.toml': manifest },
      workspacePath,
    );
    const files = await new Bun.Archive(bytes).files();
    expect(await files.get('oliphaunt-query-0.1.1/Cargo.toml.orig')?.text()).toBe(original);
    expect(
      Bun.TOML.parse((await files.get('oliphaunt-query-0.1.1/Cargo.toml')?.text()) ?? '').package
        .edition,
    ).toBe('2024');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('npm envelope rejects missing compiled exports and preserves its full manifest', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'query-npm-'));
  try {
    const manifest = join(directory, 'package.json');
    const source = join(directory, 'query.js');
    const original = JSON.stringify({
      name: '@oliphaunt/ts-query',
      version: '0.1.1',
      exports: { './query': './dist/query.js' },
      publishConfig: { access: 'public' },
    });
    await writeFile(manifest, original);
    await writeFile(source, 'export const value = 42;');
    await expect(packageEnvelope('npm', manifest, { 'package.json': manifest })).rejects.toThrow(
      'Missing exported npm entry',
    );
    const files = await new Bun.Archive(
      await packageEnvelope('npm', manifest, { 'package.json': manifest, 'dist/query.js': source }),
    ).files();
    expect(await files.get('package/package.json')?.text()).toBe(await readFile(manifest, 'utf8'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
