import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { parseDatabaseRootDescriptor, parseDatabaseRootDescriptorText } from '../database-root.js';
import { nodeDirectoryLockPath, releaseNodeDirectoryLockSync } from '../node-directory-lock.js';
import {
  acquireNodeDirectoryStorage,
  restoreNodeDirectoryStorage,
} from '../storage/node-directory-provider.js';
import {
  WASIX_PHYSICAL_IDENTITY,
  type StorageDirectory,
  type WasixClusterSeedLoader,
  type WasixPhysicalIdentity,
} from '../storage-provider.js';

const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe('WASIX Node/Bun/Deno directory storage', () => {
  it('uses a managed root and hydrates a compatible reopen', async () => {
    const root = await temporaryRoot('space ünicode');
    const first = await acquireNodeDirectoryStorage(root, clusterSeed(), compatible());
    expect(first.state).toBe('new');

    await expect(
      acquireNodeDirectoryStorage(root, clusterSeed(), compatible()),
    ).rejects.toMatchObject({ code: 'busy', commitState: 'unchanged' });

    await first.close(pgdataDirectory('persisted'), 'clean');
    expect(await readFile(join(root, 'pgdata/PG_VERSION'), 'utf8')).toBe('18\n');
    expect(await readFile(join(root, 'pgdata/user/value'), 'utf8')).toBe('persisted');
    expect(JSON.parse(await readFile(join(root, '.oliphaunt.json'), 'utf8'))).toEqual({
      schema: 'oliphaunt-database-root-v1',
      engineFamily: 'wasix',
      pgdata: 'pgdata',
      postgresMajor: 18,
      physicalFormat: 'wasix-pg18-v1',
    });
    expect(await pathExists(join(root, '.oliphaunt-wasix-ts'))).toBe(false);

    const second = await acquireNodeDirectoryStorage(
      root,
      async () => {
        throw new Error('existing directory storage must not load the cluster seed');
      },
      compatible(),
    );
    expect(second.state).toBe('existing');
    if (second.mount === undefined) throw new Error('portable storage did not provide a mount');
    expect(new TextDecoder().decode(second.mount.files['user/value'])).toBe('persisted');
    await second.close(undefined, 'failed');
  });

  it('publishes only journaled current-state changes after the first generation', async () => {
    const root = await temporaryRoot('incremental');
    const lease = await acquireNodeDirectoryStorage(root, clusterSeed(), compatible());
    const directory = trackedPgdataDirectory('first');

    await lease.sync(directory, 'operation');
    const descriptor = await readFile(join(root, '.oliphaunt.json'));
    await writeFile(join(root, 'unrelated-host-marker'), 'outside adapter metadata');
    directory.setValue('second');
    await lease.sync(directory, 'operation');
    await lease.close(undefined, 'failed');

    expect(await readFile(join(root, 'pgdata/user/value'), 'utf8')).toBe('second');
    expect(await readFile(join(root, 'unrelated-host-marker'), 'utf8')).toBe(
      'outside adapter metadata',
    );
    expect(await readFile(join(root, '.oliphaunt.json'))).toEqual(descriptor);
  });

  it('rejects physical format mismatches and symbolic links', async () => {
    const root = await temporaryRoot('fail-closed');
    const first = await acquireNodeDirectoryStorage(root, clusterSeed(), compatible());
    await first.close(pgdataDirectory('complete'), 'clean');

    const descriptorPath = join(root, '.oliphaunt.json');
    const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8')) as Record<
      string,
      unknown
    >;
    await writeFile(
      descriptorPath,
      JSON.stringify({ ...descriptor, physicalFormat: 'wasix-pg18-v2' }),
    );
    await expect(
      acquireNodeDirectoryStorage(root, clusterSeed(), compatible()),
    ).rejects.toMatchObject({ code: 'corrupt', commitState: 'unchanged' });
    await writeFile(descriptorPath, JSON.stringify(descriptor));

    await symlink(join(root, 'pgdata/PG_VERSION'), join(root, 'pgdata/linked-version'));
    await expect(
      acquireNodeDirectoryStorage(root, clusterSeed(), compatible()),
    ).rejects.toMatchObject({ code: 'corrupt', commitState: 'unchanged' });
  });

  it('does not publish a failed database outcome', async () => {
    const root = await temporaryRoot('failed');
    const lease = await acquireNodeDirectoryStorage(root, clusterSeed(), compatible());
    await lease.close(pgdataDirectory('must-not-persist'), 'failed');

    expect(await pathExists(join(root, 'pgdata/PG_VERSION'))).toBe(false);
    const reopened = await acquireNodeDirectoryStorage(root, clusterSeed(), compatible());
    expect(reopened.state).toBe('new');
    await reopened.close(undefined, 'failed');
  });

  it('removes provider-owned PGDATA when first publication fails before the descriptor', async () => {
    const root = await temporaryRoot('failed-first-publication');
    const lease = await acquireNodeDirectoryStorage(root, clusterSeed(), compatible());
    await mkdir(join(root, '.oliphaunt.json'));

    await expect(lease.sync(pgdataDirectory('partial'), 'operation')).rejects.toMatchObject({
      code: 'publication-failed',
      commitState: 'unknown',
    });
    expect(await pathExists(join(root, 'pgdata/PG_VERSION'))).toBe(true);

    await lease.close(undefined, 'failed');
    expect(await pathExists(join(root, 'pgdata'))).toBe(false);
    expect(await pathExists(join(root, '.oliphaunt.json'))).toBe(true);
  });

  it('rejects every unexpected managed-root entry without migration modes', async () => {
    const root = await temporaryRoot('collision');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'application-data'), 'keep');
    await expect(
      acquireNodeDirectoryStorage(root, clusterSeed(), compatible()),
    ).rejects.toMatchObject({ code: 'corrupt', commitState: 'unchanged' });
    expect(await readFile(join(root, 'application-data'), 'utf8')).toBe('keep');

    const raw = await temporaryRoot('raw');
    await mkdir(raw, { recursive: true });
    await writeFile(join(raw, 'PG_VERSION'), '18\n');
    await expect(
      acquireNodeDirectoryStorage(raw, clusterSeed(), compatible()),
    ).rejects.toMatchObject({
      code: 'corrupt',
      commitState: 'unchanged',
    });

    const partial = await temporaryRoot('partial');
    await mkdir(partial, { recursive: true });
    await writeFile(
      join(partial, '.oliphaunt.json'),
      JSON.stringify({
        schema: 'oliphaunt-database-root-v1',
        engineFamily: 'wasix',
        pgdata: 'pgdata',
        postgresMajor: 18,
        physicalFormat: 'wasix-pg18-v1',
      }),
    );
    await expect(
      acquireNodeDirectoryStorage(partial, clusterSeed(), compatible()),
    ).rejects.toMatchObject({ code: 'incomplete', commitState: 'unchanged' });

    const native = await temporaryRoot('native');
    await mkdir(join(native, 'pgdata/global'), { recursive: true });
    await mkdir(join(native, 'pgdata/pg_wal'));
    await writeFile(join(native, 'pgdata/PG_VERSION'), '18\n');
    await writeFile(join(native, 'pgdata/global/pg_control'), Uint8Array.of(1));
    await writeFile(
      join(native, '.oliphaunt.json'),
      `${JSON.stringify({
        schema: 'oliphaunt-database-root-v1',
        engineFamily: 'native',
        pgdata: 'pgdata',
        postgresMajor: 18,
        physicalFormat: 'native-pg18-v1',
      })}\n`,
    );
    const nativeLease = await acquireNodeDirectoryStorage(native, clusterSeed(), compatible());
    expect(nativeLease.state).toBe('existing');
    await nativeLease.close(undefined, 'failed');
  });

  it('rejects interrupted publication files instead of silently mutating the root', async () => {
    const root = await temporaryRoot('interrupted-publication');
    const first = await acquireNodeDirectoryStorage(root, clusterSeed(), compatible());
    await first.close(pgdataDirectory('complete'), 'clean');

    await writeFile(join(root, '.oliphaunt.json.oliphaunt-write-abandoned'), 'partial');
    await expect(
      acquireNodeDirectoryStorage(root, clusterSeed(), compatible()),
    ).rejects.toMatchObject({ code: 'corrupt', commitState: 'unchanged' });
  });

  it('matches the shared database-root contract', async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL('../../../../shared/fixtures/storage/database-root.json', import.meta.url),
        'utf8',
      ),
    ) as {
      descriptor: string;
      schema: string;
      pgdata: string;
      postgresMajor: number;
      families: {
        native: { physicalFormat: string };
        wasix: { physicalFormat: string };
      };
      validDescriptors: unknown[];
      invalidDescriptors: { case: string; value: unknown }[];
      malformedJson: { case: string; value: string }[];
    };
    expect(fixture.descriptor).toBe('.oliphaunt.json');
    expect(fixture.schema).toBe('oliphaunt-database-root-v1');
    expect(fixture.pgdata).toBe('pgdata');
    expect(fixture.postgresMajor).toBe(18);
    expect(fixture.families.native.physicalFormat).toBe('native-pg18-v1');
    expect(fixture.families.wasix.physicalFormat).toBe('wasix-pg18-v1');
    for (const descriptor of fixture.validDescriptors) {
      expect(parseDatabaseRootDescriptor(descriptor)).toBeDefined();
    }
    for (const invalid of fixture.invalidDescriptors) {
      expect(parseDatabaseRootDescriptor(invalid.value), invalid.case).toBeUndefined();
    }
    for (const malformed of fixture.malformedJson) {
      expect(parseDatabaseRootDescriptorText(malformed.value), malformed.case).toBeUndefined();
    }

    const valid = JSON.stringify(fixture.validDescriptors[1], undefined, 2);
    expect(parseDatabaseRootDescriptorText(valid)).toEqual(fixture.validDescriptors[1]);
    expect(
      parseDatabaseRootDescriptorText(
        valid.replace('"schema":', '"schema": "oliphaunt-database-root-v1", "schema":'),
      ),
    ).toBeUndefined();
    expect(
      parseDatabaseRootDescriptorText(valid.replace('"pgdata"', '"nested": {}, "pgdata"')),
    ).toBeUndefined();
  });

  it('uses one stable binding-local lock for open and restore', async () => {
    const root = await temporaryRoot('open-restore-lock');
    const owner = await acquireNodeDirectoryStorage(root, clusterSeed(), compatible());

    await expect(
      restoreNodeDirectoryStorage(root, storedSnapshot('restored'), compatible()),
    ).rejects.toMatchObject({ code: 'busy', commitState: 'unchanged' });

    await owner.close(undefined, 'failed');
  });

  it('uses one lock identity through a symlinked parent', async () => {
    const parent = await temporaryRoot('parent-alias');
    const realParent = join(parent, 'real');
    const aliasParent = join(parent, 'alias');
    await mkdir(realParent, { recursive: true });
    await symlink(realParent, aliasParent, 'dir');
    const realRoot = join(realParent, 'database');
    const aliasRoot = join(aliasParent, 'database');
    const lexicalRoot = `${realParent}/../real/database`;
    const owner = await acquireNodeDirectoryStorage(realRoot, clusterSeed(), compatible());

    for (const spelling of [lexicalRoot, aliasRoot]) {
      await expect(
        acquireNodeDirectoryStorage(spelling, clusterSeed(), compatible()),
      ).rejects.toMatchObject({ code: 'busy', commitState: 'unchanged' });
      await expect(
        restoreNodeDirectoryStorage(spelling, storedSnapshot('restored'), compatible()),
      ).rejects.toMatchObject({ code: 'busy', commitState: 'unchanged' });
    }

    await owner.close(undefined, 'failed');

    await restoreNodeDirectoryStorage(aliasRoot, storedSnapshot('restored'), compatible());
    expect(await readdir(realRoot)).toContain('pgdata');
  });

  it('does not remove an empty restore destination before staging succeeds', async () => {
    const root = await temporaryRoot('restore-staging-failure');
    await mkdir(root, { recursive: true });
    const invalid = {
      ...storedSnapshot('restored'),
      files: [{ path: '../escape', bytes: Uint8Array.of(1) }],
    };

    await expect(restoreNodeDirectoryStorage(root, invalid, compatible())).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  });

  it('elects exactly one concurrent owner', async () => {
    const root = await temporaryRoot('ownership-race');
    const attempts = await Promise.allSettled([
      acquireNodeDirectoryStorage(root, clusterSeed(), compatible(), 'aaaaaaaaaaaaaaaa'),
      acquireNodeDirectoryStorage(root, clusterSeed(), compatible(), 'bbbbbbbbbbbbbbbb'),
    ]);
    const leases = attempts.flatMap((attempt) =>
      attempt.status === 'fulfilled' ? [attempt.value] : [],
    );
    expect(leases).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
    await leases[0]?.close(undefined, 'failed');
  });

  it('fails closed on an abandoned ownership marker', async () => {
    const root = await temporaryRoot('abandoned-owner');
    const slot = nodeDirectoryLockPath(root);
    await mkdir(join(slot, 'owner-abandoned-token-01'), { recursive: true });

    await expect(
      acquireNodeDirectoryStorage(root, clusterSeed(), compatible()),
    ).rejects.toMatchObject({ code: 'busy', commitState: 'unchanged' });
    await expect(acquireNodeDirectoryStorage(root, clusterSeed(), compatible())).rejects.toThrow(
      /remove the stale lock directory/,
    );
    expect(await pathExists(slot)).toBe(true);
  });

  it('cleans up only the worker owner token it was given', async () => {
    const root = await temporaryRoot('exact-owner-cleanup');
    const owner = await acquireNodeDirectoryStorage(
      root,
      clusterSeed(),
      compatible(),
      'mmmmmmmmmmmmmmmm',
    );

    releaseNodeDirectoryLockSync(root, 'aaaaaaaaaaaaaaaa');
    await expect(
      acquireNodeDirectoryStorage(root, clusterSeed(), compatible(), 'aaaaaaaaaaaaaaaa'),
    ).rejects.toMatchObject({ code: 'busy', commitState: 'unchanged' });

    releaseNodeDirectoryLockSync(root, 'mmmmmmmmmmmmmmmm');
    await owner.close(undefined, 'failed');
    const reopened = await acquireNodeDirectoryStorage(root, clusterSeed(), compatible());
    await reopened.close(undefined, 'failed');
  });
});

