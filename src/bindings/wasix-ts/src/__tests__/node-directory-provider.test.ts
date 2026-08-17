import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import {
  NODE_DIRECTORY_LOCK_CANDIDATE_PREFIX,
  NODE_DIRECTORY_LOCK_SLOT,
  nodeDirectoryLockName,
} from '../node-lock-identity.js';
import { acquireNodeDirectoryStorage } from '../storage/node-directory-provider.js';
import type { StorageDirectory, WasixStorageCompatibility } from '../storage-provider.js';

const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe('WASIX server-runtime directory storage', () => {
  it('uses the selected directory as raw PGDATA and hydrates an exact reopen', async () => {
    const root = await temporaryRoot('space ünicode');
    const first = await acquireNodeDirectoryStorage(root, template(), compatible());
    expect(first.state).toBe('new');

    await expect(acquireNodeDirectoryStorage(root, template(), compatible())).rejects.toMatchObject(
      { code: 'busy', durability: 'unchanged' },
    );

    await first.close(pgdataDirectory('persisted'), 'clean');
    expect(await readFile(join(root, 'PG_VERSION'), 'utf8')).toBe('18\n');
    expect(await readFile(join(root, 'user/value'), 'utf8')).toBe('persisted');
    expect(JSON.parse(await readFile(join(root, '.oliphaunt-wasix.json'), 'utf8'))).toMatchObject({
      schema: 'oliphaunt-wasix-directory-v2',
    });
    expect(await pathExists(join(root, '.oliphaunt-wasix-ts'))).toBe(false);

    const second = await acquireNodeDirectoryStorage(root, template(), compatible());
    expect(second.state).toBe('existing');
    expect(new TextDecoder().decode(second.mount.files['user/value'])).toBe('persisted');
    await second.close(undefined, 'failed');
  });

  it('publishes only journaled current-state changes after the first generation', async () => {
    const root = await temporaryRoot('incremental');
    const lease = await acquireNodeDirectoryStorage(root, template(), compatible());
    const directory = trackedPgdataDirectory('first');

    await lease.sync(directory, 'operation');
    await writeFile(join(root, 'unrelated-host-marker'), 'outside adapter metadata');
    directory.setValue('second');
    await lease.sync(directory, 'operation');
    await lease.close(undefined, 'failed');

    expect(await readFile(join(root, 'user/value'), 'utf8')).toBe('second');
    expect(await readFile(join(root, 'unrelated-host-marker'), 'utf8')).toBe(
      'outside adapter metadata',
    );
  });

  it('fails closed for incompatible metadata and symbolic links', async () => {
    const root = await temporaryRoot('fail-closed');
    const first = await acquireNodeDirectoryStorage(root, template(), compatible());
    await first.close(pgdataDirectory('complete'), 'clean');

    await expect(
      acquireNodeDirectoryStorage(root, template(), {
        ...compatible(),
        runtime: { ...compatible().runtime, runtimeArchiveSha256: '9'.repeat(64) },
      }),
    ).rejects.toMatchObject({ code: 'incompatible', durability: 'unchanged' });

    await symlink(join(root, 'PG_VERSION'), join(root, 'linked-version'));
    await expect(acquireNodeDirectoryStorage(root, template(), compatible())).rejects.toMatchObject(
      { code: 'corrupt', durability: 'unchanged' },
    );
  });

  it('does not publish a failed database outcome', async () => {
    const root = await temporaryRoot('failed');
    const lease = await acquireNodeDirectoryStorage(root, template(), compatible());
    await lease.close(pgdataDirectory('must-not-persist'), 'failed');

    expect(await pathExists(join(root, 'PG_VERSION'))).toBe(false);
    const reopened = await acquireNodeDirectoryStorage(root, template(), compatible());
    expect(reopened.state).toBe('new');
    await reopened.close(undefined, 'failed');
  });

  it('rejects caller files and the retired nested snapshot layout', async () => {
    const root = await temporaryRoot('collision');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'application-data'), 'keep');
    await expect(acquireNodeDirectoryStorage(root, template(), compatible())).rejects.toMatchObject(
      { code: 'corrupt', durability: 'unchanged' },
    );
    expect(await readFile(join(root, 'application-data'), 'utf8')).toBe('keep');

    const retired = await temporaryRoot('retired');
    await mkdir(join(retired, '.oliphaunt-wasix-ts'), { recursive: true });
    await expect(acquireNodeDirectoryStorage(retired, template(), compatible())).rejects.toThrow(
      'retired snapshot storage',
    );

    const partial = await temporaryRoot('partial');
    await mkdir(partial, { recursive: true });
    await writeFile(
      join(partial, '.oliphaunt-wasix.json'),
      JSON.stringify({ schema: 'oliphaunt-wasix-directory-v2', compatibility: compatible() }),
    );
    await expect(acquireNodeDirectoryStorage(partial, template(), compatible())).rejects.toThrow(
      'without a complete PGDATA',
    );
  });

  it('elects exactly one owner during concurrent stale-lease recovery', async () => {
    const root = await temporaryRoot('stale-race');
    const initialized = await acquireNodeDirectoryStorage(root, template(), compatible());
    await initialized.close(undefined, 'failed');
    await createLockSlot(root, nodeDirectoryLockName(2_147_483_647, 'deadbeefdeadbeef'));

    const attempts = await Promise.allSettled([
      acquireNodeDirectoryStorage(root, template(), compatible(), 'aaaaaaaaaaaaaaaa'),
      acquireNodeDirectoryStorage(root, template(), compatible(), 'bbbbbbbbbbbbbbbb'),
    ]);
    const leases = attempts.flatMap((attempt) =>
      attempt.status === 'fulfilled' ? [attempt.value] : [],
    );
    expect(leases).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
    await leases[0]?.close(undefined, 'failed');
  });

  it('reaps abandoned lock candidates after winning the fixed slot', async () => {
    const root = await temporaryRoot('candidate-recovery');
    const abandoned = join(root, `${NODE_DIRECTORY_LOCK_CANDIDATE_PREFIX}abandoned-token-01`);
    await mkdir(abandoned, { recursive: true });
    await mkdir(join(abandoned, nodeDirectoryLockName(2_147_483_647, 'abandoned-token-01')));

    const recovered = await acquireNodeDirectoryStorage(root, template(), compatible());
    expect((await readdir(root)).filter((name) => name.includes('candidate'))).toEqual([]);
    await recovered.close(undefined, 'failed');
  });

  it('rejects every contender while an established owner remains', async () => {
    const root = await temporaryRoot('established-owner');
    const owner = await acquireNodeDirectoryStorage(
      root,
      template(),
      compatible(),
      'mmmmmmmmmmmmmmmm',
    );

    const attempts = await Promise.allSettled([
      acquireNodeDirectoryStorage(root, template(), compatible(), 'aaaaaaaaaaaaaaaa'),
      acquireNodeDirectoryStorage(root, template(), compatible(), 'zzzzzzzzzzzzzzzz'),
    ]);
    for (const attempt of attempts) {
      expect(attempt.status).toBe('rejected');
      if (attempt.status === 'rejected') {
        expect(attempt.reason).toMatchObject({ code: 'busy', durability: 'unchanged' });
      }
    }
    await owner.close(undefined, 'failed');
  });
});

