import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { syncDirectoryTree, syncRuntimeDirectoryTree } from '../native/filesystem-durability.js';

describe('filesystem durability', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  it.runIf(process.platform !== 'win32')(
    'accepts packaged runtime symlinks without weakening PGDATA publication',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'oliphaunt-runtime-sync-'));
      roots.push(root);
      const lib = join(root, 'lib');
      await mkdir(lib);
      await writeFile(join(lib, 'libicu.so.1'), 'icu');
      await symlink('libicu.so.1', join(lib, 'libicu.so'));

      await expect(syncRuntimeDirectoryTree(root)).resolves.toBeUndefined();
      await expect(syncDirectoryTree(root)).rejects.toThrow('contains a symbolic link');
    },
  );
});
