import type { WasixDirectoryMount } from './archive.js';
import { DATABASE_ROOT_POSTGRES_MAJOR, WASIX_PHYSICAL_FORMAT } from './database-root.js';
import { WasixStorageError } from './errors.js';
import type { Directory } from './host/index.mjs';
import type { SerializedWasixStorage } from './storage.js';
import type { StoredSnapshot } from './storage-snapshot.js';
import { validateIndexedDbDatabaseName, validateOpfsDatabaseName } from './storage.js';

/** Stable fields that determine whether a WASIX runtime may open stored PGDATA. */
export type WasixPhysicalIdentity = Readonly<{
  schema: 'oliphaunt-physical-format-v1';
  engineFamily: 'wasix';
  postgresMajor: number;
  physicalFormat: string;
}>;

export const WASIX_PHYSICAL_IDENTITY: WasixPhysicalIdentity = Object.freeze({
  schema: 'oliphaunt-physical-format-v1',
  engineFamily: 'wasix',
  postgresMajor: DATABASE_ROOT_POSTGRES_MAJOR,
  physicalFormat: WASIX_PHYSICAL_FORMAT,
});

export type StorageDirectoryEntry = Readonly<{
  type: 'dir' | 'file' | 'unknown';
  name: string;
}>;

/** Narrow surface currently offered by Wasmer's in-memory `Directory`. */
export type StorageDirectory = {
  readDir(path: string): Promise<StorageDirectoryEntry[]>;
  readFile(path: string): Promise<Uint8Array>;
  /** Host-patched mutation journal. Older/untracked directories fall back to a full scan. */
  changedPaths?(): readonly string[] | Promise<readonly string[]>;
  clearChanges?(): void | Promise<void>;
  entryType?(path: string): string | Promise<string>;
};

/** Internal publication strength; `full` is used for initialization, not SQL dispatch. */
export type WasixStorageSyncBoundary = 'operation' | 'full' | 'close';

/** Load the package-owned seed only after exclusive storage inspection finds a new root. */
export type WasixClusterSeedLoader = () => Promise<WasixDirectoryMount>;

export type WasixStorageLease = {
  /** Whether PGDATA came from the packaged cluster seed or persistent storage. */
  readonly state: 'new' | 'existing';
  /** Initial contents for a portable `/base` Wasmer memory mount. */
  readonly mount?: WasixDirectoryMount;
  /** Optional direct PGDATA materializer; portable providers omit it. */
  createPgdataDirectory?(DirectoryConstructor: typeof Directory): Promise<Directory>;
  /** Complete the provider's PostgreSQL-safe persistence boundary. */
  sync(directory: StorageDirectory, boundary: WasixStorageSyncBoundary): Promise<void>;
  close(directory: StorageDirectory | undefined, outcome: 'clean' | 'failed'): Promise<void>;
};

export type NodeDirectoryStorageAcquirer = (
  path: string,
  loadClusterSeed: WasixClusterSeedLoader,
  identity: WasixPhysicalIdentity,
  ownerToken?: string,
) => Promise<WasixStorageLease>;

export type NodeDirectoryStorageRestorer = (
  path: string,
  snapshot: StoredSnapshot,
  identity: WasixPhysicalIdentity,
  ownerToken?: string,
) => Promise<void>;

let acquireNodeDirectory: NodeDirectoryStorageAcquirer | undefined;
let restoreNodeDirectory: NodeDirectoryStorageRestorer | undefined;

/** @internal Installed only by a Node host realm so browser graphs stay Node-free. */
export function installNodeDirectoryStorageProvider(acquire: NodeDirectoryStorageAcquirer): void {
  acquireNodeDirectory = acquire;
}

/** @internal Installed only by a Node host realm so browser graphs stay Node-free. */
export function installNodeDirectoryStorageRestorer(restore: NodeDirectoryStorageRestorer): void {
  restoreNodeDirectory = restore;
}

/** Restore a validated snapshot into a closed, empty persistent destination. */
export async function restoreWasixStorage(
  storage: SerializedWasixStorage,
  snapshot: StoredSnapshot,
  identity: WasixPhysicalIdentity,
): Promise<void> {
  switch (storage.kind) {
    case 'memory':
      throw new WasixStorageError('physical restore requires persistent WASIX storage', {
        code: 'unavailable',
        commitState: 'unchanged',
      });
    case 'indexed-db': {
      validateIndexedDbDatabaseName(storage.name);
      const { restoreIndexedDbStorage } = await import('./storage/indexed-db-provider.js');
      return restoreIndexedDbStorage(storage.name, snapshot, identity);
    }
    case 'opfs': {
      validateOpfsDatabaseName(storage.name);
      const { restoreOpfsStorage } = await import('./storage/opfs-provider.js');
      return restoreOpfsStorage(storage.name, snapshot, identity);
    }
    case 'directory':
      if (restoreNodeDirectory === undefined) {
        throw new WasixStorageError(
          'directory restore is unavailable in this @oliphaunt/wasix-ts host',
          { code: 'unavailable', commitState: 'unchanged' },
        );
      }
      return restoreNodeDirectory(storage.path, snapshot, identity, storage.ownerToken);
  }
}

