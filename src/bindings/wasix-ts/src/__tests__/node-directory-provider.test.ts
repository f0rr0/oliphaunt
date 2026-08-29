import { link, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsCommit = vi.hoisted(() => ({ directories: [] as string[] }));

vi.mock('../node-fs-commit-state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../node-fs-commit-state.js')>();
  return {
    ...actual,
    async syncNodeDirectory(path: string) {
      fsCommit.directories.push(path);
      await actual.syncNodeDirectory(path);
    },
  };
});

import { parseDatabaseRootDescriptor, parseDatabaseRootDescriptorText } from '../database-root.js';
import { nodeDirectoryLockPath, releaseNodeDirectoryLockSync } from '../node-directory-lock.js';
import {
  acquireNodeDirectoryStorage,
  restoreNodeDirectoryStorage,
} from '../storage/node-directory-provider.js';
import {
  type StorageDirectory,
  WASIX_PHYSICAL_IDENTITY,
  type WasixClusterSeedLoader,
  type WasixPhysicalIdentity,
  type WasixStorageLease,
} from '../storage-provider.js';

const scratch: string[] = [];

beforeEach(() => {
  fsCommit.directories.length = 0;
});

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe('WASIX Node/Bun/Deno directory storage', () => {
  it('rejects an unsupported identity before creating or seeding a managed root', async () => {
    const root = await temporaryRoot('invalid-identity');
    let seedLoads = 0;
    await expect(
      acquireNodeDirectoryStorage(
        root,
        async () => {
          seedLoads += 1;
          return clusterSeed()();
        },
        { ...compatible(), physicalFormat: 'wasix-pg18-unsupported' },
      ),
    ).rejects.toThrow(/unsupported physical identity/u);

    expect(seedLoads).toBe(0);
    expect(await pathExists(root)).toBe(false);
    expect(await pathExists(nodeDirectoryLockPath(root))).toBe(false);
  });

  it('fsyncs each newly created managed-root parent before seeding PGDATA', async () => {
    const top = await temporaryRoot('durable-root');
    const root = join(top, 'nested', 'database');
    const lease = await acquireNodeDirectoryStorage(root, clusterSeed(), compatible());

    expect(fsCommit.directories.slice(0, 3)).toEqual([join(top, '..'), top, join(top, 'nested')]);
    await lease.close(undefined, 'failed');
  });

  it('publishes a fresh direct generation only at its full initialization boundary and reopens it', async () => {
    const root = await temporaryRoot('direct-initialization');
    const lease = await acquireNodeDirectoryStorage(root, clusterSeed(), compatible());
    expect(lease.state).toBe('new');
    expect(await pathExists(join(root, 'pgdata/PG_VERSION'))).toBe(true);
    expect(await pathExists(join(root, '.oliphaunt.json'))).toBe(false);
    const materialized = await materializeDirectLease(lease);

    await lease.sync(materialized.directory, 'operation');
    expect(await pathExists(join(root, '.oliphaunt.json'))).toBe(false);
    await lease.sync(materialized.directory, 'full');
    expect(
      parseDatabaseRootDescriptorText(await readFile(join(root, '.oliphaunt.json'), 'utf8')),
    ).toMatchObject({ engineFamily: 'wasix', pgdata: 'pgdata', postgresMajor: 18 });
    await lease.close(materialized.directory, 'clean');
    expect(materialized.freed()).toBe(true);

    const reopened = await acquireNodeDirectoryStorage(
      root,
      async () => {
        throw new Error('a direct reopen must not load the cluster seed');
      },
      compatible(),
    );
    expect(reopened.state).toBe('existing');
    const second = await materializeDirectLease(reopened);
    await reopened.close(second.directory, 'clean');
  });

  it('removes a failed unpublished direct seed', async () => {
    const root = await temporaryRoot('direct-unpublished');
    const lease = await acquireNodeDirectoryStorage(root, clusterSeed(), compatible());
    const materialized = await materializeDirectLease(lease);
    await lease.close(materialized.directory, 'failed');

    expect(await pathExists(join(root, 'pgdata'))).toBe(false);
    expect(await pathExists(join(root, '.oliphaunt.json'))).toBe(false);
    const reopened = await acquireNodeDirectoryStorage(root, clusterSeed(), compatible());
    expect(reopened.state).toBe('new');
    await reopened.close(undefined, 'failed');
  });

  it('rejects linked PGDATA before mounting it', async () => {
    const root = await temporaryRoot('direct-links');
    const initial = await acquireNodeDirectoryStorage(root, clusterSeed(), compatible());
    const materialized = await materializeDirectLease(initial);
    await initial.sync(materialized.directory, 'full');
    await initial.close(materialized.directory, 'clean');

    const external = join(root, '..', 'external-hardlink-target');
    await writeFile(external, 'external');
    await link(external, join(root, 'pgdata/hardlink'));
    await expect(
      acquireNodeDirectoryStorage(root, clusterSeed(), compatible()),
    ).rejects.toMatchObject({ code: 'corrupt', commitState: 'unchanged' });
    await rm(join(root, 'pgdata/hardlink'));

    await symlink(external, join(root, 'pgdata/symlink'));
    await expect(
      acquireNodeDirectoryStorage(root, clusterSeed(), compatible()),
    ).rejects.toMatchObject({ code: 'corrupt', commitState: 'unchanged' });
  });

  it('keeps a poisoned direct generation locked until failed close releases ownership', async () => {
    const root = await temporaryRoot('direct-poison-lock');
    const lease = await acquireNodeDirectoryStorage(root, clusterSeed(), compatible());
    const materialized = await materializeDirectLease(lease);
    await lease.sync(materialized.directory, 'full');

    const opened = materialized.backend.request(7, 'dirty', new Uint8Array(), 0, 0, 2 | 4);
    expect(opened[0]).toBe(0);
    expect(
      materialized.backend.request(10, '', new TextEncoder().encode('dirty'), opened[2], 0, 0)[0],
    ).toBe(0);
    expect(materialized.backend.request(8, '', new Uint8Array(), opened[2], 0, 0)[0]).toBe(0);

    const outside = join(root, '..', 'direct-poison-outside');
    await writeFile(outside, 'outside');
    await rm(join(root, 'pgdata/dirty'));
    await symlink(outside, join(root, 'pgdata/dirty'));
    await expect(lease.sync(materialized.directory, 'operation')).rejects.toMatchObject({
      code: 'publication-failed',
      commitState: 'unknown',
    });
    expect(materialized.backend.request(1, 'PG_VERSION', new Uint8Array(), 0, 0, 0)[0]).toBe(11);
    await expect(
      acquireNodeDirectoryStorage(root, clusterSeed(), compatible()),
    ).rejects.toMatchObject({ code: 'busy', commitState: 'unchanged' });

    await lease.close(materialized.directory, 'failed');
    expect(materialized.freed()).toBe(true);
    await rm(join(root, 'pgdata/dirty'));
    const reopened = await acquireNodeDirectoryStorage(root, clusterSeed(), compatible());
    expect(reopened.state).toBe('existing');
    await reopened.close(undefined, 'failed');
  });

  it('uses a managed root and reopens a compatible direct generation', async () => {
    const root = await temporaryRoot('space ünicode');
    const first = await acquireNodeDirectoryStorage(root, clusterSeed(), compatible());
    expect(first.state).toBe('new');

    await expect(
      acquireNodeDirectoryStorage(root, clusterSeed(), compatible()),
    ).rejects.toMatchObject({ code: 'busy', commitState: 'unchanged' });

    const materialized = await materializeDirectLease(first);
    await first.sync(materialized.directory, 'full');
    await first.close(materialized.directory, 'clean');
    expect(await readFile(join(root, 'pgdata/PG_VERSION'), 'utf8')).toBe('18\n');
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
    const reopened = await materializeDirectLease(second);
    await second.close(reopened.directory, 'clean');
  });

  it('rejects physical format mismatches and symbolic links', async () => {
    const root = await temporaryRoot('fail-closed');
    const first = await acquireNodeDirectoryStorage(root, clusterSeed(), compatible());
    const materialized = await materializeDirectLease(first);
    await first.sync(materialized.directory, 'full');
    await first.close(materialized.directory, 'clean');

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

  it('removes provider-owned PGDATA when first publication fails before the descriptor', async () => {
    const root = await temporaryRoot('failed-first-publication');
    const lease = await acquireNodeDirectoryStorage(root, clusterSeed(), compatible());
    const materialized = await materializeDirectLease(lease);
    await mkdir(join(root, '.oliphaunt.json'));

    await expect(lease.sync(materialized.directory, 'full')).rejects.toMatchObject({
      code: 'publication-failed',
      commitState: 'unknown',
    });
    expect(await pathExists(join(root, 'pgdata/PG_VERSION'))).toBe(true);

    await lease.close(materialized.directory, 'failed');
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
    const nativeDescriptor = await readFile(join(native, '.oliphaunt.json'));
    const nativeVersion = await readFile(join(native, 'pgdata/PG_VERSION'));
    await expect(
      acquireNodeDirectoryStorage(native, clusterSeed(), compatible()),
    ).rejects.toMatchObject({ code: 'incompatible', commitState: 'unchanged' });
    expect(await readFile(join(native, '.oliphaunt.json'))).toEqual(nativeDescriptor);
    expect(await readFile(join(native, 'pgdata/PG_VERSION'))).toEqual(nativeVersion);
  });

  it('rejects interrupted publication files instead of silently mutating the root', async () => {
    const root = await temporaryRoot('interrupted-publication');
    const first = await acquireNodeDirectoryStorage(root, clusterSeed(), compatible());
    const materialized = await materializeDirectLease(first);
    await first.sync(materialized.directory, 'full');
    await first.close(materialized.directory, 'clean');

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

async function materializeDirectLease(
  lease: Pick<WasixStorageLease, 'createPgdataDirectory'>,
): Promise<{ directory: StorageDirectory; backend: DirectBackend; freed(): boolean }> {
  if (lease.createPgdataDirectory === undefined) throw new Error('expected a direct lease');
  let backend: DirectBackend | undefined;
  let isFreed = false;
  const directory = {
    async readTextFile(path: string) {
      if (backend === undefined) throw new Error('direct backend was not installed');
      const opened = backend.request(7, path, new Uint8Array(), 0, 0, 1);
      if (opened[0] !== 0) throw new Error(`could not open ${path}: ${opened[0]}`);
      const bytes = new Uint8Array(64);
      const read = backend.request(9, '', bytes, opened[2], 0, 0);
      const closed = backend.request(8, '', new Uint8Array(), opened[2], 0, 0);
      if (read[0] !== 0 || closed[0] !== 0) throw new Error(`could not read ${path}`);
      return new TextDecoder().decode(bytes.subarray(0, read[1]));
    },
    async readDir() {
      return [];
    },
    async readFile() {
      return new Uint8Array();
    },
    free() {
      isFreed = true;
    },
  };
  await lease.createPgdataDirectory({
    createSync(candidate: typeof backend) {
      backend = candidate;
      return directory;
    },
  } as never);
  if (backend === undefined) throw new Error('direct backend was not installed');
  return { directory, backend, freed: () => isFreed };
}

type DirectBackend = {
  request(
    opcode: number,
    path: string,
    bytes: Uint8Array,
    arg0: number,
    arg1: number,
    flags: number,
  ): [number, number, number, number];
};

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
