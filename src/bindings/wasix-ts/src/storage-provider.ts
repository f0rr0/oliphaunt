import type { WasixDirectoryMount } from './archive.js';
import { WasixStorageError } from './errors.js';
import type { SerializedWasixStorage } from './storage.js';
import { validateIndexedDbDatabaseName } from './storage.js';

export type WasixStorageCompatibility = Readonly<{
  schema: 'oliphaunt-wasix-pgdata-compatibility-v1';
  runtime: Readonly<{
    product: 'liboliphaunt-wasix';
    version: string;
    manifestSha256: string;
    runtimeArchiveSha256: string;
    pgdataTemplateSha256: string;
    moduleSha256: string;
    sourceFingerprint: string;
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

export type StorageDirectoryEntry = Readonly<{
  type: 'dir' | 'file' | 'unknown';
  name: string;
}>;

/** Narrow surface currently offered by Wasmer's in-memory `Directory`. */
export type StorageDirectory = {
  readDir(path: string): Promise<StorageDirectoryEntry[]>;
  readFile(path: string): Promise<Uint8Array>;
};

export type WasixStorageLease = {
  /** Whether PGDATA came from the packaged template or a prior checkpoint. */
  readonly state: 'new' | 'existing';
  /** Initial contents for the worker-owned `/base` Wasmer memory mount. */
  readonly mount: WasixDirectoryMount;
  checkpoint(directory: StorageDirectory): Promise<void>;
  close(directory: StorageDirectory | undefined, outcome: 'clean' | 'failed'): Promise<void>;
};

export type NodeDirectoryStorageAcquirer = (
  path: string,
  template: WasixDirectoryMount,
  compatibility: WasixStorageCompatibility,
  ownerToken?: string,
) => Promise<WasixStorageLease>;

let acquireNodeDirectory: NodeDirectoryStorageAcquirer | undefined;

/** @internal Installed only by the Node worker so browser graphs stay Node-free. */
export function installNodeDirectoryStorageProvider(acquire: NodeDirectoryStorageAcquirer): void {
  acquireNodeDirectory = acquire;
}

/** @deprecated Internal compatibility alias; storage leases are host-neutral. */
export type BrowserStorageLease = WasixStorageLease;

export async function acquireWasixStorage(
  storage: SerializedWasixStorage,
  template: WasixDirectoryMount,
  compatibility: WasixStorageCompatibility,
): Promise<WasixStorageLease> {
  if (storage.schema !== 'oliphaunt-wasix-storage-v1') {
    throw new WasixStorageError('WASIX storage descriptor has an unsupported schema', {
      code: 'unavailable',
      durability: 'unchanged',
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
    case 'node-directory':
      if (acquireNodeDirectory === undefined) {
        throw new WasixStorageError('Node directory storage is unavailable in a browser worker', {
          code: 'unavailable',
          durability: 'unchanged',
        });
      }
      return acquireNodeDirectory(storage.path, template, compatibility, storage.ownerToken);
  }
}

/** @deprecated Internal compatibility alias retained for source stability. */
export const acquireBrowserStorage = acquireWasixStorage;

/** Stable JSON used only for exact, fail-closed compatibility identities. */
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
    async checkpoint() {},
    async close() {},
  };
}