async function temporaryRoot(suffix: string): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'oliphaunt-wasix-node-storage-'));
  scratch.push(parent);
  return join(parent, suffix);
}

function compatible(): WasixPhysicalIdentity {
  return { ...WASIX_PHYSICAL_IDENTITY };
}

function clusterSeed(): WasixClusterSeedLoader {
  const mount = {
    directories: ['global', 'pg_wal'],
    files: {
      PG_VERSION: new TextEncoder().encode('18\n'),
      'global/pg_control': Uint8Array.of(1),
    },
  };
  return async () => mount;
}

function storedSnapshot(value: string) {
  return {
    schema: 'oliphaunt-wasix-directory-snapshot-v1' as const,
    directories: ['global', 'pg_wal', 'user'],
    files: [
      { path: 'PG_VERSION', bytes: new TextEncoder().encode('18\n') },
      { path: 'global/pg_control', bytes: Uint8Array.of(1) },
      { path: 'user/value', bytes: new TextEncoder().encode(value) },
    ],
  };
}

function pgdataDirectory(value: string): StorageDirectory {
  return {
    async readDir(path) {
      if (path === '') {
        return [
          { type: 'file', name: 'PG_VERSION' },
          { type: 'dir', name: 'global' },
          { type: 'dir', name: 'pg_wal' },
          { type: 'dir', name: 'user' },
          { type: 'file', name: 'postmaster.pid' },
        ];
      }
      if (path === 'global') return [{ type: 'file', name: 'pg_control' }];
      if (path === 'pg_wal') return [];
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
      if (path === '' || path === 'global' || path === 'pg_wal' || path === 'user') return 'dir';
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