async function createLockSlot(root: string, ownerName: string): Promise<string> {
  const slot = join(root, NODE_DIRECTORY_LOCK_SLOT);
  await mkdir(slot);
  await mkdir(join(slot, ownerName));
  return slot;
}

async function temporaryRoot(suffix: string): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'oliphaunt-wasix-node-storage-'));
  scratch.push(parent);
  return join(parent, suffix);
}

function compatible(): WasixStorageCompatibility {
  return {
    schema: 'oliphaunt-wasix-pgdata-compatibility-v1',
    runtime: {
      product: 'liboliphaunt-wasix',
      version: '0.1.1',
      manifestSha256: '1'.repeat(64),
      runtimeArchiveSha256: '2'.repeat(64),
      pgdataTemplateSha256: '3'.repeat(64),
      moduleSha256: '4'.repeat(64),
      sourceFingerprint: 'source-v1',
      postgresVersion: '18.4',
    },
    extensions: [],
  };
}

function template() {
  return {
    directories: ['global'],
    files: {
      PG_VERSION: new TextEncoder().encode('18\n'),
      'global/pg_control': Uint8Array.of(1),
    },
  };
}

function pgdataDirectory(value: string): StorageDirectory {
  return {
    async readDir(path) {
      if (path === '') {
        return [
          { type: 'file', name: 'PG_VERSION' },
          { type: 'dir', name: 'global' },
          { type: 'dir', name: 'user' },
          { type: 'file', name: 'postmaster.pid' },
        ];
      }
      if (path === 'global') return [{ type: 'file', name: 'pg_control' }];
      if (path === 'user') return [{ type: 'file', name: 'value' }];
      throw new Error(`unexpected directory ${path}`);
    },
    async readFile(path) {
      if (path === 'PG_VERSION') return new TextEncoder().encode('18\n');
      if (path === 'global/pg_control') return Uint8Array.of(1, 2, 3);
      if (path === 'user/value') return new TextEncoder().encode(value);
      if (path === 'postmaster.pid') return new TextEncoder().encode('123');
      throw new Error(`unexpected file ${path}`);
    },
  };
}

function trackedPgdataDirectory(initialValue: string): StorageDirectory & {
  setValue(value: string): void;
} {
  let value = initialValue;
  let changes = [''];
  return {
    setValue(next) {
      value = next;
      changes.push('user/value');
    },
    changedPaths() {
      return changes;
    },
    clearChanges() {
      changes = [];
    },
    entryType(path) {
      if (path === '' || path === 'global' || path === 'user') return 'dir';
      if (path === 'PG_VERSION' || path === 'global/pg_control' || path === 'user/value') {
        return 'file';
      }
      return 'missing';
    },
    ...pgdataDirectoryProxy(() => value),
  };
}

function pgdataDirectoryProxy(value: () => string): Pick<StorageDirectory, 'readDir' | 'readFile'> {
  return {
    readDir: pgdataDirectory('').readDir,
    async readFile(path) {
      if (path === 'user/value') return new TextEncoder().encode(value());
      return pgdataDirectory('').readFile(path);
    },
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    try {
      await readdir(path);
      return true;
    } catch (directoryError) {
      if (
        directoryError instanceof Error &&
        'code' in directoryError &&
        directoryError.code === 'ENOENT'
      ) {
        return false;
      }
      throw directoryError;
    }
  }
}
