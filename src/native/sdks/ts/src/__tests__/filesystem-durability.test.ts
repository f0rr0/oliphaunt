import * as fs from 'node:fs/promises';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { syncDirectoryTree, syncRuntimeDirectoryTree } from '../native/filesystem-durability.js';

describe('filesystem durability', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  it('flushes Windows regular files with write access and preserves flush failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oliphaunt-windows-sync-'));
    roots.push(root);
    await mkdir(join(root, 'nested'));
    const file = join(root, 'nested', 'payload');
    await writeFile(file, 'durable bytes');
    const originalOpen = fs.open;
    const readOnlyHandleError = Object.assign(new Error('FlushFileBuffers requires write access'), {
      code: 'EPERM',
    });
    let flushFailure: Error | undefined;
    const flushed: string[] = [];
    const platformSpy = spyOn(os, 'platform').mockReturnValue('win32');
    const openSpy = spyOn(fs, 'open').mockImplementation(
      async (...args: Parameters<typeof fs.open>) => {
        const handle = await originalOpen(...args);
        if ((await handle.stat()).isFile()) {
          const sync = handle.sync.bind(handle);
          handle.sync = async () => {
            if (args[1] === 'r') throw readOnlyHandleError;
            if (flushFailure) throw flushFailure;
            await sync();
            flushed.push(String(args[0]));
          };
        }
        return handle;
      },
    );
    try {
      for (const sync of [syncDirectoryTree, syncRuntimeDirectoryTree]) await sync(root);
      expect(flushed).toEqual([file, file]);
      expect(await readFile(file, 'utf8')).toBe('durable bytes');
      flushFailure = Object.assign(new Error('regular-file flush failed'), { code: 'EPERM' });
      for (const sync of [syncDirectoryTree, syncRuntimeDirectoryTree])
        await expect(sync(root)).rejects.toBe(flushFailure);
    } finally {
      openSpy.mockRestore();
      platformSpy.mockRestore();
    }
  });

  it.if(process.platform !== 'win32')(
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
