import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractNpmPackage } from './npm-archives.mts';

test('locked npm dot paths extract while traversal and aliases fail closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-npm-paths-'));
  try {
    const archive = join(root, 'canonical.tgz');
    await writeFile(
      archive,
      await new Bun.Archive({
        'package/./dist/cjs/index.js': 'export {};',
        'package/dist/cjs/index.js': 'export {};',
      }).bytes(),
    );
    await expect(extractNpmPackage(archive, join(root, 'shipping'))).rejects.toThrow(
      'Duplicate shipping',
    );
    await extractNpmPackage(archive, join(root, 'valid'), { allowIdenticalAliases: true });
    expect(await readFile(join(root, 'valid/dist/cjs/index.js'), 'utf8')).toBe('export {};');
    for (const entries of [
      { 'package/../escape.js': 'escape' },
      { 'package/dist/index.js': 'first', 'package/./dist/index.js': 'alias' },
    ]) {
      await writeFile(archive, await new Bun.Archive(entries).bytes());
      await expect(
        extractNpmPackage(archive, join(root, 'invalid'), { allowIdenticalAliases: true }),
      ).rejects.toThrow();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
