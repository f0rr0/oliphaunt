import type { WasixDirectoryMount } from './archive.js';
import { DATABASE_ROOT_POSTGRES_MAJOR, WASIX_PHYSICAL_FORMAT } from './database-root.js';
import { WasixStorageError } from './errors.js';
import type { SerializedWasixStorage } from './storage.js';
import type { StoredSnapshot } from './storage-snapshot.js';
import { validateIndexedDbDatabaseName, validateOpfsDatabaseName } from './storage.js';

export type WasixStorageCompatibility = Readonly<{
  schema: 'oliphaunt-wasix-pgdata-compatibility-v1';
  runtime: Readonly<{
    product: 'liboliphaunt-wasix';
    version: string;
    manifestSha256: string;
    runtimeArchiveSha256: string;
    pgdataTemplateSha256: string;
    moduleSha256: string;
    postgresVersion: string;
  }>;
  extensions: readonly Readonly<{
    sqlName: string;
    product: string;
    version: string;
    archiveSha256: string;
    installContract: string;
  }>[];
}>;

/** Stable fields that determine whether a WASIX runtime may open stored PGDATA. */
export type WasixStorageCompatibilityKey = Readonly<{
  schema: 'oliphaunt-physical-format-v1';
  engineFamily: 'wasix';
  postgresMajor: number;
  physicalFormat: string;
}>;

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

export type WasixStorageSyncBoundary = 'operation' | 'checkpoint' | 'close';

export type WasixStorageLease = {
  /** Whether PGDATA came from the packaged template or a durable generation. */
  readonly state: 'new' | 'existing';
  /** Initial contents for the worker-owned `/base` Wasmer memory mount. */
  readonly mount: WasixDirectoryMount;
  /** Publish journaled mutations at a PostgreSQL-safe host boundary. */
  sync(directory: StorageDirectory, boundary: WasixStorageSyncBoundary): Promise<void>;
  close(directory: StorageDirectory | undefined, outcome: 'clean' | 'failed'): Promise<void>;
};

export type NodeDirectoryStorageAcquirer = (
  path: string,
  template: WasixDirectoryMount,
  compatibility: WasixStorageCompatibility,
  ownerToken?: string,
) => Promise<WasixStorageLease>;

export type NodeDirectoryStorageRestorer = (
  path: string,
  snapshot: StoredSnapshot,
  compatibility: WasixStorageCompatibility,
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
  compatibility: WasixStorageCompatibility,
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
      return restoreIndexedDbStorage(storage.name, snapshot, compatibility);
    }
    case 'opfs': {
      validateOpfsDatabaseName(storage.name);
      const { restoreOpfsStorage } = await import('./storage/opfs-provider.js');
      return restoreOpfsStorage(storage.name, snapshot, compatibility);
    }
    case 'directory':
      if (restoreNodeDirectory === undefined) {
        throw new WasixStorageError(
          'directory restore is unavailable in this @oliphaunt/wasix-ts host',
          { code: 'unavailable', commitState: 'unchanged' },
        );
      }
      return restoreNodeDirectory(storage.path, snapshot, compatibility);
  }
}

export async function acquireWasixStorage(
  storage: SerializedWasixStorage,
  template: WasixDirectoryMount,
  compatibility: WasixStorageCompatibility,
): Promise<WasixStorageLease> {
  if (storage.schema !== 'oliphaunt-wasix-storage-v1') {
    throw new WasixStorageError('WASIX storage descriptor has an unsupported schema', {
      code: 'unavailable',
      commitState: 'unchanged',
    });
  }
  switch (storage.kind) {
    case 'memory':
      return memoryLease(template);
    case 'indexed-db': {
      validateIndexedDbDatabaseName(storage.name);
      const { acquireIndexedDbStorage } = await import('./storage/indexed-db-provider.js');
      return acquireIndexedDbStorage(storage.name, template, compatibility);
    }
    case 'opfs': {
      validateOpfsDatabaseName(storage.name);
      const { acquireOpfsStorage } = await import('./storage/opfs-provider.js');
      return acquireOpfsStorage(storage.name, template, compatibility);
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
      return acquireNodeDirectory(storage.path, template, compatibility, storage.ownerToken);
  }
}

export function storageCompatibilityKey(
  compatibility: WasixStorageCompatibility,
): WasixStorageCompatibilityKey {
  if (
    compatibility.schema !== 'oliphaunt-wasix-pgdata-compatibility-v1' ||
    compatibility.runtime.product !== 'liboliphaunt-wasix'
  ) {
    throw new TypeError('WASIX storage compatibility has an unsupported runtime identity');
  }
  const postgresMajor = Number(compatibility.runtime.postgresVersion.split('.')[0] ?? '');
  if (postgresMajor !== DATABASE_ROOT_POSTGRES_MAJOR) {
    throw new TypeError('WASIX storage compatibility requires PostgreSQL 18');
  }
  return {
    schema: 'oliphaunt-physical-format-v1',
    engineFamily: 'wasix',
    postgresMajor,
    physicalFormat: WASIX_PHYSICAL_FORMAT,
  };
}

export function storageIsCompatible(stored: unknown, selected: WasixStorageCompatibility): boolean {
  const storedKey = parseStorageCompatibilityKey(stored);
  if (storedKey === undefined) {
    throw new TypeError('WASIX storage has malformed physical compatibility metadata');
  }
  const selectedKey = storageCompatibilityKey(selected);
  return (
    storedKey.schema === selectedKey.schema &&
    storedKey.engineFamily === selectedKey.engineFamily &&
    storedKey.postgresMajor === selectedKey.postgresMajor &&
    storedKey.physicalFormat === selectedKey.physicalFormat
  );
}

function parseStorageCompatibilityKey(value: unknown): WasixStorageCompatibilityKey | undefined {
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
  return key as WasixStorageCompatibilityKey;
}

/** Stable JSON for hashing or comparing JSON-compatible runtime identities. */
export function canonicalStorageContract(value: unknown): string {
  const active = new Set<object>();
  const canonicalize = (candidate: unknown): unknown => {
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') {
      return candidate;
    }
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) {
        throw new TypeError('storage compatibility metadata contains a non-finite number');
      }
      return candidate;
    }
    if (typeof candidate !== 'object') {
      throw new TypeError('storage compatibility metadata is not JSON-compatible');
    }
    if (active.has(candidate)) {
      throw new TypeError('storage compatibility metadata contains a cycle');
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

function memoryLease(template: WasixDirectoryMount): WasixStorageLease {
  return {
    state: 'new',
    mount: template,
    async sync() {},
    async close() {},
  };
}
