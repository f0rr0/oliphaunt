import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import { syncDirectoryTree, syncRuntimeDirectoryTree } from '../native/filesystem-durability.js';

describe('filesystem durability', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  it('does not mistake permission or I/O failures for unsupported directory sync', () => {
    // Isolate module mocks from other SDK tests that use the real filesystem.
    const result = Bun.spawnSync([
      process.execPath,
      '--eval',
      `
      import assert from 'node:assert/strict';
      import * as fs from 'node:fs/promises';
      import { mock } from 'bun:test';
      let code;
      mock.module('node:fs/promises', () => ({ ...fs,
        open: async () => { throw Object.assign(new Error(code), { code }); }
      }));
      const { syncDirectory } = await import(${JSON.stringify(new URL('../native/filesystem-durability.ts', import.meta.url).href)});
      for (const platform of ['linux', 'win32']) {
        Object.defineProperty(process, 'platform', { value: platform });
        for (code of ['EPERM', 'EISDIR', 'EIO']) {
          if (platform === 'win32' && code !== 'EIO') await syncDirectory('/unused');
          else await assert.rejects(syncDirectory('/unused'), { code });
        }
      }
    `,
    ]);
    expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
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
