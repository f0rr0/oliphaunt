import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { releaseNodeDirectoryLock } from '../node-directory-lock.js';
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

describe('WASIX Node directory storage', () => {
  it('publishes on clean close and hydrates an exact-compatible reopen', async () => {
    const root = await temporaryRoot('space ünicode');
    const first = await acquireNodeDirectoryStorage(root, template(), compatible());
    expect(first.state).toBe('new');

    await expect(acquireNodeDirectoryStorage(root, template(), compatible())).rejects.toMatchObject(
      {
        code: 'busy',
        durability: 'unchanged',
      },
    );

    await first.close(pgdataDirectory('persisted'), 'clean');
    expect(
      JSON.parse(await readFile(join(root, '.oliphaunt-wasix-ts/current/oliphaunt.json'), 'utf8')),
    ).toMatchObject({ schema: 'oliphaunt-wasix-node-directory-v1' });

    const second = await acquireNodeDirectoryStorage(root, template(), compatible());
    expect(second.state).toBe('existing');
    expect(new TextDecoder().decode(second.mount.files['user/value'])).toBe('persisted');
    await second.close(undefined, 'failed');
  });

  it('keeps the previous complete generation current across checkpoint replacement', async () => {
    const root = await temporaryRoot('replace');
    const first = await acquireNodeDirectoryStorage(root, template(), compatible());
    await first.checkpoint(pgdataDirectory('first'));
    await first.checkpoint(pgdataDirectory('second'));
    await first.close(undefined, 'failed');

    const reopened = await acquireNodeDirectoryStorage(root, template(), compatible());
    expect(new TextDecoder().decode(reopened.mount.files['user/value'])).toBe('second');
    await reopened.close(undefined, 'failed');
  });

  it('recovers an interrupted directory swap before validating the generation', async () => {
    const root = await temporaryRoot('recover');
    const first = await acquireNodeDirectoryStorage(root, template(), compatible());
    await first.close(pgdataDirectory('complete'), 'clean');
    const state = join(root, '.oliphaunt-wasix-ts');
    await rename(join(state, 'current'), join(state, '.previous'));
    await mkdir(join(state, '.oliphaunt-stage-abandoned'));

    const reopened = await acquireNodeDirectoryStorage(root, template(), compatible());
    expect(new TextDecoder().decode(reopened.mount.files['user/value'])).toBe('complete');
    await reopened.close(undefined, 'failed');
  });

  it('restores the last validated generation when the new current is corrupt', async () => {
    const root = await temporaryRoot('rollback');
    const first = await acquireNodeDirectoryStorage(root, template(), compatible());
    await first.checkpoint(pgdataDirectory('first'));
    await first.checkpoint(pgdataDirectory('second'));
    await first.close(undefined, 'failed');
    await rm(join(root, '.oliphaunt-wasix-ts/current/pgdata/global/pg_control'));

    const recovered = await acquireNodeDirectoryStorage(root, template(), compatible());
    expect(new TextDecoder().decode(recovered.mount.files['user/value'])).toBe('first');
    await recovered.close(undefined, 'failed');
  });

  it('restores the prior generation when published bytes no longer match their digest', async () => {
    const root = await temporaryRoot('digest-rollback');
    const first = await acquireNodeDirectoryStorage(root, template(), compatible());
    await first.checkpoint(pgdataDirectory('first'));
    await first.checkpoint(pgdataDirectory('second'));
    await first.close(undefined, 'failed');
    await writeFile(join(root, '.oliphaunt-wasix-ts/current/pgdata/user/value'), 'tampered');

    const recovered = await acquireNodeDirectoryStorage(root, template(), compatible());
    expect(new TextDecoder().decode(recovered.mount.files['user/value'])).toBe('first');
    await recovered.close(undefined, 'failed');
  });

  it('rejects an incomplete outgoing snapshot without replacing current', async () => {
    const root = await temporaryRoot('validate-outgoing');
    const first = await acquireNodeDirectoryStorage(root, template(), compatible());
    await first.close(pgdataDirectory('complete'), 'clean');

    const second = await acquireNodeDirectoryStorage(root, template(), compatible());
    await expect(
      second.checkpoint({
        async readDir() {
          return [{ type: 'file', name: 'PG_VERSION' }];
        },
        async readFile() {
          return new TextEncoder().encode('18\n');
        },
      }),
    ).rejects.toMatchObject({ code: 'checkpoint-failed', durability: 'not-persisted' });
    await second.close(undefined, 'failed');

    const recovered = await acquireNodeDirectoryStorage(root, template(), compatible());
    expect(new TextDecoder().decode(recovered.mount.files['user/value'])).toBe('complete');
    await recovered.close(undefined, 'failed');
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

    await symlink(
      join(root, '.oliphaunt-wasix-ts/current/pgdata/PG_VERSION'),
      join(root, '.oliphaunt-wasix-ts/current/pgdata/linked-version'),
    );
    await expect(acquireNodeDirectoryStorage(root, template(), compatible())).rejects.toMatchObject(
      {
        code: 'corrupt',
        durability: 'unchanged',
      },
    );
  });

  it('does not publish a failed database outcome', async () => {
    const root = await temporaryRoot('failed');
    const lease = await acquireNodeDirectoryStorage(root, template(), compatible());
    await lease.close(pgdataDirectory('must-not-persist'), 'failed');

    const reopened = await acquireNodeDirectoryStorage(root, template(), compatible());
    expect(reopened.state).toBe('new');
    expect(reopened.mount.files['user/value']).toBeUndefined();
    await reopened.close(undefined, 'failed');
  });

  it('never treats unowned host entries as provider state', async () => {
    const root = await temporaryRoot('collision');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'current'), 'application data');

    const lease = await acquireNodeDirectoryStorage(root, template(), compatible());
    await lease.close(pgdataDirectory('isolated'), 'clean');
    expect(await readFile(join(root, 'current'), 'utf8')).toBe('application data');

    const poisoned = await temporaryRoot('reserved-collision');
    await mkdir(join(poisoned, '.oliphaunt-wasix-ts'), { recursive: true });
    await writeFile(join(poisoned, '.oliphaunt-wasix-ts', 'unowned'), 'keep');
    await expect(
      acquireNodeDirectoryStorage(poisoned, template(), compatible()),
    ).rejects.toMatchObject({ code: 'unavailable', durability: 'unchanged' });
    expect(await readFile(join(poisoned, '.oliphaunt-wasix-ts', 'unowned'), 'utf8')).toBe('keep');
  });

  it('elects exactly one owner during concurrent stale-lease recovery', async () => {
    for (let round = 0; round < 32; round += 1) {
      const root = await temporaryRoot(`stale-race-${round}`);
      const initialized = await acquireNodeDirectoryStorage(root, template(), compatible());
      await initialized.close(undefined, 'failed');
      const state = join(root, '.oliphaunt-wasix-ts');
      await createLockSlot(state, nodeDirectoryLockName(2_147_483_647, 'deadbeefdeadbeef'));

      const attempts = await Promise.allSettled([
        acquireNodeDirectoryStorage(root, template(), compatible(), 'aaaaaaaaaaaaaaaa'),
        acquireNodeDirectoryStorage(root, template(), compatible(), 'bbbbbbbbbbbbbbbb'),
      ]);
      const leases = attempts.flatMap((attempt) =>
        attempt.status === 'fulfilled' ? [attempt.value] : [],
      );
      const failures = attempts.flatMap((attempt) =>
        attempt.status === 'rejected' ? [attempt.reason] : [],
      );
      expect(leases).toHaveLength(1);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({ code: 'busy', durability: 'unchanged' });
      await leases[0]?.close(undefined, 'failed');
    }
  });

  it('fails closed instead of reaping an owner from another process namespace', async () => {
    const root = await temporaryRoot('foreign-owner');
    const initialized = await acquireNodeDirectoryStorage(root, template(), compatible());
    await initialized.close(undefined, 'failed');
    const state = join(root, '.oliphaunt-wasix-ts');
    const localName = nodeDirectoryLockName(2_147_483_647, 'deadbeefdeadbeef');
    const foreignName = localName.replace(
      /^(\.oliphaunt-lock-[lp]-)([0-9a-f])/u,
      (_, prefix: string, first: string) => `${prefix}${first === '0' ? '1' : '0'}`,
    );
    const slot = await createLockSlot(state, foreignName);

    await expect(acquireNodeDirectoryStorage(root, template(), compatible())).rejects.toMatchObject(
      { code: 'busy', durability: 'unchanged' },
    );
    expect(await readdir(slot)).toContain(foreignName);
  });

  it('recovers a locally owned lease left by an earlier boot', async () => {
    const root = await temporaryRoot('previous-boot-owner');
    const initialized = await acquireNodeDirectoryStorage(root, template(), compatible());
    await initialized.close(undefined, 'failed');
    const state = join(root, '.oliphaunt-wasix-ts');
    const localName = nodeDirectoryLockName(process.pid, 'previous-boot-token');
    if (!localName.startsWith('.oliphaunt-lock-l-')) return;
    const previousBootName = localName.replace(
      /^(\.oliphaunt-lock-l-[0-9a-f]{16}-)([0-9a-f])/u,
      (_, prefix: string, first: string) => `${prefix}${first === '0' ? '1' : '0'}`,
    );
    await createLockSlot(state, previousBootName);

    const recovered = await acquireNodeDirectoryStorage(root, template(), compatible());
    await recovered.close(undefined, 'failed');
  });

  it('elects one fixed-slot winner among many simultaneous contenders', async () => {
    const root = await temporaryRoot('many-contenders');
    const attempts = await Promise.allSettled(
      Array.from({ length: 32 }, (_, index) =>
        acquireNodeDirectoryStorage(
          root,
          template(),
          compatible(),
          `contender-${index.toString().padStart(6, '0')}`,
        ),
      ),
    );
    const leases = attempts.flatMap((attempt) =>
      attempt.status === 'fulfilled' ? [attempt.value] : [],
    );
    expect(leases).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(31);
    await leases[0]?.close(undefined, 'failed');
  });

  it('uses exact-owner retirement so delayed cleanup cannot remove a successor', async () => {
    const root = await temporaryRoot('retirement-aba');
    const initialized = await acquireNodeDirectoryStorage(root, template(), compatible());
    await initialized.close(undefined, 'failed');
    const state = join(root, '.oliphaunt-wasix-ts');
    const oldOwner = nodeDirectoryLockName(process.pid, 'old-owner-token-0001');
    const slot = await createLockSlot(state, oldOwner);

    // Model a cleaner that has claimed the old lease but is delayed before it
    // retires the now-empty fixed slot.
    await rmdir(join(slot, oldOwner));
    const successor = await acquireNodeDirectoryStorage(
      root,
      template(),
      compatible(),
      'successor-token-0001',
    );
    await releaseNodeDirectoryLock(state, oldOwner);

    const successorOwner = nodeDirectoryLockName(process.pid, 'successor-token-0001');
    expect(await readdir(join(state, NODE_DIRECTORY_LOCK_SLOT))).toEqual([successorOwner]);
    await successor.close(undefined, 'failed');
  });

  it('fails closed for malformed fixed-slot ownership state', async () => {
    const root = await temporaryRoot('malformed-lock');
    const initialized = await acquireNodeDirectoryStorage(root, template(), compatible());
    await initialized.close(undefined, 'failed');
    const state = join(root, '.oliphaunt-wasix-ts');
    const slot = join(state, NODE_DIRECTORY_LOCK_SLOT);
    await mkdir(slot);
    await mkdir(join(slot, nodeDirectoryLockName(process.pid, 'first-owner-token-1')));
    await mkdir(join(slot, nodeDirectoryLockName(process.pid, 'second-owner-token')));

    await expect(acquireNodeDirectoryStorage(root, template(), compatible())).rejects.toMatchObject(
      { code: 'busy', durability: 'unchanged' },
    );
  });

  it('recovers the recognized empty-slot cleanup transient', async () => {
    const root = await temporaryRoot('empty-lock');
    const initialized = await acquireNodeDirectoryStorage(root, template(), compatible());
    await initialized.close(undefined, 'failed');
    const state = join(root, '.oliphaunt-wasix-ts');
    await mkdir(join(state, NODE_DIRECTORY_LOCK_SLOT));

    const recovered = await acquireNodeDirectoryStorage(root, template(), compatible());
    await recovered.close(undefined, 'failed');
  });

  it('reaps abandoned pre-publication lock candidates after winning the fixed slot', async () => {
    const root = await temporaryRoot('candidate-recovery');
    const initialized = await acquireNodeDirectoryStorage(root, template(), compatible());
    await initialized.close(undefined, 'failed');
    const state = join(root, '.oliphaunt-wasix-ts');
    const abandoned = join(state, `${NODE_DIRECTORY_LOCK_CANDIDATE_PREFIX}abandoned-token-01`);
    await mkdir(abandoned);
    await mkdir(join(abandoned, nodeDirectoryLockName(2_147_483_647, 'abandoned-token-01')));

    const recovered = await acquireNodeDirectoryStorage(root, template(), compatible());
    expect((await readdir(state)).filter((name) => name.includes('candidate'))).toEqual([]);
    await recovered.close(undefined, 'failed');
  });

  it('rejects every concurrent contender while an established owner remains', async () => {
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
    expect(attempts).toHaveLength(2);
    for (const attempt of attempts) {
      expect(attempt.status).toBe('rejected');
      if (attempt.status === 'rejected') {
        expect(attempt.reason).toMatchObject({ code: 'busy', durability: 'unchanged' });
      }
    }

    await owner.close(undefined, 'failed');
    const reopened = await acquireNodeDirectoryStorage(root, template(), compatible());
    await reopened.close(undefined, 'failed');
  });
});

async function createLockSlot(state: string, ownerName: string): Promise<string> {
  const slot = join(state, NODE_DIRECTORY_LOCK_SLOT);
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