export async function acquireWasixStorage(
  storage: SerializedWasixStorage,
  loadClusterSeed: WasixClusterSeedLoader,
  identity: WasixPhysicalIdentity,
): Promise<WasixStorageLease> {
  if (storage.schema !== 'oliphaunt-wasix-storage-v1') {
    throw new WasixStorageError('WASIX storage descriptor has an unsupported schema', {
      code: 'unavailable',
      commitState: 'unchanged',
    });
  }
  switch (storage.kind) {
    case 'memory':
      return memoryLease(await loadClusterSeed());
    case 'indexed-db': {
      validateIndexedDbDatabaseName(storage.name);
      const { acquireIndexedDbStorage } = await import('./storage/indexed-db-provider.js');
      return acquireIndexedDbStorage(storage.name, loadClusterSeed, identity);
    }
    case 'opfs': {
      validateOpfsDatabaseName(storage.name);
      const { acquireOpfsStorage } = await import('./storage/opfs-provider.js');
      return acquireOpfsStorage(storage.name, loadClusterSeed, identity);
    }
    case 'directory':
      if (acquireNodeDirectory === undefined) {
        throw new WasixStorageError(
          'directory storage is unavailable in this @oliphaunt/wasix-ts host',
          {
            code: 'unavailable',
            commitState: 'unchanged',
          },
        );
      }
      return acquireNodeDirectory(storage.path, loadClusterSeed, identity, storage.ownerToken);
  }
}

export function assertWasixPhysicalIdentity(
  identity: WasixPhysicalIdentity,
): WasixPhysicalIdentity {
  if (
    identity.schema !== WASIX_PHYSICAL_IDENTITY.schema ||
    identity.engineFamily !== WASIX_PHYSICAL_IDENTITY.engineFamily ||
    identity.postgresMajor !== WASIX_PHYSICAL_IDENTITY.postgresMajor ||
    identity.physicalFormat !== WASIX_PHYSICAL_IDENTITY.physicalFormat
  ) {
    throw new TypeError('WASIX storage has an unsupported physical identity');
  }
  return identity;
}

export function physicalIdentityMatches(stored: unknown, selected: WasixPhysicalIdentity): boolean {
  const storedKey = parseWasixPhysicalIdentity(stored);
  if (storedKey === undefined) {
    throw new TypeError('WASIX storage has malformed physical identity metadata');
  }
  const selectedKey = assertWasixPhysicalIdentity(selected);
  return (
    storedKey.schema === selectedKey.schema &&
    storedKey.engineFamily === selectedKey.engineFamily &&
    storedKey.postgresMajor === selectedKey.postgresMajor &&
    storedKey.physicalFormat === selectedKey.physicalFormat
  );
}

function parseWasixPhysicalIdentity(value: unknown): WasixPhysicalIdentity | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const key = value as Record<string, unknown>;
  const keys = Object.keys(key).sort();
  if (
    keys.length !== 4 ||
    keys[0] !== 'engineFamily' ||
    keys[1] !== 'physicalFormat' ||
    keys[2] !== 'postgresMajor' ||
    keys[3] !== 'schema' ||
    key.schema !== 'oliphaunt-physical-format-v1' ||
    key.engineFamily !== 'wasix' ||
    !Number.isInteger(key.postgresMajor) ||
    (key.postgresMajor as number) <= 0 ||
    typeof key.physicalFormat !== 'string' ||
    key.physicalFormat.length === 0
  ) {
    return undefined;
  }
  return key as WasixPhysicalIdentity;
}

/** Stable JSON for hashing or comparing JSON-compatible runtime identities. */
export function canonicalJson(value: unknown): string {
  const active = new Set<object>();
  const canonicalize = (candidate: unknown): unknown => {
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') {
      return candidate;
    }
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) {
        throw new TypeError('JSON identity contains a non-finite number');
      }
      return candidate;
    }
    if (typeof candidate !== 'object') {
      throw new TypeError('identity is not JSON-compatible');
    }
    if (active.has(candidate)) {
      throw new TypeError('identity contains a cycle');
    }
    active.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        return candidate.map(canonicalize);
      }
      const record = candidate as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(record)
          .sort()
          .map((key) => [key, canonicalize(record[key])]),
      );
    } finally {
      active.delete(candidate);
    }
  };
  return JSON.stringify(canonicalize(value));
}

function memoryLease(clusterSeed: WasixDirectoryMount): WasixStorageLease {
  return {
    state: 'new',
    mount: clusterSeed,
    async sync() {},
    async close() {},
  };
}
