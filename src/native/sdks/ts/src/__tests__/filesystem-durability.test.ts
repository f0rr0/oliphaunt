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

  it('skips Windows directory barriers without swallowing Unix permission or I/O failures', () => {
    // Isolate module mocks from other SDK tests that use the real filesystem.
    const result = Bun.spawnSync([
      process.execPath,
      '--eval',
      `
      import assert from 'node:assert/strict';
      import * as fs from 'node:fs/promises';
      import { mock } from 'bun:test';
      let code;
      let failOpen;
      let opens = 0;
      let closes = 0;
      const fail = () => { throw Object.assign(new Error(code), { code }); };
      mock.module('node:fs/promises', () => ({ ...fs,
        open: async () => {
          opens++;
          if (failOpen) fail();
          return { sync: async () => fail(), close: async () => { closes++; } };
        }
      }));
      const { syncDirectory } = await import(${JSON.stringify(new URL('../native/filesystem-durability.ts', import.meta.url).href)});
      for (const platform of ['linux', 'win32']) {
        Object.defineProperty(process, 'platform', { value: platform });
        for (failOpen of [true, false]) {
          for (code of ['EPERM', 'EACCES', 'EISDIR', 'EIO', 'EINVAL', 'ENOTSUP']) {
            const previousOpens = opens;
            const previousCloses = closes;
            if (platform === 'win32' || ['EINVAL', 'ENOTSUP'].includes(code)) await syncDirectory('/unused');
            else await assert.rejects(syncDirectory('/unused'), { code });
            assert.equal(opens - previousOpens, platform === 'win32' ? 0 : 1);
            assert.equal(closes - previousCloses, platform === 'win32' || failOpen ? 0 : 1);
          }
        }
      }
    `,
    ]);
    expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
  });

  it('uses write-capable Windows file handles and propagates file-sync failures', () => {
    const result = Bun.spawnSync([
      process.execPath,
      '--eval',
      `
      import assert from 'node:assert/strict';
      import * as fs from 'node:fs/promises';
      import { join } from 'node:path';
      import { tmpdir } from 'node:os';
      import { mock } from 'bun:test';
      const root = await fs.mkdtemp(join(tmpdir(), 'oliphaunt-file-sync-'));
      const file = join(root, 'value');
      await fs.writeFile(file, 'retained');
      let code;
      let closes = 0;
      mock.module('node:fs/promises', () => ({ ...fs,
        open: async (path, flags) => {
          assert.equal(flags, path === file && process.platform === 'win32' ? 'r+' : 'r');
          return {
            sync: async () => { if (code) throw Object.assign(new Error(code), { code }); },
            close: async () => { closes++; }
          };
        }
      }));
      const { syncDirectoryTree } = await import(${JSON.stringify(new URL('../native/filesystem-durability.ts', import.meta.url).href)});
      try {
        for (const platform of ['linux', 'win32']) {
          Object.defineProperty(process, 'platform', { value: platform });
          code = undefined;
          await syncDirectoryTree(root);
          for (code of ['EPERM', 'EACCES', 'EIO', 'EINVAL', 'ENOTSUP']) {
            const previousCloses = closes;
            await assert.rejects(syncDirectoryTree(root), { code });
            assert.equal(closes - previousCloses, 1);
          }
        }
        assert.equal(await fs.readFile(file, 'utf8'), 'retained');
      } finally { await fs.rm(root, { force: true, recursive: true }); }
    `,
    ]);
    expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
  });

  it('flushes a nonempty staging tree on the current platform without changing file contents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oliphaunt-staging-sync-'));
    roots.push(root);
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'nested', 'value'), 'retained');
    await expect(syncDirectoryTree(root)).resolves.toBeUndefined();
    expect(await Bun.file(join(root, 'nested', 'value')).text()).toBe('retained');
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
